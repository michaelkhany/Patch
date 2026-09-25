'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * The tool registry: every tool the agent can call, with its JSON schema
 * (sent to models with native tool calling, rendered as text otherwise),
 * its permission class, and its executor.
 *
 * Executors receive (args, ctx) where ctx = {
 *   cwd, settings, gate, signal, emit, host, readOverride, confine, onOutput
 * }. `host` is what the VS Code layer provides (diagnostics, writeFile that
 * goes through WorkspaceEdit, …); every tool works without it.
 */

const path = require('path');
const fsTools = require('./fs');
const shell = require('./shell');
const packages = require('./packages');
const web = require('./web');
const runner = require('./runner');
const patch = require('../patch');
const languages = require('../languages');

function schema(name, description, properties, required) {
  return { name, description, parameters: { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false } };
}

function str(description) { return { type: 'string', description }; }
function int(description) { return { type: 'integer', description }; }
function bool(description) { return { type: 'boolean', description }; }

const TOOLS = [
  {
    ...schema('Read', 'Read a text file from the workspace as numbered lines. Read before you edit.',
      { path: str('File path, relative to the workspace root.'), offset: int('First line to show (1-based). Default 1.'), limit: int('How many lines to show. Default 2000.') }, ['path']),
    async execute(args, ctx) { return fsTools.readFile(ctx.cwd, args, ctx); },
  },
  {
    ...schema('Write', 'Create or overwrite a file with the given content. Use Edit for small changes to an existing file.',
      { path: str('File path, relative to the workspace root.'), content: str('The complete file content.') }, ['path', 'content']),
    async execute(args, ctx) { return fsTools.writeFile(ctx.cwd, args, ctx); },
    describe: (args) => `Write ${args.path}`,
  },
  {
    ...schema('Edit', 'Replace an exact string in a file. old_string must match exactly once (include enough context) unless replace_all is true.',
      { path: str('File path, relative to the workspace root.'), old_string: str('The exact text to replace.'), new_string: str('The replacement text.'), replace_all: bool('Replace every occurrence. Default false.') }, ['path', 'old_string', 'new_string']),
    async execute(args, ctx) { return fsTools.editFile(ctx.cwd, args, ctx); },
    describe: (args) => `Edit ${args.path}`,
  },
  {
    ...schema('ListDir', 'List a directory as a tree (ignoring node_modules, .git, build output).',
      { path: str('Directory, relative to the workspace root. Default ".".'), depth: int('Levels to show (1-6). Default 2.') }, []),
    async execute(args, ctx) { return fsTools.listDir(ctx.cwd, args, ctx); },
  },
  {
    ...schema('Glob', 'Find files by glob pattern, newest first, e.g. "**/*.test.ts" or "src/**/*.py".',
      { pattern: str('Glob pattern.'), path: str('Directory to search. Default ".".') }, ['pattern']),
    async execute(args, ctx) { return fsTools.glob(ctx.cwd, args, ctx); },
  },
  {
    ...schema('Grep', 'Search file contents with a regular expression. Returns path:line: text.',
      { pattern: str('Regular expression (JavaScript syntax).'), path: str('Directory or file to search. Default ".".'), glob: str('Only files matching this glob, e.g. "*.py".'), case_insensitive: bool('Ignore case.'), max_results: int('Cap on matches (default 100).'), context: int('Lines of context around each match (0-5).') }, ['pattern']),
    async execute(args, ctx) { return fsTools.grep(ctx.cwd, args, ctx); },
  },
  {
    ...schema('Shell', 'Run ONE command in the workspace (no shell: no pipes, no &&, no redirects). Read-only inspections run immediately; anything else asks the user first.',
      { command: str('The command line, e.g. "npm test" or "python -m pytest tests/".'), reason: str('Why you need it (shown to the user).'), timeout: int('Seconds before the command is killed. Default from settings.'), cwd: str('Subdirectory to run in, relative to the workspace.') }, ['command']),
    classify(args) {
      const c = shell.classify(args.command);
      return { readOnly: c.readOnly, destructive: shell.isDestructive(args.command), why: c.why };
    },
    async execute(args, ctx) {
      const cwd = args.cwd ? fsTools.resolvePath(ctx.cwd, args.cwd, { confine: ctx.confine, mustExist: true }) : ctx.cwd;
      const timeoutMs = 1000 * Math.max(5, Math.min(Number(args.timeout) || ctx.settings.commandTimeoutSeconds, 3600));
      return shell.run(args.command, { cwd, timeoutMs, env: ctx.settings.env, signal: ctx.signal, onOutput: ctx.onOutput });
    },
    describe: (args) => `Shell: ${args.command}`,
  },
  {
    ...schema('RunCode', 'Write a complete script in the given language, run it, and get stdout/stderr/exit code plus any files it produced. A missing package is installed (with permission) and the script re-run. Use this to test an idea, reproduce a bug, or perform an analysis.',
      { language: str(`One of: ${languages.runnable().join(', ')}.`), code: str('The COMPLETE, self-contained script.'), reason: str('What the script is for (shown to the user).'), filename: str('Optional file name for the script, e.g. "check.py".'), stdin: str('Optional text piped to the script\'s standard input.') }, ['language', 'code']),
    classify(args) { return { readOnly: false, destructive: shell.isDestructive(args.code || '') && /\b(rm|del|format|mkfs|diskpart)\b/i.test(String(args.code)) }; },
    async execute(args, ctx) {
      const timeoutMs = 1000 * ctx.settings.runTimeoutSeconds;
      const result = await runner.run(String(args.code || ''), args.language, {
        cwd: ctx.cwd, timeoutMs, env: ctx.settings.env, signal: ctx.signal, onOutput: ctx.onOutput,
        filename: args.filename, stdin: args.stdin, gate: ctx.gate, emit: ctx.emit,
      });
      return {
        success: result.success, exitCode: result.exitCode, language: result.language, command: result.command,
        stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: result.durationMs,
        files: (result.files || []).map((f) => fsTools.relOf(ctx.cwd, f)), notes: result.notes, scriptPath: result.scriptPath ? fsTools.relOf(ctx.cwd, result.scriptPath) : undefined,
      };
    },
    describe: (args) => `Run ${args.language} script${args.reason ? ': ' + args.reason : ''}`,
  },
  {
    ...schema('Install', 'Install packages with a package manager so the work can continue. Always asks the user first.',
      { manager: str('pip, npm, npm-dev, pnpm, yarn, r, gem, go, cargo, dotnet or composer.'), packages: { type: 'array', items: { type: 'string' }, description: 'Package names (optionally with version specifiers).' }, reason: str('Why they are needed.') }, ['manager', 'packages']),
    classify(args) { return { readOnly: false, destructive: false }; },
    async execute(args, ctx) {
      const result = await packages.install(args.manager, args.packages, { cwd: ctx.cwd, env: ctx.settings.env, signal: ctx.signal, onOutput: ctx.onOutput });
      return { success: result.success, installed: result.installed, rejected: result.rejected, command: result.command, stdout: result.stdout, stderr: result.stderr, error: result.error };
    },
    describe: (args) => `Install (${args.manager}): ${(args.packages || []).join(' ')}`,
    commandOf: (args) => { const argv = packages.installCommand(args.manager, args.packages || [], {}); return argv ? argv.join(' ') : ''; },
  },
  {
    ...schema('WebSearch', 'Search the web (DuckDuckGo, no account needed). Look up an API, an error message or documentation instead of guessing.',
      { query: str('The search query.'), max_results: int('1-10, default 6.') }, ['query']),
    async execute(args, ctx) {
      if (ctx.settings.webSearch === false || (ctx.settings.sandbox && ctx.settings.sandbox.allowNetwork === false)) return { error: 'Web access is disabled in Patch Code settings.' };
      return web.search(args.query, { maxResults: args.max_results, signal: ctx.signal });
    },
  },
  {
    ...schema('WebFetch', 'Fetch a web page or API URL and return its text (HTML converted to plain text).',
      { url: str('The http(s) URL.'), max_chars: int('Cap on the returned text (default 12000).') }, ['url']),
    async execute(args, ctx) {
      if (ctx.settings.webSearch === false || (ctx.settings.sandbox && ctx.settings.sandbox.allowNetwork === false)) return { error: 'Web access is disabled in Patch Code settings.' };
      return web.fetchPage(args.url, { maxChars: args.max_chars, signal: ctx.signal });
    },
  },
  {
    ...schema('Diagnostics', 'The problems VS Code currently reports (errors, warnings from language servers and linters), optionally for one file.',
      { path: str('Limit to this file (relative to the workspace).') }, []),
    async execute(args, ctx) {
      if (!ctx.host || !ctx.host.diagnostics) return { error: 'Diagnostics are only available inside VS Code.' };
      return ctx.host.diagnostics(args.path ? fsTools.resolvePath(ctx.cwd, args.path, { confine: ctx.confine }) : null);
    },
  },
  {
    ...schema('KnowledgeGraph', 'What a file already defines: imports, functions with signatures, classes, top-level variables, files it touches. Read it before adding to a file so you reuse instead of redefining.',
      { path: str('File path, relative to the workspace root.') }, ['path']),
    async execute(args, ctx) {
      const read = fsTools.readFile(ctx.cwd, { path: args.path, limit: 5000 }, ctx);
      if (read.error) return read;
      if (read.binary) return { error: 'Binary file.' };
      const raw = read.content.split('\n').map((l) => l.replace(/^\s*\d+\t/, '')).join('\n');
      const lang = languages.byFilename(args.path);
      const graph = patch.analyse(raw, lang ? lang.id : 'plaintext');
      return { path: read.path, graph, summary: patch.graphPrompt(graph) };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** OpenAI function specs. `names` restricts the set (e.g. plan mode). */
function specs(names) {
  return TOOLS.filter((t) => !names || names.includes(t.name)).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function get(name) {
  return BY_NAME.get(name) || null;
}

function names() {
  return TOOLS.map((t) => t.name);
}

/** A one-line human description of a call. */
function describe(name, args) {
  const tool = get(name);
  if (!tool) return name;
  if (tool.describe) return tool.describe(args || {});
  const subject = (args && (args.path || args.pattern || args.query || args.url)) || '';
  return subject ? `${name} ${subject}` : name;
}

/** Best-effort exact command a permission prompt should show. */
function commandOf(name, args) {
  const tool = get(name);
  if (tool && tool.commandOf) return tool.commandOf(args || {});
  if (name === 'Shell') return String((args && args.command) || '');
  if (name === 'RunCode') return `${args.language || ''} script (${String(args.code || '').split('\n').length} lines)`;
  return '';
}

module.exports = { TOOLS, specs, get, names, describe, commandOf, path };
