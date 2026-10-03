// The "Claude Changes" view in the Source Control sidebar: by file (file -> hunks) or by round (your message -> files -> hunks).
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Hunk } from '../core/diff';
import type { PendingFile, ReviewModel } from '../core/model';
import { promptTitle } from '../core/rounds';
import { plural } from '../core/text';
import { formatTime, OTHER_ROUND, type RoundGroup, type RoundService } from './rounds';
import { countChanges } from './statusBar';

export type ReviewNode =
  | { type: 'file'; path: string }
  | { type: 'hunk'; path: string; hunkId: string }
  | { type: 'round'; roundId: string }
  | { type: 'roundFile'; roundId: string; path: string };

export type GroupMode = 'file' | 'round';

export function hunkLabel(h: Hunk): string {
  if (h.added === 0) return `Before line ${h.curStart + 1}`;
  return h.added === 1 ? `Line ${h.curStart + 1}` : `Lines ${h.curStart + 1}–${h.curStart + h.added}`;
}

function counts(added: number, removed: number): string {
  return [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ');
}

function fileState(f: PendingFile | undefined): string {
  if (!f) return '';
  if (f.missing) return 'deleted';
  if (!f.existed) return 'new';
  if (f.kind === 'binary') return 'binary';
  if (f.kind === 'large') return 'large file';
  return counts(f.addedCount, f.removedCount);
}

function relDir(file: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  return folder ? path.relative(folder.uri.fsPath, path.dirname(file)) : path.dirname(file);
}

export class ChangesTree implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ReviewNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly view: vscode.TreeView<ReviewNode>;
  mode: GroupMode = 'file';
  private groups: RoundGroup[] = [];

  constructor(
    private readonly model: ReviewModel,
    private readonly files: () => PendingFile[],
    private readonly rounds: RoundService,
  ) {
    this.view = vscode.window.createTreeView('ccReview.changes', { treeDataProvider: this, showCollapseAll: true });
  }

  refresh(): void {
    if (this.mode === 'round') this.groups = this.rounds.group(this.files());
    this.emitter.fire();
    const files = this.files();
    const n = countChanges(files);
    this.view.badge = n ? { value: n, tooltip: `${plural(n, 'Claude change')} pending in ${plural(files.length, 'file')}` } : undefined;
    this.view.description = files.length
      ? this.mode === 'round'
        ? `${plural(this.groups.length, 'prompt')} · ${plural(files.length, 'file')}`
        : plural(files.length, 'file')
      : undefined;
  }

  /** The pending hunks of a round (optionally limited to one file), for round grouping */
  roundHunks(roundId: string, file?: string): Map<string, string[]> {
    const groups = this.mode === 'round' ? this.groups : this.rounds.group(this.files());
    const g = groups.find((x) => x.roundId === roundId);
    if (!g) return new Map();
    return file ? new Map(g.files.has(file) ? [[file, g.files.get(file)!]] : []) : g.files;
  }

  getChildren(el?: ReviewNode): ReviewNode[] {
    if (!el) {
      return this.mode === 'round'
        ? this.groups.map((g) => ({ type: 'round', roundId: g.roundId }))
        : this.files().map((f) => ({ type: 'file', path: f.path }));
    }
    switch (el.type) {
      case 'file': {
        const f = this.model.getFile(el.path);
        if (!f || f.kind !== 'text' || !f.existed) return [];
        return f.hunks.map((h) => ({ type: 'hunk', path: el.path, hunkId: h.id }));
      }
      case 'round': {
        const g = this.groups.find((x) => x.roundId === el.roundId);
        return g ? [...g.files.keys()].map((p) => ({ type: 'roundFile', roundId: el.roundId, path: p })) : [];
      }
      case 'roundFile': {
        const ids = this.groups.find((x) => x.roundId === el.roundId)?.files.get(el.path) ?? [];
        return ids.map((id) => ({ type: 'hunk', path: el.path, hunkId: id }));
      }
      default:
        return [];
    }
  }

  getParent(el: ReviewNode): ReviewNode | undefined {
    if (el.type === 'roundFile') return { type: 'round', roundId: el.roundId };
    if (el.type !== 'hunk') return undefined;
    if (this.mode === 'file') return { type: 'file', path: el.path };
    const g = this.groups.find((x) => x.files.get(el.path)?.includes(el.hunkId));
    return g ? { type: 'roundFile', roundId: g.roundId, path: el.path } : undefined;
  }

  getTreeItem(el: ReviewNode): vscode.TreeItem {
    switch (el.type) {
      case 'file':
        return this.fileItem(el.path);
      case 'hunk':
        return this.hunkItem(el.path, el.hunkId);
      case 'round':
        return this.roundItem(el.roundId);
      case 'roundFile':
        return this.roundFileItem(el.roundId, el.path);
    }
  }

  private fileItem(file: string): vscode.TreeItem {
    const f = this.model.getFile(file);
    const item = new vscode.TreeItem(vscode.Uri.file(file));
    item.id = `f:${file}`;
    item.description = [relDir(file), fileState(f)].filter(Boolean).join('  ');
    item.tooltip = file;
    item.contextValue = 'ccReview.file';
    const expandable = !!f && f.kind === 'text' && f.existed && !f.missing && f.hunks.length > 0;
    item.collapsibleState = expandable
      ? f!.hunks.length <= 10
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    item.command = f?.missing
      ? { command: 'ccReview.openDiff', title: 'Open Diff', arguments: [file] }
      : { command: 'ccReview.openFile', title: 'Open', arguments: [file] };
    return item;
  }

  private hunkItem(file: string, hunkId: string): vscode.TreeItem {
    const f = this.model.getFile(file);
    const h = f?.hunks.find((x) => x.id === hunkId);
    const item = new vscode.TreeItem(h ? hunkLabel(h) : '(outdated)');
    item.id = `h:${file}:${hunkId}`;
    if (h && f) {
      const first = (h.added ? f.curLines[h.curStart] : h.removed[0])?.trim() ?? '';
      item.description = `${counts(h.added, h.removed.length)}  ${first.slice(0, 80)}`;
      item.iconPath = new vscode.ThemeIcon(h.added && h.removed.length ? 'diff-modified' : h.added ? 'diff-added' : 'diff-removed');
      const md = new vscode.MarkdownString();
      const round = this.mode === 'file' ? this.rounds.title(this.rounds.roundOf(f, h.id)) : undefined;
      if (round) md.appendMarkdown(`From your message: ${round.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&')}\n\n`);
      if (h.removed.length) md.appendCodeblock(h.removed.slice(0, 20).map((l) => '- ' + l).join('\n'), 'diff');
      if (h.added) md.appendCodeblock(f.curLines.slice(h.curStart, h.curStart + Math.min(h.added, 20)).map((l) => '+ ' + l).join('\n'), 'diff');
      item.tooltip = md;
    }
    item.contextValue = 'ccReview.hunk';
    item.command = { command: 'ccReview.revealHunk', title: 'Go to Change', arguments: [file, hunkId] };
    return item;
  }

  private roundItem(roundId: string): vscode.TreeItem {
    const g = this.groups.find((x) => x.roundId === roundId);
    const meta = g?.meta;
    const label = roundId === OTHER_ROUND ? 'Other changes (not linked to a prompt)' : promptTitle(meta);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `r:${roundId}`;
    const files = g?.files.size ?? 0;
    item.description = [plural(files, 'file'), plural(g?.hunkCount ?? 0, 'change'), meta ? formatTime(meta.ts) : ''].filter(Boolean).join(' · ');
    if (meta) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Your message** · ${formatTime(meta.ts)}\n\n`);
      md.appendCodeblock(meta.prompt ?? '(prompt text not recorded)', 'text');
      if (meta.session) md.appendMarkdown(`\n\nSession \`${meta.session}\``);
      item.tooltip = md;
    }
    item.iconPath = new vscode.ThemeIcon(roundId === OTHER_ROUND ? 'question' : 'comment-discussion');
    item.contextValue = roundId === OTHER_ROUND ? 'ccReview.roundOther' : 'ccReview.round';
    return item;
  }

  private roundFileItem(roundId: string, file: string): vscode.TreeItem {
    const f = this.model.getFile(file);
    const ids = this.groups.find((x) => x.roundId === roundId)?.files.get(file) ?? [];
    const hs = ids.map((id) => f?.hunks.find((h) => h.id === id)).filter((h): h is Hunk => !!h);
    const item = new vscode.TreeItem(vscode.Uri.file(file), hs.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = `rf:${roundId}:${file}`;
    const state = hs.length ? counts(hs.reduce((n, h) => n + h.added, 0), hs.reduce((n, h) => n + h.removed.length, 0)) : fileState(f);
    item.description = [relDir(file), state].filter(Boolean).join('  ');
    item.tooltip = roundId ? `${file}\nClick to see what this prompt changed in the file` : file;
    // Files in the "other changes" group also act only on that group's hunks, so no whole-file buttons
    item.contextValue = 'ccReview.roundFile';
    item.command =
      roundId === OTHER_ROUND
        ? { command: 'ccReview.openFile', title: 'Open', arguments: [file] }
        : { command: 'ccReview.openRoundDiff', title: "Show This Prompt's Changes", arguments: [roundId, file] };
    return item;
  }

  dispose(): void {
    this.view.dispose();
    this.emitter.dispose();
  }
}
