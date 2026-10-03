// "Ask Claude about this hunk": open Claude Code with the file, line numbers and original content
// prefilled, in the session that made the change.
// The public interface is the URI handler vscode://anthropic.claude-code/open?prompt=...&session=...
// (the prompt is prefilled, not sent; an unknown session starts a new conversation). The handler only
// calls claude-vscode.primaryEditor.open(session, prompt), which Claude Code declares in its
// package.json. Opening another extension's URI makes VS Code ask "Allow ... to open this URI?", so
// call the command directly when it exists and fall back to the URI otherwise.
import * as vscode from 'vscode';
export { buildAskPrompt, formatMention } from '../core/ask';

export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
export const CLAUDE_OPEN_COMMAND = 'claude-vscode.primaryEditor.open';

export function claudeInstalled(): boolean {
  return !!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
}

/** authority is replaceable so tests can check, with our own extension ID, that the query is decoded exactly once end to end */
export function claudeOpenUri(prompt: string, session?: string, authority = CLAUDE_EXTENSION_ID): vscode.Uri {
  // Claude Code parses with new URLSearchParams(uri.query), so put once-encoded values in the query
  const query = [`prompt=${encodeURIComponent(prompt)}`];
  if (session) query.push(`session=${encodeURIComponent(session)}`);
  return vscode.Uri.from({ scheme: vscode.env.uriScheme, authority, path: '/open', query: query.join('&') });
}

/** Validate the session ID like Claude Code's URI handler (no / \\ .. or NUL); otherwise drop it and start a new conversation */
export function safeSessionId(session: string | undefined): string | undefined {
  return session && !/[/\\\u0000]/.test(session) && !session.includes('..') ? session : undefined;
}

export async function openClaude(prompt: string, session: string | undefined): Promise<'command' | 'uri'> {
  const sid = safeSessionId(session);
  if ((await vscode.commands.getCommands(true)).includes(CLAUDE_OPEN_COMMAND)) {
    await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, sid, prompt);
    return 'command';
  }
  await vscode.env.openExternal(claudeOpenUri(prompt, sid));
  return 'uri';
}
