'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/** Lightbulb actions: "Fix with Patch Code" on any diagnostic, and ask/explain/improve on a selection. */

const vscode = require('vscode');

class PatchCodeActionProvider {
  static metadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite] };

  provideCodeActions(document, range, context) {
    const actions = [];
    for (const diagnostic of context.diagnostics || []) {
      const action = new vscode.CodeAction(`Fix with Patch Code: ${diagnostic.message.slice(0, 60)}${diagnostic.message.length > 60 ? '…' : ''}`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.command = { command: 'patchCode.fixDiagnostic', title: 'Fix with Patch Code', arguments: [document.uri, diagnostic] };
      actions.push(action);
    }
    if (!range.isEmpty) {
      const improve = new vscode.CodeAction('Patch Code: improve selection', vscode.CodeActionKind.RefactorRewrite);
      improve.command = { command: 'patchCode.improveSelection', title: 'Improve selection' };
      actions.push(improve);
      const ask = new vscode.CodeAction('Patch Code: ask about selection', vscode.CodeActionKind.Empty);
      ask.command = { command: 'patchCode.askAboutSelection', title: 'Ask about selection' };
      actions.push(ask);
    }
    return actions;
  }
}

function register(context) {
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new PatchCodeActionProvider(), PatchCodeActionProvider.metadata));
}

module.exports = { register, PatchCodeActionProvider };
