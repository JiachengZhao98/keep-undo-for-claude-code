// Keep | Undo | Ask Claude as plain CodeLens links below each change, for when the colored buttons
// (editor insets) are not available. A CodeLens sits above its line, so it goes on the line after the change.
import * as vscode from 'vscode';
import type { PathIndex } from '../adapters';
import type { PendingFile, ReviewModel } from '../core/model';

export interface LensExtras {
  /** Whether the Claude Code extension is installed */
  askEnabled(): boolean;
  /** Whether the colored Keep / Undo bar is shown above the file (it replaces the file-level lenses) */
  fileButtonsShown(): boolean;
  /** Whether colored buttons are shown below each change (they replace the per-change lenses) */
  changeButtonsShown(): boolean;
}

export class HunkCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private readonly model: ReviewModel,
    private readonly idx: PathIndex,
    private readonly extras: LensExtras,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const path = this.idx.ofUri(doc.uri);
    const pf = path ? this.model.getFile(path) : undefined;
    if (!pf || pf.missing) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    if ((pf.kind !== 'text' || !pf.existed) && this.extras.fileButtonsShown()) return [];
    if (pf.kind !== 'text') {
      const what = pf.kind === 'binary' ? 'binary file' : 'large file';
      return [
        new vscode.CodeLens(top, { title: `Claude changed this ${what}; it can only be kept or undone as a whole`, command: '' }),
        new vscode.CodeLens(top, { title: '$(check) Keep File', command: 'ccReview.keepFile', arguments: [pf.path] }),
        new vscode.CodeLens(top, { title: '$(discard) Undo File', command: 'ccReview.undoFile', arguments: [pf.path] }),
      ];
    }
    if (!pf.existed) {
      return [
        new vscode.CodeLens(top, { title: 'New file created by Claude', command: '' }),
        new vscode.CodeLens(top, { title: '$(check) Keep', command: 'ccReview.keepFile', arguments: [pf.path] }),
        new vscode.CodeLens(top, { title: '$(discard) Undo (Delete File)', command: 'ccReview.undoFile', arguments: [pf.path] }),
      ];
    }
    if (this.extras.changeButtonsShown() || !vscode.workspace.getConfiguration('ccReview').get<boolean>('changeButtons', true)) return [];
    const last = doc.lineCount - 1;
    const ask = this.extras.askEnabled();
    const lenses: vscode.CodeLens[] = [];
    for (const h of pf.hunks) {
      const line = Math.min(h.curStart + h.added, last);
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, { title: '$(check) Keep', tooltip: 'Keep this change (⌃⌥K)', command: 'ccReview.keepHunk', arguments: [pf.path, h.id] }),
        new vscode.CodeLens(range, { title: '$(discard) Undo', tooltip: 'Undo this change (⌃⌥U)', command: 'ccReview.undoHunk', arguments: [pf.path, h.id] }),
      );
      if (ask) {
        lenses.push(
          new vscode.CodeLens(range, { title: '$(comment-discussion) Ask Claude', tooltip: 'Ask Claude about this change (⌃⌥C)', command: 'ccReview.askClaude', arguments: [pf.path, h.id] }),
        );
      }
    }
    return lenses;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
