// Transport for the private, undocumented Google RPC protocol
// `batchexecute`, which powers the NotebookLM web UI itself
// (`POST <origin>/_/LabsTailwindUi/data/batchexecute`). This is Plan C from
// the README ("If upload doesn't work") — used because the DOM path
// (`<input type=file>` + drag&drop in uploader.ts) breaks with every Angular
// UI redesign, while the protocol itself is far more stable (the page uses
// it too). This is purely a transport layer: request building, chunked
// response parsing, extracting protobuf-like errors embedded in HTTP 200
// responses, and retries. Domain operations (adding a source, etc.) are
// implemented by another module on top of `callRpc`.
//
// The protocol was reverse-engineered in the third-party project
// notebooklm-mcp-cli (github.com/jacob-bd/notebooklm-mcp-cli, core/base.py,
// core/errors.py, core/auth.py) — only the transport logic is ported here.
//
// Google can change this private API without notice at any time — that is
// expected, hence the retries and explicit error messages below.

/** RPC call error. `code` is the numeric error code from the batchexecute
 * response (if applicable), e.g. 3 (INVALID_ARGUMENT) or 16 (UNAUTHENTICATED). */
export class RpcError extends Error {
  code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

type PageTokens = {
  /** CSRF token (key SNlM0e in WIZ_global_data), sent both in the body
   * (`at=`) and in the X-Goog-Csrf-Token header. */
  at: string;
  /** Session id (key FdrFJe), sent in the query as f.sid. May be absent. */
  sid: string;
  /** Build label (key cfb2h), sent in the query as bl. May be absent. */
  bl: string;
};

let cachedTokens: PageTokens | null = null;

function scrapeToken(re: RegExp): string {
  const match = document.documentElement.innerHTML.match(re);
  return match ? match[1] : '';
}

/** Scrapes the CSRF/session/build-label tokens from the inline WIZ_global_data
 * JSON that Google embeds in the NotebookLM page HTML. Cached in the module
 * until invalidateTokens() is called. */
export function readPageTokens(): PageTokens {
  if (cachedTokens) return cachedTokens;

  const at = scrapeToken(/"SNlM0e":"([^"]+)"/);
  const sid = scrapeToken(/"FdrFJe":"([^"]+)"/);
  const bl = scrapeToken(/"cfb2h":"([^"]+)"/);

  if (!at) {
    throw new RpcError(
      'Could not find a CSRF token on the NotebookLM page — open the notebook tab and reload it.',
    );
  }

  cachedTokens = { at, sid, bl };
  return cachedTokens;
}

/** Clears the token cache — used before retrying after an authentication
 * error, so the next readPageTokens() re-reads the page. */
export function invalidateTokens(): void {
  cachedTokens = null;
}

/** Parses a batchexecute response: strips the anti-XSSI prefix `)]}'` and
 * parses alternating "chunk byte count / JSON chunk" lines into an array of
 * chunks. Malformed chunks are silently skipped — the server sometimes sends
 * empty lines. */
export function parseBatchExecute(raw: string): unknown[] {
  let text = raw;
  if (text.startsWith(")]}'")) {
    text = text.slice(4);
  }

  const lines = text.split('\n');
  const chunks: unknown[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i += 1;
      continue;
    }

    if (/^\d+$/.test(line)) {
      // A byte-count line — the chunk itself is on the next line.
      i += 1;
      if (i < lines.length) {
        try {
          chunks.push(JSON.parse(lines[i]));
        } catch {
          // corrupted/incomplete chunk — skip
        }
        i += 1;
      }
    } else {
      // Not a number — try parsing the line itself as JSON.
      try {
        chunks.push(JSON.parse(line));
      } catch {
        // not JSON — skip
      }
      i += 1;
    }
  }

  return chunks;
}

const GRPC_CODE_NAMES: Record<number, string> = {
  3: 'INVALID_ARGUMENT',
  5: 'NOT_FOUND',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  16: 'UNAUTHENTICATED',
};

// UserDisplayableError payload — the human-readable text is buried in
// arbitrarily nested lists of strings. Walk depth-first, collecting all
// non-empty strings. Depth is capped in case of a malformed response.
function extractUserMessage(data: unknown, depth = 0): string {
  if (depth > 20 || data == null) return '';
  if (typeof data === 'string') return data.trim();
  if (Array.isArray(data)) {
    return data
      .map((item) => extractUserMessage(item, depth + 1))
      .filter(Boolean)
      .join('; ');
  }
  return '';
}

/** Extracts an error from a single response element shaped like
 * `["wrb.fr", rpcId, result, null, null, errorPayload, "generic"]`, where
 * errorPayload = `[code, null, [[detailTypeUrl, detailData], ...]]`.
 * Returns null if the element isn't such an array or has no error. */
