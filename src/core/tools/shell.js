'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Running commands for the agent - as first implemented in DAYA Studio's agent_tools.run_shell
 * and patch_agent.HARD_BLOCK.
 *
 * Commands are split into argv and run WITHOUT a shell, so pipes, chaining
 * and redirects cannot happen at all; a command that contains them is
 * classified as consequential (never read-only). A short list of inspection
 * commands runs without asking; anything else goes through the permission
 * gate; a handful of destructive commands are refused even when approved.
 */

const { spawn } = require('child_process');
const path = require('path');

const SAFE_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'find', 'stat', 'file', 'du', 'df', 'echo',
  'which', 'where', 'whoami', 'date', 'env', 'printenv', 'uname', 'type', 'tree',
  'python', 'python3', 'pip', 'pip3', 'rscript', 'r', 'conda', 'node', 'npm', 'npx', 'pnpm', 'yarn',
  'git', 'go', 'cargo', 'java', 'javac', 'dotnet', 'ruby', 'gem', 'php', 'perl', 'rustc', 'tsc', 'gcc', 'g++', 'clang',
]);

const SAFE_SUBCOMMANDS = {
  pip: ['list', 'show', '--version', '-V', 'freeze', 'check'],
  pip3: ['list', 'show', '--version', '-V', 'freeze', 'check'],
  conda: ['list', 'info', '--version'],
  python: ['--version', '-V'],
  python3: ['--version', '-V'],
  node: ['--version', '-v'],
  npm: ['--version', '-v', 'ls', 'list', 'view', 'outdated', 'why', 'config'],
  npx: ['--version'],
  pnpm: ['--version', 'ls', 'list'],
  yarn: ['--version', 'list', 'why'],
  git: ['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag', 'config', 'stash', 'shortlog'],
  go: ['version', 'env', 'list', 'vet'],
  cargo: ['--version', 'metadata', 'tree', 'check'],
  java: ['-version', '--version'],
  javac: ['-version', '--version'],
  dotnet: ['--version', '--info', '--list-sdks', '--list-runtimes'],
  ruby: ['--version', '-v'],
  gem: ['list', '--version'],
  php: ['--version', '-v'],
  perl: ['--version', '-v'],
  rustc: ['--version'],
  tsc: ['--version', '-v'],
  gcc: ['--version'],
  'g++': ['--version'],
  clang: ['--version'],
  r: ['--version'],
  rscript: ['--version'],
};
// git sub-commands that mutate even though the program is listed as safe.
const GIT_MUTATING = new Set(['stash']);

const SHELL_METACHARACTERS = ['&&', '||', '|', ';', '>', '<', '`', '$(', '\n', '\r'];

const HARD_BLOCK = [
  /^\s*rm\s+(-[a-zA-Z]*\s+)*-?[rRf]{1,2}\s+(\/|~|\*|\$HOME)(\s|$|\*)/,
  /^\s*rm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+.*(\/|\\)\s*$/,
  /\bmkfs(\.|\s)/,
  /\bdd\s+.*of=\/dev\/(sd|nvme|hd)/,
  /^\s*(del|erase)\s+\/[sfq].*[a-zA-Z]:\\(\s|$|\*)/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\b(Stop|Restart)-Computer\b/i,
  /\bRemove-Item\b.*-Recurse.*(\\|\/)\s*$/i,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+checkout\s+--\s+\./,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bchmod\s+(-R\s+)?777\s+\//,
];

function isDestructive(command) {
  const text = String(command || '');
  return HARD_BLOCK.some((re) => re.test(text));
}

/** Split into argv without a shell. Handles quotes on both platforms. */
function splitCommand(text) {
  const out = [];
  let current = '';
  let quote = null;
  let has = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < s.length && '"\\'.includes(s[i + 1])) { current += s[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' && process.platform !== 'win32' && i + 1 < s.length) { current += s[++i]; has = true; continue; }
    if (/\s/.test(ch)) {
      if (current || has) { out.push(current); current = ''; has = false; }
      continue;
    }
    current += ch;
    has = true;
  }
  if (quote) throw new Error('unterminated quote');
  if (current || has) out.push(current);
  return out;
}

