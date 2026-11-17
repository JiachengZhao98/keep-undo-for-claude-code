// Performance scenarios: what you see and feel while reviewing. They only log measurements (see
// probe.ts) and run with CCR_PERF=1, which starts VS Code with a debug port.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as inspector from 'node:inspector';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { appendJsonLine } from '../../src/core/fsutil';
import { layoutOf } from '../../src/core/paths';
import type { PendingFile } from '../../src/core/model';
import type { CcReviewApi } from '../../src/extension';
import { formatFrames, Probe, watchEventLoop } from './probe';

export interface PerfContext {
  test(name: string, fn: () => Promise<void>): void;
  api(): CcReviewApi;
  log: string[];
  WS: string;
  claudeWrites(name: string, before: string | undefined, after: string): string;
  pending(p: string, hunks?: number): Promise<PendingFile>;
  waitFor<T>(what: string, fn: () => T | undefined | false | null, timeout?: number): Promise<T>;
  sleep(ms: number): Promise<unknown>;
}

const L = layoutOf();

/** A file of n lines and Claude's version of it: per 36 lines one rewritten line, one 3-line addition and one 2-line deletion */
export function sample(n = 360): { before: string; after: string; hunks: number } {
  const line = (i: number) => `const v${i} = compute(${i}, 'value ${i}');`;
  const before: string[] = [];
  const after: string[] = [];
  let hunks = 0;
  for (let i = 0; i < n; i++) {
    before.push(line(i));
    const m = i % 36;
    if (m === 6) {
      after.push(`const v${i} = compute(${i}, 'changed ${i}');`, `const w${i} = v${i} * 2;`);
      hunks++;
    } else if (m === 18) {
      after.push(line(i), `// added after ${i}`, `log(v${i});`, `check(v${i});`);
      hunks++;
    } else if (m === 30) {
      hunks++;
    } else if (m !== 31) {
      after.push(line(i));
    }
  }
  return { before: before.join('\n') + '\n', after: after.join('\n') + '\n', hunks };
}

const stats = (xs: readonly number[]): string => {
  if (xs.length === 0) return 'none';
  const s = [...xs].sort((a, b) => a - b);
  return `${s[0]}/${s[Math.floor(s.length / 2)]}/${s.at(-1)}ms (min/median/max of ${s.length})`;
};

/** Self time per function in this process (the extension host) while fn runs, largest first */
async function profileHost<T>(fn: () => Promise<T>): Promise<{ result: T; top: string[]; busyMs: number }> {
  const session = new inspector.Session();
  session.connect();
  const post = <R>(method: string, params?: object) =>
    new Promise<R>((resolve, reject) => session.post(method as 'Profiler.enable', params as never, (e: Error | null, r: unknown) => (e ? reject(e) : resolve(r as R))));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 250 });
  await post('Profiler.start');
  let result: T;
  let profile: inspector.Profiler.Profile;
  try {
    result = await fn();
  } finally {
    profile = (await post<{ profile: inspector.Profiler.Profile }>('Profiler.stop')).profile;
    session.disconnect();
  }
  const self = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) ?? 0) + (deltas[i] ?? 0));
  const byFn = new Map<string, number>();
  let busy = 0;
  for (const node of profile.nodes) {
    const us = self.get(node.id) ?? 0;
    const f = node.callFrame;
    // Idle time, and the profiler's own start and stop
    if (f.functionName === '(idle)' || f.url === 'node:inspector') continue;
    busy += us;
    const where = f.url ? `${path.basename(f.url)}:${f.lineNumber + 1}` : '';
    const key = `${f.functionName || '(anonymous)'} ${where}`.trim();
    byFn.set(key, (byFn.get(key) ?? 0) + us);
  }
  const top = [...byFn]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([k, us]) => `${(us / 1000).toFixed(1)}ms ${k}`);
  return { result: result!, top, busyMs: Math.round(busy / 1000) };
}

