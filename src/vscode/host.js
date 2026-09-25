'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * What the VS Code layer lends to the core: writes that go through the
 * editor (so open documents update and Undo works), unsaved editor content
 * for reads, the Problems panel, and a snapshot of the editor state for the
 * system prompt.
 */

const vscode = require('vscode');
const path = require('path');

function severityLabel(severity) {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    default: return 'hint';
  }
}

function relative(root, fsPath) {
  return root ? path.relative(root, fsPath).split(path.sep).join('/') : fsPath;
}

/** Text of an open (possibly dirty) document for a path, or undefined. */
function readOverride(fsPath) {
  const wanted = path.resolve(fsPath).toLowerCase();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file' && path.resolve(doc.uri.fsPath).toLowerCase() === wanted) return doc.getText();
  }
  return undefined;
}

/** Replace a file's content through a WorkspaceEdit (creating it if needed), then save. */
async function writeFile(fsPath, content) {
  const uri = vscode.Uri.file(fsPath);
  const edit = new vscode.WorkspaceEdit();
  let exists = true;
  try { await vscode.workspace.fs.stat(uri); } catch (_) { exists = false; }
  if (!exists) {
    edit.createFile(uri, { ignoreIfExists: true });
    await vscode.workspace.applyEdit(edit);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const replace = new vscode.WorkspaceEdit();
  replace.replace(uri, full, content);
  const applied = await vscode.workspace.applyEdit(replace);
  if (!applied) throw new Error(`VS Code refused the edit to ${fsPath}`);
  if (doc.isDirty) await doc.save();
}

/** Problems for one file or the whole workspace. */
function diagnostics(root, fsPath, { max = 200 } = {}) {
  const all = fsPath ? [[vscode.Uri.file(fsPath), vscode.languages.getDiagnostics(vscode.Uri.file(fsPath))]] : vscode.languages.getDiagnostics();
  const items = [];
  for (const [uri, list] of all) {
    if (uri.scheme !== 'file') continue;
    for (const d of list) {
      items.push({
        path: relative(root, uri.fsPath), line: d.range.start.line + 1, column: d.range.start.character + 1,
        endLine: d.range.end.line + 1, severity: severityLabel(d.severity), source: d.source || '', code: d.code && typeof d.code === 'object' ? String(d.code.value) : (d.code !== undefined ? String(d.code) : ''),
        message: d.message,
      });
    }
  }
  const order = { error: 0, warning: 1, info: 2, hint: 3 };
  items.sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
  const shown = items.slice(0, max);
  return {
    count: items.length, truncated: items.length > max,
    problems: shown,
    text: shown.map((d) => `${d.path}:${d.line}:${d.column} ${d.severity}${d.source ? ` [${d.source}${d.code ? ' ' + d.code : ''}]` : ''}: ${d.message}`).join('\n') || '(no problems)',
  };
}

/** Editor snapshot for the system prompt. */
function editorContext(root, settings) {
  const openFiles = [];
  const active = vscode.window.activeTextEditor;
  if (settings.includeOpenEditors !== false) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        const uri = input && input.uri;
        if (!uri || uri.scheme !== 'file') continue;
        const entry = { path: relative(root, uri.fsPath), active: Boolean(active && active.document.uri.fsPath === uri.fsPath) };
        if (entry.active) {
          entry.language = active.document.languageId;
          const sel = active.selection;
          if (!sel.isEmpty) entry.selection = { start: sel.start.line + 1, end: sel.end.line + 1, text: active.document.getText(sel) };
        }
        openFiles.push(entry);
      }
    }
    if (active && !openFiles.some((f) => f.active) && active.document.uri.scheme === 'file') {
      const sel = active.selection;
      openFiles.unshift({ path: relative(root, active.document.uri.fsPath), active: true, language: active.document.languageId, selection: sel.isEmpty ? undefined : { start: sel.start.line + 1, end: sel.end.line + 1, text: active.document.getText(sel) } });
    }
  }
  let diag = '';
  if (settings.includeDiagnostics !== false) {
    const d = diagnostics(root, null, { max: 40 });
    if (d.count) diag = d.text + (d.truncated ? `\n… ${d.count - 40} more` : '');
  }
  return { openFiles, diagnostics: diag };
}

/** Build the host object handed to the agent. */
function makeHost(root, settings) {
  return {
    readOverride,
    writeFile,
    diagnostics: (fsPath) => diagnostics(root, fsPath),
    editorContext: async () => editorContext(root, settings),
  };
}

module.exports = { makeHost, readOverride, writeFile, diagnostics, editorContext, relative };
