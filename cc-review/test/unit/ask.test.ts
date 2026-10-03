import { describe, expect, it } from 'vitest';
import { buildAskPrompt, formatMention } from '../../src/core/ask';
import { computeHunks } from '../../src/core/diff';
import type { PendingFile } from '../../src/core/model';
import { splitLines } from '../../src/core/text';

function pending(base: string, cur: string): PendingFile {
  const baseLines = splitLines(base);
  const curLines = splitLines(cur);
  const hunks = computeHunks(baseLines, curLines);
  return {
    path: '/p/src/a.ts',
    key: 'k',
    existed: true,
    missing: false,
    kind: 'text',
    ts: 0,
    sessions: [],
    baseLines,
    baseHash: '',
    baseEol: '\n',
    baseBom: false,
    curLines,
    curEol: '\n',
    hunks,
    addedCount: 0,
    removedCount: 0,
  };
}

describe('Ask Claude prefill', () => {
  it('formats @-mentions like the Claude Code extension (⌥K)', () => {
    expect(formatMention('src/a.ts', 3, 5)).toBe('@src/a.ts#3-5');
    expect(formatMention('src/a.ts', 3, 3)).toBe('@src/a.ts#3');
    expect(formatMention('weird#name.ts', 1, 2)).toBeUndefined();
  });

  it('rewrite: mentions the new lines and includes the original content', () => {
    const pf = pending('a\nb\nc\n', 'a\nB1\nB2\nc\n');
    const text = buildAskPrompt(pf, pf.hunks[0], 'src/a.ts', 'typescript');
    expect(text).toBe('About your change at @src/a.ts#2-3, which replaced:\n```typescript\nb\n```\n\n');
  });

  it('pure addition: only the mention', () => {
    const pf = pending('a\nc\n', 'a\nb\nc\n');
    expect(buildAskPrompt(pf, pf.hunks[0], 'src/a.ts', 'ts')).toBe('About your change at @src/a.ts#2\n\n');
  });

  it('pure deletion: mentions the lines around the gap and includes the deleted content', () => {
    const pf = pending('a\nb\nc\n', 'a\nc\n');
    expect(buildAskPrompt(pf, pf.hunks[0], 'src/a.ts', '')).toBe('About the lines you deleted between @src/a.ts#1-2:\n```\nb\n```\n\n');
    const top = pending('a\nb\n', 'b\n');
    expect(buildAskPrompt(top, top.hunks[0], 'src/a.ts', '')).toBe('About the lines you deleted at @src/a.ts#1:\n```\na\n```\n\n');
  });

  it('includes only the first 15 lines of long original content', () => {
    const old = Array.from({ length: 30 }, (_, i) => `old ${i}`).join('\n');
    const pf = pending(`a\n${old}\nz`, 'a\nnew\nz');
    const text = buildAskPrompt(pf, pf.hunks[0], 'src/a.ts', 'ts');
    expect(text).toContain('old 14');
    expect(text).not.toContain('old 15\n');
    expect(text).toContain('… (15 more lines)');
  });
});
