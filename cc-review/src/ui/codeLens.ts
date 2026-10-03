// Keep | Undo above each hunk. For a pure deletion it sits above the line below the deletion.
import * as vscode from 'vscode';
import type { PathIndex } from '../adapters';
import type { PendingFile, ReviewModel } from '../core/model';

export interface LensExtras {
  /** Which round the hunk came from: the start of your message */
  roundTitle(pf: PendingFile, hunkId: string): string | undefined;
  /** Whether the Claude Code extension is installed */
  askEnabled(): boolean;
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
    if (!vscode.workspace.getConfiguration('ccReview').get<boolean>('codeLens', true)) return [];
    const path = this.idx.ofUri(doc.uri);
    const pf = path ? this.model.getFile(path) : undefined;
    if (!pf || pf.missing) return [];
    const top = new vscode.Range(0, 0, 0, 0);
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
    const last = doc.lineCount - 1;
    const ask = this.extras.askEnabled();
    const lenses: vscode.CodeLens[] = [];
    pf.hunks.forEach((h, i) => {
      const line = Math.min(h.curStart, last);
      const range = new vscode.Range(line, 0, line, 0);
      const counts = [h.added ? `+${h.added}` : '', h.removed.length ? `−${h.removed.length}` : ''].filter(Boolean).join(' ');
      const round = this.extras.roundTitle(pf, h.id);
      lenses.push(
        new vscode.CodeLens(range, { title: '$(check) Keep', tooltip: 'Keep this change (⌃⌥K)', command: 'ccReview.keepHunk', arguments: [pf.path, h.id] }),
        new vscode.CodeLens(range, { title: '$(discard) Undo', tooltip: 'Undo this change (⌃⌥U)', command: 'ccReview.undoHunk', arguments: [pf.path, h.id] }),
      );
      if (ask) {
        lenses.push(
          new vscode.CodeLens(range, { title: '$(comment-discussion) Ask Claude', tooltip: 'Ask Claude about this change (⌃⌥C)', command: 'ccReview.askClaude', arguments: [pf.path, h.id] }),
        );
      }
      lenses.push(
        new vscode.CodeLens(range, {
          title: `Claude ${i + 1}/${pf.hunks.length} · ${counts}${round ? ` · "${round.length > 24 ? round.slice(0, 24) + '…' : round}"` : ''}`,
          tooltip: round ? `From your message: ${round}` : undefined,
          command: '',
        }),
      );
    });
    return lenses;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
