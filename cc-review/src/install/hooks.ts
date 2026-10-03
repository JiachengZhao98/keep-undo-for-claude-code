// Add / remove our three hooks in ~/.claude/settings.json: merge instead of overwrite, back up first, and confirm via a diff.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { writeAtomic } from '../core/fsutil';
import type { Layout } from '../core/paths';
import { addOurHooks, detectIndent, ourHooksInstalled, removeOurHooks } from './hookConfig';

export const PREVIEW_SCHEME = 'cc-review-preview';

export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function readSettings(file: string): { text: string; json: Record<string, unknown> } {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (!text.trim()) return { text, json: {} };
  const json = JSON.parse(text) as unknown;
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('the top level of settings.json is not an object');
  return { text, json: json as Record<string, unknown> };
}

export function hooksInstalled(L: Layout): boolean {
  try {
    return ourHooksInstalled(readSettings(claudeSettingsPath()).json, L.hookScript);
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Find a stable absolute node path: setting > Homebrew / system locations > node from a login shell */
export async function findNode(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('ccReview').get<string>('nodePath')?.trim();
  if (configured) return isExecutable(configured) ? configured : undefined;
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) if (isExecutable(p)) return p;
  const shell = process.env.SHELL || '/bin/zsh';
  const found = await new Promise<string | undefined>((resolve) => {
    execFile(shell, ['-lc', 'command -v node'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const line = stdout
        .split('\n')
        .map((s) => s.trim())
        .reverse()
        .find((s) => s.startsWith('/'));
      resolve(line);
    });
  });
  return found && isExecutable(found) ? found : undefined;
}

export class PreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(name: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${name}` });
    this.docs.set(uri.path, text);
    this.emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? '';
  }
}

async function applyChange(
  preview: PreviewProvider,
  file: string,
  oldText: string,
  newText: string,
  title: string,
  question: string,
  action: string,
): Promise<boolean> {
  if (oldText === newText) return true;
  const left = preview.set('settings.before.json', oldText);
  const right = preview.set('settings.after.json', newText);
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  const pick = await vscode.window.showInformationMessage(question, { modal: true, detail: `${file}\nThe current file will be backed up as settings.json.cc-review.bak.` }, action);
  if (pick !== action) return false;
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.cc-review.bak');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, newText);
  return true;
}

export async function installHooks(L: Layout, preview: PreviewProvider): Promise<boolean> {
  const file = claudeSettingsPath();
  let current: { text: string; json: Record<string, unknown> };
  try {
    current = readSettings(file);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not parse ${file}: ${e instanceof Error ? e.message : String(e)}. Fix the file first.`);
    return false;
  }
  const node = await findNode();
  if (!node) {
    void vscode.window.showErrorMessage('Could not find node. Set the ccReview.nodePath setting to the absolute path of node.');
    return false;
  }
  const trackBash = vscode.workspace.getConfiguration('ccReview').get<boolean>('trackBash') ?? false;
  const next = addOurHooks(current.json, { node, script: L.hookScript, trackBash });
  const newText = JSON.stringify(next, null, detectIndent(current.text)) + '\n';
  const ok = await applyChange(
    preview,
    file,
    current.text,
    newText,
    'settings.json ↔ After Installing Claude Review Hooks',
    `Add ${trackBash ? 5 : 3} hooks to your Claude Code settings?`,
    'Install',
  );
  if (ok) void vscode.window.showInformationMessage('Hooks installed. Claude Code picks up the new settings automatically; files Claude edits from now on will appear under "Claude Changes".');
  return ok;
}

export async function uninstallHooks(L: Layout, preview: PreviewProvider): Promise<boolean> {
  const file = claudeSettingsPath();
  let current: { text: string; json: Record<string, unknown> };
  try {
    current = readSettings(file);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const next = removeOurHooks(current.json, L.hookScript);
  const newText = JSON.stringify(next, null, detectIndent(current.text)) + '\n';
  if (JSON.stringify(next) === JSON.stringify(current.json)) {
    void vscode.window.showInformationMessage('settings.json has no Claude Review hooks.');
    return true;
  }
  return applyChange(preview, file, current.text, newText, 'settings.json ↔ After Removing Claude Review Hooks', 'Remove the Claude Review hooks from your Claude Code settings?', 'Remove');
}
