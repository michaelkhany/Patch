'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Layered settings, the way Claude Code defines them.
 *
 *   1. built-in defaults
 *   2. user settings        ~/.patchcode/settings.json
 *   3. project settings     <workspace>/.patchcode/settings.json   (committed)
 *   4. local settings       <workspace>/.patchcode/settings.local.json (git-ignored)
 *   5. VS Code settings     patchCode.* (passed in by the extension host)
 *
 * Later layers win for scalars; `permissions.allow/deny/ask`, `env` and
 * `hooks` are merged (concatenated / object-merged) so a project can add
 * rules without dropping the user's. The context file (PATCHCODE.md) is
 * loaded from the workspace and its parents, plus the user directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTO_MODEL = 'auto';
const CONTEXT_FILENAME = 'PATCHCODE.md';
const DIRNAME = '.patchcode';

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

const DEFAULTS = Object.freeze({
  provider: 'gwdg',
  serviceAddress: 'https://chat-ai.academiccloud.de/v1',
  model: AUTO_MODEL,
  apiKeyEnv: '',
  permissionMode: 'default',
  permissions: { allow: [], deny: [], ask: [] },
  maxIterations: 6,
  maxSteps: 40,
  commandTimeoutSeconds: 120,
  runTimeoutSeconds: 180,
  maxTokens: 4000,
  temperature: 0.1,
  toolCalling: 'auto',
  streaming: true,
  contextFiles: [CONTEXT_FILENAME],
  autoModelExclude: [],
  env: {},
  hooks: {},
  sandbox: { confineToWorkspace: true, allowNetwork: true },
  includeDiagnostics: true,
  includeOpenEditors: true,
  maxContextFileBytes: 60000,
  language: 'auto',
  webSearch: true,
});

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    // Tolerate comments and trailing commas (settings.json style).
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    const data = JSON.parse(stripped);
    return data && typeof data === 'object' ? data : {};
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { __error: `${file}: ${error.message}` };
  }
}

function userDir() {
  return path.join(process.env.PATCHCODE_HOME || os.homedir(), DIRNAME);
}

function userSettingsPath() {
  return path.join(userDir(), 'settings.json');
}

function projectSettingsPath(workspaceRoot) {
  return path.join(workspaceRoot, DIRNAME, 'settings.json');
}

function localSettingsPath(workspaceRoot) {
  return path.join(workspaceRoot, DIRNAME, 'settings.local.json');
}