/** (readOnly, why). Chained or redirected commands are never read-only. */
function classify(command) {
  const text = String(command || '').trim();
  if (!text) return { readOnly: false, why: 'empty command' };
  if (SHELL_METACHARACTERS.some((token) => text.includes(token))) return { readOnly: false, why: 'chains, pipes or redirects the output' };
  let parts;
  try { parts = splitCommand(text); } catch (_) { return { readOnly: false, why: 'unbalanced quotes' }; }
  if (!parts.length) return { readOnly: false, why: 'empty command' };
  let program = path.basename(parts[0]).toLowerCase();
  if (program.endsWith('.exe') || program.endsWith('.cmd')) program = program.replace(/\.(exe|cmd)$/, '');
  if (!SAFE_COMMANDS.has(program)) return { readOnly: false, why: `'${program}' is not on the read-only list` };
  const allowed = SAFE_SUBCOMMANDS[program];
  if (allowed) {
    if (parts.length < 2 || !allowed.includes(parts[1])) return { readOnly: false, why: `'${program}' is only read-only for ${allowed.join(', ')}` };
    if (program === 'git' && GIT_MUTATING.has(parts[1])) return { readOnly: false, why: 'git stash changes the working tree' };
    if (program === 'git' && parts[1] === 'config' && !parts.slice(2).some((p) => p === '--get' || p === '--list' || p === '-l')) {
      return { readOnly: false, why: 'git config without --get/--list writes' };
    }
  }
  if (['python', 'python3', 'node', 'ruby', 'perl', 'php'].includes(program) && parts.some((p) => p === '-c' || p === '-e')) {
    return { readOnly: false, why: `${program} -c/-e runs arbitrary code` };
  }
  return { readOnly: true, why: 'read-only inspection' };
}

function trimTail(text, limit) {
  const s = String(text || '');
  return s.length > limit ? '…' + s.slice(-limit) : s;
}

/**
 * Run one command (argv, no shell) in `cwd`. Resolves to a result object; never rejects.
 * `onOutput(chunk, stream)` streams output. `signal` cancels.
 */
function run(command, { cwd, timeoutMs = 120000, env, signal, onOutput, stdin } = {}) {
  return new Promise((resolve) => {
    const text = String(command || '').trim();
    if (!text) return resolve({ success: false, exitCode: null, stdout: '', stderr: '', error: 'No command was given.' });
    let argv;
    try { argv = splitCommand(text); } catch (error) {
      return resolve({ success: false, exitCode: null, stdout: '', stderr: '', error: `Could not parse the command: ${error.message}` });
    }
    if (!argv.length) return resolve({ success: false, exitCode: null, stdout: '', stderr: '', error: 'No command was given.' });
    runArgv(argv, { cwd, timeoutMs, env, signal, onOutput, stdin, command: text }).then(resolve);
  });
}

function runArgv(argv, { cwd, timeoutMs = 120000, env, signal, onOutput, stdin, command } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    let child;
    const started = Date.now();
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve({ command: command || argv.join(' '), durationMs: Date.now() - started, ...result });
    };
    const mergedEnv = { ...process.env, ...(env || {}), NO_COLOR: '1', CI: '1', TERM: 'dumb', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
    try {
      // .cmd/.bat launchers on Windows (npm, npx, tsc…) need a shell wrapper; spawn without one otherwise.
      const needsCmd = process.platform === 'win32' && /^(npm|npx|pnpm|yarn|tsc|code|cargo-script|dotnet-script|kotlinc|scala-cli)$/i.test(path.basename(argv[0]));
      child = needsCmd
        ? spawn('cmd.exe', ['/d', '/s', '/c', argv.map(quoteWin).join(' ')], { cwd, env: mergedEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(argv[0], argv.slice(1), { cwd, env: mergedEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      return finish({ success: false, exitCode: null, stdout, stderr, error: `${error.code === 'ENOENT' ? 'Command not found' : error.message}: ${argv[0]}` });
    }
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    child.stdout.on('data', (chunk) => { const s = chunk.toString('utf8'); stdout += s; if (onOutput) onOutput(s, 'stdout'); });
    child.stderr.on('data', (chunk) => { const s = chunk.toString('utf8'); stderr += s; if (onOutput) onOutput(s, 'stderr'); });
    const timer = setTimeout(() => { timedOut = true; kill(child); }, timeoutMs);
    const onAbort = () => kill(child);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ success: false, exitCode: null, stdout, stderr, error: error.code === 'ENOENT' ? `Command not found: ${argv[0]}` : error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return finish({ success: false, exitCode: code, stdout: trimTail(stdout, 6000), stderr: trimTail(stderr, 4000), error: 'Stopped by user.', cancelled: true });
      if (timedOut) return finish({ success: false, exitCode: code, stdout: trimTail(stdout, 6000), stderr: trimTail(stderr, 4000), error: `The command timed out after ${Math.round(timeoutMs / 1000)}s.` });
      finish({ success: code === 0, exitCode: code, stdout: trimTail(stdout, 6000), stderr: trimTail(stderr, 4000), error: code === 0 ? null : `Exited with code ${code}.` });
    });
  });
}

function quoteWin(arg) {
  if (!/[\s"&|<>^]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '\\"') + '"';
}

function kill(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch (_) { /* already gone */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } }, 2000);
}

module.exports = { run, runArgv, classify, splitCommand, isDestructive, SAFE_COMMANDS, HARD_BLOCK };
