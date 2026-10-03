// activate: wires up the modules and registers commands.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OwnEdits, PathIndex, Scope, VsEditApplier, VsTextSource } from './adapters';
import type { Hunk } from './core/diff';
import { StoreWatcher, type WriteEvent } from './core/events';
import { writeAtomic } from './core/fsutil';
import { ReviewModel, type OpResult, type PendingFile } from './core/model';
import { layoutOf, metaFile, type Layout } from './core/paths';
import { promptTitle, RoundStore } from './core/rounds';
import { Store } from './core/store';
import { plural, splitLines } from './core/text';
import { hooksInstalled, installHooks, PREVIEW_SCHEME, PreviewProvider, uninstallHooks } from './install/hooks';
import { buildAskPrompt, claudeInstalled, openClaude } from './ui/askClaude';
import { HunkCodeLens } from './ui/codeLens';
import { DecorationPainter } from './ui/decorations';
import { PendingBadges } from './ui/fileBadges';
import { SyntaxHighlighter } from './ui/highlight';
import { BASELINE_SCHEME, BaselineProvider, openFileDiff, openMultiDiff } from './ui/multiDiff';
import { PhantomInsets, type InsetAction } from './ui/phantomInsets';
import { OTHER_ROUND, ROUND_SCHEME, RoundService } from './ui/rounds';
import { ReviewStatusBar } from './ui/statusBar';
import { ChangesTree, type GroupMode, type ReviewNode } from './ui/tree';

