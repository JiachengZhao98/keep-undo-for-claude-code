// Runs inside a real VS Code extension host. Claude is not needed: writing baselines and events and
// editing files directly covers everything except the hook triggers. The inset rendering checks live here too.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { appendJsonLine } from '../../src/core/fsutil';
import { baseFile, canonical, layoutOf, metaFile, pathKey } from '../../src/core/paths';
import { recordPrompt, recordRoundWrite } from '../../src/core/rounds';
import { Store } from '../../src/core/store';
import type { CcReviewApi } from '../../src/extension';
import { claudeOpenUri } from '../../src/ui/askClaude';
import { renderRemovedLines } from '../../src/ui/phantomInsets';

const WS = canonical(process.env.CCR_WORKSPACE!);
const L = layoutOf();
const store = new Store(L);
const log: string[] = [];
let api: CcReviewApi;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => T | undefined | false | null, timeout = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(50);
  }
}

async function waitForAsync<T>(what: string, fn: () => Promise<T | undefined | false | null>, timeout = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(100);
  }
}

/** Simulate the hook: store a baseline, write the file, append a write event */
function claudeWrites(name: string, before: string | undefined, after: string): string {
  const p = path.join(WS, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (before !== undefined) fs.writeFileSync(p, before);
  store.write({ path: p, existed: before !== undefined, ts: Date.now(), sessions: ['it-session'] }, Buffer.from(before ?? ''));
  fs.writeFileSync(p, after);
  appendJsonLine(L.events, { type: 'claude-write', path: p, tool: 'Edit', session: 'it-session', ts: Date.now() });
  return p;
}

const pending = (p: string, hunks?: number) =>
  waitFor(`${path.basename(p)} pending${hunks === undefined ? '' : ` (${hunks} hunks)`}`, () => {
    const f = api.model.getFile(p);
    return f && (hunks === undefined || f.hunks.length === hunks) ? f : undefined;
  });

const resolved = (p: string) => waitFor(`${path.basename(p)} to leave the queue`, () => !api.model.getFile(p));

function expectedLineHeight(): number {
  const c = vscode.workspace.getConfiguration('editor');
  const fontSize = c.get<number>('fontSize') ?? 12;
  let lh = c.get<number>('lineHeight') ?? 0;
  if (lh === 0) lh = (process.platform === 'darwin' ? 1.5 : 1.35) * fontSize;
  else if (lh < 8) lh = lh * fontSize;
  return Math.round(lh);
}

const activeLine = () => vscode.window.activeTextEditor?.selection.active.line;
const activePath = () => {
  const ed = vscode.window.activeTextEditor;
  return ed ? canonical(ed.document.uri.fsPath) : undefined;
};

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

// ---------------- Inset rendering ----------------

test('editorInsets is available in stable VS Code with --enable-proposed-api', async () => {
  assert.equal(typeof vscode.window.createWebviewTextEditorInset, 'function');
  assert.equal(api.controller.insets.isAvailable, true);
});

test('insets render, fit at the top of the file, and are exactly lines x editor line height tall', async () => {
  const p = path.join(WS, 'p0.txt');
  fs.writeFileSync(p, Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'));
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  const metrics: Array<{ line: number; height: number; h: number; lineH: number; fontSize: string; fontFamily: string }> = [];
  const make = (line: number, height: number) => {
    const inset = vscode.window.createWebviewTextEditorInset(ed, line, height, { enableScripts: true });
    inset.webview.onDidReceiveMessage((m) => m?.cmd === 'metrics' && metrics.push({ line, height, ...m }));
    inset.webview.html = renderRemovedLines(
      Array.from({ length: height }, (_, i) => `removed ${i}`),
      { tabSize: 4, letterSpacing: 0, ligatures: false },
    );
    return inset;
  };
  const insets = [make(-1, 2), make(5, 3), make(39, 1)];
  try {
    await waitFor('both visible insets to report sizes', () => metrics.some((m) => m.line === -1) && metrics.some((m) => m.line === 5), 15_000);
    // Webviews outside the viewport only render once scrolled into view
    ed.revealRange(new vscode.Range(39, 0, 39, 0));
    await waitFor('the last inset to report after scrolling to the end', () => metrics.length >= 3, 15_000);
  } finally {
    log.push(`    insets that reported sizes: ${metrics.map((m) => m.line).join(', ') || 'none'}`);
  }
  const lh = expectedLineHeight();
  for (const m of metrics.sort((a, b) => a.line - b.line)) {
    log.push(`    inset below line ${m.line}, ${m.height} lines: ${m.h}px, ${m.lineH}px per line (editor line height ${lh}px); font ${m.fontSize} ${m.fontFamily.slice(0, 40)}`);
    assert.equal(m.h, m.height * lh);
    assert.equal(Math.round(m.lineH), lh);
  }
  insets.forEach((i) => i.dispose());
});

test('creation time with 50 insets at once', async () => {
  const p = path.join(WS, 'p0-many.txt');
  fs.writeFileSync(p, Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n'));
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  let reported = 0;
  const t0 = Date.now();
  const insets = Array.from({ length: 50 }, (_, i) => {
    const inset = vscode.window.createWebviewTextEditorInset(ed, i * 2, 1, { enableScripts: true });
    inset.webview.onDidReceiveMessage((m) => m?.cmd === 'metrics' && reported++);
    inset.webview.html = renderRemovedLines([`removed ${i}`], { tabSize: 4, letterSpacing: 0, ligatures: false });
    return inset;
  });
  const created = Date.now() - t0;
  await waitFor('insets in the visible range to render', () => reported >= 10, 30_000);
  // Scroll around to check that the extension host stays responsive
  const t1 = Date.now();
  ed.revealRange(new vscode.Range(100, 0, 100, 0));
  await sleep(300);
  ed.revealRange(new vscode.Range(0, 0, 0, 0));
  await sleep(300);
  log.push(`    created 50 insets in ${created}ms; ${reported} rendered within ${Date.now() - t0}ms; scrolling back and forth took ${Date.now() - t1}ms`);
  insets.forEach((i) => i.dispose());
});

/** Physical memory footprint of each process in KB, as Activity Monitor and top report it (macOS) */
function footprints(): Map<number, number> {
  const unit: Record<string, number> = { B: 1 / 1024, K: 1, M: 1024, G: 1024 * 1024 };
  const out = new Map<number, number>();
  for (const line of execFileSync('top', ['-l', '1', '-stats', 'pid,mem'], { encoding: 'utf8' }).split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)([BKMG])\+?\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Number(m[2]) * unit[m[3]]);
  }
  return out;
}

/**
 * Memory of this VS Code instance in MB: its main process and every process under it (renderers,
 * GPU, extension host). `mb` is the physical footprint (shared memory counted once); `rssMb` sums RSS.
 */
function vscodeMemoryMB(): { mb: number; rssMb: number; processes: number; root: string; top: string } {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), kb: Number(m[3]), comm: m[4] }));
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<number, number[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
  // Walk up from the extension host to the main process ("…/Contents/MacOS/Code")
  let root = process.pid;
  while (byPid.get(root) && !/\/MacOS\/(Code|Electron)$/.test(byPid.get(root)!.comm) && byPid.get(root)!.ppid > 1) root = byPid.get(root)!.ppid;
  const foot = footprints();
  let rssKb = 0;
  let footKb = 0;
  const tree: Array<{ pid: number; kb: number; comm: string }> = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    const r = byPid.get(pid);
    if (r) {
      rssKb += r.kb;
      footKb += foot.get(pid) ?? 0;
      tree.push({ ...r, kb: foot.get(pid) ?? 0 });
    }
    stack.push(...(children.get(pid) ?? []));
  }
  const top = tree
    .sort((a, b) => b.kb - a.kb)
    .slice(0, 5)
    .map((r) => `${path.basename(r.comm)} ${Math.round(r.kb / 1024)}MB`)
    .join('; ');
  return { mb: Math.round(footKb / 1024), rssMb: Math.round(rssKb / 1024), processes: tree.length, root: path.basename(byPid.get(root)?.comm ?? '?'), top };
}

