// Pure Keep / Undo transforms. No vscode dependency, so they are unit-testable.
import { computeHunks, diffRegions, type Hunk } from './diff';

/** Keep a hunk: new baseline = baseline[0, baseStart) + current[curStart, curStart+added) + baseline[baseStart+removed, end) */
export function keepHunkLines(base: readonly string[], cur: readonly string[], h: Hunk): string[] {
  return [
    ...base.slice(0, h.baseStart),
    ...cur.slice(h.curStart, h.curStart + h.added),
    ...base.slice(h.baseStart + h.removed.length),
  ];
}

/** Undo a hunk: replace current[curStart, curStart+added) with removed */
export function undoHunkLines(cur: readonly string[], h: Hunk): string[] {
  return [...cur.slice(0, h.curStart), ...h.removed, ...cur.slice(h.curStart + h.added)];
}

/** One replacement in a document, in 0-based lines and UTF-16 columns, like vscode.Range. */
export interface LineEdit {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  text: string;
}

/**
 * Express undoing a hunk as one minimal replacement in the current document.
 * A document always has at least one line and "a\n" splits into ['a', ''], so deleting through the
 * end of the file must also remove the preceding newline.
 */
export function undoHunkEdit(cur: readonly string[], h: Hunk, eol: string): LineEdit {
  const n = cur.length;
  const s = h.curStart;
  const a = h.added;
  const r = h.removed.length;
  if (a > 0 && r > 0) {
    return { startLine: s, startChar: 0, endLine: s + a - 1, endChar: cur[s + a - 1].length, text: h.removed.join(eol) };
  }
  if (a > 0) {
    if (s + a < n) return { startLine: s, startChar: 0, endLine: s + a, endChar: 0, text: '' };
    // Deleting through the end of the file: s > 0 always holds (if the whole document were added, the baseline would be non-empty, so r would not be 0)
    return { startLine: s - 1, startChar: cur[s - 1].length, endLine: n - 1, endChar: cur[n - 1].length, text: '' };
  }
  if (s < n) return { startLine: s, startChar: 0, endLine: s, endChar: 0, text: h.removed.join(eol) + eol };
  return { startLine: n - 1, startChar: cur[n - 1].length, endLine: n - 1, endChar: cur[n - 1].length, text: eol + h.removed.join(eol) };
}

/** Apply a LineEdit to text held as lines (used by tests and for files not open in an editor). */
export function applyLineEdit(lines: readonly string[], e: LineEdit, eol: string): string[] {
  const text = lines.join(eol);
  const offsetOf = (line: number, ch: number) => {
    let off = 0;
    for (let i = 0; i < line; i++) off += lines[i].length + eol.length;
    return off + ch;
  };
  const out = text.slice(0, offsetOf(e.startLine, e.startChar)) + e.text + text.slice(offsetOf(e.endLine, e.endChar));
  return out.split(eol);
}

/** Map a line number in the current document that lies outside every hunk to its baseline line number. */
function mapToBase(hunks: readonly Hunk[], p: number): number {
  let delta = 0;
  for (const h of hunks) {
    if (h.curStart + h.added <= p) delta += h.removed.length - h.added;
    else break;
  }
  return p + delta;
}

function overlaps(u0: number, u1: number, h: Hunk): boolean {
  const c0 = h.curStart;
  const c1 = h.curStart + h.added;
  if (u1 > u0) {
    // The user changed lines [u0, u1)
    return c1 > c0 ? u0 < c1 && c0 < u1 : u0 < c0 && c0 < u1;
  }
  // The user inserted lines at u0
  return c1 > c0 ? c0 < u0 && u0 < c1 : u0 === c0;
}

/**
 * Auto-keep your own edits: prev -> next is one edit you made. The parts outside Claude's hunks are
 * applied to the baseline as-is (so they never show up as Claude's changes); parts touching a hunk
 * stay pending. Returns undefined when nothing can be merged.
 */
export function mergeUserEdit(
  base: readonly string[],
  prev: readonly string[],
  next: readonly string[],
  prevHunks: readonly Hunk[] = computeHunks(base, prev),
): string[] | undefined {
  const userRegions = diffRegions(prev, next);
  const outside = userRegions.filter((u) => !prevHunks.some((h) => overlaps(u.a0, u.a1, h)));
  if (outside.length === 0) return undefined;
  const out = base.slice();
  // Apply bottom-up so earlier line numbers stay valid
  for (let i = outside.length - 1; i >= 0; i--) {
    const u = outside[i];
    out.splice(mapToBase(prevHunks, u.a0), u.a1 - u.a0, ...next.slice(u.b0, u.b1));
  }
  return out;
}
