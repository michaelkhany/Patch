'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Model selection - DAYA's "Auto - best native-tool model".
 *
 * Auto picks, among the models the probe (or the provider's documentation)
 * says can emit native tool calls, the one with the largest advertised
 * context window; ties are broken deterministically by a preference list
 * of coding-oriented names, then alphabetically, so the status bar and every
 * request agree on which model is in use.
 */

const providers = require('./providers');

const AUTO = 'auto';

/** Names that make a model a good coding pick when context windows tie. */
const PREFERRED = [/coder/i, /devstral/i, /codestral/i, /gpt-5/i, /gpt-4\.1/i, /deepseek/i, /qwen3\.?[5-9]/i, /glm/i, /gpt-oss/i, /mistral-large/i, /llama-3\.[3-9]/i, /gemma/i];

function preferenceRank(model) {
  const index = PREFERRED.findIndex((re) => re.test(model));
  return index === -1 ? PREFERRED.length : index;
}

/**
 * @param {Object} o
 * @param {string[]} o.models
 * @param {Object<string,number>} [o.contexts]
 * @param {Object<string,{nativeToolCalling?:boolean, verdict?:string}>} [o.capabilities]
 * @param {string[]} [o.exclude]
 * @param {string} [o.serviceAddress]
 */
function pickBestModel({ models, contexts, capabilities, exclude, serviceAddress } = {}) {
  const list = (models || []).filter(Boolean);
  if (!list.length) return '';
  const caps = capabilities || {};
  const excluded = new Set((exclude || []).map((s) => String(s).toLowerCase()));
  let supported = list.filter((m) => {
    if (excluded.has(String(m).toLowerCase())) return false;
    const cap = caps[m];
    if (cap && cap.nativeToolCalling === true) return true;
    if (providers.knownToolSupport(serviceAddress, m) === true) return true;
    return false;
  });
  if (!supported.length) return '';
  const ctx = contexts || {};
  const best = Math.max(...supported.map((m) => Number(ctx[m]) || 0));
  const pool = best > 0 ? supported.filter((m) => (Number(ctx[m]) || 0) === best) : supported;
  pool.sort((a, b) => preferenceRank(a) - preferenceRank(b) || a.localeCompare(b));
  return pool[0];
}

/** The concrete model id a configuration maps to, resolving "auto". */
function effectiveModel(configuredModel, cache) {
  const wanted = String(configuredModel || AUTO).trim();
  if (wanted && wanted !== AUTO) return wanted;
  if (!cache) return '';
  return cache.autoResolved || pickBestModel(cache);
}

/** A short label for the status bar. */
function label(configuredModel, cache) {
  const model = effectiveModel(configuredModel, cache);
  if (!model) return 'no model';
  return String(configuredModel || AUTO) === AUTO ? `auto · ${model}` : model;
}

module.exports = { AUTO, pickBestModel, effectiveModel, label, preferenceRank };