function uniq(list) {
  return [...new Set((list || []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
}

function mergeHooks(base, extra) {
  const out = { ...(base || {}) };
  for (const [event, entries] of Object.entries(extra || {})) {
    if (!Array.isArray(entries)) continue;
    out[event] = [...(out[event] || []), ...entries];
  }
  return out;
}

function mergeLayer(base, layer) {
  if (!layer || typeof layer !== 'object') return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined || value === null || key === '__error') continue;
    if (key === 'permissions' && typeof value === 'object') {
      out.permissions = {
        allow: uniq([...(base.permissions.allow || []), ...(value.allow || [])]),
        deny: uniq([...(base.permissions.deny || []), ...(value.deny || [])]),
        ask: uniq([...(base.permissions.ask || []), ...(value.ask || [])]),
      };
    } else if (key === 'env' && typeof value === 'object') {
      out.env = { ...(base.env || {}), ...value };
    } else if (key === 'hooks' && typeof value === 'object') {
      out.hooks = mergeHooks(base.hooks, value);
    } else if (key === 'sandbox' && typeof value === 'object') {
      out.sandbox = { ...(base.sandbox || {}), ...value };
    } else if (key === 'autoModelExclude' && Array.isArray(value)) {
      out.autoModelExclude = uniq([...(base.autoModelExclude || []), ...value]);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Load every layer. `vscodeLayer` is the flattened patchCode.* configuration.
 * Returns {settings, sources, errors}.
 */
function load({ workspaceRoot, vscodeLayer } = {}) {
  const sources = [];
  const errors = [];
  let settings = { ...DEFAULTS, permissions: { allow: [], deny: [], ask: [] } };

  const layers = [['user', userSettingsPath()]];
  if (workspaceRoot) {
    layers.push(['project', projectSettingsPath(workspaceRoot)]);
    layers.push(['local', localSettingsPath(workspaceRoot)]);
  }
  for (const [name, file] of layers) {
    const data = readJson(file);
    if (data === null) continue;
    if (data.__error) { errors.push(data.__error); continue; }
    sources.push({ name, file });
    settings = mergeLayer(settings, data);
  }
  if (vscodeLayer) {
    sources.push({ name: 'vscode', file: 'settings (patchCode.*)' });
    settings = mergeLayer(settings, vscodeLayer);
  }
  if (!PERMISSION_MODES.includes(settings.permissionMode)) settings.permissionMode = 'default';
  settings.maxIterations = clampInt(settings.maxIterations, 0, 50, DEFAULTS.maxIterations);
  settings.maxSteps = clampInt(settings.maxSteps, 1, 400, DEFAULTS.maxSteps);
  settings.commandTimeoutSeconds = clampInt(settings.commandTimeoutSeconds, 5, 3600, DEFAULTS.commandTimeoutSeconds);
  settings.runTimeoutSeconds = clampInt(settings.runTimeoutSeconds, 5, 3600, DEFAULTS.runTimeoutSeconds);
  settings.maxTokens = clampInt(settings.maxTokens, 256, 200000, DEFAULTS.maxTokens);
  return { settings, sources, errors };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Walk from the workspace root upward and collect PATCHCODE.md files (outermost first), plus ~/.patchcode/PATCHCODE.md. */
function loadContextFiles({ workspaceRoot, names, maxBytes = 60000 } = {}) {
  const wanted = (names && names.length ? names : [CONTEXT_FILENAME]);
  const found = [];
  const seen = new Set();
  const tryDir = (dir, scope) => {
    for (const name of wanted) {
      const file = path.join(dir, name);
      if (seen.has(file)) continue;
      seen.add(file);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        let text = fs.readFileSync(file, 'utf8');
        if (text.length > maxBytes) text = text.slice(0, maxBytes) + '\n\n[truncated]';
        found.push({ file, scope, text });
      } catch (_) { /* absent */ }
    }
  };
  tryDir(userDir(), 'user');
  if (workspaceRoot) {
    const chain = [];
    let dir = path.resolve(workspaceRoot);
    while (true) {
      chain.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const d of chain.reverse()) tryDir(d, d === path.resolve(workspaceRoot) ? 'project' : 'parent');
    tryDir(path.join(workspaceRoot, DIRNAME), 'project');
  }
  return found;
}

/** Write one layer (used by /config and "Save to project settings"). */
function writeLayer(file, patch) {
  const existing = readJson(file);
  const base = existing && !existing.__error ? existing : {};
  const next = { ...base, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** Add a permission rule to a layer file without duplicating it. */
function addPermissionRule(file, list, rule) {
  const existing = readJson(file);
  const base = existing && !existing.__error ? existing : {};
  const permissions = { allow: [], deny: [], ask: [], ...(base.permissions || {}) };
  if (!permissions[list].includes(rule)) permissions[list].push(rule);
  return writeLayer(file, { permissions });
}

const CONTEXT_TEMPLATE = `# PATCHCODE.md

This file is read by Patch Code at the start of every conversation, the same way
Claude Code reads CLAUDE.md. Keep it short and factual: what the project is, how
to build and test it, conventions the agent must follow.

## Project

- Purpose:
- Main language(s):
- Entry point(s):

## Build & test

- Install:
- Build:
- Test:
- Lint:

## Conventions

- Style:
- Do not touch:
`;

module.exports = {
  AUTO_MODEL, CONTEXT_FILENAME, DIRNAME, DEFAULTS, PERMISSION_MODES, CONTEXT_TEMPLATE,
  load, mergeLayer, loadContextFiles, writeLayer, addPermissionRule,
  userDir, userSettingsPath, projectSettingsPath, localSettingsPath, readJson,
};
