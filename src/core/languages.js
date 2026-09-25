'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Language registry.
 *
 * Patch Code reads, edits and explains any language VS Code can open - the
 * file tools are language-agnostic, exactly as in Claude Code. This registry
 * adds what a *patch* needs on top of that: the fence tag the model should
 * use, the comment syntax for patch markers, and - where an interpreter or
 * compiler exists - how to RUN a generated script so it can be repaired
 * against its real error output (DAYA's iTailor loop).
 *
 * `run` is a function (scriptPath, ctx) -> argv | null. It may consult ctx
 * ({platform, nodeMajor, cwd}) and return null when no runner applies.
 */

const path = require('path');

const isWin = process.platform === 'win32';

/** @type {Array<Object>} */
const LANGUAGES = [
  { id: 'python', label: 'Python', extensions: ['.py', '.pyw'], fence: 'python', comment: '#',
    run: (script) => [isWin ? 'python' : 'python3', script],
    missingModule: /No module named ['"]([A-Za-z0-9_.]+)['"]/, packageManager: 'pip' },
  { id: 'javascript', label: 'JavaScript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], fence: 'javascript', comment: '//',
    run: (script) => ['node', script],
    missingModule: /Cannot find (?:module|package) '([^']+)'/, packageManager: 'npm' },
  { id: 'typescript', label: 'TypeScript', extensions: ['.ts', '.mts', '.cts', '.tsx'], fence: 'typescript', comment: '//',
    run: (script, ctx) => (ctx && ctx.nodeMajor >= 23 ? ['node', script] : ['npx', '--yes', 'tsx', script]),
    missingModule: /Cannot find (?:module|package) '([^']+)'/, packageManager: 'npm' },
  { id: 'r', label: 'R', extensions: ['.r', '.R', '.rmd'], fence: 'r', comment: '#',
    run: (script) => ['Rscript', script],
    missingModule: /there is no package called ['‘"]([A-Za-z0-9_.]+)['’"]/, packageManager: 'r' },
  { id: 'shellscript', label: 'Bash', extensions: ['.sh', '.bash'], fence: 'bash', comment: '#',
    run: (script) => ['bash', script] },
  { id: 'powershell', label: 'PowerShell', extensions: ['.ps1', '.psm1'], fence: 'powershell', comment: '#',
    run: (script) => [isWin ? 'powershell' : 'pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] },
  { id: 'go', label: 'Go', extensions: ['.go'], fence: 'go', comment: '//',
    run: (script) => ['go', 'run', script], packageManager: 'go' },
  { id: 'rust', label: 'Rust', extensions: ['.rs'], fence: 'rust', comment: '//',
    run: (script) => ['cargo', 'script', script], packageManager: 'cargo' },
  { id: 'java', label: 'Java', extensions: ['.java'], fence: 'java', comment: '//',
    run: (script) => ['java', script] },
  { id: 'kotlin', label: 'Kotlin', extensions: ['.kt', '.kts'], fence: 'kotlin', comment: '//',
    run: (script) => (script.endsWith('.kts') ? ['kotlinc', '-script', script] : null) },
  { id: 'c', label: 'C', extensions: ['.c', '.h'], fence: 'c', comment: '//',
    compile: (script, out) => ['gcc', script, '-o', out], run: null },
  { id: 'cpp', label: 'C++', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'], fence: 'cpp', comment: '//',
    compile: (script, out) => ['g++', '-std=c++17', script, '-o', out], run: null },
  { id: 'csharp', label: 'C#', extensions: ['.cs'], fence: 'csharp', comment: '//',
    run: (script) => ['dotnet', 'run', '--project', path.dirname(script)] },
  { id: 'ruby', label: 'Ruby', extensions: ['.rb'], fence: 'ruby', comment: '#',
    run: (script) => ['ruby', script], packageManager: 'gem' },
  { id: 'php', label: 'PHP', extensions: ['.php'], fence: 'php', comment: '//',
    run: (script) => ['php', script] },
  { id: 'perl', label: 'Perl', extensions: ['.pl', '.pm'], fence: 'perl', comment: '#',
    run: (script) => ['perl', script] },
  { id: 'lua', label: 'Lua', extensions: ['.lua'], fence: 'lua', comment: '--',
    run: (script) => ['lua', script] },
  { id: 'swift', label: 'Swift', extensions: ['.swift'], fence: 'swift', comment: '//',
    run: (script) => ['swift', script] },
  { id: 'dart', label: 'Dart', extensions: ['.dart'], fence: 'dart', comment: '//',
    run: (script) => ['dart', 'run', script] },
  { id: 'julia', label: 'Julia', extensions: ['.jl'], fence: 'julia', comment: '#',
    run: (script) => ['julia', script] },
  { id: 'scala', label: 'Scala', extensions: ['.scala', '.sc'], fence: 'scala', comment: '//',
    run: (script) => ['scala-cli', 'run', script] },
  { id: 'elixir', label: 'Elixir', extensions: ['.ex', '.exs'], fence: 'elixir', comment: '#',
    run: (script) => ['elixir', script] },
  { id: 'haskell', label: 'Haskell', extensions: ['.hs'], fence: 'haskell', comment: '--',
    run: (script) => ['runghc', script] },
  { id: 'sql', label: 'SQL', extensions: ['.sql'], fence: 'sql', comment: '--', run: null },
  { id: 'html', label: 'HTML', extensions: ['.html', '.htm'], fence: 'html', comment: '<!--', commentEnd: '-->', run: null },
  { id: 'css', label: 'CSS', extensions: ['.css', '.scss', '.less'], fence: 'css', comment: '/*', commentEnd: '*/', run: null },
  { id: 'json', label: 'JSON', extensions: ['.json', '.jsonc'], fence: 'json', comment: '//', run: null },
  { id: 'yaml', label: 'YAML', extensions: ['.yml', '.yaml'], fence: 'yaml', comment: '#', run: null },
  { id: 'toml', label: 'TOML', extensions: ['.toml'], fence: 'toml', comment: '#', run: null },
  { id: 'markdown', label: 'Markdown', extensions: ['.md', '.markdown'], fence: 'markdown', comment: '<!--', commentEnd: '-->', run: null },
  { id: 'xml', label: 'XML', extensions: ['.xml', '.xsl', '.svg'], fence: 'xml', comment: '<!--', commentEnd: '-->', run: null },
  { id: 'dockerfile', label: 'Dockerfile', extensions: ['.dockerfile'], fence: 'dockerfile', comment: '#', run: null },
  { id: 'makefile', label: 'Makefile', extensions: ['.mk'], fence: 'makefile', comment: '#', run: null },
  { id: 'plaintext', label: 'Plain text', extensions: ['.txt'], fence: '', comment: '#', run: null },
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));
const BY_EXT = new Map();
for (const lang of LANGUAGES) for (const ext of lang.extensions) BY_EXT.set(ext.toLowerCase(), lang);

/** VS Code language ids that differ from ours. */
const ALIASES = {
  py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  javascriptreact: 'javascript', typescriptreact: 'typescript', sh: 'shellscript', bash: 'shellscript',
  zsh: 'shellscript', shell: 'shellscript', rlang: 'r', rscript: 'r', 'c++': 'cpp', cs: 'csharp',
  golang: 'go', rb: 'ruby', md: 'markdown', yml: 'yaml', jsonc: 'json', dockerfile: 'dockerfile',
  ps1: 'powershell', pwsh: 'powershell', kt: 'kotlin', rs: 'rust', jl: 'julia', hs: 'haskell',
};

function byId(id) {
  const key = String(id || '').toLowerCase();
  return BY_ID.get(key) || BY_ID.get(ALIASES[key]) || null;
}

function byFilename(filename) {
  const base = path.basename(String(filename || ''));
  if (/^dockerfile$/i.test(base)) return BY_ID.get('dockerfile');
  if (/^makefile$/i.test(base)) return BY_ID.get('makefile');
  return BY_EXT.get(path.extname(base).toLowerCase()) || null;
}

/** Resolve "auto" / a vscode language id / an extension / a filename. */
function resolve(hint, filename) {
  const direct = byId(hint);
  if (direct) return direct;
  if (hint && String(hint).startsWith('.')) return BY_EXT.get(String(hint).toLowerCase()) || null;
  if (filename) return byFilename(filename);
  return null;
}

/** The fence tag for a fenced code block, e.g. "python". */
function fenceOf(lang) {
  return (lang && lang.fence) || '';
}

/** Wrap text as a single-line comment in this language. */
function commentLine(lang, text) {
  const open = (lang && lang.comment) || '#';
  const close = lang && lang.commentEnd ? ' ' + lang.commentEnd : '';
  return `${open} ${text}${close}`;
}

/** The languages that can be executed on this machine's PATH (by declaration, not probing). */
function runnable() {
  return LANGUAGES.filter((l) => typeof l.run === 'function' || typeof l.compile === 'function').map((l) => l.id);
}

function summary() {
  return LANGUAGES.map((l) => `${l.label} (${l.extensions.join(', ')})${l.run || l.compile ? '' : ' - edit only'}`).join('; ');
}

module.exports = { LANGUAGES, byId, byFilename, resolve, fenceOf, commentLine, runnable, summary };
