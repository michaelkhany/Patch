'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Bridges VS Code configuration, secret storage and the layered settings
 * files into the one `settings` object the core uses, and owns the model
 * cache (models, context windows, tool-capability verdicts) per endpoint.
 */

const vscode = require('vscode');
const settingsCore = require('../core/settings');
const providers = require('../core/providers');
const llm = require('../core/llm');
const modelselect = require('../core/modelselect');

const SECRET_KEY_PREFIX = 'patchCode.apiKey:';
const CACHE_KEY = 'patchCode.modelCache';

class Config {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this._modelCache = context.globalState.get(CACHE_KEY) || {};
  }

  workspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : undefined;
  }

  /** The flattened patchCode.* layer, only for keys the user actually set. */
  vscodeLayer() {
    const cfg = vscode.workspace.getConfiguration('patchCode');
    const layer = {};
    const keys = ['provider', 'serviceAddress', 'model', 'apiKeyEnv', 'permissionMode', 'maxSteps', 'maxIterations',
      'commandTimeoutSeconds', 'runTimeoutSeconds', 'modelTimeoutSeconds', 'permissionTimeoutSeconds', 'maxTokens',
      'temperature', 'contextTokens', 'toolCalling', 'streaming', 'contextFiles', 'includeOpenEditors', 'includeDiagnostics',
      'webSearch', 'autoModelExclude', 'env', 'language'];
    for (const key of keys) {
      const inspected = cfg.inspect(key);
      if (!inspected) continue;
      const explicit = inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue;
      if (explicit !== undefined) layer[key] = explicit;
    }
    const permissions = {};
    for (const list of ['allow', 'deny', 'ask']) {
      const value = cfg.get(`permissions.${list}`);
      if (Array.isArray(value) && value.length) permissions[list] = value;
    }
    if (Object.keys(permissions).length) layer.permissions = permissions;
    const sandbox = {};
    for (const key of ['confineToWorkspace', 'allowNetwork']) {
      const inspected = cfg.inspect(`sandbox.${key}`);
      const explicit = inspected && (inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue);
      if (explicit !== undefined) sandbox[key] = explicit;
    }
    if (Object.keys(sandbox).length) layer.sandbox = sandbox;
    // A provider preset chosen in VS Code fills in the address unless the address itself was set explicitly.
    if (layer.provider && layer.serviceAddress === undefined) {
      const preset = providers.get(layer.provider);
      if (preset && preset.serviceAddress) layer.serviceAddress = preset.serviceAddress;
    }
    return layer;
  }

  /** Merged settings + sources + errors. */
  load() {
    const result = settingsCore.load({ workspaceRoot: this.workspaceRoot(), vscodeLayer: this.vscodeLayer() });
    if (!vscode.workspace.isTrusted) result.settings.permissionMode = 'plan';
    for (const error of result.errors) this.output.appendLine(`[settings] ${error}`);
    return result;
  }

  settings() {
    return this.load().settings;
  }

  contextFiles(settings) {
    const s = settings || this.settings();
    return settingsCore.loadContextFiles({ workspaceRoot: this.workspaceRoot(), names: s.contextFiles, maxBytes: s.maxContextFileBytes });
  }

  // -- API key ---------------------------------------------------------------
  secretKeyFor(serviceAddress) {
    return SECRET_KEY_PREFIX + String(serviceAddress || '').trim().replace(/\/+$/, '');
  }

  async apiKey(settings) {
    const s = settings || this.settings();
    const stored = await this.context.secrets.get(this.secretKeyFor(s.serviceAddress));
    if (stored) return stored;
    const envNames = [s.apiKeyEnv, 'PATCHCODE_API_KEY', 'OPENAI_API_KEY'].filter(Boolean);
    for (const name of envNames) if (process.env[name]) return process.env[name];
    const preset = providers.get(providers.detect(s.serviceAddress));
    if (preset && preset.localhost) return 'local';
    return '';
  }

  async setApiKey(serviceAddress, key) {
    if (key) await this.context.secrets.store(this.secretKeyFor(serviceAddress), key);
    else await this.context.secrets.delete(this.secretKeyFor(serviceAddress));
  }

  // -- Model cache -----------------------------------------------------------
  cacheFor(serviceAddress) {
    const key = llm.buildChatEndpoint(serviceAddress);
    return this._modelCache[key] || null;
  }

  async saveCache(serviceAddress, cache) {
    const key = llm.buildChatEndpoint(serviceAddress);
    this._modelCache[key] = { ...cache, updatedAt: Date.now() };
    await this.context.globalState.update(CACHE_KEY, this._modelCache);
  }

  /** {serviceAddress, apiKey, model, configuredModel, cache, toolMode} ready for a run, or an error string. */
  async resolveLlm(settings) {
    const s = settings || this.settings();
    const apiKey = await this.apiKey(s);
    const cache = this.cacheFor(s.serviceAddress);
    const configured = s.model || modelselect.AUTO;
    let model = modelselect.effectiveModel(configured, cache ? { ...cache, exclude: s.autoModelExclude, serviceAddress: s.serviceAddress } : null);
    if (configured === modelselect.AUTO && cache) model = modelselect.pickBestModel({ ...cache, exclude: s.autoModelExclude, serviceAddress: s.serviceAddress });
    return { serviceAddress: s.serviceAddress, apiKey, model, configuredModel: configured, cache, settings: s };
  }

  /** Decide native vs text tool calling for a model (probing once when needed). */
  async toolModeFor(resolved, { probe = true } = {}) {
    const s = resolved.settings;
    if (s.toolCalling === 'native' || s.toolCalling === 'text') return s.toolCalling;
    if (providers.knownToolSupport(resolved.serviceAddress, resolved.model) === true) return 'native';
    const cache = this.cacheFor(resolved.serviceAddress) || { models: [], contexts: {}, capabilities: {} };
    const cap = (cache.capabilities || {})[resolved.model];
    if (cap && cap.verdict === 'supported') return 'native';
    if (cap && cap.verdict === 'unsupported') return 'text';
    if (!probe) return 'native';
    const verdict = await llm.probeToolCalling({ serviceAddress: resolved.serviceAddress, apiKey: resolved.apiKey, model: resolved.model });
    this.output.appendLine(`[probe] ${resolved.model}: ${verdict.verdict} - ${verdict.detail}`);
    if (verdict.verdict !== 'inconclusive') {
      cache.capabilities = { ...(cache.capabilities || {}), [resolved.model]: { nativeToolCalling: verdict.verdict === 'supported', verdict: verdict.verdict, detail: verdict.detail, checkedAt: new Date().toISOString() } };
      await this.saveCache(resolved.serviceAddress, cache);
    }
    return verdict.verdict === 'unsupported' ? 'text' : 'native';
  }

  /**
   * Load the model list and probe tool support for every unknown model.
   * onProgress(message). Returns the cache.
   */
  async refreshModels(resolved, { onProgress, signal, probeAll = true } = {}) {
    const progress = onProgress || (() => {});
    progress('Loading models…');
    const listed = await llm.listModels({ serviceAddress: resolved.serviceAddress, apiKey: resolved.apiKey, signal });
    if (!listed.ok) throw new Error(listed.message);
    const models = providers.filterModels(resolved.serviceAddress, listed.models);
    const previous = this.cacheFor(resolved.serviceAddress) || {};
    const capabilities = { ...(previous.capabilities || {}) };
    if (probeAll) {
      let i = 0;
      for (const model of models) {
        if (signal && signal.aborted) break;
        i++;
        if (providers.knownToolSupport(resolved.serviceAddress, model) === true) {
          capabilities[model] = { nativeToolCalling: true, verdict: 'supported', detail: 'Documented by the provider.', source: 'provider' };
          continue;
        }
        const known = capabilities[model];
        if (known && (known.verdict === 'supported' || known.verdict === 'unsupported')) continue;
        progress(`Probing tool support ${i}/${models.length}: ${model}`);
        const verdict = await llm.probeToolCalling({ serviceAddress: resolved.serviceAddress, apiKey: resolved.apiKey, model, signal, timeoutMs: 30000 });
        this.output.appendLine(`[probe] ${model}: ${verdict.verdict} - ${verdict.detail}`);
        capabilities[model] = { nativeToolCalling: verdict.verdict === 'supported', verdict: verdict.verdict, detail: verdict.detail, checkedAt: new Date().toISOString(), source: 'probe' };
      }
    }
    const cache = { models, contexts: listed.contexts, capabilities };
    cache.autoResolved = modelselect.pickBestModel({ ...cache, exclude: resolved.settings.autoModelExclude, serviceAddress: resolved.serviceAddress });
    await this.saveCache(resolved.serviceAddress, cache);
    return cache;
  }
}

module.exports = { Config };
