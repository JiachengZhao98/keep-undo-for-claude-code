// Prefilled text for "Ask Claude about this hunk". No vscode dependency, so it is unit-testable.
import type { Hunk } from './diff';
import type { PendingFile } from './model';
import { plural } from './text';

/** Same format the Claude Code extension inserts on ⌥K: @relative/path#start-end. Like it, refuse paths containing # or ". */
export function formatMention(relPath: string, start: number, end: number): string | undefined {
  if (relPath.includes('#') || relPath.includes('"')) return undefined;
  return start !== end ? `@${relPath}#${start}-${end}` : `@${relPath}#${start}`;
}

const MAX_CONTEXT_LINES = 15;

export function buildAskPrompt(pf: PendingFile, h: Hunk, relPath: string, languageId: string): string {
  const last = Math.max(pf.curLines.length, 1);
  // Added or rewritten lines: mention the new lines. Pure deletion: mention the two lines around the gap.
  const [start, end] = h.added > 0 ? [h.curStart + 1, h.curStart + h.added] : [Math.max(h.curStart, 1), Math.min(h.curStart + 1, last)];
  const where = formatMention(relPath, start, end) ?? (start === end ? `${relPath} line ${start}` : `${relPath} lines ${start}–${end}`);
  let text = h.added > 0 ? `About your change at ${where}` : `About the lines you deleted ${start === end ? 'at' : 'between'} ${where}`;
  if (h.removed.length > 0) {
    const shown = h.removed.slice(0, MAX_CONTEXT_LINES);
    if (h.removed.length > MAX_CONTEXT_LINES) shown.push(`… (${plural(h.removed.length - MAX_CONTEXT_LINES, 'more line')})`);
    text += `${h.added > 0 ? ', which replaced' : ''}:\n\`\`\`${languageId}\n${shown.join('\n')}\n\`\`\``;
  }
  return text + '\n\n';
}
