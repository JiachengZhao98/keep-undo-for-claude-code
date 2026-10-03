// VS Code implementations of the abstract interfaces in core/.
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { DocState, EditApplier, TextSource } from './core/model';
import { canonical, isUnder } from './core/paths';
import { decodeUtf8, detectEol } from './core/text';
import type { LineEdit } from './core/transforms';

/** Editor paths (possibly via symlinks or with different case) <-> the realpaths the hook records */
export class PathIndex {
  private cache = new Map<string, string>();

  canon(fsPath: string): string {
    let c = this.cache.get(fsPath);
    if (c === undefined) {
      if (this.cache.size > 5000) this.cache.clear();
      c = canonical(fsPath);
      this.cache.set(fsPath, c);
    }
    return c;
  }

  ofUri(uri: vscode.Uri): string | undefined {
    return uri.scheme === 'file' ? this.canon(uri.fsPath) : undefined;
  }

  findDoc(path: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => !d.isClosed && d.uri.scheme === 'file' && this.canon(d.uri.fsPath) === path);
  }

  uriFor(path: string): vscode.Uri {
    return this.findDoc(path)?.uri ?? vscode.Uri.file(path);
  }

  editorsFor(path: string): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => this.ofUri(e.document.uri) === path);
  }
}

export class VsTextSource implements TextSource {
  constructor(private readonly idx: PathIndex) {}

  async read(path: string): Promise<DocState | undefined> {
    const doc = this.idx.findDoc(path);
    if (doc) {
      // Deleted on disk but still open in an editor: the disk wins
      if (!doc.isDirty && !fs.existsSync(path)) return undefined;
      return {
        kind: 'text',
        text: doc.getText(),
        eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
        version: doc.version,
        isDirty: doc.isDirty,
      };
    }
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
      throw e;
    }
    const d = decodeUtf8(buf);
    return d ? { kind: 'text', text: d.text, eol: detectEol(d.text) } : { kind: 'binary', bytes: buf };
  }

  isOpen(path: string): boolean {
    return !!this.idx.findDoc(path);
  }
}

/**
 * Remembers the edits the extension itself made to documents. When you press ⌘Z on an Undo, that
 * change must not be merged into the baseline as your own edit, or Claude's change would be kept
 * silently.
 */
export class OwnEdits {
  private inFlight = new Map<string, number>();
  private history = new Map<string, Array<{ before: string; after: string }>>();

  begin(path: string): void {
    this.inFlight.set(path, (this.inFlight.get(path) ?? 0) + 1);
  }

  end(path: string, before: string | undefined, after: string | undefined): void {
    const n = (this.inFlight.get(path) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(path);
    else this.inFlight.set(path, n);
    if (before === undefined || after === undefined || before === after) return;
    const h = this.history.get(path) ?? [];
    h.push({ before, after });
    if (h.length > 10) h.shift();
    this.history.set(path, h);
  }

  /** Whether this document change is one of our own edits, or your undo / redo of one */
  match(path: string, prev: string, next: string, reason: vscode.TextDocumentChangeReason | undefined): 'inflight' | 'undo' | 'redo' | undefined {
    if (this.inFlight.get(path)) return 'inflight';
    for (const h of this.history.get(path) ?? []) {
      if (reason === vscode.TextDocumentChangeReason.Undo && prev === h.after && next === h.before) return 'undo';
      if (reason === vscode.TextDocumentChangeReason.Redo && prev === h.before && next === h.after) return 'redo';
    }
    return undefined;
  }

  hasHistory(path: string): boolean {
    return this.history.has(path) || this.inFlight.has(path);
  }

  forget(path: string): void {
    this.history.delete(path);
  }
}

export class VsEditApplier implements EditApplier {
  constructor(
    private readonly idx: PathIndex,
    private readonly own: OwnEdits,
  ) {}

  private async openDoc(path: string): Promise<vscode.TextDocument> {
    return this.idx.findDoc(path) ?? (await vscode.workspace.openTextDocument(vscode.Uri.file(path)));
  }

  /** Edit the buffer with a WorkspaceEdit so it lands on the undo stack (⌘Z restores it), then save so Claude reads the reverted content */
  private async edit(doc: vscode.TextDocument, path: string, changes: ReadonlyArray<[vscode.Range, string]>): Promise<boolean> {
    const before = doc.getText();
    const we = new vscode.WorkspaceEdit();
    for (const [range, text] of changes) we.replace(doc.uri, range, text);
    this.own.begin(path);
    let ok = false;
    try {
      ok = await vscode.workspace.applyEdit(we);
    } finally {
      this.own.end(path, before, ok ? doc.getText() : undefined);
    }
    if (ok) await doc.save();
    return ok;
  }

  async applyEdits(path: string, edits: LineEdit[], expectedVersion: number | undefined): Promise<boolean> {
    const doc = await this.openDoc(path);
    // Staleness guard: give up if the document version differs from the one the hunks were computed on
    if (expectedVersion !== undefined && doc.version !== expectedVersion) return false;
    return this.edit(
      doc,
      path,
      edits.map((e) => [new vscode.Range(e.startLine, e.startChar, e.endLine, e.endChar), e.text]),
    );
  }

  async replaceAll(path: string, text: string): Promise<boolean> {
    const doc = await this.openDoc(path);
    const last = doc.lineAt(doc.lineCount - 1);
    return this.edit(doc, path, [[new vscode.Range(0, 0, last.lineNumber, last.text.length), text]]);
  }

  async writeBytes(path: string, bytes: Buffer): Promise<void> {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(path), bytes);
  }

  async deleteFile(path: string): Promise<void> {
    const uri = this.idx.uriFor(path);
    // Close its tabs first so no dirty "deleted" editor is left behind
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && this.idx.ofUri(t.input.uri) === path);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    // Integration tests must not fill your trash
    await vscode.workspace.fs.delete(uri, { useTrash: process.env.CCR_NO_TRASH !== '1' });
  }
}

/** Summary views only show files inside this window's workspace */
export class Scope {
  private folders: string[] = [];

  constructor(private readonly idx: PathIndex) {
    this.update();
  }

  update(): void {
    this.folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => this.idx.canon(f.uri.fsPath));
  }

  includes(path: string): boolean {
    if (vscode.workspace.getConfiguration('ccReview').get<boolean>('showFilesOutsideWorkspace')) return true;
    if (this.folders.length === 0) return true;
    return this.folders.some((f) => isUnder(path, f));
  }
}
