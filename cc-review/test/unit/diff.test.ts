import { describe, expect, it } from 'vitest';
import { computeHunks, diffRegions, type Hunk } from '../../src/core/diff';
import { splitLines } from '../../src/core/text';

const L = (s: string) => splitLines(s);

/** Rebuild the current content from the baseline using the hunks, proving the hunks are a complete and correct description */
function rebuild(base: string[], cur: string[], hunks: Hunk[]): string[] {
  const out: string[] = [];
  let bi = 0;
  for (const h of hunks) {
    out.push(...base.slice(bi, h.baseStart));
    out.push(...cur.slice(h.curStart, h.curStart + h.added));
    bi = h.baseStart + h.removed.length;
  }
  out.push(...base.slice(bi));
  return out;
}

function checkConsistent(base: string[], cur: string[]): Hunk[] {
  const hunks = computeHunks(base, cur);
  expect(rebuild(base, cur, hunks)).toEqual(cur);
  for (const h of hunks) {
    expect(h.removed).toEqual(base.slice(h.baseStart, h.baseStart + h.removed.length));
    expect(h.removed.length + h.added).toBeGreaterThan(0);
  }
  // Adjacent hunks are separated by at least one equal line, with matching offsets in base and cur
  for (let i = 1; i < hunks.length; i++) {
    const a = hunks[i - 1];
    const b = hunks[i];
    const gapBase = b.baseStart - (a.baseStart + a.removed.length);
    const gapCur = b.curStart - (a.curStart + a.added);
    expect(gapBase).toBeGreaterThan(0);
    expect(gapBase).toBe(gapCur);
  }
  return hunks;
}

