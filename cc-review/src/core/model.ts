// ReviewModel: the review queue, Keep/Undo transforms and change events.
// Invariant: a file is in the queue iff it has a baseline and the baseline differs from the current
// content. Every operation recomputes; when they are equal the baseline is deleted.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { computeHunks, type Hunk } from './diff';
import type { WriteEvent } from './events';
import { pathKey } from './paths';
import { preview, type RevertKind, type RevertRecord } from './reverts';
import type { Store } from './store';
import { contentEqual, decodeUtf8, detectEol, encodeUtf8, hash53, linesEqual, splitLines, type Eol } from './text';
import { keepHunkLines, mergeUserEdit, undoHunkEdit, type LineEdit } from './transforms';

export type DocState =
  | { kind: 'text'; text: string; eol: Eol; version?: number; isDirty?: boolean }
  | { kind: 'binary'; bytes: Buffer };

export interface TextSource {
  /** Prefer the open document (it may have unsaved edits), else read from disk; undefined if the file does not exist */
  read(path: string): Promise<DocState | undefined>;
  /** Whether the file is open in an editor (open files refresh via document events, not disk polling) */
  isOpen(path: string): boolean;
}

export interface EditApplier {
  /** Apply non-overlapping edits to the buffer in one step and save; undoable in the editor. False if the document version changed */
  applyEdits(path: string, edits: LineEdit[], expectedVersion: number | undefined): Promise<boolean>;
  /** Replace the whole file with text (Undo File for text files) */
  replaceAll(path: string, text: string): Promise<boolean>;
  /** Write straight to disk: binary files, or restoring a deleted file */
  writeBytes(path: string, bytes: Buffer): Promise<void>;
  /** Delete the file (move it to the trash) */
  deleteFile(path: string): Promise<void>;
}

export type FileKind = 'text' | 'binary' | 'large';

export interface PendingFile {
  path: string;
  key: string;
  /** false = a file Claude created */
  existed: boolean;
  /** The file no longer exists: it was deleted */
  missing: boolean;
  /** binary / large files can only be kept or undone as a whole */
  kind: FileKind;
  ts: number;
  sessions: string[];
  baseLines: string[];
  /** Hash of the baseline content; syntax highlighting caches tokenizer state by it */
  baseHash: string;
  baseEol: Eol;
  baseBom: boolean;
  curLines: string[];
  curEol: Eol;
  docVersion?: number;
  hunks: Hunk[];
  addedCount: number;
  removedCount: number;
}

export type OpResult = 'ok' | 'stale' | 'none' | 'needs-file-op';

export interface ModelOptions {
  maxBytes: number;
}

type Listener = (paths: string[]) => void;

export class ReviewModel {
  private files = new Map<string, PendingFile>();
  private stamps = new Map<string, string>();
  private keyToPath = new Map<string, string>();
  private sessionsByPath = new Map<string, Set<string>>();
  /** The session that last wrote each file; "Ask Claude" returns to that conversation */
  private lastWriter = new Map<string, { session: string; ts: number }>();
  private diskStamps = new Map<string, string>();
  private recentReverts = new Map<string, { id: string; ts: number }>();
  /** Files that recently left the queue; used to rebuild the baseline when the last Undo is undone */
  private resolvedInfo = new Map<string, { sessions: string[]; ts: number; bom: boolean }>();
  private locks = new Map<string, Promise<unknown>>();
  private listeners = new Set<Listener>();

  constructor(
    readonly store: Store,
    private readonly source: TextSource,
    private readonly applier: EditApplier,
    public opts: ModelOptions,
  ) {}

