import * as vscode from 'vscode';
import type { PendingFile } from '../core/model';
import { plural } from '../core/text';

export function countChanges(files: readonly PendingFile[]): number {
  return files.reduce((n, f) => n + (f.kind === 'text' && !f.missing ? Math.max(f.hunks.length, 1) : 1), 0);
}

export class ReviewStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('ccReview.status', vscode.StatusBarAlignment.Left, 50);

  constructor() {
    this.item.name = 'Claude Review';
  }

  update(files: readonly PendingFile[], hooksInstalled: boolean): void {
    if (!hooksInstalled) {
      this.item.text = '$(warning) Claude Review: hooks not installed';
      this.item.tooltip = 'Click to install the hooks in ~/.claude/settings.json';
      this.item.command = 'ccReview.installHooks';
      this.item.show();
      return;
    }
    if (files.length === 0) {
      this.item.hide();
      return;
    }
    this.item.text = `$(sparkle) Claude: ${plural(files.length, 'file')} · ${plural(countChanges(files), 'change')}`;
    this.item.tooltip = 'Review all Claude changes in a multi-file diff';
    this.item.command = 'ccReview.reviewAll';
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
