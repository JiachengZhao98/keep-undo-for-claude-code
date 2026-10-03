// Green added lines, gutter bars and overview ruler marks; red markers and hovers at deletions (the phantom line fallback).
import * as vscode from 'vscode';
import type { Hunk } from '../core/diff';
import type { PendingFile } from '../core/model';
import { plural } from '../core/text';

export function hunkArgs(path: string, hunkId: string): string {
  return encodeURIComponent(JSON.stringify([path, hunkId]));
}

export function removedHover(pf: PendingFile, h: Hunk, languageId: string, ask: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['ccReview.keepHunk', 'ccReview.undoHunk', 'ccReview.askClaude'] };
  const args = hunkArgs(pf.path, h.id);
  const what = h.added > 0 ? `Claude replaced ${plural(h.removed.length, 'line')} here` : `Claude deleted ${plural(h.removed.length, 'line')}`;
  const askLink = ask ? ` · [$(comment-discussion) Ask Claude](command:ccReview.askClaude?${args})` : '';
  md.appendMarkdown(`**${what}** · [$(check) Keep](command:ccReview.keepHunk?${args}) · [$(discard) Undo](command:ccReview.undoHunk?${args})${askLink}\n`);
  const shown = h.removed.length > 60 ? [...h.removed.slice(0, 60), `… ${plural(h.removed.length - 60, 'more line')}`] : h.removed;
  md.appendCodeblock(shown.join('\n'), languageId);
  return md;
}

export class DecorationPainter implements vscode.Disposable {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly deletedAbove: vscode.TextEditorDecorationType;
  private readonly deletedBelow: vscode.TextEditorDecorationType;

  constructor(media: vscode.Uri) {
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      gutterIconPath: vscode.Uri.joinPath(media, 'added.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    const deleted = (icon: string): vscode.DecorationRenderOptions => ({
      isWholeLine: true,
      gutterIconPath: vscode.Uri.joinPath(media, icon),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    // The deletion happened above this line / below the last line for deletions at the end of the file
    this.deletedAbove = vscode.window.createTextEditorDecorationType(deleted('deleted-above.svg'));
    this.deletedBelow = vscode.window.createTextEditorDecorationType(deleted('deleted-below.svg'));
  }

  /** withHover: without phantom lines, show the removed content in a hover */
  paint(editor: vscode.TextEditor, pf: PendingFile | undefined, withHover: boolean, ask = false): void {
    const added: vscode.DecorationOptions[] = [];
    const above: vscode.DecorationOptions[] = [];
    const below: vscode.DecorationOptions[] = [];
    if (pf && pf.kind === 'text' && !pf.missing) {
      const doc = editor.document;
      const last = doc.lineCount - 1;
      for (const h of pf.hunks) {
        const hover = withHover && h.removed.length > 0 ? removedHover(pf, h, doc.languageId, ask) : undefined;
        if (h.added > 0) {
          const end = Math.min(h.curStart + h.added - 1, last);
          added.push({ range: new vscode.Range(h.curStart, 0, end, 0), hoverMessage: hover });
          // Rewritten hunks show the removed part as phantom lines; in hover mode, also mark "deleted above" on the first line
          if (withHover && h.removed.length > 0) above.push({ range: new vscode.Range(h.curStart, 0, h.curStart, 0) });
        } else if (h.curStart <= last) {
          above.push({ range: new vscode.Range(h.curStart, 0, h.curStart, 0), hoverMessage: hover });
        } else {
          below.push({ range: new vscode.Range(last, 0, last, 0), hoverMessage: hover });
        }
      }
    }
    editor.setDecorations(this.added, added);
    editor.setDecorations(this.deletedAbove, above);
    editor.setDecorations(this.deletedBelow, below);
  }

  dispose(): void {
    this.added.dispose();
    this.deletedAbove.dispose();
    this.deletedBelow.dispose();
  }
}
