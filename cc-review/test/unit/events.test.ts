import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StoreWatcher, type TurnEndEvent, type WriteEvent } from '../../src/core/events';
import { appendJsonLine } from '../../src/core/fsutil';
import { ensureLayout, layoutOf } from '../../src/core/paths';
import { fileChangeSummary, turnSummaryMessage } from '../../src/core/summary';

describe('StoreWatcher', () => {
  it('reports turn ends that happen while it runs, but not the ones already in the log', async () => {
    const L = layoutOf(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-events-')));
    ensureLayout(L);
    appendJsonLine(L.events, { type: 'turn-end', session: 's', prompt: 'old', ts: 1 });
    const writes: WriteEvent[] = [];
    const ends: TurnEndEvent[] = [];
    const w = new StoreWatcher(L, { onEvents: (e) => writes.push(...e), onBaselinesChanged: () => undefined, onTurnEnd: (e) => ends.push(e) }, 300);
    w.start();
    try {
      appendJsonLine(L.events, { type: 'claude-write', path: '/p/a.ts', ts: 2 });
      appendJsonLine(L.events, { type: 'turn-end', session: 's', prompt: 'new', ts: 3 });
      await vi.waitFor(() => expect(ends.map((e) => e.prompt)).toEqual(['new']), { timeout: 3000 });
      expect(writes.map((e) => e.path)).toEqual(['/p/a.ts']);
    } finally {
      w.dispose();
    }
  });
});

describe('end-of-turn summary', () => {
  it('names up to three files and counts the rest', () => {
    expect(turnSummaryMessage(['/p/README.md'])).toBe('Claude changed 1 file: README.md');
    expect(turnSummaryMessage(['/p/a.ts', '/p/src/b.ts'])).toBe('Claude changed 2 files: a.ts, b.ts');
    expect(turnSummaryMessage(['/p/a', '/p/b', '/p/c', '/p/d', '/p/e'])).toBe('Claude changed 5 files: a, b, c and 2 more');
  });
});

describe('file bar summary', () => {
  const pf = (over: object) => ({ existed: true, kind: 'text' as const, hunks: [{}, {}] as never[], addedCount: 5, removedCount: 3, ...over });
  it('describes edited, new, binary and large files', () => {
    expect(fileChangeSummary(pf({}))).toBe('Claude changed this file · 2 changes · +5 −3');
    expect(fileChangeSummary(pf({ hunks: [{}] as never[], removedCount: 0 }))).toBe('Claude changed this file · 1 change · +5');
    expect(fileChangeSummary(pf({ existed: false }))).toBe('New file from Claude');
    expect(fileChangeSummary(pf({ kind: 'binary' }))).toBe('Claude changed this binary file');
    expect(fileChangeSummary(pf({ kind: 'large' }))).toBe('Claude changed this large file');
  });
});
