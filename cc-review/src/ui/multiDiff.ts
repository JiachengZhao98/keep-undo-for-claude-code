// cc-baseline: content provider plus the vscode.changes multi-file diff.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PathIndex } from '../adapters';
import type { PendingFile } from '../core/model';
import type { Store } from '../core/store';
import { decodeUtf8 } from '../core/text';

export const BASELINE_SCHEME = 'cc-baseline';

export function baselineUri(p: string, empty = false): vscode.Uri {
  return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: p, query: empty ? 'empty' : '' });
}

export class BaselineProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly store: Store,
    private readonly idx: PathIndex,
  ) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.query === 'empty') return '';
    const b = this.store.readByPath(uri.path);
    if (b) return b.meta.existed ? (decodeUtf8(b.content)?.text ?? '(binary file)') : '';
    // The baseline is gone (everything kept or undone): show the current content so the diff is empty
    const doc = this.idx.findDoc(uri.path);
    if (doc) return doc.getText();
    try {
      return decodeUtf8(fs.readFileSync(uri.path))?.text ?? '';
    } catch {
      return '';
    }
  }

  changed(paths: readonly string[]): void {
    for (const p of paths) this.emitter.fire(baselineUri(p));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export async function openMultiDiff(files: readonly PendingFile[], idx: PathIndex): Promise<void> {
  if (files.length === 0) {
    void vscode.window.showInformationMessage('No pending Claude changes.');
    return;
  }
  const resources = files.map((f) => {
    const uri = idx.uriFor(f.path);
    return [uri, f.existed ? baselineUri(f.path) : baselineUri(f.path, true), f.missing ? baselineUri(f.path, true) : uri] as const;
  });
  await vscode.commands.executeCommand('vscode.changes', 'Claude Changes', resources);
}

export async function openFileDiff(f: PendingFile, idx: PathIndex): Promise<void> {
  const right = f.missing ? baselineUri(f.path, true) : idx.uriFor(f.path);
  const left = f.existed ? baselineUri(f.path) : baselineUri(f.path, true);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(f.path)} (Claude Changes)`);
}
