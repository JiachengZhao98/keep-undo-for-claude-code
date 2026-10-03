// Changes by round (prompt_id): each pending hunk is attributed to the round that introduced it; each round has its own diff (before -> after).
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PendingFile } from '../core/model';
import { pathKey } from '../core/paths';
import { attributeHunks, promptTitle, type RoundMeta, type RoundStore } from '../core/rounds';
import { decodeUtf8, plural } from '../core/text';

export const ROUND_SCHEME = 'cc-round';

/** Changes that belong to no recorded round (e.g. from older Claude Code versions without prompt_id) */
export const OTHER_ROUND = '';

export function roundUri(file: string, roundId: string, side: 'before' | 'after'): vscode.Uri {
  return vscode.Uri.from({ scheme: ROUND_SCHEME, path: file, query: new URLSearchParams({ round: roundId, side }).toString() });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:05" today, "Oct 2 14:05" on other days */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

export interface RoundGroup {
  roundId: string;
  meta: RoundMeta | undefined;
  /** file -> hunks attributed to this round (an empty list means the whole file: non-text, new or deleted) */
  files: Map<string, string[]>;
  hunkCount: number;
}

export class RoundService implements vscode.TextDocumentContentProvider {
  private cache = new Map<string, { sig: string; map: Map<string, string | undefined> }>();

  constructor(readonly store: RoundStore) {}

  /** New writes arrived: recompute the round index and attribution */
  invalidate(): void {
    this.store.invalidate();
    this.cache.clear();
  }

  meta(roundId: string): RoundMeta | undefined {
    return roundId ? this.store.get(roundId)?.meta : undefined;
  }

  title(roundId: string | undefined): string | undefined {
    return roundId ? promptTitle(this.meta(roundId)) : undefined;
  }

  /** Which round each hunk of this file came from */
  attribution(pf: PendingFile): Map<string, string | undefined> {
    if (pf.kind !== 'text' || pf.missing) return new Map();
    const rounds = this.store.forPath(pf.path);
    const sig = `${pf.hunks.map((h) => `${h.id}@${h.curStart}`).join(',')}|${rounds.map((r) => `${r.round.promptId}:${r.file.lastTs}`).join(',')}|${pf.curLines.length}`;
    const hit = this.cache.get(pf.path);
    if (hit && hit.sig === sig) return hit.map;
    const map = attributeHunks(pf.hunks, pf.curLines, this.store.chain(pf.path));
    this.cache.set(pf.path, { sig, map });
    return map;
  }

  roundOf(pf: PendingFile, hunkId: string): string | undefined {
    return this.attribution(pf).get(hunkId);
  }

  /** Group pending changes by round, newest first; unattributed changes go last */
  group(files: readonly PendingFile[]): RoundGroup[] {
    const groups = new Map<string, RoundGroup>();
    const add = (roundId: string, file: string, hunkId?: string) => {
      let g = groups.get(roundId);
      if (!g) groups.set(roundId, (g = { roundId, meta: this.meta(roundId), files: new Map(), hunkCount: 0 }));
      const list = g.files.get(file) ?? [];
      if (hunkId) list.push(hunkId);
      g.files.set(file, list);
      g.hunkCount += 1;
    };
    for (const f of files) {
      if (f.kind === 'text' && !f.missing && f.existed) {
        const attr = this.attribution(f);
        for (const h of f.hunks) add(attr.get(h.id) ?? OTHER_ROUND, f.path, h.id);
      } else {
        // Whole-file changes: attribute to the last round that touched the file
        add(this.store.forPath(f.path).at(-1)?.round.promptId ?? OTHER_ROUND, f.path);
      }
    }
    return [...groups.values()].sort((a, b) => (b.roundId ? (b.meta?.ts ?? 0) : -1) - (a.roundId ? (a.meta?.ts ?? 0) : -1));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const q = new URLSearchParams(uri.query);
    const roundId = q.get('round') ?? '';
    const side = q.get('side') === 'before' ? 'before' : 'after';
    const buf = this.store.read(roundId, pathKey(uri.path), side);
    return buf ? (decodeUtf8(buf)?.text ?? '(binary file)') : '';
  }

  /** What this round did to one file: before <-> after the round */
  async openFileDiff(roundId: string, file: string): Promise<void> {
    await vscode.commands.executeCommand(
      'vscode.diff',
      roundUri(file, roundId, 'before'),
      roundUri(file, roundId, 'after'),
      `${path.basename(file)} (${this.title(roundId)})`,
    );
  }

  /** Every file this round changed, in one multi-file diff */
  async openRoundDiff(roundId: string): Promise<void> {
    const entry = this.store.get(roundId);
    if (!entry || entry.files.size === 0) {
      void vscode.window.showInformationMessage('No snapshots were recorded for this prompt.');
      return;
    }
    const resources = [...entry.files.values()].map((f) => [vscode.Uri.file(f.path), roundUri(f.path, roundId, 'before'), roundUri(f.path, roundId, 'after')] as const);
    await vscode.commands.executeCommand('vscode.changes', `Claude Changes: ${promptTitle(entry.meta)}`, resources);
  }

  /** Recent rounds (including fully reviewed ones); pick one to see its changes */
  async pickRound(inScope: (file: string) => boolean): Promise<void> {
    const rounds = this.store.all().filter((r) => [...r.files.values()].some((f) => inScope(f.path)));
    if (rounds.length === 0) {
      void vscode.window.showInformationMessage('No prompts with Claude changes have been recorded yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      rounds.map((r) => ({
        label: `$(comment-discussion) ${promptTitle(r.meta, 80)}`,
        description: `${formatTime(r.meta.ts)} · ${plural(r.files.size, 'file')}`,
        detail: [...r.files.values()].map((f) => path.basename(f.path)).join(', '),
        roundId: r.meta.promptId,
      })),
      { placeHolder: 'Pick a prompt to see what Claude changed in response to it', matchOnDescription: true, matchOnDetail: true },
    );
    if (pick) await this.openRoundDiff(pick.roundId);
  }
}
