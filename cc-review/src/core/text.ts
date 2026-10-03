export type Eol = '\n' | '\r\n';

/** Matches VS Code's line model: \r\n, \r and \n all break lines; "a\n" is two lines (the second empty). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export function detectEol(text: string): Eol {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

export function linesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface Decoded {
  text: string;
  bom: boolean;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Returns undefined for binary (contains NUL) or non-UTF-8 data. The BOM is reported separately; VS Code's document text has no BOM either. */
export function decodeUtf8(buf: Uint8Array): Decoded | undefined {
  if (buf.indexOf(0) !== -1) return undefined;
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  try {
    return { text: utf8.decode(bom ? buf.subarray(3) : buf), bom };
  } catch {
    return undefined;
  }
}

export function encodeUtf8(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

/** Compare line by line, ignoring EOL differences and the BOM; fall back to bytes if either side is not text. */
export function contentEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (Buffer.compare(a, b) === 0) return true;
  const da = decodeUtf8(a);
  const db = decodeUtf8(b);
  if (!da || !db) return false;
  return linesEqual(splitLines(da.text), splitLines(db.text));
}

/** "1 file", "3 files" */
export function plural(n: number, noun: string, many = noun + 's'): string {
  return `${n} ${n === 1 ? noun : many}`;
}

/** cyrb53: a fast 53-bit string hash, used for hunk ids. */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
