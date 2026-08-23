const ARRAY_KEY_PRIORITY = ['data', 'items', 'messages', 'records', 'results', 'rows'];
const NAME_CANDS = ['name', 'title', 'channel_name', 'chat_name'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function findArray(obj: unknown): unknown[] | null {
  if (Array.isArray(obj)) return obj;
  if (!isPlainObject(obj)) return null;

  for (const key of ARRAY_KEY_PRIORITY) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
  }
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
  }
  return [obj]; // a single object with no nested array becomes the record itself
}

export function parseJson(text: string): { records: Record<string, unknown>[]; sourceName: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('Invalid JSON: ' + (e instanceof Error ? e.message : String(e)));
  }

  const arr = findArray(parsed);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('No record array found. Check the JSON structure.');
  }

  let sourceName = '';
  if (isPlainObject(parsed)) {
    for (const key of NAME_CANDS) {
      const v = parsed[key];
      if (typeof v === 'string' && v !== '') {
        sourceName = v;
        break;
      }
    }
  }

  return { records: arr.map((item) => (isPlainObject(item) ? item : { value: item })), sourceName };
}
