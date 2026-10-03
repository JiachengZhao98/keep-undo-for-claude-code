// DiffEngine: baseline vs current -> Hunk[]. Line-based with zero context; each contiguous change is one hunk.
import { hash53 } from './text';

export interface Hunk {
  /** hash(removed, added content, one line before and after); unrelated edits elsewhere keep it stable */
  id: string;
  /** First line in the baseline (0-based) */
  baseStart: number;
  /** Baseline lines that were deleted or replaced -> drawn as phantom lines */
  removed: string[];
  /** First line in the current document (0-based) */
  curStart: number;
  /** Number of added or rewritten lines in the current document -> drawn with a green background */
  added: number;
}

/** a[a0, a1) is replaced by b[b0, b1) */
export interface Region {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** Step budget for Myers' inner loops. Past it, fall back to one big replacement so huge files cannot stall the extension host. */
const DEFAULT_BUDGET = 40_000_000;

class BudgetExceeded extends Error {}

export function diffRegions(a: readonly string[], b: readonly string[], budget = DEFAULT_BUDGET): Region[] {
  // 1. Strip the common prefix and suffix: Claude's edits usually touch a small part of the file
  const minLen = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < minLen && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < minLen - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const aEnd = a.length - suf;
  const bEnd = b.length - suf;
  if (pre === aEnd && pre === bEnd) return [];
  if (pre === aEnd || pre === bEnd) return slide(a, b, [{ a0: pre, a1: aEnd, b0: pre, b1: bEnd }]);

  // 2. Map lines to integers for faster comparison
  const ids = new Map<string, number>();
  const toId = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) {
      id = ids.size;
      ids.set(s, id);
    }
    return id;
  };
  const A = new Int32Array(aEnd - pre);
  const B = new Int32Array(bEnd - pre);
  for (let i = 0; i < A.length; i++) A[i] = toId(a[pre + i]);
  for (let i = 0; i < B.length; i++) B[i] = toId(b[pre + i]);

  let runs: Array<[number, number, number]>;
  try {
    runs = matchRuns(A, B, budget);
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    return [{ a0: pre, a1: aEnd, b0: pre, b1: bEnd }];
  }

  // 3. The gaps between equal runs are the changed regions
  const regions: Region[] = [];
  let ai = 0;
  let bi = 0;
  for (const [x, y, len] of runs) {
    if (x > ai || y > bi) regions.push({ a0: pre + ai, a1: pre + x, b0: pre + bi, b1: pre + y });
    ai = x + len;
    bi = y + len;
  }
  if (ai < A.length || bi < B.length) regions.push({ a0: pre + ai, a1: pre + A.length, b0: pre + bi, b1: pre + B.length });
  return slide(a, b, regions);
}

/**
 * Linear-space Myers (divide and conquer on the middle snake). Returns the equal runs [x, y, len] in order.
 * See E. Myers, "An O(ND) Difference Algorithm and Its Variations", 1986, section 4b.
 */
function matchRuns(A: Int32Array, B: Int32Array, budget: number): Array<[number, number, number]> {
  const runs: Array<[number, number, number]> = [];
  const maxD = Math.ceil((A.length + B.length) / 2) + 1;
  const off = maxD + 1;
  const Vf = new Int32Array(2 * maxD + 3);
  const Vb = new Int32Array(2 * maxD + 3);
  let steps = 0;

  // Find the middle snake in A[a0,a1) x B[b0,b1); returns [x, y, u, v], the diagonal from (x,y) to (u,v)
  const middleSnake = (a0: number, a1: number, b0: number, b1: number): [number, number, number, number] => {
    const N = a1 - a0;
    const M = b1 - b0;
    const delta = N - M;
    const odd = (delta & 1) !== 0;
    const half = Math.ceil((N + M) / 2);
    Vf[off + 1] = 0;
    Vb[off + 1] = 0;
    for (let d = 0; d <= half; d++) {
      steps += 2 * d + 2;
      if (steps > budget) throw new BudgetExceeded();
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && Vf[off + k - 1] < Vf[off + k + 1]) ? Vf[off + k + 1] : Vf[off + k - 1] + 1;
        let y = x - k;
        const x0 = x;
        const y0 = y;
        while (x < N && y < M && A[a0 + x] === B[b0 + y]) {
          x++;
          y++;
        }
        steps += x - x0;
        Vf[off + k] = x;
        const kb = delta - k;
        if (odd && kb >= -(d - 1) && kb <= d - 1 && Vf[off + k] + Vb[off + kb] >= N) {
          return [a0 + x0, b0 + y0, a0 + x, b0 + y];
        }
      }
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && Vb[off + k - 1] < Vb[off + k + 1]) ? Vb[off + k + 1] : Vb[off + k - 1] + 1;
        let y = x - k;
        const x0 = x;
        const y0 = y;
        while (x < N && y < M && A[a1 - 1 - x] === B[b1 - 1 - y]) {
          x++;
          y++;
        }
        steps += x - x0;
        Vb[off + k] = x;
        const kf = delta - k;
        if (!odd && kf >= -d && kf <= d && Vb[off + k] + Vf[off + kf] >= N) {
          return [a1 - x, b1 - y, a1 - x0, b1 - y0];
        }
      }
    }
    // Unreachable in theory
    throw new Error('middle snake not found');
  };

  const rec = (a0: number, a1: number, b0: number, b1: number): void => {
    const s0 = a0;
    const t0 = b0;
    while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) {
      a0++;
      b0++;
    }
    if (a0 > s0) runs.push([s0, t0, a0 - s0]);
    let tail = 0;
    while (a0 < a1 && b0 < b1 && A[a1 - 1] === B[b1 - 1]) {
      a1--;
      b1--;
      tail++;
    }
    // With both sides non-empty and differing at both ends, D >= 2, so both halves have a strictly smaller D and the recursion terminates
    if (a0 < a1 && b0 < b1) {
      const [x, y, u, v] = middleSnake(a0, a1, b0, b1);
      rec(a0, x, b0, y);
      if (u > x) runs.push([x, y, u - x]);
      rec(u, a1, v, b1);
    }
    if (tail) runs.push([a1, b1, tail]);
  };

  rec(0, A.length, 0, B.length);
  return runs;
}

