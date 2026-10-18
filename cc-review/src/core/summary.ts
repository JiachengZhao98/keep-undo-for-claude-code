// Short summaries of Claude's changes: the end-of-turn notification and the bar above each changed file.
import * as path from 'node:path';
import type { PendingFile } from './model';
import { plural } from './text';

const MAX_NAMES = 3;

/** "Claude changed 2 files: README.md, app.ts" */
export function turnSummaryMessage(files: readonly string[]): string {
  const names = files.slice(0, MAX_NAMES).map((f) => path.basename(f));
  const more = files.length - names.length;
  return `Claude changed ${plural(files.length, 'file')}: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** The text beside a file's Keep / Undo buttons: "Claude changed this file · 2 changes · +5 −3" */
export function fileChangeSummary(pf: Pick<PendingFile, 'existed' | 'kind' | 'hunks' | 'addedCount' | 'removedCount'>): string {
  if (!pf.existed) return 'New file from Claude';
  if (pf.kind !== 'text') return `Claude changed this ${pf.kind === 'binary' ? 'binary' : 'large'} file`;
  const counts = [pf.addedCount ? `+${pf.addedCount}` : '', pf.removedCount ? `−${pf.removedCount}` : ''].filter(Boolean).join(' ');
  return `Claude changed this file · ${plural(pf.hunks.length, 'change')}${counts ? ` · ${counts}` : ''}`;
}