test('memory per inset', async () => {
  const p = path.join(WS, 'p0-memory.txt');
  fs.writeFileSync(p, Array.from({ length: 240 }, (_, i) => `line ${i}`).join('\n'));
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  await sleep(1500);
  const before = vscodeMemoryMB();
  const rendered = new Set<number>();
  const insets = Array.from({ length: 40 }, (_, i) => {
    const inset = vscode.window.createWebviewTextEditorInset(ed, i * 6, 1, { enableScripts: true });
    inset.webview.onDidReceiveMessage((m) => m?.cmd === 'metrics' && rendered.add(i));
    inset.webview.html = renderRemovedLines([`removed ${i}`], { tabSize: 4, letterSpacing: 0, ligatures: false });
    return inset;
  });
  // Scroll through the file so every inset comes into view once
  for (let line = 0; line < 240; line += 12) {
    ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
    await sleep(300);
  }
  await sleep(1500);
  const all = vscodeMemoryMB();
  ed.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
  await sleep(1500);
  const top = vscodeMemoryMB();
  insets.forEach((i) => i.dispose());
  await sleep(1500);
  const disposed = vscodeMemoryMB();
  const each = (a: number, b: number) => ((b - a) / 40).toFixed(1);
  log.push(
    `    40 insets (${rendered.size} reported rendering): ${before.processes} -> ${all.processes} processes; ` +
      `footprint ${before.mb} -> ${all.mb} MB (${each(before.mb, all.mb)} MB per inset), RSS ${before.rssMb} -> ${all.rssMb} MB (${each(before.rssMb, all.rssMb)} MB per inset)`,
    `    scrolled back to the top: ${top.processes} processes, ${top.mb} MB; 1.5 s after disposing them: ${disposed.processes} processes, ${disposed.mb} MB`,
    `    largest with insets: ${all.top}`,
  );
});