const isBlank = (s: string | undefined) => s === undefined || s.trim() === '';
const indentOf = (s: string) => s.length - s.trimStart().length;

/**
 * A pure insertion or deletion can slide up or down (e.g. when a function is inserted between two
 * others, the blank line and closing brace have several equivalent alignments). Pick the most
 * natural position within the slide range: score higher when the block follows a blank line or the
 * start of the file, ends with a blank line, or is followed by a blank line or the end of the file.
 * Break ties by smaller indentation of the first line, then by the lowest position (git's default).
 */
function slide(a: readonly string[], b: readonly string[], regions: Region[]): Region[] {
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const isIns = r.a0 === r.a1;
    const isDel = r.b0 === r.b1;
    if (isIns === isDel) continue;
    const lines = isIns ? b : a;
    const start = isIns ? r.b0 : r.a0;
    const len = isIns ? r.b1 - r.b0 : r.a1 - r.a0;
    const prev = regions[i - 1];
    const next = regions[i + 1];
    // Never slide into contact with a neighboring region, or the two would merge
    const lo = prev ? (isIns ? prev.b1 : prev.a1) + 1 : 0;
    const hi = next ? (isIns ? next.b0 : next.a0) - 1 : lines.length;

    let top = start;
    while (top - 1 >= lo && lines[top - 1] === lines[top - 1 + len]) top--;
    let bottom = start;
    while (bottom + len + 1 <= hi && lines[bottom] === lines[bottom + len]) bottom++;
    if (top === bottom) continue;

    let best = bottom;
    let bestScore = -Infinity;
    for (let s = bottom; s >= top; s--) {
      const before = s > 0 ? lines[s - 1] : undefined;
      const after = s + len < lines.length ? lines[s + len] : undefined;
      const score =
        (isBlank(before) ? 2 : 0) +
        (isBlank(lines[s + len - 1]) ? 1 : 0) +
        (isBlank(after) ? 1 : 0) -
        indentOf(lines[s]) / 1000;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    const shift = best - start;
    regions[i] = { a0: r.a0 + shift, a1: r.a1 + shift, b0: r.b0 + shift, b1: r.b1 + shift };
  }
  return regions;
}

export function computeHunks(base: readonly string[], cur: readonly string[]): Hunk[] {
  const hunks: Hunk[] = diffRegions(base, cur).map((r) => ({
    id: '',
    baseStart: r.a0,
    removed: base.slice(r.a0, r.a1),
    curStart: r.b0,
    added: r.b1 - r.b0,
  }));
  const seen = new Map<string, number>();
  for (const h of hunks) {
    const sig = [
      h.removed.join('\n'),
      cur.slice(h.curStart, h.curStart + h.added).join('\n'),
      h.curStart > 0 ? cur[h.curStart - 1] : '\u0000BOF',
      h.curStart + h.added < cur.length ? cur[h.curStart + h.added] : '\u0000EOF',
    ].join('\u0001');
    const base36 = hash53(sig);
    const n = seen.get(base36) ?? 0;
    seen.set(base36, n + 1);
    h.id = n === 0 ? base36 : `${base36}-${n}`;
  }
  return hunks;
}
