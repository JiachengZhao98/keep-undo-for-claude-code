// Runs the integration tests in the locally installed VS Code with separate user-data and extensions
// directories and temp data directories, so neither your running VS Code nor the real ~/.cc-review
// and ~/.claude are touched.
import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-it-')));
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const resultFile = path.join(tmp, 'results.txt');

const vscodeExecutablePath = process.env.VSCODE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

// When run from a VS Code terminal (or Claude Code's VS Code extension) these variables are inherited:
// ELECTRON_RUN_AS_NODE would start VS Code as plain node, and VSCODE_* would connect it to the outer instance
for (const k of Object.keys(process.env)) if (k.startsWith('ELECTRON_') || k.startsWith('VSCODE_')) delete process.env[k];

let code = 0;
try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist/test/suite.js'),
    launchArgs: [
      workspace,
      '--enable-proposed-api',
      'local.cc-review',
      '--disable-extensions',
      `--user-data-dir=${path.join(tmp, 'user-data')}`,
      `--extensions-dir=${path.join(tmp, 'extensions')}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
    ],
    extensionTestsEnv: {
      CC_REVIEW_HOME: path.join(tmp, 'cc-review-home'),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
      CCR_WORKSPACE: workspace,
      CCR_RESULTS: resultFile,
      CCR_NO_TRASH: '1',
    },
  });
} catch (e) {
  console.error('Integration tests failed:', e);
  code = 1;
}
if (fs.existsSync(resultFile)) console.log(fs.readFileSync(resultFile, 'utf8'));
// Clean up on success; keep everything on failure to inspect VS Code logs and the data directory
if (code === 0) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`Temp directory (kept): ${tmp}`);
process.exit(code);
