'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Quick picks: provider & API key, model, permission mode - the Settings
 * dialog of DAYA Studio and the /model, /permissions commands of Claude
 * Code, in VS Code's own UI.
 */

const vscode = require('vscode');
const providers = require('../core/providers');
const settingsCore = require('../core/settings');
const modelselect = require('../core/modelselect');

function configTarget() {
  const cfg = vscode.workspace.getConfiguration('patchCode');
  const inspected = cfg.inspect('model');
  return inspected && inspected.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

async function configure(config, output) {
  const current = config.settings();
  const currentId = providers.detect(current.serviceAddress);
  const items = providers.catalog().map((p) => ({
    label: p.label, description: p.serviceAddress || 'enter a base URL', detail: p.note, id: p.id,
    picked: p.id === currentId,
  }));
  const provider = await vscode.window.showQuickPick(items, { title: 'Patch Code: choose a provider', placeHolder: 'Any OpenAI-compatible endpoint works', ignoreFocusOut: true });
  if (!provider) return false;
  const preset = providers.get(provider.id);
  const serviceAddress = await vscode.window.showInputBox({
    title: 'Patch Code: service address', prompt: 'Base URL of the OpenAI-compatible API (ending in /v1)',
    value: provider.id === currentId ? current.serviceAddress : (preset.serviceAddress || 'https://'), ignoreFocusOut: true,
    validateInput: (v) => (/^https?:\/\/\S+/.test(v.trim()) ? null : 'Enter a http(s) URL'),
  });
  if (!serviceAddress) return false;
  const existing = await config.context.secrets.get(config.secretKeyFor(serviceAddress));
  const key = await vscode.window.showInputBox({
    title: 'Patch Code: API key', password: true, ignoreFocusOut: true,
    prompt: `${preset.keyPlaceholder}${preset.keysUrl ? `  (get one: ${preset.keysUrl})` : ''}${existing ? ' - leave empty to keep the stored key' : ''}${preset.localhost ? ' - local servers accept any value' : ''}`,
    placeHolder: preset.keyPlaceholder,
  });
  if (key === undefined) return false;
  const cfg = vscode.workspace.getConfiguration('patchCode');
  await cfg.update('provider', provider.id, vscode.ConfigurationTarget.Global);
  await cfg.update('serviceAddress', serviceAddress.trim(), vscode.ConfigurationTarget.Global);
  if (key.trim()) await config.setApiKey(serviceAddress.trim(), key.trim());
  else if (!existing && preset.localhost) await config.setApiKey(serviceAddress.trim(), 'local');
  output.appendLine(`[config] provider=${provider.id} address=${serviceAddress.trim()} key=${key.trim() ? 'stored' : (existing ? 'kept' : 'none')}`);
  return selectModel(config, output, { refresh: true });
}

async function setApiKey(config) {
  const current = config.settings();
  const key = await vscode.window.showInputBox({ title: `Patch Code: API key for ${current.serviceAddress}`, password: true, ignoreFocusOut: true, prompt: 'Stored in VS Code secret storage, never in settings files.' });
  if (key === undefined) return;
  await config.setApiKey(current.serviceAddress, key.trim());
  vscode.window.showInformationMessage(key.trim() ? 'Patch Code: API key stored.' : 'Patch Code: API key cleared.');
}

async function clearApiKey(config) {
  const current = config.settings();
  await config.setApiKey(current.serviceAddress, '');
  vscode.window.showInformationMessage(`Patch Code: API key for ${current.serviceAddress} removed.`);
}

async function refreshModels(config, output, resolved) {
  const controller = new AbortController();
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Patch Code', cancellable: true }, async (progress, token) => {
    token.onCancellationRequested(() => controller.abort());
    return config.refreshModels(resolved, { onProgress: (message) => progress.report({ message }), signal: controller.signal });
  });
}

