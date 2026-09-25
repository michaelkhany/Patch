'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Known OpenAI-compatible providers.
 *
 * Patch Code talks to any OpenAI-compatible endpoint, so a provider is really
 * just a base URL plus a little knowledge that makes the model list
 * trustworthy: which entries are chat models, and which models are documented
 * as supporting native tool calling (so we can skip a probe request).
 *
 * Same presets as DAYA Studio's backend/providers.py.
 */

const PROVIDERS = [
  {
    id: 'gwdg',
    label: 'GWDG · KISSKI / AcademicCloud',
    serviceAddress: 'https://chat-ai.academiccloud.de/v1',
    keysUrl: 'https://kisski.gwdg.de/leistungen/2-02-llm-service/',
    keyPlaceholder: 'your AcademicCloud API key',
    note: 'Hosts open-weight models (Llama, Qwen, Mistral, gpt-oss, DeepSeek).',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    serviceAddress: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    note: 'GPT models. Embedding, audio, image and moderation entries are filtered out.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    serviceAddress: 'https://api.deepseek.com/v1',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    keyPlaceholder: 'sk-…',
    note: 'deepseek-chat and deepseek-reasoner, both with native tool calling.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    serviceAddress: 'http://127.0.0.1:11434/v1',
    keysUrl: 'https://ollama.com/download',
    keyPlaceholder: 'ollama (any non-empty value)',
    note: 'A locally running Ollama server. The key can be any non-empty string.',
    localhost: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    serviceAddress: 'http://127.0.0.1:1234/v1',
    keysUrl: 'https://lmstudio.ai/',
    keyPlaceholder: 'lm-studio (any non-empty value)',
    note: "LM Studio's local server. Start it from the Developer tab first.",
    localhost: true,
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server (local)',
    serviceAddress: 'http://127.0.0.1:8089/v1',
    keysUrl: 'https://github.com/ggml-org/llama.cpp',
    keyPlaceholder: 'the --api-key you started llama-server with',
    note: 'llama-server with --jinja for native tool calling. Same engine DAYA Studio uses offline.',
    localhost: true,
  },
  {
    id: 'custom',
    label: 'Custom (any OpenAI-compatible endpoint)',
    serviceAddress: '',
    keysUrl: '',
    keyPlaceholder: 'API key',
    note: 'vLLM, a gateway, or any other server exposing /v1/chat/completions.',
  },
];

const HOST_TO_PROVIDER = [
  ['api.openai.com', 'openai'],
  ['api.deepseek.com', 'deepseek'],
  ['academiccloud.de', 'gwdg'],
  ['kisski', 'gwdg'],
  [':11434', 'ollama'],
  [':1234', 'lmstudio'],
  [':8089', 'llamacpp'],
];

/** Models a provider documents as supporting OpenAI-style tool calling. */
const TOOL_CAPABLE = {
  openai: [/^gpt-5/, /^gpt-4\.1/, /^gpt-4o/, /^gpt-4-turbo/, /^o[34]/, /^chatgpt-4o/],
  deepseek: [/^deepseek-chat$/, /^deepseek-reasoner$/],
};

/** Models an OpenAI key lists that cannot serve as a chat backend. */
const NON_CHAT = /(embedding|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|search-preview|codex)/i;

function detect(serviceAddress) {
  const host = String(serviceAddress || '').toLowerCase();
  for (const [needle, id] of HOST_TO_PROVIDER) {
    if (host.includes(needle)) return id;
  }
  return 'custom';
}

function get(providerId) {
  return PROVIDERS.find((p) => p.id === providerId) || null;
}

function filterModels(serviceAddress, models) {
  if (detect(serviceAddress) !== 'openai') return [...(models || [])];
  return (models || []).filter((m) => !NON_CHAT.test(String(m)));
}

/** true when the provider documents it, null when a probe is needed. */
function knownToolSupport(serviceAddress, model) {
  const patterns = TOOL_CAPABLE[detect(serviceAddress)];
  if (!patterns) return null;
  const name = String(model || '').trim();
  return patterns.some((re) => re.test(name)) ? true : null;
}

function catalog() {
  return PROVIDERS.map((p) => ({ ...p }));
}

module.exports = { PROVIDERS, detect, get, filterModels, knownToolSupport, catalog };
