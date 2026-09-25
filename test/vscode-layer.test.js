'use strict';
/**
 * Loads the VS Code layer against a small fake `vscode` module, so wrong API
 * usage (a missing export, a typo in an enum) fails here instead of in the
 * extension host.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; this.path = fsPath.replace(/\\/g, '/'); }
  static file(p) { return new Uri(p); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return 'file://' + this.path; }
}
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(a, b, c, d) { if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); } } get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; } }
class Selection extends Range {}
class WorkspaceEdit { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push(['replace', uri, range, text]); } createFile(uri) { this.ops.push(['create', uri]); } }
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class MarkdownString { constructor(v) { this.value = v; } }
class ThemeColor { constructor(id) { this.id = id; } }
class EventEmitter { constructor() { this.handlers = []; } event = (h) => { this.handlers.push(h); return { dispose() {} }; }; fire(v) { this.handlers.forEach((h) => h(v)); } }

const config = new Map([['patchCode.model', 'auto'], ['patchCode.permissionMode', 'default']]);
const globalState = new Map();
const secrets = new Map();
const registered = { commands: new Map(), providers: [] };
const applied = [];
const vscode = {
  Uri, Position, Range, Selection, WorkspaceEdit, CodeAction, MarkdownString, ThemeColor, EventEmitter,
  CodeActionKind: { QuickFix: 'quickfix', RefactorRewrite: 'refactor.rewrite', Empty: '' },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  EndOfLine: { LF: 1, CRLF: 2 },
  ViewColumn: { Beside: -2 },
  TextEditorRevealType: { InCenter: 2 },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(os.tmpdir()) }],
    isTrusted: true,
    textDocuments: [],
    getConfiguration: (section) => ({
      get: (key) => config.get(`${section}.${key}`),
      inspect: (key) => ({ globalValue: config.get(`${section}.${key}`) }),
      update: async (key, value) => { config.set(`${section}.${key}`, value); },
    }),
    applyEdit: async (edit) => { applied.push(edit); return true; },
    openTextDocument: async (arg) => ({ uri: typeof arg === 'object' && arg.fsPath ? arg : Uri.file(String(arg.content ? 'untitled' : arg)), getText: () => 'x', positionAt: (n) => new Position(0, n), isDirty: false, save: async () => true }),
    fs: { stat: async () => { throw new Error('missing'); }, writeFile: async (uri, data) => fs.writeFileSync(uri.fsPath, data) },
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
  },
  window: {
    activeTextEditor: null,
    tabGroups: { all: [] },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '' }),
    registerWebviewViewProvider: (id, provider) => { registered.providers.push(id); return { dispose() {} }; },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => ({}),
    withProgress: async (opts, task) => task({ report() {} }, { onCancellationRequested() {} }),
  },
  commands: {
    registerCommand: (name, handler) => { registered.commands.set(name, handler); return { dispose() {} }; },
    executeCommand: async () => undefined,
  },
  languages: {
    getDiagnostics: (uri) => (uri ? [{ range: new Range(0, 0, 0, 5), severity: 0, message: 'boom', source: 'test' }] : [[Uri.file(path.join(os.tmpdir(), 'a.py')), [{ range: new Range(1, 0, 1, 5), severity: 1, message: 'warn' }]]]),
    registerCodeActionsProvider: () => ({ dispose() {} }),
  },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

const context = {
  subscriptions: [], extensionUri: Uri.file(path.resolve(__dirname, '..')),
  globalState: { get: (k) => globalState.get(k), update: async (k, v) => { globalState.set(k, v); } },
  secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
};

test('vscode layer: activate registers every contributed command', () => {
  const extension = require('../src/extension');
  const api = extension.activate(context);
  assert.equal(typeof api.ask, 'function');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  const contributed = manifest.contributes.commands.map((c) => c.command);
  for (const name of contributed) assert.ok(registered.commands.has(name), `command ${name} is contributed but not registered`);
  for (const name of registered.commands.keys()) assert.ok(contributed.includes(name), `command ${name} is registered but not contributed`);
  assert.deepEqual(registered.providers, ['patchCode.chatView']);
  for (const key of manifest.contributes.keybindings.map((k) => k.command)) assert.ok(contributed.includes(key), key);
  for (const menu of Object.values(manifest.contributes.menus).flat()) if (menu.command) assert.ok(contributed.includes(menu.command), menu.command);
  extension.deactivate();
});

test('vscode layer: config resolves llm, secrets and model cache', async () => {
  const { Config } = require('../src/vscode/config');
  const cfg = new Config(context, { appendLine() {} });
  const layer = cfg.vscodeLayer();
  assert.equal(layer.model, 'auto');
  const resolved = await cfg.resolveLlm();
  assert.equal(resolved.apiKey, '');
  assert.equal(resolved.model, '');
  await cfg.setApiKey(resolved.serviceAddress, 'k');
  assert.equal(await cfg.apiKey(), 'k');
  await cfg.saveCache(resolved.serviceAddress, { models: ['m1', 'm2'], contexts: { m1: 1000, m2: 2000 }, capabilities: { m1: { nativeToolCalling: true, verdict: 'supported' }, m2: { nativeToolCalling: false, verdict: 'unsupported' } } });
  const again = await cfg.resolveLlm();
  assert.equal(again.model, 'm1');
  assert.equal(await cfg.toolModeFor({ ...again, model: 'm2' }, { probe: false }), 'text');
  assert.equal(await cfg.toolModeFor(again, { probe: false }), 'native');
});

test('vscode layer: host diagnostics and editor context', () => {
  const host = require('../src/vscode/host');
  const d = host.diagnostics(os.tmpdir(), path.join(os.tmpdir(), 'a.py'));
  assert.equal(d.count, 1);
  assert.match(d.text, /a\.py:1:1 error \[test\]: boom/);
  const all = host.diagnostics(os.tmpdir(), null);
  assert.equal(all.problems[0].severity, 'warning');
  const ctx = host.editorContext(os.tmpdir(), { includeOpenEditors: true, includeDiagnostics: true });
  assert.deepEqual(ctx.openFiles, []);
  assert.match(ctx.diagnostics, /warn/);
});

test('vscode layer: code actions for diagnostics and selections', () => {
  const { PatchCodeActionProvider } = require('../src/vscode/codeActions');
  const provider = new PatchCodeActionProvider();
  const actions = provider.provideCodeActions({ uri: Uri.file('x') }, new Range(0, 0, 0, 3), { diagnostics: [{ message: 'unused variable', range: new Range(0, 0, 0, 1) }] });
  assert.equal(actions.length, 3);
  assert.equal(actions[0].command.command, 'patchCode.fixDiagnostic');
});

test('vscode layer: chat view html has a CSP and slash /mode updates config', async () => {
  const { ChatViewProvider } = require('../src/vscode/chatView');
  const { Config } = require('../src/vscode/config');
  const chat = new ChatViewProvider(context, new Config(context, { appendLine() {} }), { appendLine() {} });
  const posted = [];
  chat.view = { webview: { postMessage: (m) => posted.push(m), asWebviewUri: (u) => u, cspSource: 'vscode-resource:' }, visible: true };
  const html = chat.html(chat.view.webview);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /nonce-/);
  await chat.slash('/mode acceptEdits');
  assert.equal(config.get('patchCode.permissionMode'), 'acceptEdits');
  await chat.slash('/help');
  assert.ok(posted.some((m) => m.type === 'assistant'));
  const decision = chat.ask({ summary: 's', kind: 'shell', command: 'x' });
  const request = posted.find((m) => m.type === 'permission');
  await chat.onMessage({ type: 'permission', requestId: request.request.requestId, decision: 'always' });
  assert.equal(await decision, 'always');
});
