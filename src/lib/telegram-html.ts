// Parses Telegram Desktop/macOS HTML chat exports (messages.html,
// messages2.html, …) into the same {date, from, text} record shape as
// Telegram's own JSON export, so the existing detectFields/buildFiles/upload
// pipeline runs unchanged (see popup.ts's Preview handler).
//
// Deliberately string-based, not DOMParser: these files can run several MB
// and DOMParser would build a full tree for a document we only need three
// fields out of per message. The message boundary and field regexes below
// were validated against a real 2.8MB export.

const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

function toIsoDate(raw: string): string {
  // macOS client: "9 September 2020, 18:44:51"
  const m = raw.match(/^(\d{1,2}) (\w+) (\d{4}), (\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [, day, monthName, year, hh, mm, ss] = m;
    const month = MONTHS[monthName.toLowerCase()];
    if (!month) return raw;
    return `${year}-${month}-${day.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:${ss}`;
  }
  // Telegram Desktop: "09.09.2020 18:44:51 UTC+01:00" (offset dropped — it is
  // constant within one export, and ISO keeps the cursor ordering).
  const d = raw.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})/);
  if (d) return `${d[3]}-${d[2]}-${d[1]}T${d[4]}`;
  return raw;
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', nbsp: ' ', laquo: '«', raquo: '»',
};

// Single pass, so decoded output is never re-scanned (`&#38;lt;` → "&lt;", not "<").
function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-z]+));/g, (whole, hex, dec, name) => {
    if (name) return NAMED_ENTITIES[name] ?? whole;
    const cp = parseInt(hex ?? dec, hex ? 16 : 10);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole; // malformed entity stays literal
  });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
  ).trim();
}

export function parseTelegramHtml(html: string): { records: Record<string, unknown>[]; sourceName: string } {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  let sourceName = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  if (!sourceName || sourceName === 'Exported Data') {
    // Telegram Desktop always titles the page "Exported Data"; the chat name
    // lives in the page header instead.
    const headerMatch = html.match(/<div class="page_header">[\s\S]*?<div class="text bold">\s*([\s\S]*?)\s*<\/div>/);
    if (headerMatch) sourceName = decodeEntities(headerMatch[1]).trim();
  }

  const chunks = html.split('<div class="message ');
  const records: Record<string, unknown>[] = [];
  let lastFrom = '';

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Telegram Desktop nests the forwarded original (with its own from_name)
    // in a `forwarded body` div; the message author must come from before it.
    const [head, fwdBody] = chunk.split('<div class="forwarded body">');
    const fromMatch = head.match(/<div class="from_name">\s*([\s\S]*?)\s*<\/div>/);
    if (fromMatch) lastFrom = decodeEntities(fromMatch[1]);

    if (chunk.startsWith('service"')) continue;

    // Same field as the Telegram JSON export's "id": without it records have
    // no TITLE_CANDS field and every message renders as "Untitled".
    const idMatch = chunk.match(/^[^>]*\bid="message(\d+)"/);

    const dateMatch = chunk.match(/class="pull_right date details" title="([^"]+)"/);
    const date = dateMatch ? toIsoDate(dateMatch[1]) : '';

    // macOS client marks forwards with a `forwarded_from details` line; the
    // Desktop one puts the sender's from_name (with a trailing date span)
    // inside the `forwarded body` div.
    const forwardedMatch = chunk.match(/<div class="forwarded_from details">\s*(?:Forwarded from )?([\s\S]*?)\s*<\/div>/);
    let forwardedName = forwardedMatch ? decodeEntities(forwardedMatch[1]).trim() : '';
    if (!forwardedName && fwdBody) {
      const m = fwdBody.match(/^\s*<div class="from_name">\s*([\s\S]*?)\s*<\/div>/);
      if (m) forwardedName = decodeEntities(m[1].replace(/<span[\s\S]*?<\/span>/g, '')).trim();
    }
    const mediaMatch = chunk.match(/<div class="media clearfix[^"]*">[\s\S]*?<div class="title bold">([^<]*)</);
    const textMatch = chunk.match(/<div class="text">\s*([\s\S]*?)\s*<\/div>/);

    if (!mediaMatch && !textMatch) continue;

    const parts: string[] = [];
    if (mediaMatch) parts.push(`[${decodeEntities(mediaMatch[1]).trim()}]`);
    if (textMatch) parts.push(htmlToText(textMatch[1]));
    let text = parts.join('\n');
    if (forwardedName) text = `Forwarded from ${forwardedName}:\n${text}`;

    const rec: Record<string, unknown> = { date, from: lastFrom, text };
    if (idMatch) rec.id = Number(idMatch[1]);
    records.push(rec);
  }

  return { records, sourceName };
}
