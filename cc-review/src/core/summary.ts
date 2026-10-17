// The message shown when Claude finishes a turn that left changes to review.
import * as path from 'node:path';
import { plural } from './text';

const MAX_NAMES = 3;

/** "Claude changed 2 files: README.md, app.ts" */
export function turnSummaryMessage(files: readonly string[]): string {
  const names = files.slice(0, MAX_NAMES).map((f) => path.basename(f));
  const more = files.length - names.length;
  return `Claude changed ${plural(files.length, 'file')}: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}
