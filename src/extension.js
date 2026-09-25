'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Patch Code - extension entry point.
 *
 * Wires the pure core (src/core, no VS Code dependency, unit-tested) to VS
 * Code: the chat sidebar, the in-editor patch engine, commands, code actions,
 * status bar, configuration and secret storage.
 */

const vscode = require('vscode');
const { Config } = require('./vscode/config');
const { ChatViewProvider } = require('./vscode/chatView');
const { PatchEngine } = require('./vscode/patchEngine');
const { StatusBar } = require('./vscode/statusBar');
const commands = require('./vscode/commands');
const codeActions = require('./vscode/codeActions');
const runner = require('./core/tools/runner');

let chat = null;
let engine = null;

function activate(context) {
  const output = vscode.window.createOutputChannel('Patch Code');
  context.subscriptions.push(output);
  const config = new Config(context, output);

  chat = new ChatViewProvider(context, config, output);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }));

  engine = new PatchEngine(config, chat, output);
  const statusBar = new StatusBar(context, config);
  commands.register(context, { config, chat, engine, output, statusBar });
  codeActions.register(context);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('patchCode')) { statusBar.refresh(); chat.pushState(); }
  }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { statusBar.refresh(); chat.pushState(); }));

  const root = config.workspaceRoot();
  if (root) {
    try { const removed = runner.cleanup(root); if (removed) output.appendLine(`[housekeeping] removed ${removed} old run folder(s) under .patchcode/runs`); } catch (_) { /* ignore */ }
  }
  output.appendLine(`Patch Code activated. Workspace: ${root || '(none)'}. Node ${process.versions.node}.`);

  // First-run nudge: no key yet.
  config.resolveLlm().then((resolved) => {
    if (!resolved.apiKey && !context.globalState.get('patchCode.welcomed')) {
      context.globalState.update('patchCode.welcomed', true);
      vscode.window.showInformationMessage('Patch Code: add your LLM provider and API key to start.', 'Configure').then((choice) => {
        if (choice) vscode.commands.executeCommand('patchCode.configure');
      });
    }
  });

  return {
    /** Public API for other extensions: run a prompt in the chat. */
    ask: (text) => chat.askAgent(text),
  };
}

function deactivate() {
  if (chat) chat.stop();
  if (engine) engine.stop();
}

module.exports = { activate, deactivate };