export function registerPerfTests(c: PerfContext): void {
  const { test, log, sleep, waitFor } = c;
  let probe: Probe | undefined;
  const getProbe = async () => (probe ??= await Probe.connect(Number(process.env.CCR_CDP_PORT), process.env.CCR_SHOTS || undefined));
  const ins = () => c.api().controller.insets;

  /** Wait until every inset created since `created0` has a running webview, and nothing new appears for a moment */
  const settled = async (created0: number, timeout = 30_000) => {
    await waitFor('insets to be created', () => ins().created > created0, timeout);
    let stableSince = 0;
    let last = -1;
    await waitFor(
      'insets to finish loading',
      () => {
        const now = Date.now();
        if (ins().loadingCount > 0 || ins().created !== last) {
          last = ins().created;
          stableSince = now;
          return false;
        }
        return now - stableSince > 400;
      },
      timeout,
    );
  };

  /** Run a scenario while recording the window's frames, the extension host's stalls and the insets it created */
  const measure = async (label: string, fn: () => Promise<void>) => {
    const p = await getProbe();
    const created0 = ins().created;
    const ready0 = ins().readyTimes.length;
    await p.start();
    const stall = watchEventLoop();
    const t0 = performance.now();
    await fn();
    const ms = Math.round(performance.now() - t0);
    const host = stall();
    const frames = await p.stop();
    log.push(
      `    ${label}: ${ms}ms; insets created ${ins().created - created0}, time to running ${stats(ins().readyTimes.slice(ready0))}`,
      `      window: ${formatFrames(frames)}`,
      `      extension host: longest stall ${host}ms; webviews alive ${await p.webviews()}`,
    );
  };

  const open = (p: string) => vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false });

  test('perf: opening a file with many changes, switching tabs, scrolling', async () => {
    const s = sample();
    const p = c.claudeWrites('perf/open.ts', s.before, s.after);
    await c.pending(p, s.hunks);
    const other = path.join(c.WS, 'perf/plain.ts');
    fs.writeFileSync(other, s.before);
    await open(other);
    await sleep(1500);

    let created0 = ins().created;
    await measure('open, until the insets in view run', async () => {
      await open(p);
      await waitFor('the insets in view to run', () => ins().created > created0 && ins().loadingCount === 0, 30_000);
    });
    await measure('then, until the insets around them run', () => settled(created0));
    await (await getProbe()).shot('open-settled');

    await measure('idle with insets (1.5 s)', () => sleep(1500) as Promise<void>);
    if (process.env.CCR_LONG_IDLE) {
      // Long enough for an inset to miss two pings in a row, were the pings to go unanswered
      const revived = ins().revived;
      const created = ins().created;
      await measure('idle for 23 s, insets in and out of view', () => sleep(23_000) as Promise<void>);
      log.push(`      insets taken for stopped meanwhile: ${ins().revived - revived}; created: ${ins().created - created}; window focused: ${vscode.window.state.focused}`);
    }

    await open(other);
    await sleep(800);
    created0 = ins().created;
    await measure('switch back to the tab, until the insets in view run', async () => {
      await open(p);
      await waitFor('the insets in view to run', () => ins().created > created0 && ins().loadingCount === 0, 30_000);
    });
    await settled(created0);
    const ed = vscode.window.activeTextEditor!;

    // Wheel input at one point over the editor, as when the mouse rests there: insets pass under the pointer
    const pr = await getProbe();
    const point = await pr.evaluate<{ x: number; y: number }>(
      `(() => { const r = document.querySelector('.part.editor .editor-group-container .monaco-editor .view-lines').getBoundingClientRect(); return { x: Math.round(r.left + 200), y: Math.round(r.top + 300) }; })()`,
    );
    const scrollTop = () =>
      pr.evaluate<number>(`(() => { const e = document.querySelector('.part.editor .editor-group-container .monaco-editor .lines-content'); return e ? -Math.round(parseFloat(e.style.top || '0')) : -1; })()`);
    const wheel = async (deltaY: number, steps: number) => {
      for (let i = 0; i < steps; i++) {
        await pr.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY });
        await sleep(16);
      }
    };
    ed.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    await vscode.commands.executeCommand('editorScroll', { to: 'up', by: 'line', value: 50 });
    await sleep(500);
    for (const pass of ['first time', 'again']) {
      const from = await scrollTop();
      let down = 0;
      await measure(`wheel 120 notches down, then 120 up (${pass})`, async () => {
        await wheel(40, 120);
        await sleep(400);
        down = (await scrollTop()) - from;
        await wheel(-40, 120);
        await sleep(600);
      });
      log.push(`      scrolled ${down}px down and ${down + from - (await scrollTop())}px back up; over plain text the same wheel scrolls 6000px`);
    }
    await pr.shot('after-scroll');
  });

  test('perf: what appears when, frame by frame, on a tab switch', async () => {
    const s = sample();
    const p = c.claudeWrites('perf/frames.ts', s.before, s.after);
    await c.pending(p, s.hunks);
    const other = path.join(c.WS, 'perf/frames-other.ts');
    fs.writeFileSync(other, s.before);
    const pr = await getProbe();
    let created0 = ins().created;
    await open(p);
    await settled(created0);
    await open(other);
    await sleep(800);
    // Each animation frame: whether the file's text, the green lines, the space of the insets, the preview of the deleted lines and the inset frames are on screen
    const record = `(() => new Promise((resolve) => {
      const t0 = performance.now();
      const out = [];
      const tick = () => {
        const ed = document.querySelector('.part.editor .editor-group-container.active .monaco-editor');
        const text = !!ed && ed.querySelector('.view-lines').textContent.includes('changed 6');
        const green = ed ? ed.querySelectorAll('.view-overlays [class*="ced-"]').length : 0;
        const zones = ed ? [...ed.querySelectorAll('.view-zones > div')].filter((z) => z.offsetHeight > 0).length : 0;
        let preview = 0;
        if (ed) for (const sp of ed.querySelectorAll('.view-lines span[class*="ced-"]')) if ((getComputedStyle(sp, '::before').content || '').length > 20) preview++;
        const frames = ed ? ed.querySelectorAll('.view-zones iframe').length : 0;
        out.push([Math.round(performance.now() - t0), text ? 1 : 0, green, zones, preview, frames].join(','));
        if (performance.now() - t0 < 1200) requestAnimationFrame(tick); else resolve(out.join(' '));
      };
      requestAnimationFrame(tick);
    }))()`;
    for (const round of [1, 2]) {
      created0 = ins().created;
      const ready0 = ins().readyTimes.length;
      const rec = pr.evaluate<string>(record);
      await sleep(30);
      const t0 = performance.now();
      await open(p);
      const shownAt = Math.round(performance.now() - t0);
      const frames = (await rec).split(' ').map((f) => f.split(',').map(Number));
      const first = (i: number, min = 1) => frames.find((f) => f[i] >= min)?.[0] ?? -1;
      log.push(
        `    switch ${round}: showTextDocument resolved after ${shownAt}ms; first frame (ms after recording began, ~30ms before the switch) with ` +
          `text ${first(1)}, green lines ${first(2)}, inset space ${first(3)}, preview ${first(4)}, inset frames ${first(5)}; ` +
          `insets created ${ins().created - created0}, their webviews running after ${stats(ins().readyTimes.slice(ready0))}`,
      );
      await settled(created0);
      await open(other);
      await sleep(800);
    }
    // Process count over repeated switches
    const procs = () => Number(execFileSync('sh', ['-c', 'ps -axo comm= | grep -c "Code Helper (Renderer)" || true'], { encoding: 'utf8' }).trim());
    const before = procs();
    for (let i = 0; i < 8; i++) {
      created0 = ins().created;
      await open(p);
      await settled(created0);
      await open(other);
      await sleep(300);
    }
    const after: string[] = [];
    for (const wait of [2, 10, 30, 60, 90]) {
      await sleep((wait - (after.length ? [2, 10, 30, 60, 90][after.length - 1] : 0)) * 1000);
      after.push(`${wait}s: ${procs()}`);
    }
    log.push(`    renderer processes before 8 more switches ${before}; after them ${after.join(', ')}; webviews alive ${await pr.webviews()}`);
    // Does an inset without content start a process?
    const p0 = procs();
    const ed = await open(other);
    const empty = Array.from({ length: 10 }, (_, i) => vscode.window.createWebviewTextEditorInset(ed, i * 3, 1, { enableScripts: false }));
    await sleep(3000);
    log.push(`    10 insets without content: renderer processes ${p0} -> ${procs()}`);
    empty.forEach((e) => e.dispose());
  });

  test('perf: screenshots of the preview with wrapped lines', async () => {
    if (!process.env.CCR_SHOTS) return;
    const long = (i: number) => `Paragraph ${i}: ` + 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua '.repeat(3);
    const before = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? long(i) : `- short item ${i}`));
    // Delete two lines after a long line, and one long line after a short one
    const after = before.filter((_, i) => i !== 4 && i !== 5 && i !== 9);
    const p = c.claudeWrites('perf/wrapped.md', before.join('\n') + '\n', after.join('\n') + '\n');
    await c.pending(p, 2);
    const other = path.join(c.WS, 'perf/plain3.ts');
    fs.writeFileSync(other, 'x\n');
    await open(other);
    await sleep(1000);
    const pr = await getProbe();
    const t0 = performance.now();
    void open(p);
    for (const at of [90, 160, 900]) {
      await sleep(Math.max(0, at - (performance.now() - t0)));
      await pr.shot(`wrapped-${Math.round(performance.now() - t0)}ms`);
    }
  });

  test('perf: screenshots while a file with many changes opens', async () => {
    if (!process.env.CCR_SHOTS) return;
    const s = sample();
    const p = c.claudeWrites('perf/shots.ts', s.before, s.after);
    await c.pending(p, s.hunks);
    const other = path.join(c.WS, 'perf/plain2.ts');
    fs.writeFileSync(other, s.before);
    await open(other);
    await sleep(1500);
    const pr = await getProbe();
    const t0 = performance.now();
    void open(p);
    for (const at of [60, 120, 200, 300, 500, 800, 1500]) {
      await sleep(Math.max(0, at - (performance.now() - t0)));
      await pr.shot(`open-${Math.round(performance.now() - t0)}ms`);
    }
  });

  test('perf: Claude keeps editing a file that is open', async () => {
    const s = sample();
    const p = c.claudeWrites('perf/live.ts', s.before, s.after);
    await c.pending(p, s.hunks);
    let created0 = ins().created;
    const ed = await open(p);
    await settled(created0);
    await sleep(500);
    const write = (text: string) => {
      fs.writeFileSync(p, text);
      appendJsonLine(L.events, { type: 'claude-write', path: p, tool: 'Edit', session: 'it-session', ts: Date.now() });
    };
    const caughtUp = (text: string) => waitFor('the model to follow the write', () => ed.document.getText() === text && c.api().model.getFile(p)?.docVersion === ed.document.version);

    // 1. Four edits to lines Claude had not touched, in view
    let lines = s.after.split('\n');
    created0 = ins().created;
    await measure('4 edits, each a new change in view', async () => {
      for (const at of [2, 10, 14, 24]) {
        lines = lines.map((l, i) => (i === at ? l.replace('compute', 'recompute') : l));
        const text = lines.join('\n');
        write(text);
        await caughtUp(text);
        await sleep(350);
      }
      await settled(created0 - 1);
    });

    // 2. Four more edits to the same change (Claude refining what it just wrote)
    created0 = ins().created;
    await measure('4 edits to one existing change', async () => {
      for (let k = 1; k <= 4; k++) {
        lines = lines.map((l, i) => (i === 2 ? l.replace(/recompute\d*/, `recompute${k}`) : l));
        const text = lines.join('\n');
        write(text);
        await caughtUp(text);
        await sleep(350);
      }
      await sleep(600);
    });
    await (await getProbe()).shot('live-edits');
  });

  test('perf: typing inside a change, then Keep and Undo', async () => {
    const s = sample();
    const p = c.claudeWrites('perf/type.ts', s.before, s.after);
    const pf = await c.pending(p, s.hunks);
    const created0 = ins().created;
    const ed = await open(p);
    await settled(created0);
    await sleep(500);
    // The first change rewrote line 7 into lines 7-8
    const h = pf.hunks[0];
    await measure('typing 10 characters inside a change', async () => {
      for (let k = 0; k < 10; k++) {
        await ed.edit((eb) => eb.insert(new vscode.Position(h.curStart, 6), 'x'));
        await sleep(260);
      }
      await sleep(700);
    });
    await ed.document.save();
    await sleep(300);

    const cur = () => c.api().model.getFile(p)!;
    await measure('Keep the first change', async () => {
      const n = cur().hunks.length;
      await vscode.commands.executeCommand('ccReview.keepHunk', p, cur().hunks[0].id);
      await waitFor('one change fewer', () => cur().hunks.length === n - 1);
      await sleep(700);
    });
    await measure('Undo the next change', async () => {
      const n = cur().hunks.length;
      await vscode.commands.executeCommand('ccReview.undoHunk', p, cur().hunks[0].id);
      await waitFor('one change fewer', () => cur().hunks.length === n - 1);
      await sleep(700);
    });
    await (await getProbe()).shot('after-keep-undo');
  });

  test('perf: many pending files, some of them large', async () => {
    // Like a real project after a long session: 60 new files, a 5 MB and a 400 KB JSON, and a few edited files
    const small = Array.from({ length: 80 }, (_, i) => `def f${i}(x):\n    return x + ${i}\n`).join('\n');
    for (let i = 0; i < 60; i++) c.claudeWrites(`perf/many/new${i}.py`, undefined, small);
    const row = (i: number) => `    {"id": ${i}, "question": "what is item ${i}", "answer": "item ${i} is a thing", "score": ${i % 7}},`;
    const json = (rows: number) => '[\n' + Array.from({ length: rows }, (_, i) => row(i)).join('\n') + '\n]\n';
    c.claudeWrites('perf/many/results-big.json', undefined, json(62_000));
    c.claudeWrites('perf/many/results.json', undefined, json(4_600));
    const s = sample();
    const p = c.claudeWrites('perf/many/edited.ts', s.before, s.after);
    await c.pending(p, s.hunks);
    await waitFor('all files to be pending', () => c.api().model.getFiles().length >= 63, 30_000);
    const created0 = ins().created;
    const ed = await open(p);
    await settled(created0);
    await sleep(800);
    const size = (f: string) => `${(fs.statSync(path.join(c.WS, f)).size / 1024 / 1024).toFixed(1)} MB`;
    log.push(`    ${c.api().model.getFiles().length} pending files; results-big.json ${size('perf/many/results-big.json')}, results.json ${size('perf/many/results.json')}`);

    const profiled = async (label: string, fn: () => Promise<void>) => {
      let stalled = 0;
      const t0 = performance.now();
      const { top, busyMs } = await profileHost(async () => {
        // Inside the profile, so that stopping the profiler (over 100 ms) does not count as a stall
        const stall = watchEventLoop();
        await fn();
        stalled = stall();
      });
      log.push(`    ${label}: ${Math.round(performance.now() - t0)}ms, extension host busy ${busyMs}ms, longest stall ${stalled}ms`, ...top.slice(0, 6).map((t) => `        ${t}`));
    };

    await profiled('idle for 7 s (two disk polls)', () => sleep(7000) as Promise<void>);
    await profiled('one write by Claude to the open file', async () => {
      const text = ed.document.getText().replace('compute(3,', 'recompute(3,');
      fs.writeFileSync(p, text);
      appendJsonLine(L.events, { type: 'claude-write', path: p, tool: 'Edit', session: 'it-session', ts: Date.now() });
      await waitFor('the model to follow the write', () => ed.document.getText() === text && c.api().model.getFile(p)?.docVersion === ed.document.version);
      await sleep(600);
    });
    await profiled('typing 10 characters in the open file', async () => {
      for (let k = 0; k < 10; k++) {
        await ed.edit((eb) => eb.insert(new vscode.Position(0, 6), 'x'));
        await sleep(200);
      }
      await sleep(500);
    });
    await ed.document.save();
    await profiled('moving the cursor 30 lines (selection changes only)', async () => {
      for (let k = 0; k < 30; k++) {
        ed.selection = new vscode.Selection(k, 0, k, 0);
        await sleep(30);
      }
    });
    await profiled('Refresh (recompute every pending file)', async () => {
      await vscode.commands.executeCommand('ccReview.refresh');
      await sleep(300);
    });
    await profiled('opening the Claude Changes view', async () => {
      await vscode.commands.executeCommand('ccReview.changes.focus');
      await sleep(1200);
    });
    await profiled('one write while the view is open', async () => {
      const text = ed.document.getText().replace('compute(4,', 'recompute(4,');
      fs.writeFileSync(p, text);
      appendJsonLine(L.events, { type: 'claude-write', path: p, tool: 'Edit', session: 'it-session', ts: Date.now() });
      await waitFor('the model to follow the write', () => ed.document.getText() === text && c.api().model.getFile(p)?.docVersion === ed.document.version);
      await sleep(800);
    });
    await profiled('opening the 5 MB pending file', async () => {
      await open(path.join(c.WS, 'perf/many/results-big.json'));
      await sleep(2500);
    });
    await profiled('opening the 400 KB pending file', async () => {
      await open(path.join(c.WS, 'perf/many/results.json'));
      await sleep(2500);
    });
    await (await getProbe()).shot('many-files');
    await vscode.commands.executeCommand('workbench.view.explorer');
  });
}