  onDidChange(fn: Listener): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private fire(paths: string[]): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(paths);
      } catch (e) {
        console.error('[cc-review] listener failed', e);
      }
    }
  }

  getFile(path: string): PendingFile | undefined {
    return this.files.get(path);
  }

  getFiles(): PendingFile[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  latestSession(path: string): string | undefined {
    return this.lastWriter.get(path)?.session ?? this.files.get(path)?.sessions.at(-1);
  }

  /** This path has a baseline (pending, or equal but not yet saved to disk) */
  tracks(path: string): boolean {
    return this.keyToPath.has(pathKey(path));
  }

  /** Serialize operations on the same path */
  private exclusive<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(path) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(path, tail);
    void tail.then(() => {
      if (this.locks.get(path) === tail) this.locks.delete(path);
    });
    return run;
  }

  noteEvents(events: readonly WriteEvent[]): string[] {
    const paths = new Set<string>();
    for (const e of events) {
      paths.add(e.path);
      if (e.session) {
        let s = this.sessionsByPath.get(e.path);
        if (!s) this.sessionsByPath.set(e.path, (s = new Set()));
        s.add(e.session);
        const prev = this.lastWriter.get(e.path);
        if (!prev || e.ts >= prev.ts) this.lastWriter.set(e.path, { session: e.session, ts: e.ts });
      }
    }
    return [...paths];
  }

  refresh(path: string): Promise<PendingFile | undefined> {
    return this.exclusive(path, () => this.compute(path));
  }

  /** Reconcile with baselines/: recompute new or changed baselines, drop the ones that disappeared */
  async syncWithStore(): Promise<void> {
    const keys = new Set(this.store.keys());
    const todo: string[] = [];
    for (const key of keys) {
      const stamp = this.store.stamp(key);
      if (stamp === undefined || stamp === this.stamps.get(key)) continue;
      const b = this.store.read(key);
      if (b) todo.push(b.meta.path);
    }
    for (const [key, path] of [...this.keyToPath]) {
      if (keys.has(key)) continue;
      this.keyToPath.delete(key);
      this.stamps.delete(key);
      this.drop(path);
    }
    await Promise.all(todo.map((p) => this.refresh(p)));
  }

  /** Pending files not open in an editor: poll the disk to catch external changes such as git checkout */
  async checkDisk(): Promise<void> {
    const todo: string[] = [];
    for (const f of this.files.values()) {
      if (this.source.isOpen(f.path)) continue;
      let stamp = 'missing';
      try {
        const st = fs.statSync(f.path);
        stamp = `${st.mtimeMs}:${st.size}`;
      } catch {
        // Does not exist
      }
      if (this.diskStamps.get(f.path) !== stamp) todo.push(f.path);
    }
    await Promise.all(todo.map((p) => this.refresh(p)));
  }

  private rememberDiskStamp(path: string): void {
    try {
      const st = fs.statSync(path);
      this.diskStamps.set(path, `${st.mtimeMs}:${st.size}`);
    } catch {
      this.diskStamps.set(path, 'missing');
    }
  }

  private untrack(key: string): void {
    this.keyToPath.delete(key);
    this.stamps.delete(key);
  }

  private drop(path: string): undefined {
    this.diskStamps.delete(path);
    if (this.files.delete(path)) this.fire([path]);
    return undefined;
  }

  private set(pf: PendingFile): PendingFile {
    const old = this.files.get(pf.path);
    this.files.set(pf.path, pf);
    if (!old || layoutChanged(old, pf)) this.fire([pf.path]);
    return pf;
  }

  private async compute(path: string): Promise<PendingFile | undefined> {
    const key = pathKey(path);
    const stamp = this.store.stamp(key);
    const b = this.store.read(key);
    if (!b) {
      this.keyToPath.delete(key);
      this.stamps.delete(key);
      return this.drop(path);
    }
    this.keyToPath.set(key, path);
    this.stamps.set(key, stamp ?? '');
    this.rememberDiskStamp(path);

    const cur = await this.source.read(path);
    const sessions = [...new Set([...(b.meta.sessions ?? []), ...(this.sessionsByPath.get(path) ?? [])])];
    const base = b.meta.existed ? decodeUtf8(b.content) : { text: '', bom: false };
    const common = {
      path,
      key,
      existed: b.meta.existed,
      ts: b.meta.ts,
      sessions,
      baseHash: base ? hash53(base.text) : '',
      baseEol: base ? detectEol(base.text) : ('\n' as Eol),
      baseBom: base?.bom ?? false,
    };
    const resolved = () => {
      // Equal: leave the queue. Delete the baseline once the disk matches too (keep it while the editor has unsaved edits)
      if (this.store.deleteIfDiskMatches(key)) this.untrack(key);
      this.resolvedInfo.set(path, { sessions, ts: b.meta.ts, bom: common.baseBom });
      if (this.resolvedInfo.size > 200) this.resolvedInfo.delete(this.resolvedInfo.keys().next().value!);
      return this.drop(path);
    };

    if (!cur) {
      if (!b.meta.existed) return resolved(); // Created and then deleted again: nothing changed
      const baseLines = base ? splitLines(base.text) : [];
      return this.set({
        ...common,
        missing: true,
        kind: base ? 'text' : 'binary',
        baseLines,
        curLines: [],
        curEol: common.baseEol,
        hunks: [],
        addedCount: 0,
        removedCount: baseLines.length,
      });
    }

    if (cur.kind === 'binary' || !base) {
      const curBytes = cur.kind === 'binary' ? cur.bytes : encodeUtf8(cur.text, false);
      if (b.meta.existed && contentEqual(b.content, curBytes)) return resolved();
      return this.set({
        ...common,
        missing: false,
        kind: 'binary',
        baseLines: [],
        curLines: [],
        curEol: '\n',
        hunks: [],
        addedCount: 0,
        removedCount: 0,
      });
    }

    const baseLines = b.meta.existed ? splitLines(base.text) : [];
    const curLines = splitLines(cur.text);
    if (b.meta.existed && linesEqual(baseLines, curLines)) return resolved();

    const large = Math.max(b.content.length, cur.text.length) > this.opts.maxBytes;
    const hunks = large ? [] : computeHunks(baseLines, curLines);
    this.cancelRestoredReverts(path, hunks);
    return this.set({
      ...common,
      missing: false,
      kind: large ? 'large' : 'text',
      baseLines,
      curLines,
      curEol: cur.eol,
      docVersion: cur.version,
      hunks,
      addedCount: hunks.reduce((n, h) => n + h.added, 0),
      removedCount: hunks.reduce((n, h) => n + h.removed.length, 0),
    });
  }

  // ---------- Keep ----------

  keepHunk(path: string, hunkId: string): Promise<OpResult> {
    return this.keepHunks(path, [hunkId]);
  }

  /** Keep several hunks of one file at once (used by Keep Round); writes the baseline once */
  keepHunks(path: string, hunkIds: readonly string[]): Promise<OpResult> {
    return this.exclusive(path, async () => {
      const pf = await this.compute(path);
      if (!pf) return 'none';
      if (pf.kind !== 'text' || !pf.existed || pf.missing) return this.keepFileLocked(pf);
      const hs = this.findHunks(pf, hunkIds);
      if (!hs) return 'stale';
      // Apply bottom-up so earlier line numbers stay valid
      let base = pf.baseLines;
      for (const h of hs.sort((a, b) => b.baseStart - a.baseStart)) base = keepHunkLines(base, pf.curLines, h);
      this.writeBaseline(pf, base);
      await this.compute(path);
      return 'ok';
    });
  }

  private findHunks(pf: PendingFile, ids: readonly string[]): Hunk[] | undefined {
    const hs = ids.map((id) => pf.hunks.find((x) => x.id === id));
    return hs.every((h): h is Hunk => !!h) && hs.length > 0 ? hs : undefined;
  }

  keepFile(path: string): Promise<OpResult> {
    return this.exclusive(path, async () => {
      const pf = await this.compute(path);
      return pf ? this.keepFileLocked(pf) : 'none';
    });
  }

  private async keepFileLocked(pf: PendingFile): Promise<OpResult> {
    if (pf.missing) {
      // Accept the deletion
      this.store.delete(pf.key);
      this.untrack(pf.key);
      this.drop(pf.path);
      return 'ok';
    }
    const cur = await this.source.read(pf.path);
    if (!cur) return 'stale';
    const bytes = cur.kind === 'binary' ? cur.bytes : encodeUtf8(cur.text, pf.baseBom);
    this.store.write({ path: pf.path, existed: true, ts: pf.ts, sessions: pf.sessions }, bytes);
    await this.compute(pf.path);
    return 'ok';
  }

  private writeBaseline(pf: PendingFile, lines: readonly string[]): void {
    this.store.write(
      { path: pf.path, existed: true, ts: pf.ts, sessions: pf.sessions },
      encodeUtf8(lines.join(pf.baseEol), pf.baseBom),
    );
    this.stamps.set(pf.key, this.store.stamp(pf.key) ?? '');
  }

  // ---------- Undo ----------

  /** New, deleted, binary and large files can only be handled as a whole: returns needs-file-op so the caller uses undoFile (which confirms first). */
  undoHunk(path: string, hunkId: string): Promise<OpResult> {
    return this.undoHunks(path, [hunkId]);
  }

  /** Undo several hunks of one file at once (used by Undo Round): one edit, one save, one undo step */
  undoHunks(path: string, hunkIds: readonly string[]): Promise<OpResult> {
    return this.exclusive(path, async () => {
      const pf = await this.compute(path);
      if (!pf) return 'none';
      if (pf.kind !== 'text' || !pf.existed || pf.missing) return 'needs-file-op';
      const hs = this.findHunks(pf, hunkIds);
      if (!hs) return 'stale';
      const edits = hs.map((h) => undoHunkEdit(pf.curLines, h, pf.curEol));
      if (!(await this.applier.applyEdits(path, edits, pf.docVersion))) return 'stale';
      for (const h of hs.sort((a, b) => a.curStart - b.curStart)) this.recordRevert(pf, h);
      await this.compute(path);
      return 'ok';
    });
  }

  undoFile(path: string): Promise<OpResult> {
    return this.exclusive(path, async () => {
      const pf = await this.compute(path);
      if (!pf) return 'none';
      const b = this.store.read(pf.key);
      if (!b) return 'none';
      if (!pf.existed) {
        await this.applier.deleteFile(path);
        this.recordRevert(pf, undefined, 'newfile');
      } else if (pf.missing) {
        await this.applier.writeBytes(path, b.content);
        this.recordRevert(pf, undefined, 'restored');
      } else if (pf.kind === 'binary') {
        await this.applier.writeBytes(path, b.content);
        this.recordRevert(pf, undefined, 'file');
      } else {
        const ok = await this.applier.replaceAll(path, decodeUtf8(b.content)?.text ?? '');
        if (!ok) return 'stale';
        this.recordRevert(pf, undefined, 'file');
      }
      await this.compute(path);
      return 'ok';
    });
  }

  /** Discard the baseline without touching the file */
  discard(path: string): Promise<void> {
    return this.exclusive(path, async () => {
      this.store.delete(pathKey(path));
      this.untrack(pathKey(path));
      this.drop(path);
    });
  }

  private recordRevert(pf: PendingFile, h: Hunk | undefined, fileKind?: RevertKind): void {
    const id = crypto.randomUUID();
    let rec: RevertRecord;
    if (h) {
      const undone = pf.curLines.slice(h.curStart, h.curStart + h.added);
      const kind: RevertKind = h.added > 0 && h.removed.length > 0 ? 'modified' : h.added > 0 ? 'added' : 'deleted';
      rec = {
        type: 'revert',
        id,
        path: pf.path,
        kind,
        startLine: h.curStart + 1,
        endLine: kind === 'added' ? undefined : h.curStart + h.removed.length,
        undone: undone.length ? preview(undone) : undefined,
        restored: h.removed.length ? preview(h.removed) : undefined,
        count: kind === 'added' ? h.added : h.removed.length,
        sessions: pf.sessions,
        hunkId: h.id,
        ts: Date.now(),
      };
      this.recentReverts.set(`${pf.path}\u0000${h.id}`, { id, ts: rec.ts });
    } else {
      rec = { type: 'revert', id, path: pf.path, kind: fileKind ?? 'file', sessions: pf.sessions, ts: Date.now() };
    }
    try {
      this.store.appendRevert(rec);
    } catch (e) {
      console.error('[cc-review] append revert failed', e);
    }
  }

  /** You pressed ⌘Z on an Undo and the hunk came back: cancel its revert record so Claude is not told something false */
  private cancelRestoredReverts(path: string, hunks: readonly Hunk[]): void {
    if (this.recentReverts.size === 0) return;
    const now = Date.now();
    for (const [k, v] of this.recentReverts) if (now - v.ts > 3600_000) this.recentReverts.delete(k);
    for (const h of hunks) {
      const k = `${path}\u0000${h.id}`;
      const r = this.recentReverts.get(k);
      if (!r) continue;
      this.recentReverts.delete(k);
      try {
        this.store.appendRevert({ type: 'cancel', id: r.id, ts: now });
      } catch {
        // Ignore
      }
    }
  }

  // ---------- Your own edits (auto-keep) ----------

  /**
   * prev -> next is one edit you made in the editor. Parts outside Claude's hunks are merged into
   * the baseline. Runs synchronously and writes the baseline immediately; returns whether it changed.
   */
  applyUserEdit(path: string, prev: readonly string[], next: readonly string[]): boolean {
    const pf = this.files.get(path);
    if (!pf || pf.kind !== 'text' || !pf.existed || pf.missing) return false;
    const hunks = linesEqual(pf.curLines, prev) ? pf.hunks : computeHunks(pf.baseLines, prev);
    const merged = mergeUserEdit(pf.baseLines, prev, next, hunks);
    if (!merged) return false;
    pf.baseLines = merged;
    pf.baseHash = hash53(merged.join(pf.baseEol));
    try {
      this.writeBaseline(pf, merged);
    } catch (e) {
      console.error('[cc-review] write baseline failed', e);
    }
    return true;
  }

  /**
   * You undid the last Undo in the editor. At that point the file equaled the baseline, so the
   * baseline was deleted. Rebuild it from the post-undo content (the original baseline) so Claude's
   * change is pending again.
   */
  restoreBaseline(path: string, baselineText: string): boolean {
    if (this.tracks(path)) return false;
    const info = this.resolvedInfo.get(path);
    if (!info) return false;
    this.store.write({ path, existed: true, ts: info.ts, sessions: info.sessions }, encodeUtf8(baselineText, info.bom));
    this.keyToPath.set(pathKey(path), path);
    return true;
  }

  dump(): string {
    const lines: string[] = [];
    for (const f of this.getFiles()) {
      lines.push(
        `${f.path}  [${f.kind}${f.existed ? '' : ', new'}${f.missing ? ', deleted' : ''}]  +${f.addedCount} −${f.removedCount}  v${f.docVersion ?? '-'}  sessions=${f.sessions.join(',') || '-'}`,
      );
      for (const h of f.hunks) {
        lines.push(`  ${h.id}  base@${h.baseStart + 1} −${h.removed.length}  cur@${h.curStart + 1} +${h.added}`);
      }
    }
    return lines.length ? lines.join('\n') : '(queue is empty)';
  }
}

function layoutChanged(a: PendingFile, b: PendingFile): boolean {
  if (a.kind !== b.kind || a.missing !== b.missing || a.existed !== b.existed || a.hunks.length !== b.hunks.length) return true;
  for (let i = 0; i < a.hunks.length; i++) {
    const x = a.hunks[i];
    const y = b.hunks[i];
    if (x.id !== y.id || x.curStart !== y.curStart || x.added !== y.added) return true;
  }
  return false;
}
