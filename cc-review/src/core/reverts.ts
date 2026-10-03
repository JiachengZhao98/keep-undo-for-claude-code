// Revert records: the extension appends one to reverts.jsonl after each Undo; the UserPromptSubmit hook reads them and tells Claude.
import * as path from 'node:path';
import { isUnder } from './paths';
import { plural } from './text';

export type RevertKind =
  | 'modified' // Modified lines restored to their original content
  | 'added' // Lines Claude added were removed
  | 'deleted' // Lines Claude deleted were restored
  | 'file' // The whole file was restored to its pre-change content
  | 'newfile' // A file Claude created was deleted
  | 'restored'; // A deleted file was recreated

export interface RevertRecord {
  type: 'revert';
  id: string;
  path: string;
  kind: RevertKind;
  /** Affected lines in the file after the revert (1-based, inclusive) */
  startLine?: number;
  endLine?: number;
  /** Content Claude wrote that was reverted (excerpt) */
  undone?: string[];
  /** Original content that was restored (excerpt) */
  restored?: string[];
  count?: number;
  sessions: string[];
  /** The hunk, so this record can be cancelled if you press ⌘Z to undo the Undo */
  hunkId?: string;
  ts: number;
}

export interface RevertCancel {
  type: 'cancel';
  id: string;
  ts: number;
}

export type RevertLine = RevertRecord | RevertCancel;

const MAX_PREVIEW_LINES = 4;
const MAX_PREVIEW_CHARS = 160;
const MAX_RECORDS = 20;

export function preview(lines: readonly string[]): string[] {
  const out = lines.slice(0, MAX_PREVIEW_LINES).map((l) => (l.length > MAX_PREVIEW_CHARS ? l.slice(0, MAX_PREVIEW_CHARS) + '…' : l));
  if (lines.length > MAX_PREVIEW_LINES) out.push(`… (${lines.length} lines in total)`);
  return out;
}

function displayPath(p: string, cwd: string | undefined): string {
  return cwd && isUnder(p, cwd) ? path.relative(cwd, p) || path.basename(p) : p;
}

/** " line 3" or " lines 3–4" (with a leading space); empty when the record has no line numbers */
function range(r: RevertRecord, prefix = ''): string {
  if (r.startLine === undefined) return '';
  const lines = r.endLine !== undefined && r.endLine !== r.startLine ? `lines ${r.startLine}–${r.endLine}` : `line ${r.startLine}`;
  return ` ${prefix}${lines}`;
}

function block(lines: readonly string[] | undefined): string {
  if (!lines || lines.length === 0) return '';
  return '\n' + lines.map((l) => '    ' + l).join('\n');
}

export function describeRevert(r: RevertRecord, cwd: string | undefined): string {
  const p = displayPath(r.path, cwd);
  switch (r.kind) {
    case 'modified':
      return `- ${p}${range(r)}: the user reverted your edit; these lines are back to their original content. Reverted content:${block(r.undone)}`;
    case 'added': {
      const n = r.count ?? r.undone?.length ?? 0;
      return `- ${p}${range(r, 'at ')}: the user deleted the ${n === 1 ? 'line' : `${n} lines`} you added:${block(r.undone)}`;
    }
    case 'deleted':
      return `- ${p}${range(r)}: the user restored lines you had deleted:${block(r.restored)}`;
    case 'file':
      return `- ${p}: the user reverted all of your changes to this file; it is back to its content from before your edits.`;
    case 'newfile':
      return `- ${p}: the user deleted this file, which you had created.`;
    case 'restored':
      return `- ${p}: the user restored this file, which you had deleted.`;
  }
}

/** Phrased as statements of fact, not instructions, so it is not mistaken for prompt injection. */
export function formatRevertReport(records: readonly RevertRecord[], cwd: string | undefined): string {
  const shown = records.slice(-MAX_RECORDS);
  const lines = [
    '[cc-review] Since your last message, the user reverted some of your changes in the editor. These files now differ from what you last wrote:',
    ...shown.map((r) => describeRevert(r, cwd)),
  ];
  if (records.length > shown.length) lines.push(`(${plural(records.length - shown.length, 'earlier revert')} not shown)`);
  return lines.join('\n') + '\n';
}
