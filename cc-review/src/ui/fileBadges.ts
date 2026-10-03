// Badges for pending files in the Explorer.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PathIndex } from '../adapters';
import type { ReviewModel } from '../core/model';

export class PendingBadges implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private basenames = new Set<string>();

  constructor(
    private readonly model: ReviewModel,
    private readonly idx: PathIndex,
  ) {}

  refresh(): void {
    this.basenames = new Set(this.model.getFiles().map((f) => path.basename(f.path).toLowerCase()));
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    // Filter by file name first to avoid a realpath call for every file in the Explorer
    if (!this.basenames.has(path.basename(uri.fsPath).toLowerCase())) return undefined;
    const f = this.model.getFile(uri.fsPath) ?? this.model.getFile(this.idx.canon(uri.fsPath));
    if (!f) return undefined;
    return {
      badge: 'C',
      tooltip: f.existed ? 'Changed by Claude, pending review' : 'Created by Claude, pending review',
      color: new vscode.ThemeColor(f.existed ? 'gitDecoration.modifiedResourceForeground' : 'gitDecoration.untrackedResourceForeground'),
      propagate: true,
    };
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
