'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/** Status bar item: the model in use and the permission mode. */

const vscode = require('vscode');

class StatusBar {
  constructor(context, config) {
    this.config = config;
    this.item = vscode.window.createStatusBarItem('patchCode.status', vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'Patch Code';
    this.item.command = 'patchCode.selectModel';
    context.subscriptions.push(this.item);
    this.item.show();
    this.refresh();
  }

  async refresh() {
    try {
      const resolved = await this.config.resolveLlm();
      const s = resolved.settings;
      const model = resolved.model ? (resolved.configuredModel === 'auto' ? `auto · ${resolved.model}` : resolved.model) : 'no model';
      const modeIcon = { default: '$(shield)', acceptEdits: '$(edit)', plan: '$(book)', bypassPermissions: '$(unlock)' }[s.permissionMode] || '$(shield)';
      this.item.text = `$(tools) ${model} ${modeIcon}`;
      this.item.tooltip = new vscode.MarkdownString([
        `**Patch Code**`, '', `Model: ${model}`, `Endpoint: ${resolved.serviceAddress}`, `API key: ${resolved.apiKey ? 'set' : 'missing'}`, `Permission mode: ${s.permissionMode}`, '', 'Click to change the model.',
      ].join('\n'));
      this.item.backgroundColor = resolved.apiKey && resolved.model ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    } catch (error) {
      this.item.text = '$(tools) Patch Code';
      this.item.tooltip = String(error.message);
    }
  }
}

module.exports = { StatusBar };
