'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Editor and palette commands. Everything that needs the model goes through
 * the chat view (so the user sees the steps and answers the permission
 * prompts there); the patch engine handles the two in-editor operations.
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const settingsCore = require('../core/settings');
const patch = require('../core/patch');
const languages = require('../core/languages');
const pickers = require('./pickers');
const host = require('./host');

function activeEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) vscode.window.showInformationMessage('Patch Code: open a file first.');
  return editor;
}

function selectionBlock(editor) {
  const doc = editor.document;
  const sel = editor.selection;
  const range = sel.isEmpty ? doc.lineAt(sel.active.line).range : sel;
  const text = doc.getText(range);
  const lang = languages.resolve(doc.languageId, doc.fileName);
  return { text, lang, range, start: range.start.line + 1, end: range.end.line + 1 };
}

function register(context, { config, chat, engine, output, statusBar }) {
  const cmd = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
    try { return await handler(...args); } catch (error) {
      output.appendLine(`[${name}] ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`Patch Code: ${error.message}`);
      return undefined;
    }
  }));

  cmd('patchCode.openChat', async () => { await chat.reveal(); chat.post({ type: 'focus' }); });
  cmd('patchCode.newConversation', () => chat.newConversation());
  cmd('patchCode.stop', () => { chat.stop(); engine.stop(); });
  cmd('patchCode.configure', async () => { await pickers.configure(config, output); statusBar.refresh(); chat.pushState(); });
  cmd('patchCode.setApiKey', async () => { await pickers.setApiKey(config); chat.pushState(); });
  cmd('patchCode.clearApiKey', async () => { await pickers.clearApiKey(config); chat.pushState(); });
  cmd('patchCode.selectModel', async () => { await pickers.selectModel(config, output); statusBar.refresh(); chat.pushState(); });
  cmd('patchCode.refreshModels', async () => { await pickers.selectModel(config, output, { refresh: true }); statusBar.refresh(); chat.pushState(); });
  cmd('patchCode.selectPermissionMode', async () => { await pickers.selectPermissionMode(config); statusBar.refresh(); chat.pushState(); });
  cmd('patchCode.showOutput', () => output.show(true));
  cmd('patchCode.showCost', () => {
    const u = chat.usage;
    vscode.window.showInformationMessage(`Patch Code this session: ${u.requests} request(s), ${u.promptTokens.toLocaleString()} prompt + ${u.completionTokens.toLocaleString()} completion = ${u.totalTokens.toLocaleString()} tokens.`);
  });

  // -- selection-based ---------------------------------------------------
  const withSelection = (intro) => async () => {
    const editor = activeEditor();
    if (!editor) return;
    const { text, lang, start, end } = selectionBlock(editor);
    const rel = host.relative(config.workspaceRoot(), editor.document.fileName);
    const fence = lang ? lang.fence : '';
    const prompt = `${intro}\n\nFile: ${rel} (lines ${start}-${end})\n\`\`\`${fence}\n${text}\n\`\`\``;
    await chat.askAgent(prompt, { display: `${intro} (${rel}:${start}-${end})` });
  };
  cmd('patchCode.explainSelection', withSelection('Explain this code: what it does, how it fits the file, and anything surprising or risky. Do not change any file.'));
  cmd('patchCode.improveSelection', withSelection('Improve this code in place: correctness first, then clarity and performance, keeping behaviour and style. Edit the file with the Edit tool and verify the change (run tests or a quick script where possible).'));
  cmd('patchCode.askAboutSelection', async () => {
    const editor = activeEditor();
    if (!editor) return;
    const { text, lang, start, end } = selectionBlock(editor);
    const question = await vscode.window.showInputBox({ title: 'Patch Code: ask about the selection', prompt: 'What do you want to know or change?', ignoreFocusOut: true });
    if (!question) return;
    const rel = host.relative(config.workspaceRoot(), editor.document.fileName);
    await chat.askAgent(`${question}\n\nSelected code in ${rel} (lines ${start}-${end}):\n\`\`\`${lang ? lang.fence : ''}\n${text}\n\`\`\``, { display: `${question} (${rel}:${start}-${end})` });
  });

  // -- diagnostics -------------------------------------------------------
  cmd('patchCode.fixDiagnostics', async () => {
    const editor = activeEditor();
    if (!editor) return;
    const root = config.workspaceRoot();
    const d = host.diagnostics(root, editor.document.fileName, { max: 40 });
    const rel = host.relative(root, editor.document.fileName);
    if (!d.count) { vscode.window.showInformationMessage(`Patch Code: no problems reported in ${rel}.`); return; }
    await chat.askAgent(`Fix the problems VS Code reports in ${rel}. Read the file, make minimal edits with the Edit tool, then check Diagnostics for that file again (and run the relevant test or a quick script if one exists) until it is clean.\n\nProblems:\n${d.text}`, { display: `Fix ${d.count} problem(s) in ${rel}` });
  });
  cmd('patchCode.fixDiagnostic', async (uri, diagnostic) => {
    if (!uri || !diagnostic) return vscode.commands.executeCommand('patchCode.fixDiagnostics');
    const root = config.workspaceRoot();
    const rel = host.relative(root, uri.fsPath);
    const line = diagnostic.range.start.line + 1;
    await chat.askAgent(`Fix this problem in ${rel} at line ${line}: ${diagnostic.message}${diagnostic.source ? ` [${diagnostic.source}]` : ''}. Read the surrounding code first, make the smallest correct edit with the Edit tool, then confirm with the Diagnostics tool that the problem is gone.`, { display: `Fix: ${diagnostic.message} (${rel}:${line})` });
  });

  // -- patches -----------------------------------------------------------
  cmd('patchCode.applyPatches', async () => { const editor = activeEditor(); if (editor) await engine.applyPatches(editor); });
  cmd('patchCode.runAndRepairFile', async () => { const editor = activeEditor(); if (editor) await engine.runAndRepair(editor); });
  cmd('patchCode.insertPatchRequest', async () => {
    const editor = activeEditor();
    if (!editor) return;
    const lang = languages.resolve(editor.document.languageId, editor.document.fileName) || languages.byId('plaintext');
    const instruction = await vscode.window.showInputBox({ title: 'Patch Code: new patch', prompt: 'Describe what the code at the cursor should do', ignoreFocusOut: true });
    if (!instruction) return;
    const line = editor.selection.active.line;
    const indent = /^\s*/.exec(editor.document.lineAt(line).text)[0];
    const text = `${indent}${languages.commentLine(lang, '@patch ' + instruction)}\n`;
    await editor.edit((b) => b.insert(new vscode.Position(line, 0), text));
    const run = await vscode.window.showInformationMessage('Patch request inserted. Apply it now?', 'Apply @patch requests', 'Later');
    if (run === 'Apply @patch requests') await engine.applyPatches(editor);
  });
  cmd('patchCode.showKnowledgeGraph', async () => {
    const editor = activeEditor();
    if (!editor) return;
    const lang = languages.resolve(editor.document.languageId, editor.document.fileName);
    const graph = patch.analyse(editor.document.getText(), lang ? lang.id : 'plaintext');
    const rel = host.relative(config.workspaceRoot(), editor.document.fileName);
    const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: `# Knowledge graph of ${rel} - what Patch Code tells the model the file already defines\n${patch.graphPrompt(graph)}\n` });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  });

  // -- project files -----------------------------------------------------
  cmd('patchCode.initProject', async () => {
    const root = config.workspaceRoot();
    if (!root) { vscode.window.showInformationMessage('Patch Code: open a folder first.'); return; }
    const file = path.join(root, settingsCore.CONTEXT_FILENAME);
    if (fs.existsSync(file)) {
      const choice = await vscode.window.showInformationMessage(`${settingsCore.CONTEXT_FILENAME} already exists.`, 'Open it', 'Regenerate with the agent');
      if (choice === 'Open it') { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file)); return; }
      if (!choice) return;
    }
    await chat.askAgent(`Analyse this workspace (ListDir, Glob for manifests such as package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, README) and write ${settingsCore.CONTEXT_FILENAME} at the workspace root: a short, factual guide for a coding agent - what the project is, the main languages and entry points, exactly how to install, build, test and lint, and the conventions to follow. Use this structure:\n\n${settingsCore.CONTEXT_TEMPLATE}\n\nWrite the file with the Write tool, then open nothing else.`, { display: `Initialize ${settingsCore.CONTEXT_FILENAME}` });
    if (fs.existsSync(file)) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
  });
  const openSettings = async (file, template) => {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, template, 'utf8');
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
  };
  cmd('patchCode.openSettingsFile', async () => {
    const root = config.workspaceRoot();
    if (!root) { vscode.window.showInformationMessage('Patch Code: open a folder first.'); return; }
    await openSettings(settingsCore.projectSettingsPath(root), JSON.stringify({
      permissionMode: 'default',
      permissions: { allow: ['Shell(git status)', 'Shell(git diff*)', 'Shell(npm test*)'], deny: ['Write(.env*)', 'Shell(git push*)'], ask: [] },
      env: {},
      hooks: {},
    }, null, 2) + '\n');
  });
  cmd('patchCode.openUserSettingsFile', async () => {
    await openSettings(settingsCore.userSettingsPath(), JSON.stringify({ permissionMode: 'default', permissions: { allow: [], deny: [], ask: [] } }, null, 2) + '\n');
  });
}

module.exports = { register };