async function selectModel(config, output, { refresh = false } = {}) {
  let resolved = await config.resolveLlm();
  if (!resolved.apiKey) {
    const pick = await vscode.window.showWarningMessage('Patch Code needs an API key first.', 'Configure');
    if (pick) return configure(config, output);
    return false;
  }
  let cache = resolved.cache;
  if (refresh || !cache || !(cache.models || []).length) {
    try {
      cache = await refreshModels(config, output, resolved);
    } catch (error) {
      vscode.window.showErrorMessage(`Patch Code could not load models: ${error.message}`);
      if (!cache) {
        const manual = await vscode.window.showInputBox({ title: 'Patch Code: model id', prompt: 'Enter the model id to use', value: resolved.configuredModel !== 'auto' ? resolved.configuredModel : '' });
        if (manual) await vscode.workspace.getConfiguration('patchCode').update('model', manual.trim(), configTarget());
        return Boolean(manual);
      }
    }
    resolved = await config.resolveLlm();
  }
  const s = resolved.settings;
  const auto = modelselect.pickBestModel({ ...cache, exclude: s.autoModelExclude, serviceAddress: resolved.serviceAddress });
  const capOf = (m) => (cache.capabilities || {})[m];
  const describe = (m) => {
    const ctx = (cache.contexts || {})[m];
    const cap = capOf(m);
    const tools = cap ? (cap.nativeToolCalling ? 'native tools' : (cap.verdict === 'inconclusive' ? 'tools unknown' : 'no native tools (text protocol)')) : (providers.knownToolSupport(resolved.serviceAddress, m) ? 'native tools' : 'not probed');
    return [ctx ? `${Math.round(ctx / 1000)}k ctx` : '', tools].filter(Boolean).join(' · ');
  };
  const items = [
    { label: '$(sparkle) Auto', description: auto ? `best tool-capable model: ${auto}` : 'no tool-capable model found', detail: 'Largest context window among models that can emit native tool calls (like DAYA Studio).', id: modelselect.AUTO },
    ...(cache.models || []).map((m) => ({ label: m, description: describe(m), id: m, picked: m === resolved.model })),
    { label: '$(refresh) Reload models & probe tool support', id: '__refresh__', alwaysShow: true },
    { label: '$(edit) Enter a model id manually', id: '__manual__', alwaysShow: true },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: `Patch Code: model (${resolved.serviceAddress})`, placeHolder: `Current: ${resolved.configuredModel === 'auto' ? 'auto · ' + (resolved.model || '?') : resolved.configuredModel}`, matchOnDescription: true, ignoreFocusOut: true });
  if (!pick) return false;
  if (pick.id === '__refresh__') return selectModel(config, output, { refresh: true });
  if (pick.id === '__manual__') {
    const manual = await vscode.window.showInputBox({ title: 'Patch Code: model id', prompt: 'Model id as the provider names it' });
    if (!manual) return false;
    await vscode.workspace.getConfiguration('patchCode').update('model', manual.trim(), configTarget());
    return true;
  }
  await vscode.workspace.getConfiguration('patchCode').update('model', pick.id, configTarget());
  output.appendLine(`[config] model=${pick.id}${pick.id === modelselect.AUTO ? ` (resolves to ${auto || 'nothing'})` : ''}`);
  return true;
}

async function selectPermissionMode(config) {
  const current = config.settings().permissionMode;
  const items = [
    { label: 'default', description: 'read-only tools run; edits, commands, scripts and installs ask', id: 'default' },
    { label: 'acceptEdits', description: 'file edits apply without asking; commands, scripts and installs still ask', id: 'acceptEdits' },
    { label: 'plan', description: 'read-only: inspect the workspace and produce a plan', id: 'plan' },
    { label: 'bypassPermissions', description: 'never ask - only in a sandbox you can afford to lose', id: 'bypassPermissions' },
  ].map((i) => ({ ...i, picked: i.id === current, label: (i.id === current ? '$(check) ' : '') + i.label }));
  const pick = await vscode.window.showQuickPick(items, { title: 'Patch Code: permission mode', placeHolder: `Current: ${current}` });
  if (!pick) return;
  if (pick.id === 'bypassPermissions') {
    const sure = await vscode.window.showWarningMessage('bypassPermissions lets the agent edit files, run commands and install packages without asking. Continue?', { modal: true }, 'Yes, bypass permissions');
    if (!sure) return;
  }
  await vscode.workspace.getConfiguration('patchCode').update('permissionMode', pick.id, vscode.ConfigurationTarget.Global);
}

module.exports = { configure, setApiKey, clearApiKey, selectModel, selectPermissionMode, refreshModels, PERMISSION_MODES: settingsCore.PERMISSION_MODES };