/** Used by the integration tests */
export interface CcReviewApi {
  model: ReviewModel;
  controller: Controller;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<CcReviewApi> {
  const controller = new Controller(ctx);
  ctx.subscriptions.push(controller);
  await controller.start();
  return { model: controller.model, controller };
}

export function deactivate(): void {
  // Everything is disposed through ctx.subscriptions
}

const cfg = () => vscode.workspace.getConfiguration('ccReview');

const UNDO_HINT = 'In text files you can undo this with ⌘Z in the editor.';

const NODE_TYPES = new Set(['file', 'hunk', 'round', 'roundFile']);

function isNode(x: unknown): x is ReviewNode {
  return !!x && typeof x === 'object' && NODE_TYPES.has((x as { type?: string }).type ?? '');
}

/** The hunk under the cursor; otherwise the nearest hunk within 2 lines */
export function hunkAtLine(hunks: readonly Hunk[], line: number): Hunk | undefined {
  let best: Hunk | undefined;
  let bestDist = Infinity;
  for (const h of hunks) {
    const lo = h.added ? h.curStart : h.curStart - 1;
    const hi = h.added ? h.curStart + h.added - 1 : h.curStart;
    const dist = line < lo ? lo - line : line > hi ? line - hi : 0;
    if (dist < bestDist) {
      best = h;
      bestDist = dist;
    }
  }
  return bestDist <= 2 ? best : undefined;
}

export class Controller implements vscode.Disposable {
  readonly L: Layout = layoutOf();
  readonly store = new Store(this.L);
  readonly idx = new PathIndex();
  readonly own = new OwnEdits();
  readonly model: ReviewModel;
  readonly scope: Scope;
  readonly out = vscode.window.createOutputChannel('Claude Review', { log: true });
  readonly insets: PhantomInsets;
  readonly rounds = new RoundStore(this.L);
  readonly roundService = new RoundService(this.rounds);
  readonly highlighter: SyntaxHighlighter;
  private askEnabled = claudeInstalled();
  private readonly painter: DecorationPainter;
  private readonly codeLens: HunkCodeLens;
  private readonly statusBar = new ReviewStatusBar();
  private readonly badges: PendingBadges;
  private readonly baselines: BaselineProvider;
  private readonly preview = new PreviewProvider();
  tree: ChangesTree | undefined;
  private watcher: StoreWatcher | undefined;
  /** Text snapshots of pending files open in editors: auto-keep needs the content before your edit */
  private readonly shadows = new Map<string, string>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly userEditQueue = new Map<string, Promise<void>>();
  private readonly rangeTimers = new Map<vscode.TextEditor, NodeJS.Timeout>();
  private uiTimer: NodeJS.Timeout | undefined;
  private hooksOk = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.model = new ReviewModel(this.store, new VsTextSource(this.idx), new VsEditApplier(this.idx, this.own), {
      maxBytes: (cfg().get<number>('maxFileSizeKB') ?? 1024) * 1024,
    });
    this.scope = new Scope(this.idx);
    this.painter = new DecorationPainter(vscode.Uri.joinPath(ctx.extensionUri, 'media'));
    this.insets = new PhantomInsets(ctx.extension, (a) => void this.onInsetAction(a), (m) => this.out.info(m));
    this.highlighter = new SyntaxHighlighter(vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'onig.wasm').fsPath, (m) => this.out.info(m));
    this.insets.highlighting = this.highlighter;
    this.insets.askEnabled = this.askEnabled;
    this.codeLens = new HunkCodeLens(this.model, this.idx, {
      roundTitle: (pf, hunkId) => this.roundService.title(this.roundService.roundOf(pf, hunkId)),
      askEnabled: () => this.askEnabled,
    });
    this.badges = new PendingBadges(this.model, this.idx);
    this.baselines = new BaselineProvider(this.store, this.idx);
  }

  async start(): Promise<void> {
    this.store.ensure();
    this.installHookScript();
    const { removedBaselines } = this.store.gc();
    if (removedBaselines.length) this.out.info(`Removed ${removedBaselines.length} baselines older than 30 days`);
    const removedRounds = this.rounds.gc((key) => fs.existsSync(metaFile(this.L, key)));
    if (removedRounds) this.out.info(`Removed ${removedRounds} expired round snapshots`);

    const d = this.disposables;
    d.push(
      this.out,
      this.painter,
      this.insets,
      this.codeLens,
      this.statusBar,
      this.badges,
      this.baselines,
      this.highlighter,
      vscode.workspace.registerTextDocumentContentProvider(ROUND_SCHEME, this.roundService),
      // Theme changed: recolor phantom lines with the new theme
      this.highlighter.onDidChangeTheme(() => {
        this.insets.clearAll();
        this.renderAll();
      }),
      // Claude Code extension installed or removed: show or hide the "Ask Claude" buttons
      vscode.extensions.onDidChange(() => {
        const ask = claudeInstalled();
        if (ask === this.askEnabled) return;
        this.askEnabled = this.insets.askEnabled = ask;
        void vscode.commands.executeCommand('setContext', 'ccReview.claudeInstalled', ask);
        this.insets.clearAll();
        this.renderAll();
        this.codeLens.refresh();
      }),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.codeLens),
      vscode.window.registerFileDecorationProvider(this.badges),
      vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, this.baselines),
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, this.preview),
      this.model.onDidChange((paths) => this.onModelChanged(paths)),
      this.insets.onDidBecomeUnavailable(() => this.renderAll()),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChanged(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDocLifecycle(doc, 0)),
      vscode.workspace.onDidOpenTextDocument((doc) => {
        const p = this.idx.ofUri(doc.uri);
        if (p && this.model.getFile(p)) this.shadows.set(p, doc.getText());
        this.onDocLifecycle(doc, 0);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const p = this.idx.ofUri(doc.uri);
        if (p) {
          this.shadows.delete(p);
          this.own.forget(p);
        }
        this.onDocLifecycle(doc, 0);
      }),
      vscode.window.onDidChangeVisibleTextEditors((eds) => {
        this.insets.retainEditors(eds);
        this.renderAll();
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.onVisibleRangesChanged(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKeys()),
      vscode.window.onDidChangeTextEditorOptions((e) => this.renderEditor(e.textEditor, true)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.scope.update();
        this.scheduleUi();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfigChanged(e)),
    );
    this.registerCommands();
    this.tree = new ChangesTree(this.model, () => this.scopeFiles(), this.roundService);
    d.push(this.tree);
    this.applyGroupMode();
    void vscode.commands.executeCommand('setContext', 'ccReview.claudeInstalled', this.askEnabled);

    this.watcher = new StoreWatcher(this.L, {
      onEvents: (evs) => this.onEvents(evs),
      onBaselinesChanged: () => void this.model.syncWithStore(),
    });
    this.watcher.start();
    await this.model.syncWithStore();

    // Pending files not open in an editor: poll the disk to catch external changes such as git checkout or rewind
    let ticks = 0;
    const poll = setInterval(() => {
      void this.model.checkDisk();
      if (++ticks % 5 === 0) this.checkHooks();
    }, 3000);
    d.push({ dispose: () => clearInterval(poll) });

    this.checkHooks();
    this.renderAll();
    this.scheduleUi();
    void this.maybeOfferInstall();
    this.out.info(`Started: data directory ${this.L.root}; phantom lines ${this.insets.isAvailable ? 'use editorInsets' : 'use the hover fallback'}`);
  }

  // ---------- Initialization ----------

  /** Copy dist/hook.js to ~/.cc-review/hook.js: a fixed path that does not change between extension versions */
  private installHookScript(): void {
    try {
      const src = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'hook.js').fsPath;
      const data = fs.readFileSync(src);
      let current: Buffer | undefined;
      try {
        current = fs.readFileSync(this.L.hookScript);
      } catch {
        // First run
      }
      if (!current || !current.equals(data)) {
        writeAtomic(this.L.hookScript, data);
        this.out.info(`Updated ${this.L.hookScript}`);
      }
    } catch (e) {
      this.out.error(`Failed to copy hook.js: ${String(e)}`);
    }
  }

  private checkHooks(): void {
    const ok = hooksInstalled(this.L);
    if (ok !== this.hooksOk) {
      this.hooksOk = ok;
      this.scheduleUi();
    }
    void vscode.commands.executeCommand('setContext', 'ccReview.hooksInstalled', ok);
  }

  private async maybeOfferInstall(): Promise<void> {
    if (this.hooksOk || this.ctx.globalState.get<boolean>('ccReview.dontAskInstall')) return;
    const pick = await vscode.window.showInformationMessage(
      'Claude Review needs to install hooks in ~/.claude/settings.json to record which files Claude changes.',
      'Review and Install',
      "Don't Ask Again",
    );
    if (pick === 'Review and Install') await this.runInstall();
    else if (pick === "Don't Ask Again") await this.ctx.globalState.update('ccReview.dontAskInstall', true);
  }

  private async runInstall(): Promise<void> {
    await installHooks(this.L, this.preview);
    this.checkHooks();
  }

  // ---------- Events ----------

  private onEvents(events: WriteEvent[]): void {
    // New writes may belong to a new round: recompute the round index and hunk attribution
    this.roundService.invalidate();
    for (const p of this.model.noteEvents(events)) this.scheduleRefresh(p, 0);
    this.scheduleUi();
  }

  private onModelChanged(paths: string[]): void {
    for (const p of paths) {
      if (this.model.getFile(p)) {
        if (!this.shadows.has(p)) {
          const doc = this.idx.findDoc(p);
          if (doc) this.shadows.set(p, doc.getText());
        }
      } else if (!this.own.hasHistory(p)) {
        // Keep the snapshot of a file whose last hunk was just undone: you may press ⌘Z right away
        this.shadows.delete(p);
      }
    }
    this.baselines.changed(paths);
    this.scheduleUi();
  }

  private onDocChanged(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (doc.uri.scheme !== 'file' || e.contentChanges.length === 0) return;
    this.insets.onDocumentChanged(e);
    const p = this.idx.ofUri(doc.uri)!;
    if (!this.model.getFile(p) && !this.model.tracks(p) && !this.own.hasHistory(p)) return;
    // Without a snapshot, if the model was computed on the previous version, its curLines are the pre-edit content
    const pf = this.model.getFile(p);
    const prev = this.shadows.get(p) ?? (pf && pf.docVersion === doc.version - 1 ? pf.curLines.join(pf.curEol) : undefined);
    const next = doc.getText();
    this.shadows.set(p, next);
    if (prev !== undefined) {
      const own = this.own.match(p, prev, next, e.reason);
      if (own === 'undo' && !this.model.tracks(p)) {
        // The last Undo was undone: its baseline was deleted when the file matched it, so rebuild it from the post-undo content
        if (this.model.restoreBaseline(p, prev)) this.out.info(`Undo was undone, ${p} is pending again`);
      } else if (!own && cfg().get<boolean>('autoKeepUserEdits', true)) {
        this.queueUserEdit(p, e, prev, next);
      }
    }
    this.scheduleRefresh(p);
  }

  /**
   * Did you make this change in the editor, or did the editor reload the file after it changed on
   * disk (Claude writing, git checkout)? Undo / redo, or an already-dirty document, is always your
   * edit. Otherwise wait briefly and check whether the document became dirty: on the first edit the
   * change event arrives before isDirty updates, while a reload from disk never makes the document
   * dirty. Comparing against the disk does not work: when Claude writes twice in a row, the disk may
   * already hold the next write. Decisions for one file are queued so merges into the baseline keep
   * the order of the edits.
   */
  private queueUserEdit(p: string, e: vscode.TextDocumentChangeEvent, prev: string, next: string): void {
    const doc = e.document;
    const certain = e.reason !== undefined || doc.isDirty;
    const run = async () => {
      if (!certain) {
        await new Promise((r) => setTimeout(r, 50));
        if (!doc.isDirty || doc.isClosed) return;
      }
      if (this.model.applyUserEdit(p, splitLines(prev), splitLines(next))) this.out.debug(`Auto-kept your edit in ${p}`);
    };
    const chain = (this.userEditQueue.get(p) ?? Promise.resolve()).then(run, run);
    this.userEditQueue.set(p, chain);
    void chain.finally(() => {
      if (this.userEditQueue.get(p) === chain) this.userEditQueue.delete(p);
    });
  }

  private onDocLifecycle(doc: vscode.TextDocument, delay: number): void {
    const p = this.idx.ofUri(doc.uri);
    if (p && (this.model.getFile(p) || this.model.tracks(p))) this.scheduleRefresh(p, delay);
  }

  private onVisibleRangesChanged(editor: vscode.TextEditor): void {
    clearTimeout(this.rangeTimers.get(editor));
    this.rangeTimers.set(
      editor,
      setTimeout(() => {
        this.rangeTimers.delete(editor);
        this.renderEditor(editor);
      }, 100),
    );
  }

  private onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration('ccReview.maxFileSizeKB')) {
      this.model.opts.maxBytes = (cfg().get<number>('maxFileSizeKB') ?? 1024) * 1024;
      for (const f of this.model.getFiles()) this.scheduleRefresh(f.path, 0);
    }
    if (e.affectsConfiguration('ccReview.showFilesOutsideWorkspace')) this.scheduleUi();
    if (e.affectsConfiguration('ccReview.groupBy')) this.applyGroupMode();
    if (e.affectsConfiguration('ccReview.trackBash') && this.hooksOk) {
      void vscode.window
        .showInformationMessage('ccReview.trackBash changed. Reinstall the hooks for it to take effect.', 'Reinstall')
        .then((pick) => (pick ? this.runInstall() : undefined));
    }
    const fontChanged = ['editor.fontFamily', 'editor.fontSize', 'editor.lineHeight', 'editor.letterSpacing', 'editor.fontLigatures', 'editor.fontWeight'].some(
      (k) => e.affectsConfiguration(k),
    );
    if (fontChanged || e.affectsConfiguration('ccReview')) {
      for (const ed of vscode.window.visibleTextEditors) this.insets.clear(ed);
      this.renderAll();
      this.codeLens.refresh();
    }
  }

  private scheduleRefresh(p: string, delay = 150): void {
    clearTimeout(this.refreshTimers.get(p));
    this.refreshTimers.set(
      p,
      setTimeout(() => {
        this.refreshTimers.delete(p);
        this.model.refresh(p).catch((e) => this.out.error(`Failed to refresh ${p}: ${String(e)}`));
      }, delay),
    );
  }

  private scheduleUi(): void {
    clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => {
      this.renderAll();
      this.codeLens.refresh();
      this.tree?.refresh();
      this.badges.refresh();
      this.statusBar.update(this.scopeFiles(), this.hooksOk);
      this.updateContextKeys();
    }, 30);
  }

  // ---------- Rendering ----------

  scopeFiles(): PendingFile[] {
    return this.model.getFiles().filter((f) => this.scope.includes(f.path));
  }

  private renderAll(): void {
    for (const ed of vscode.window.visibleTextEditors) this.renderEditor(ed);
  }

  private renderEditor(ed: vscode.TextEditor, force = false): void {
    if (ed.document.uri.scheme !== 'file') return;
    const p = this.idx.ofUri(ed.document.uri)!;
    const pf = this.model.getFile(p);
    // The model has not caught up with the latest edit (debouncing): keep the decorations VS Code already shifted, repaint after recomputing
    if (!force && pf && pf.docVersion !== undefined && pf.docVersion !== ed.document.version) return;
    const useInsets = this.insets.isAvailable && cfg().get<string>('phantomLines') !== 'hover';
    this.painter.paint(ed, pf, !useInsets, this.askEnabled);
    if (useInsets) this.insets.update(ed, pf, cfg().get<number>('maxInsetsPerEditor') ?? 20);
    else this.insets.clear(ed);
  }

  private updateContextKeys(): void {
    const ed = vscode.window.activeTextEditor;
    const p = ed && ed.document.uri.scheme === 'file' ? this.idx.ofUri(ed.document.uri) : undefined;
    const active = !!(p && this.model.getFile(p));
    void vscode.commands.executeCommand('setContext', 'ccReview.activeFileHasPending', active);
    void vscode.commands.executeCommand('setContext', 'ccReview.hasPending', active || this.scopeFiles().length > 0);
  }

  // ---------- Commands ----------

  private registerCommands(): void {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
      this.disposables.push(
        vscode.commands.registerCommand(id, async (...args: unknown[]) => {
          try {
            return await fn(...args);
          } catch (e) {
            this.out.error(`${id} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
            void vscode.window.showErrorMessage(`Claude Review: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );
    reg('ccReview.keepHunk', (...a) => this.keepHunk(a));
    reg('ccReview.undoHunk', (...a) => this.undoHunk(a));
    reg('ccReview.nextHunk', () => this.navigate(1));
    reg('ccReview.prevHunk', () => this.navigate(-1));
    reg('ccReview.keepFile', (a) => this.keepFile(a));
    reg('ccReview.undoFile', (a) => this.undoFile(a));
    reg('ccReview.keepAll', () => this.keepAll());
    reg('ccReview.undoAll', () => this.undoAll());
    reg('ccReview.reviewAll', () => openMultiDiff(this.scopeFiles(), this.idx));
    reg('ccReview.openDiff', (a) => {
      const f = this.fileFromArg(a);
      return f ? openFileDiff(f, this.idx) : undefined;
    });
    reg('ccReview.openFile', (a) => this.openFile(a));
    reg('ccReview.revealHunk', (p, id) => (typeof p === 'string' && typeof id === 'string' ? this.revealHunk(p, id) : undefined));
    reg('ccReview.refresh', () => this.refreshAll());
    reg('ccReview.installHooks', () => this.runInstall());
    reg('ccReview.uninstallHooks', async () => {
      await uninstallHooks(this.L, this.preview);
      this.checkHooks();
    });
    reg('ccReview.clearAll', () => this.clearAll());
    reg('ccReview.dumpState', () => this.dumpState());
    reg('ccReview.askClaude', (...a) => this.askClaude(a));
    reg('ccReview.groupByRound', () => cfg().update('groupBy', 'round', vscode.ConfigurationTarget.Global));
    reg('ccReview.groupByFile', () => cfg().update('groupBy', 'file', vscode.ConfigurationTarget.Global));
    reg('ccReview.keepRound', (a) => this.keepRound(a));
    reg('ccReview.undoRound', (a) => this.undoRound(a));
    reg('ccReview.reviewRound', (a) => {
      const t = this.roundTarget(a);
      return t?.roundId ? this.roundService.openRoundDiff(t.roundId) : undefined;
    });
    reg('ccReview.openRoundDiff', (roundId, file) =>
      typeof roundId === 'string' && typeof file === 'string' ? this.roundService.openFileDiff(roundId, file) : undefined,
    );
    reg('ccReview.showRounds', () => this.roundService.pickRound((f) => this.scope.includes(f)));
  }

  private applyGroupMode(): void {
    const mode: GroupMode = cfg().get<string>('groupBy') === 'round' ? 'round' : 'file';
    void vscode.commands.executeCommand('setContext', 'ccReview.groupMode', mode);
    if (!this.tree || this.tree.mode === mode) return;
    this.tree.mode = mode;
    this.tree.refresh();
  }

  // ---------- Rounds ----------

  private roundTarget(a: unknown): { roundId: string; file?: string } | undefined {
    if (isNode(a) && a.type === 'round') return { roundId: a.roundId };
    if (isNode(a) && a.type === 'roundFile') return { roundId: a.roundId, file: a.path };
    return typeof a === 'string' ? { roundId: a } : undefined;
  }

  /** "3 changes from "Fix the login bug"", or "3 other changes" for unattributed ones */
  private roundChanges(roundId: string, n: number): string {
    return roundId === OTHER_ROUND ? plural(n, 'other change') : `${plural(n, 'change')} from "${promptTitle(this.roundService.meta(roundId))}"`;
  }

  /** Keep every pending hunk of a round (or of one file within a round) */
  async keepRound(a: unknown): Promise<number> {
    const t = this.roundTarget(a);
    if (!t || !this.tree) return 0;
    let n = 0;
    for (const [p, ids] of this.tree.roundHunks(t.roundId, t.file)) {
      const f = this.model.getFile(p);
      if (!f) continue;
      const r = ids.length && f.kind === 'text' && f.existed && !f.missing ? await this.model.keepHunks(p, ids) : await this.model.keepFile(p);
      if (r === 'ok') n += Math.max(ids.length, 1);
      else this.report(r);
    }
    void vscode.window.setStatusBarMessage(`Kept ${this.roundChanges(t.roundId, n)}`, 3000);
    return n;
  }

  /** Undo every pending hunk of a round (or of one file within a round); hunks of one file become one edit, so a single ⌘Z restores them */
  async undoRound(a: unknown, confirmed = false): Promise<number> {
    const t = this.roundTarget(a);
    if (!t || !this.tree) return 0;
    const targets = [...this.tree.roundHunks(t.roundId, t.file)].filter(([p]) => this.model.getFile(p));
    if (targets.length === 0) return 0;
    if (!confirmed) {
      const total = targets.reduce((n, [, ids]) => n + Math.max(ids.length, 1), 0);
      const created = targets.filter(([p]) => !this.model.getFile(p)!.existed).length;
      const detail = [`Affects ${plural(targets.length, 'file')}.`, created ? `${plural(created, 'new file')} created by Claude will be moved to the Trash.` : '', UNDO_HINT]
        .filter(Boolean)
        .join(' ');
      const pick = await vscode.window.showWarningMessage(`Undo ${this.roundChanges(t.roundId, total)}?`, { modal: true, detail }, 'Undo');
      if (pick !== 'Undo') return 0;
    }
    let n = 0;
    for (const [p, ids] of targets) {
      const f = this.model.getFile(p)!;
      const r = ids.length && f.kind === 'text' && f.existed && !f.missing ? await this.model.undoHunks(p, ids) : await this.model.undoFile(p);
      if (r === 'ok') n += Math.max(ids.length, 1);
      else this.report(r);
    }
    return n;
  }

  // ---------- Ask Claude ----------

  /** What to ask Claude: the hunk's location and original content, plus the session that made the change */
  askTarget(args: unknown[]): { prompt: string; session: string | undefined } | undefined {
    const t = this.resolveHunk(args);
    const pf = t && this.model.getFile(t.path);
    const h = t && pf?.hunks.find((x) => x.id === t.hunkId);
    if (!t || !pf || !h) return undefined;
    const uri = this.idx.uriFor(t.path);
    const prompt = buildAskPrompt(pf, h, vscode.workspace.asRelativePath(uri), this.idx.findDoc(t.path)?.languageId ?? '');
    // Prefer the session of the round that introduced the hunk, then the session that last wrote the file
    const roundId = this.roundService.roundOf(pf, h.id);
    const session = (roundId && this.roundService.meta(roundId)?.session) || this.model.latestSession(t.path);
    return { prompt, session };
  }

  async askClaude(args: unknown[]): Promise<void> {
    const target = this.askTarget(args);
    if (!target) {
      void vscode.window.showInformationMessage('No Claude change near the cursor.');
      return;
    }
    if (!this.askEnabled) {
      void vscode.window.showWarningMessage('Install the Claude Code extension (anthropic.claude-code) first.');
      return;
    }
    const via = await openClaude(target.prompt, target.session);
    this.out.debug(`Ask Claude (${via}): session=${target.session ?? 'new conversation'}`);
  }

  private resolveHunk(args: unknown[]): { path: string; hunkId: string } | undefined {
    const [a, b] = args;
    if (typeof a === 'string' && typeof b === 'string') return { path: a, hunkId: b };
    if (isNode(a) && a.type === 'hunk') return { path: a.path, hunkId: a.hunkId };
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return undefined;
    const p = this.idx.ofUri(ed.document.uri)!;
    const h = hunkAtLine(this.model.getFile(p)?.hunks ?? [], ed.selection.active.line);
    return h ? { path: p, hunkId: h.id } : undefined;
  }

  private pathFromArg(a: unknown): string | undefined {
    if (typeof a === 'string') return a;
    if (isNode(a)) return 'path' in a ? a.path : undefined;
    if (a instanceof vscode.Uri) return this.idx.ofUri(a);
    const ed = vscode.window.activeTextEditor;
    return ed ? this.idx.ofUri(ed.document.uri) : undefined;
  }

  private fileFromArg(a: unknown): PendingFile | undefined {
    const p = this.pathFromArg(a);
    return p ? this.model.getFile(p) : undefined;
  }

  private report(r: OpResult): void {
    if (r === 'stale') void vscode.window.showWarningMessage('This change was modified just now. Please try again.');
    else if (r === 'none') void vscode.window.showInformationMessage('This file has no pending Claude changes.');
  }

  async keepHunk(args: unknown[]): Promise<OpResult | undefined> {
    const t = this.resolveHunk(args);
    if (!t) {
      void vscode.window.showInformationMessage('No Claude change near the cursor.');
      return undefined;
    }
    const r = await this.model.keepHunk(t.path, t.hunkId);
    this.report(r);
    return r;
  }

  async undoHunk(args: unknown[]): Promise<OpResult | undefined> {
    const t = this.resolveHunk(args);
    if (!t) {
      void vscode.window.showInformationMessage('No Claude change near the cursor.');
      return undefined;
    }
    const r = await this.model.undoHunk(t.path, t.hunkId);
    if (r === 'needs-file-op') return this.undoFile(t.path);
    this.report(r);
    return r;
  }

  async keepFile(a: unknown): Promise<OpResult | undefined> {
    const p = this.pathFromArg(a);
    if (!p) return undefined;
    const r = await this.model.keepFile(p);
    this.report(r);
    return r;
  }

  async undoFile(a: unknown, confirmed = false): Promise<OpResult | undefined> {
    const f = this.fileFromArg(a);
    if (!f) return undefined;
    const name = path.basename(f.path);
    if (!confirmed && (!f.existed || f.kind === 'binary' || f.missing)) {
      const [question, detail, action] = !f.existed
        ? [`Delete ${name}, which Claude created?`, 'The file will be moved to the Trash.', 'Delete']
        : f.missing
          ? [`Restore the deleted file ${name}?`, "It will be recreated with its content from before Claude's changes.", 'Restore']
          : [`Restore ${name} to its content from before Claude's changes?`, 'This is a binary file, so the restore cannot be undone with ⌘Z.', 'Restore'];
      if ((await vscode.window.showWarningMessage(question, { modal: true, detail }, action)) !== action) return undefined;
    }
    const r = await this.model.undoFile(f.path);
    this.report(r);
    return r;
  }

  private async keepAll(): Promise<void> {
    const files = this.scopeFiles();
    for (const f of files) await this.model.keepFile(f.path);
    void vscode.window.setStatusBarMessage(`Kept Claude's changes in ${plural(files.length, 'file')}`, 3000);
  }

  private async undoAll(): Promise<void> {
    const files = this.scopeFiles();
    if (files.length === 0) return;
    const created = files.filter((f) => !f.existed).length;
    const detail = created ? `${plural(created, 'new file')} created by Claude will be moved to the Trash.` : UNDO_HINT;
    const pick = await vscode.window.showWarningMessage(`Undo all of Claude's changes in ${plural(files.length, 'file')}?`, { modal: true, detail }, 'Undo All');
    if (pick !== 'Undo All') return;
    for (const f of files) await this.model.undoFile(f.path);
  }

  private async clearAll(): Promise<void> {
    const files = this.scopeFiles();
    if (files.length === 0) return;
    const pick = await vscode.window.showWarningMessage(
      `Discard the baselines of ${plural(files.length, 'file')}?`,
      { modal: true, detail: 'The files stay as they are; they just stop showing as pending.' },
      'Discard',
    );
    if (pick !== 'Discard') return;
    for (const f of files) await this.model.discard(f.path);
  }

  private async refreshAll(): Promise<void> {
    this.roundService.invalidate();
    await this.model.syncWithStore();
    await Promise.all(this.model.getFiles().map((f) => this.model.refresh(f.path)));
    this.scheduleUi();
  }

  private async openFile(a: unknown): Promise<void> {
    const f = this.fileFromArg(a);
    if (!f) return;
    if (f.kind !== 'text' || f.missing) return openFileDiff(f, this.idx);
    const first = f.hunks[0];
    if (first) await this.revealHunk(f.path, first.id);
    else await vscode.window.showTextDocument(this.idx.uriFor(f.path), { preview: false });
  }

  async revealHunk(p: string, hunkId: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(this.idx.uriFor(p));
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const h = this.model.getFile(p)?.hunks.find((x) => x.id === hunkId);
    if (!h) return;
    const line = Math.min(h.curStart, doc.lineCount - 1);
    ed.selection = new vscode.Selection(line, 0, line, 0);
    const end = Math.min(line + Math.max(h.added, 1) - 1, doc.lineCount - 1);
    ed.revealRange(new vscode.Range(Math.max(line - h.removed.length, 0), 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Jump to the next / previous hunk, across files */
  async navigate(dir: 1 | -1): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const cur = ed && ed.document.uri.scheme === 'file' ? this.idx.ofUri(ed.document.uri) : undefined;
    const files = this.scopeFiles();
    if (cur && !files.some((f) => f.path === cur) && this.model.getFile(cur)) files.push(this.model.getFile(cur)!);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const stops = files.filter((f) => f.kind === 'text' && !f.missing).flatMap((f) => f.hunks.map((h) => ({ path: f.path, hunk: h })));
    if (stops.length === 0) {
      void vscode.window.showInformationMessage('No pending Claude changes.');
      return;
    }
    const order = (p: string | undefined) => (p ? files.findIndex((f) => f.path === p) : -1);
    const here = order(cur);
    const line = ed?.selection.active.line ?? -1;
    const target =
      dir > 0
        ? (stops.find((s) => order(s.path) > here || (s.path === cur && s.hunk.curStart > line)) ?? stops[0])
        : ([...stops].reverse().find((s) => order(s.path) < here || (s.path === cur && s.hunk.curStart + Math.max(s.hunk.added, 1) - 1 < line)) ??
          stops[stops.length - 1]);
    await this.revealHunk(target.path, target.hunk.id);
  }

  private async onInsetAction(a: InsetAction): Promise<void> {
    if (a.action === 'ask') {
      await this.askClaude([a.path, a.hunkId]);
      return;
    }
    if (a.action === 'keep') await this.keepHunk([a.path, a.hunkId]);
    else await this.undoHunk([a.path, a.hunkId]);
    // Clicking a button in the webview leaves focus there; give it back to the editor
    if (vscode.window.visibleTextEditors.includes(a.editor)) {
      await vscode.window.showTextDocument(a.editor.document, { viewColumn: a.editor.viewColumn, preserveFocus: false });
    }
  }

  private dumpState(): void {
    this.out.info(`---- queue (${this.L.root}) ----\n${this.model.dump()}`);
    this.out.info(
      `editorInsets ${this.insets.isAvailable ? 'available' : 'unavailable'}, ${this.insets.insetCount} insets now; hooks ${this.hooksOk ? 'installed' : 'not installed'}`,
    );
    for (const m of this.insets.metrics.slice(-5)) {
      this.out.info(`inset measured: ${m.lines} lines -> ${m.insetPx}px, ${m.linePx}px per line; font ${m.fontSize} ${m.fontFamily}`);
    }
    this.out.info(`Highlight theme: ${this.highlighter.themeName ?? '(not loaded)'}; colored spans in recent insets: ${this.insets.highlighted.slice(-5).join(', ') || 'none'}`);
    for (const g of this.roundService.group(this.scopeFiles())) {
      this.out.info(`round ${g.roundId || '(unattributed)'}: ${g.roundId ? promptTitle(g.meta) : '-'}, ${g.files.size} files, ${g.hunkCount} hunks`);
    }
    this.out.show(true);
  }

  dispose(): void {
    this.watcher?.dispose();
    clearTimeout(this.uiTimer);
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    for (const t of this.rangeTimers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