describe('computeHunks', () => {
  it('returns no hunks for identical content', () => {
    expect(computeHunks(L('a\nb\n'), L('a\nb\n'))).toEqual([]);
  });

  it('insertion in the middle', () => {
    const h = checkConsistent(L('a\nb\nc'), L('a\nb\nx\ny\nc'));
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ baseStart: 2, removed: [], curStart: 2, added: 2 });
  });

  it('insertion at the start and at the end', () => {
    expect(checkConsistent(L('a\nb'), L('x\na\nb'))[0]).toMatchObject({ curStart: 0, added: 1, removed: [] });
    expect(checkConsistent(L('a\nb'), L('a\nb\nx'))[0]).toMatchObject({ curStart: 2, added: 1, removed: [] });
  });

  it('deletion at the start, middle and end', () => {
    expect(checkConsistent(L('a\nb\nc'), L('b\nc'))[0]).toMatchObject({ baseStart: 0, removed: ['a'], curStart: 0, added: 0 });
    expect(checkConsistent(L('a\nb\nc'), L('a\nc'))[0]).toMatchObject({ baseStart: 1, removed: ['b'], curStart: 1, added: 0 });
    expect(checkConsistent(L('a\nb\nc'), L('a\nb'))[0]).toMatchObject({ baseStart: 2, removed: ['c'], curStart: 2, added: 0 });
  });

  it('a modification is one hunk with both removed and added lines', () => {
    const h = checkConsistent(L('a\nb\nc'), L('a\nB\nc'));
    expect(h).toEqual([expect.objectContaining({ baseStart: 1, removed: ['b'], curStart: 1, added: 1 })]);
  });

  it('two changes one line apart are two hunks', () => {
    const h = checkConsistent(L('1\n2\n3\n4\n5'), L('1\nX\n3\nY\n5'));
    expect(h).toHaveLength(2);
  });

  it('adding and removing the trailing newline', () => {
    // "a\nb\n" -> "a\nb": the last empty line is removed
    expect(checkConsistent(L('a\nb\n'), L('a\nb'))[0]).toMatchObject({ baseStart: 2, removed: [''], curStart: 2, added: 0 });
    expect(checkConsistent(L('a\nb'), L('a\nb\n'))[0]).toMatchObject({ curStart: 2, added: 1, removed: [] });
  });

  it('CRLF and LF compare equal line by line', () => {
    expect(computeHunks(L('a\r\nb\r\n'), L('a\nb\n'))).toEqual([]);
  });

  it('places an inserted function after the blank line (slide heuristic)', () => {
    const base = L('function a() {\n  return 1;\n}\n\nfunction c() {}\n');
    const cur = L('function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction c() {}\n');
    const [h] = checkConsistent(base, cur);
    expect(cur.slice(h.curStart, h.curStart + h.added)).toEqual(['function b() {', '  return 2;', '}', '']);
  });

  it('starts an added method inside a class with the blank line', () => {
    const base = L('class A {\n  foo() {\n  }\n}');
    const cur = L('class A {\n  foo() {\n  }\n\n  bar() {\n  }\n}');
    const [h] = checkConsistent(base, cur);
    expect(cur.slice(h.curStart, h.curStart + h.added)).toEqual(['', '  bar() {', '  }']);
  });

  it('keeps hunk ids stable across unrelated edits', () => {
    const base = L(Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
    const cur1 = base.slice();
    cur1[10] = 'changed 10';
    const cur2 = cur1.slice();
    cur2[40] = 'changed 40';
    cur2.splice(30, 0, 'inserted');
    const id1 = computeHunks(base, cur1)[0].id;
    const hunks2 = computeHunks(base, cur2);
    expect(hunks2).toHaveLength(3);
    expect(hunks2[0].id).toBe(id1);
    expect(new Set(hunks2.map((h) => h.id)).size).toBe(3);
  });

  it('gives distinct ids to hunks with identical content and context', () => {
    const base = L('x\na\nx\na\nx');
    const cur = L('x\nb\nx\nb\nx');
    const ids = computeHunks(base, cur).map((h) => h.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('falls back to one replacement over budget and stays correct', () => {
    const base = Array.from({ length: 300 }, (_, i) => `a${i % 7}`);
    const cur = Array.from({ length: 300 }, (_, i) => `a${i % 5}`);
    const regions = diffRegions(base, cur, 10);
    expect(regions.length).toBe(1);
    checkConsistent(base, cur);
  });

  it('random input: hunks always rebuild the current content from the baseline', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ['a', 'b', 'c', '', '}', '  x'];
    for (let iter = 0; iter < 500; iter++) {
      const base = Array.from({ length: rand(30) + 1 }, () => alphabet[rand(alphabet.length)]);
      const cur = base.slice();
      const edits = rand(5);
      for (let e = 0; e < edits; e++) {
        const pos = rand(cur.length + 1);
        const op = rand(3);
        if (op === 0) cur.splice(pos, 0, ...Array.from({ length: rand(4) + 1 }, () => alphabet[rand(alphabet.length)]));
        else if (op === 1 && cur.length > 1) cur.splice(Math.min(pos, cur.length - 1), rand(3) + 1);
        else if (pos < cur.length) cur[pos] = alphabet[rand(alphabet.length)] + 'm';
      }
      if (cur.length === 0) cur.push('');
      checkConsistent(base, cur);
    }
  });

  it('random input: the number of changed lines equals the LCS minimum', () => {
    const lcs = (a: string[], b: string[]) => {
      const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      return dp[0][0];
    };
    let seed = 1234;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let iter = 0; iter < 500; iter++) {
      const a = Array.from({ length: rand(40) }, () => 'abcd'[rand(4)]);
      const b = Array.from({ length: rand(40) }, () => 'abcd'[rand(4)]);
      const hunks = computeHunks(a, b);
      const changed = hunks.reduce((n, h) => n + h.removed.length + h.added, 0);
      const k = lcs(a, b);
      expect(changed).toBe(a.length - k + (b.length - k));
      expect(rebuild(a, b, hunks)).toEqual(b);
    }
  });

  it('handles small edits in large files quickly', () => {
    const base = Array.from({ length: 50_000 }, (_, i) => `const v${i} = ${i};`);
    const cur = base.slice();
    cur[100] = 'changed';
    cur.splice(25_000, 3);
    cur.splice(40_000, 0, 'new line');
    const t = Date.now();
    expect(computeHunks(base, cur)).toHaveLength(3);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