test('scrolling back and forth over a file with many changes', async () => {
  const before = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`);
  // 20 changed lines, one every 20 lines: each gets a red line inset and a buttons inset
  const after = before.map((l, i) => (i % 20 === 10 ? l.replace('= ', '= 1 + ') : l));
  const p = claudeWrites('scroll/many.ts', before.join('\n') + '\n', after.join('\n') + '\n');
  await pending(p, 20);
  const ins = api.controller.insets;
  const c0 = ins.created;
  const m0 = vscodeMemoryMB();
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  await waitFor('insets near the top', () => ins.insetCount > 0);
  const passes: string[] = [];
  const t0 = Date.now();
  for (let pass = 1; pass <= 3; pass++) {
    for (let line = 0; line <= 400; line += 40) {
      ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
      await sleep(150);
    }
    for (let line = 400; line >= 0; line -= 40) {
      ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
      await sleep(150);
    }
    passes.push(String(ins.created - c0));
  }
  const m1 = vscodeMemoryMB();
  log.push(
    `    20 changes (40 insets and a file bar): insets created after each pass down and up: ${passes.join(', ')} (${Date.now() - t0}ms); ` +
      `${ins.insetCount + ins.changeButtonCount} alive; VS Code ${m0.processes} -> ${m1.processes} processes, ${m0.mb} -> ${m1.mb} MB`,
  );
  // Each inset is created once and kept: a disposed inset's renderer process lives on until the editor closes
  assert.deepEqual(passes, ['41', '41', '41']);
});

// ---------------- In-editor review ----------------

test('after Claude edits a file: hunks, phantom lines and buttons below each change appear', async () => {
  const p = claudeWrites('src/flow.ts', 'a\nb\nc\nd\ne\nf\n', 'a\nB\nc\nd\nnew1\nnew2\ne\n');
  const pf = await pending(p, 3);
  assert.deepEqual(
    pf.hunks.map((h) => [h.curStart, h.added, h.removed]),
    [
      [1, 1, ['b']],
      [4, 2, []],
      [7, 0, ['f']],
    ],
  );
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  await waitFor('two phantom line insets', () => api.controller.insets.insetCount === 2);
  // Buttons below each change: two rows of their own, and one inside the pure deletion's inset
  await waitFor('buttons for all three changes', () => api.controller.insets.changeButtonCount === 3);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', ed.document.uri);
  assert.equal(lenses.filter((l) => l.command?.command === 'ccReview.keepHunk').length, 0);
});

test('a changed file gets a Keep / Undo bar at the top; a new file shows it instead of its file-level CodeLens', async () => {
  const p = claudeWrites('bar/edited.ts', 'a\nb\n', 'a\nB\n');
  await pending(p, 1);
  await vscode.window.showTextDocument(vscode.Uri.file(p));
  await waitFor('the file bar', () => api.controller.insets.fileBarCount === 1);
  await api.controller.keepFile(p);
  await resolved(p);
  await waitFor('the file bar to go away once nothing is left to review', () => api.controller.insets.fileBarCount === 0);

  const created = claudeWrites('bar/created.ts', undefined, 'new\n');
  await waitFor('the new file to be pending', () => api.model.getFile(created));
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(created));
  await waitFor('the file bar on the new file', () => api.controller.insets.fileBarCount === 1);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', ed.document.uri);
  assert.equal(lenses.filter((l) => l.command?.command === 'ccReview.undoFile').length, 0);
  await api.controller.keepFile(created);
  await resolved(created);
});

test('hunk-level Keep / Undo: Undo writes to disk and records a revert; the baseline is deleted after the last hunk', async () => {
  const p = claudeWrites('src/ku.ts', '1\n2\n3\n4\n5\n', '1\nX\n3\n4\nY\n5\n');
  const pf = await pending(p, 2);
  await vscode.window.showTextDocument(vscode.Uri.file(p));
  await vscode.commands.executeCommand('ccReview.keepHunk', p, pf.hunks[0].id);
  const rest = await pending(p, 1);
  await vscode.commands.executeCommand('ccReview.undoHunk', p, rest.hunks[0].id);
  await resolved(p);
  assert.equal(fs.readFileSync(p, 'utf8'), '1\nX\n3\n4\n5\n');
  assert.ok(!fs.existsSync(metaFile(L, pathKey(p))));
  assert.ok(store.readReverts().some((r) => r.type === 'revert' && r.path === p && r.kind === 'added'));
});

test('Keep / Undo at the cursor (the argument-less form used by keybindings)', async () => {
  const p = claudeWrites('src/cursor.ts', 'a\nb\nc\nd\ne\nf\ng\n', 'A\nb\nc\nd\ne\nf\nG\n');
  await pending(p, 2);
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  ed.selection = new vscode.Selection(6, 0, 6, 0);
  await vscode.commands.executeCommand('ccReview.undoHunk');
  await waitFor('the last line to be undone', () => ed.document.lineAt(6).text === 'g');
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('ccReview.keepHunk');
  await resolved(p);
  assert.equal(fs.readFileSync(p, 'utf8'), 'A\nb\nc\nd\ne\nf\ng\n');
});

test('⌘Z after Undo restores the change, makes it pending again and cancels the revert record', async () => {
  const p = claudeWrites('src/undo.ts', 'a\nb\nc\n', 'a\nB\nc\n');
  const [h] = (await pending(p, 1)).hunks;
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  await sleep(200);
  await vscode.commands.executeCommand('ccReview.undoHunk', p, h.id);
  await resolved(p);
  assert.equal(ed.document.getText(), 'a\nb\nc\n');
  await vscode.window.showTextDocument(ed.document);
  await vscode.commands.executeCommand('undo');
  await waitFor("Claude's change to return to the editor", () => ed.document.getText() === 'a\nB\nc\n');
  const back = await pending(p, 1);
  assert.equal(back.hunks[0].id, h.id);
  await waitFor('the revert record to be cancelled', () => store.readReverts().some((l) => l.type === 'cancel'));
  await ed.document.save();
});

test('auto-keep: manual edits outside hunks merge into the baseline, edits inside stay pending', async () => {
  const p = claudeWrites('src/auto.ts', 'a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n');
  await pending(p, 1);
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  await sleep(300);
  await ed.edit((eb) => eb.insert(new vscode.Position(3, 1), '!'));
  await waitFor('your edit to be merged into the baseline', () => fs.readFileSync(baseFile(L, pathKey(p)), 'utf8') === 'a\nb\nc\nd!\ne\n');
  await waitFor("still only Claude's single hunk", () => {
    const f = api.model.getFile(p);
    return f?.docVersion === ed.document.version && f.hunks.length === 1 && f.hunks[0].removed[0] === 'b';
  });
  await ed.edit((eb) => eb.insert(new vscode.Position(1, 1), '?'));
  await sleep(400);
  assert.equal(fs.readFileSync(baseFile(L, pathKey(p)), 'utf8'), 'a\nb\nc\nd!\ne\n');
  await waitFor('the edit inside the hunk to count as pending', () => api.model.getFile(p)?.hunks[0] && ed.document.lineAt(1).text === 'B?');
  await ed.document.save();
});

test('two quick writes by Claude while the editor is open: reloads are not your edits', async () => {
  const p = claudeWrites('src/twice.ts', 'a\nb\nc\nd\n', 'a\nB\nc\nd\n');
  await pending(p, 1);
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  await sleep(300);
  fs.writeFileSync(p, 'a\nB\nc\nD\n');
  await sleep(5);
  fs.writeFileSync(p, 'a\nB\nC\nD\n');
  await waitFor('the editor to load the final content', () => ed.document.getText() === 'a\nB\nC\nD\n');
  await sleep(400);
  assert.equal(fs.readFileSync(baseFile(L, pathKey(p)), 'utf8'), 'a\nb\nc\nd\n');
  const f = await pending(p, 1);
  assert.deepEqual(f.hunks[0].removed, ['b', 'c', 'd']);
});

test('new file from Claude: Keep removes it from the queue', async () => {
  const p = claudeWrites('src/new.ts', undefined, 'export const x = 1;\n');
  const pf = await pending(p, 1);
  assert.equal(pf.existed, false);
  await vscode.commands.executeCommand('ccReview.keepHunk', p, pf.hunks[0].id);
  await resolved(p);
  assert.ok(!fs.existsSync(metaFile(L, pathKey(p))));
});

test('new file from Claude: Undo deletes the file', async () => {
  const p = claudeWrites('src/new2.ts', undefined, 'x\n');
  await pending(p, 1);
  await vscode.window.showTextDocument(vscode.Uri.file(p));
  await api.controller.undoFile(p, true);
  assert.ok(!fs.existsSync(p));
  await resolved(p);
});

test('an external revert (git checkout / rewind) removes the file from the queue', async () => {
  const p = claudeWrites('src/ext.ts', 'orig\n', 'claude\n');
  await pending(p, 1);
  fs.writeFileSync(p, 'orig\n');
  await resolved(p);
});

test('an external revert of an open file also removes it from the queue', async () => {
  const p = claudeWrites('src/ext-open.ts', 'orig\n', 'claude\n');
  await pending(p, 1);
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  fs.writeFileSync(p, 'orig\n');
  await waitFor('the editor to reload', () => ed.document.getText() === 'orig\n');
  await resolved(p);
});

test('next / previous hunk across files', async () => {
  const p1 = claudeWrites('nav/a.ts', '1\n2\n3\n4\n5\n6\n', '1\nX\n3\n4\n5\nY\n');
  const p2 = claudeWrites('nav/b.ts', 'q\nw\n', 'q\nW\n');
  await pending(p1, 2);
  await pending(p2, 1);
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p1));
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('ccReview.nextHunk');
  assert.equal(activeLine(), 1);
  await vscode.commands.executeCommand('ccReview.nextHunk');
  assert.equal(activeLine(), 5);
  await vscode.commands.executeCommand('ccReview.nextHunk');
  assert.equal(activePath(), p2);
  assert.equal(activeLine(), 1);
  await vscode.commands.executeCommand('ccReview.prevHunk');
  assert.equal(activePath(), p1);
  assert.equal(activeLine(), 5);
});

test('phantom lines are rebuilt after switching tabs', async () => {
  const p = claudeWrites('tabs/a.ts', 'a\nb\nc\n', 'a\nc\n');
  await pending(p, 1);
  const other = path.join(WS, 'tabs/other.ts');
  fs.writeFileSync(other, 'x\n');
  await vscode.window.showTextDocument(vscode.Uri.file(p));
  await waitFor('the inset to be created', () => api.controller.insets.insetCount === 1);
  await vscode.window.showTextDocument(vscode.Uri.file(other));
  await waitFor('the inset to be disposed after switching away', () => api.controller.insets.insetCount === 0);
  await vscode.window.showTextDocument(vscode.Uri.file(p));
  await waitFor('the inset to be rebuilt after switching back', () => api.controller.insets.insetCount === 1);
});

test('inserting lines above an inset shifts it without rebuilding', async () => {
  const p = claudeWrites('tabs/shift.ts', 'a\nb\nc\nd\n', 'a\nb\nd\n');
  await pending(p, 1);
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
  await waitFor('the inset to be created', () => api.controller.insets.insetCount === 1);
  await ed.edit((eb) => eb.insert(new vscode.Position(0, 0), 'top\n'));
  await waitFor('the model to catch up', () => api.model.getFile(p)?.docVersion === ed.document.version);
  await sleep(200);
  assert.equal(api.controller.insets.insetCount, 1);
  assert.equal(api.model.getFile(p)!.hunks[0].curStart, 3);
  await ed.document.save();
});

test('hover fallback: no insets with phantomLines = hover', async () => {
  const c = vscode.workspace.getConfiguration('ccReview');
  await c.update('phantomLines', 'hover', vscode.ConfigurationTarget.Global);
  try {
    const p = claudeWrites('hover/a.ts', 'a\nb\nc\nd\n', 'a\nc\nD\n');
    await pending(p, 2);
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
    await sleep(500);
    assert.equal(api.controller.insets.insetCount, 0);
    assert.equal(api.controller.insets.changeButtonCount, 0);
    // Without insets, Keep / Undo / Ask Claude fall back to CodeLens links on the line after each change
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', ed.document.uri);
    const keeps = lenses.filter((l) => l.command?.command === 'ccReview.keepHunk');
    assert.deepEqual(
      keeps.map((l) => l.range.start.line),
      [1, 3],
    );
    assert.ok(lenses.every((l) => !l.command?.title.startsWith('Claude ')), 'no "Claude 1/2 ..." summary');
  } finally {
    await c.update('phantomLines', undefined, vscode.ConfigurationTarget.Global);
  }
});

// ---------------- Summary views ----------------

test('multi-file diff and tree view', async () => {
  const p = claudeWrites('summary/a.ts', 'a\n', 'b\n');
  await pending(p, 1);
  assert.ok(api.controller.scopeFiles().some((f) => f.path === p));
  await vscode.commands.executeCommand('ccReview.reviewAll');
  try {
    await waitFor('the multi-file diff to open', () => vscode.window.tabGroups.activeTabGroup.activeTab?.label.startsWith('Claude Changes'));
  } finally {
    const t = vscode.window.tabGroups.activeTabGroup.activeTab;
    log.push(`    active tab: ${t?.label} (${t?.input?.constructor?.name})`);
  }
  await vscode.commands.executeCommand('ccReview.openDiff', p);
  await waitFor('the single-file diff to open', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
});

test('Undo records reach the UserPromptSubmit hook (real hook.js)', async () => {
  const p = claudeWrites('src/report.ts', 'keep\nold\n', 'keep\nnew\n');
  const [h] = (await pending(p, 1)).hunks;
  await vscode.commands.executeCommand('ccReview.undoHunk', p, h.id);
  await resolved(p);
  const out = execFileSync(process.execPath, [L.hookScript, 'prompt'], {
    input: JSON.stringify({ session_id: 'it-session', cwd: WS, prompt: 'go on' }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).toString();
  log.push('    hook output: ' + out.trim().split('\n').join('\n    '));
  assert.match(out, /src\/report\.ts line 2: the user reverted your edit/);
  assert.match(out, /new/);
});

test('a file changed by a shell command becomes pending (real hook.js)', async () => {
  const p = path.join(WS, 'shell/edited.txt');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'keep\nbefore\n');
  const input = { session_id: 'it-session', prompt_id: 'it-shell', cwd: path.dirname(p), tool_name: 'Bash', tool_use_id: 'it-bash-1', tool_input: { command: './fix.sh' } };
  const hook = (mode: string) =>
    execFileSync(process.execPath, [L.hookScript, mode], { input: JSON.stringify(input), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_PROJECT_DIR: '' } });
  hook('bash-pre');
  fs.writeFileSync(p, 'keep\nafter\n');
  hook('bash-post');
  const pf = await pending(p, 1);
  assert.deepEqual(pf.hunks[0].removed, ['before']);
});

test('Keep All / Undo All (model level, no confirmation dialog)', async () => {
  const a = claudeWrites('all/a.ts', 'a\n', 'A\n');
  const b = claudeWrites('all/b.ts', 'b\n', 'B\n');
  await pending(a, 1);
  await pending(b, 1);
  await api.model.keepFile(a);
  await api.model.undoFile(b);
  await resolved(a);
  await resolved(b);
  assert.equal(fs.readFileSync(a, 'utf8'), 'A\n');
  assert.equal(fs.readFileSync(b, 'utf8'), 'b\n');
});

test('the extension trims the snapshot cache in a child process (real hook.js)', async () => {
  fs.mkdirSync(L.snapshots, { recursive: true });
  const stale = path.join(L.snapshots, `${'0'.repeat(40)}.json`);
  fs.writeFileSync(stale, JSON.stringify({ root: '/gone', ts: 0, files: {} }));
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  const budget = () => (fs.existsSync(L.config) ? (JSON.parse(fs.readFileSync(L.config, 'utf8')) as { snapshotCacheMB?: number }).snapshotCacheMB : undefined);
  const c = vscode.workspace.getConfiguration('ccReview');
  await c.update('snapshotCacheMB', 120, vscode.ConfigurationTarget.Global);
  try {
    await waitFor('the budget to reach config.json for the hook', () => budget() === 120);
    await waitFor('the folder index unused for two days to be dropped', () => !fs.existsSync(stale), 15_000);
  } finally {
    await c.update('snapshotCacheMB', undefined, vscode.ConfigurationTarget.Global);
  }
});

// ---------------- Syntax highlighting, rounds, Ask Claude ----------------

/** Simulate a round: record the message, write the file, store before/after snapshots, append a write event */
function claudeRound(file: string, promptId: string, prompt: string, after: string, session = 'it-session'): void {
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  recordPrompt(L, promptId, session, WS, prompt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  recordRoundWrite(L, promptId, pathKey(file), file, before, session, WS);
  appendJsonLine(L.events, { type: 'claude-write', path: file, tool: 'Edit', session, prompt: promptId, ts: Date.now() });
}

test('phantom lines are highlighted with the active theme; a removed line inside a block comment gets the comment color', async () => {
  const before = ['const a = 1;', '/* block', '   comment line */', 'function f(x: number) {', '  return "text" + x; // note', '}', ''].join('\n');
  const after = ['const a = 1;', '/* block */', 'function f(x: number) {', '  return x;', '}', ''].join('\n');
  const p = claudeWrites('hl/a.ts', before, after);
  const pf = await pending(p);
  await vscode.window.showTextDocument(vscode.Uri.file(p));
  await waitFor('phantom lines to report highlighting', () => api.controller.insets.highlighted.some((n) => n > 0), 20_000);
  const hl = api.controller.highlighter;
  log.push(`    theme: ${hl.themeName}`);
  const rows = await hl.highlight(p, pf.baseHash, 'typescript', pf.baseLines, 2, 3);
  assert.ok(rows, 'no highlighting result');
  const [commentLine, , returnLine] = rows!;
  const colorOf = (row: typeof commentLine, text: string) => row.find(([t]) => t.includes(text))?.[1];
  log.push(`    "   comment line */" → ${JSON.stringify(commentLine)}`);
  log.push(`    return line -> ${JSON.stringify(returnLine)}`);
  const commentColor = colorOf(returnLine, '// note');
  assert.ok(commentColor, 'the trailing comment should be colored');
  assert.equal(colorOf(commentLine, 'comment line'), commentColor);
  assert.ok(colorOf(returnLine, 'return'));
  assert.ok(colorOf(returnLine, '"text"'));
  assert.notEqual(colorOf(returnLine, 'return'), colorOf(returnLine, '"text"'));
});

test('colors follow a switch to a light theme, recoloring insets in place', async () => {
  const p = claudeWrites('hl/theme.ts', 'let x = "s"; // c\nend\n', 'end\n');
  const pf = await pending(p);
  const hl = api.controller.highlighter;
  const ins = api.controller.insets;
  await vscode.window.showTextDocument(vscode.Uri.file(p));
  await waitFor('the deleted line to be drawn and colored', () => ins.insetCount === 1 && ins.highlighted.length > 0, 20_000);
  const created = ins.created;
  const reports = ins.highlightReports;
  const darkRows = await hl.highlight(p, pf.baseHash, 'typescript', pf.baseLines, 0, 1);
  const wb = vscode.workspace.getConfiguration('workbench');
  await wb.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
  try {
    await waitFor('the light theme to apply', () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light);
    const light = await waitForAsync('recoloring with the light theme', async () => {
      const r = await hl.highlight(p, pf.baseHash, 'typescript', pf.baseLines, 0, 1);
      return r && JSON.stringify(r) !== JSON.stringify(darkRows) ? r : undefined;
    });
    log.push(`    dark ${JSON.stringify(darkRows![0])}\n    light ${JSON.stringify(light[0])} (${hl.themeName})`);
    await waitFor('the inset to receive the new colors', () => ins.highlightReports > reports, 20_000);
    assert.equal(ins.created, created, 'switching themes should not rebuild insets');
  } finally {
    await wb.update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
    await waitFor('the dark theme to return', () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark);
  }
});

test('grouping by round attributes each hunk to its round; Keep / Undo a round; view a round diff', async () => {
  const p = path.join(WS, 'rounds/r.ts');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'a\nb\nc\nd\ne\n');
  store.write({ path: p, existed: true, ts: Date.now(), sessions: ['it-session'] }, Buffer.from('a\nb\nc\nd\ne\n'));
  claudeRound(p, 'it-p1', 'Round one: change b to B', 'a\nB\nc\nd\ne\n');
  claudeRound(p, 'it-p2', 'Round two: change d to D\nmore details', 'a\nB\nc\nD\ne\n');
  const pf = await pending(p, 2);
  const svc = api.controller.roundService;
  await waitFor('the two hunks to be attributed to the two rounds', () => svc.roundOf(pf, pf.hunks[0].id) === 'it-p1' && svc.roundOf(pf, pf.hunks[1].id) === 'it-p2');

  await vscode.workspace.getConfiguration('ccReview').update('groupBy', 'round', vscode.ConfigurationTarget.Global);
  try {
    const tree = api.controller.tree!;
    await waitFor('the tree to switch to rounds', () => tree.mode === 'round');
    tree.refresh();
    const roots = tree.getChildren();
    const ids = roots.map((r) => (r.type === 'round' ? r.roundId : '?'));
    assert.ok(ids.indexOf('it-p2') >= 0 && ids.indexOf('it-p2') < ids.indexOf('it-p1'), `newer round first: ${ids.join(',')}`);
    assert.equal(tree.getTreeItem({ type: 'round', roundId: 'it-p2' }).label, 'Round two: change d to D');
    const files = tree.getChildren({ type: 'round', roundId: 'it-p1' });
    assert.deepEqual(files, [{ type: 'roundFile', roundId: 'it-p1', path: p }]);
    assert.equal(tree.getChildren(files[0]).length, 1);

    assert.equal(await api.controller.keepRound('it-p2'), 1);
    await pending(p, 1);
    assert.deepEqual(api.model.getFile(p)!.hunks[0].removed, ['b']);
    assert.equal(fs.readFileSync(baseFile(L, pathKey(p)), 'utf8'), 'a\nb\nc\nD\ne\n');

    await vscode.commands.executeCommand('ccReview.reviewRound', 'it-p1');
    await waitFor("the round's multi-file diff", () => vscode.window.tabGroups.activeTabGroup.activeTab?.label.startsWith('Claude Changes: '));
    await vscode.commands.executeCommand('ccReview.openRoundDiff', 'it-p1', p);
    await waitFor("the round's diff for the file", () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);

    assert.equal(await api.controller.undoRound('it-p1', true), 1);
    await resolved(p);
    assert.equal(fs.readFileSync(p, 'utf8'), 'a\nb\nc\nD\ne\n');
  } finally {
    await vscode.workspace.getConfiguration('ccReview').update('groupBy', undefined, vscode.ConfigurationTarget.Global);
  }
});

test('the Claude Changes list shows which message each change came from', async () => {
  const p = path.join(WS, 'rounds/lens.ts');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x\ny\n');
  store.write({ path: p, existed: true, ts: Date.now(), sessions: ['it-session'] }, Buffer.from('x\ny\n'));
  claudeRound(p, 'it-lens', 'Add a line to lens.ts', 'x\nnew\ny\n');
  const pf = await pending(p, 1);
  const tree = api.controller.tree!;
  await waitFor('the message in the change tooltip', () => {
    const tip = tree.getTreeItem({ type: 'hunk', path: p, hunkId: pf.hunks[0].id }).tooltip;
    return tip instanceof vscode.MarkdownString && tip.value.includes('From your message: Add a line to lens');
  });
});

test('when Claude finishes a turn, its pending changes are summarized in the order Claude wrote them', async () => {
  const edited = path.join(WS, 'turn/edited.ts');
  const created = path.join(WS, 'turn/NEW.md');
  fs.mkdirSync(path.dirname(edited), { recursive: true });
  fs.writeFileSync(edited, 'one\ntwo\n');
  store.write({ path: edited, existed: true, ts: Date.now(), sessions: ['it-turn'] }, Buffer.from('one\ntwo\n'));
  claudeRound(edited, 'it-turn-1', 'Edit a file and add a README', 'one\nTWO\n', 'it-turn');
  await sleep(20);
  store.write({ path: created, existed: false, ts: Date.now(), sessions: ['it-turn'] }, Buffer.alloc(0));
  claudeRound(created, 'it-turn-1', 'Edit a file and add a README', '# New\n', 'it-turn');
  await pending(edited, 1);
  await waitFor('the new file to be pending', () => api.model.getFile(created));

  appendJsonLine(L.events, { type: 'turn-end', session: 'it-turn', prompt: 'it-turn-1', ts: Date.now() });
  const s = await waitFor('the end-of-turn summary', () => api.controller.lastTurnSummary?.roundId === 'it-turn-1' && api.controller.lastTurnSummary);
  assert.deepEqual(s.files, [edited, created]);
  assert.equal(s.changes.get(edited)?.length, 1);
  assert.deepEqual(s.changes.get(created), []);
  // Without a prompt_id, the session's latest round is used
  assert.equal((await api.controller.turnSummary({ type: 'turn-end', session: 'it-turn', ts: Date.now() }))?.roundId, 'it-turn-1');

  // Review opens the first file at its first change
  await api.controller.reviewTurn(s);
  const ed = await waitFor('the first changed file to open', () => {
    const e = vscode.window.activeTextEditor;
    return e && e.document.uri.fsPath === edited && e;
  });
  assert.equal(ed.selection.active.line, 1);

  assert.equal(await api.controller.keepRound('it-turn-1'), 2);
  await resolved(edited);
  await resolved(created);
  // Nothing left to review: no summary
  assert.equal(await api.controller.turnSummary({ type: 'turn-end', session: 'it-turn', prompt: 'it-turn-1', ts: Date.now() }), undefined);
});

test('Ask Claude prefills the @-mention and original content and targets the session that introduced the hunk', async () => {
  const p = path.join(WS, 'askc/a.ts');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'one\ntwo\nthree\n');
  store.write({ path: p, existed: true, ts: Date.now(), sessions: ['other-session'] }, Buffer.from('one\ntwo\nthree\n'));
  claudeRound(p, 'it-ask', 'Change two', 'one\nTWO\nthree\n', 'sess-xyz');
  const pf = await pending(p, 1);
  await vscode.window.showTextDocument(vscode.Uri.file(p));
  const target = await waitFor('the ask target to be computed', () => (api.controller.roundService.roundOf(pf, pf.hunks[0].id) ? api.controller.askTarget([p, pf.hunks[0].id]) : undefined));
  log.push(`    prefill: ${JSON.stringify(target.prompt)}, session ${target.session}`);
  assert.equal(target.prompt, 'About your change at @askc/a.ts#2, which replaced:\n```typescript\ntwo\n```\n\n');
  assert.equal(target.session, 'sess-xyz');
});

test('the Ask Claude URI query is decoded exactly once after VS Code serializes and parses it', async () => {
  const tricky = 'About @src/a&b.ts#3-5 (naïve café ✓ 🚀): 100% = ok + "q"\n```ts\nconst x = a && b; // #tag ?y=1\n```\n';
  const uri = claudeOpenUri(tricky, 'abc-123');
  // VS Code opens the URI in its string form; the URL service parses it back before handing it to Claude Code's handler
  const received = vscode.Uri.parse(uri.toString());
  assert.equal(received.authority, 'anthropic.claude-code');
  assert.equal(received.path, '/open');
  for (const q of [new URLSearchParams(received.query), new URLSearchParams(uri.query)]) {
    assert.equal(q.get('prompt'), tricky);
    assert.equal(q.get('session'), 'abc-123');
  }
});

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<CcReviewApi>('local.cc-review');
  assert.ok(ext, 'extension local.cc-review not found');
  api = await ext.activate();
  let failed = 0;
  // CCR_ONLY=<regex> runs only the matching tests
  const only = process.env.CCR_ONLY ? new RegExp(process.env.CCR_ONLY) : undefined;
  const selected = tests.filter(([name]) => !only || only.test(name));
  for (const [name, fn] of selected) {
    const t0 = Date.now();
    try {
      await fn();
      log.push(`✓ ${name} (${Date.now() - t0}ms)`);
    } catch (e) {
      failed++;
      log.push(`✗ ${name}\n    ${(e instanceof Error ? (e.stack ?? e.message) : String(e)).split('\n').slice(0, 6).join('\n    ')}`);
    }
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
  const m = api.controller.insets.metrics;
  log.push(`phantom line insets reported ${m.length} measurements, e.g. ${m.slice(0, 3).map((x) => `${x.lines} lines -> ${x.insetPx}px`).join(', ') || 'none'}`);
  const summary = `${selected.length - failed}/${selected.length} passed`;
  fs.writeFileSync(process.env.CCR_RESULTS!, [...log, summary].join('\n') + '\n');
  if (failed) throw new Error(summary);
}