export function extractRpcError(chunk: unknown): { code: number; message: string } | null {
  if (!Array.isArray(chunk)) return null;

  const errorPayload = chunk[5];
  if (!Array.isArray(errorPayload) || errorPayload.length === 0) return null;

  const code = errorPayload[0];
  if (typeof code !== 'number') return null;

  let detailType = '';
  let detailData: unknown = null;
  const details = errorPayload[2];
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (Array.isArray(detail) && detail.length > 0) {
        detailType = typeof detail[0] === 'string' ? detail[0] : '';
        detailData = detail.length > 1 ? detail[1] : null;
        break;
      }
    }
  }

  let message = `API error (code ${code}): ${detailType || GRPC_CODE_NAMES[code] || 'unknown'}`;
  if (detailType.includes('UserDisplayableError')) {
    const userMessage = extractUserMessage(detailData);
    if (userMessage) message = `API error (code ${code}): ${userMessage}`;
  }

  return { code, message };
}

// Finds the wrb.fr element for the given rpcId in the parsed response.
function findRpcItem(chunks: unknown[], rpcId: string): unknown[] | null {
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    for (const item of chunk) {
      if (Array.isArray(item) && item[0] === 'wrb.fr' && item[1] === rpcId) {
        return item;
      }
    }
  }
  return null;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 16000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const AUTH_EXPIRED_MESSAGE = 'Google session expired, please reload the notebook page.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(rpcId: string, tokens: PageTokens, notebookId?: string): string {
  const params = new URLSearchParams({
    rpcids: rpcId,
    'source-path': notebookId ? `/notebook/${notebookId}` : '/',
    bl: tokens.bl,
    hl: 'en',
    rt: 'c',
  });
  if (tokens.sid) params.set('f.sid', tokens.sid);
  return `${location.origin}/_/LabsTailwindUi/data/batchexecute?${params.toString()}`;
}

function buildBody(rpcId: string, params: unknown[], tokens: PageTokens): string {
  const fReq = [[[rpcId, JSON.stringify(params), null, 'generic']]];
  const parts = [`f.req=${encodeURIComponent(JSON.stringify(fReq))}`];
  if (tokens.at) parts.push(`at=${encodeURIComponent(tokens.at)}`);
  // Trailing `&` — part of the format the NotebookLM page itself sends.
  return `${parts.join('&')}&`;
}

/** Performs a single batchexecute RPC call and returns the parsed payload
 * chunk (JSON.parse of item[2], or, if parsing fails, the whole chunk list
 * as-is).
 *
 * Retries HTTP 429/500/502/503/504 up to 3 times with exponential backoff
 * (1s → 2s → 4s, capped at 16s). On signs of an expired session (HTTP
 * 400/401/403, a redirect to accounts.google.com, or error code 16 in the
 * response body) it clears the token cache once and retries; if that doesn't
 * help, it throws an RpcError with a clear message. */
export async function callRpc(
  rpcId: string,
  params: unknown[],
  notebookId?: string,
): Promise<unknown[]> {
  let authRetried = false;

  for (let attempt = 0; ; attempt += 1) {
    const tokens = readPageTokens();
    const url = buildUrl(rpcId, tokens, notebookId);
    const body = buildBody(rpcId, params, tokens);

    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1',
        'X-Goog-Csrf-Token': tokens.at,
      },
      body,
    });

    const redirectedToLogin = response.redirected && response.url.includes('accounts.google.com');
    const isHttpAuthError = redirectedToLogin || [400, 401, 403].includes(response.status);

    if (isHttpAuthError) {
      if (!authRetried) {
        authRetried = true;
        invalidateTokens();
        continue;
      }
      throw new RpcError(AUTH_EXPIRED_MESSAGE);
    }

    if (RETRYABLE_STATUS.has(response.status)) {
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
        await sleep(delay);
        continue;
      }
      throw new RpcError(`batchexecute returned HTTP ${response.status} after ${MAX_RETRIES} retries.`);
    }

    if (!response.ok) {
      throw new RpcError(`batchexecute returned HTTP ${response.status}.`);
    }

    const chunks = parseBatchExecute(await response.text());
    const item = findRpcItem(chunks, rpcId);
    if (!item) {
      // No element found for our rpcId — return the whole parsed response,
      // let the caller figure it out (better than silently swallowing data).
      return chunks;
    }

    const error = extractRpcError(item);
    if (error) {
      if (error.code === 16) {
        if (!authRetried) {
          authRetried = true;
          invalidateTokens();
          continue;
        }
        throw new RpcError(AUTH_EXPIRED_MESSAGE, 16);
      }
      throw new RpcError(error.message, error.code);
    }

    const result = item[2];
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [result];
      }
    }
    return Array.isArray(result) ? result : [result];
  }
}
