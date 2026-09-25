'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * OpenAI-compatible chat client.
 *
 * One module, no dependencies: list models (with context windows), plain
 * completions, tool-calling completions with streaming deltas, and the
 * one-request probe that decides whether a model can emit native tool calls.
 *
 * Every function returns a result object and never throws on transport or
 * HTTP errors, so the agent can tell the user the REAL reason a call failed
 * (HTTP status + body, unreachable host, timeout) - as first implemented in DAYA Studio's
 * itailor._llm_complete and app._llmChatNativeTools.
 */

const CONTEXT_WINDOW_KEYS = [
  'context_length', 'context_window', 'max_context_length',
  'max_model_len', 'max_input_tokens', 'max_tokens', 'max_position_embeddings',
];

function normalizeBase(serviceAddress) {
  return String(serviceAddress || '').trim().replace(/\/+$/, '');
}

function buildChatEndpoint(serviceAddress) {
  const address = normalizeBase(serviceAddress);
  if (!address) return '';
  return address.endsWith('/chat/completions') ? address : address + '/chat/completions';
}

function buildModelsEndpoint(serviceAddress) {
  const address = normalizeBase(serviceAddress);
  if (!address) return '';
  if (address.endsWith('/chat/completions')) return address.replace(/\/chat\/completions$/, '/models');
  return address.endsWith('/models') ? address : address + '/models';
}

function extractContextWindow(item) {
  if (!item || typeof item !== 'object') return 0;
  const candidates = [item];
  for (const nested of ['meta', 'capabilities', 'config']) {
    if (item[nested] && typeof item[nested] === 'object') candidates.push(item[nested]);
  }
  for (const source of candidates) {
    for (const key of CONTEXT_WINDOW_KEYS) {
      const value = source[key];
      if (typeof value === 'number' && value > 0) return Math.floor(value);
    }
  }
  return 0;
}

function httpStatusOf(detail) {
  const match = /HTTP (\d{3})/.exec(String(detail || ''));
  return match ? Number(match[1]) : null;
}

function isRetryableError(detail) {
  const status = httpStatusOf(detail);
  const text = String(detail || '').toLowerCase();
  return (status !== null && status >= 500) || status === 429
    || text.includes('timed out') || text.includes('timeout')
    || text.includes('could not reach') || text.includes('temporarily unavailable')
    || text.includes('connection reset') || text.includes('remote end closed')
    || text.includes('fetch failed') || text.includes('econnrefused') || text.includes('socket hang up');
}

function errorKind(detail) {
  const status = httpStatusOf(detail);
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  if (isRetryableError(detail)) return 'unavailable';
  return 'error';
}

function friendlyError(detail, action) {
  const status = httpStatusOf(detail);
  const trimmed = String(detail || '').replace(/\s+/g, ' ').slice(0, 400);
  if (status === 401 || status === 403) {
    return `The model API rejected the API key (HTTP ${status}) while ${action}. Check the key and the service address in Patch Code settings. ${trimmed}`;
  }
  if (status === 404) {
    return `The model API answered 404 while ${action} - usually the service address or model id is wrong. ${trimmed}`;
  }
  if (isRetryableError(detail)) {
    return `The model API is unavailable or overloaded (${trimmed || 'no detail'}). Try again in a moment.`;
  }
  return `The model API failed while ${action}: ${trimmed || 'no further detail'}`;
}

function headers(apiKey, extra) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(extra || {}),
  };
}

async function readErrorBody(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch (_) {
    return '';
  }
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timed out')), timeoutMs);
  const onAbort = () => controller.abort((signal && signal.reason) || new Error('cancelled'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

function describeFetchError(error) {
  if (!error) return 'unknown error';
  const cause = error.cause ? ` (${error.cause.code || error.cause.message || error.cause})` : '';
  if (error.name === 'AbortError' || /timed out/i.test(String(error.message))) {
    return `The request to the model API timed out${cause}`;
  }
  return `Could not reach the model API: ${error.message || error}${cause}`;
}

/**
 * List the models an API key can reach.
 * @returns {Promise<{ok:boolean, models:string[], contexts:Object<string,number>, message:string}>}
 */
async function listModels({ serviceAddress, apiKey, timeoutMs = 20000, signal } = {}) {
  const endpoint = buildModelsEndpoint(serviceAddress);
  if (!endpoint) return { ok: false, models: [], contexts: {}, message: 'Service address is empty.' };
  if (!apiKey) return { ok: false, models: [], contexts: {}, message: 'API key is empty.' };
  const t = withTimeout(signal, timeoutMs);
  try {
    const response = await fetch(endpoint, { method: 'GET', headers: headers(apiKey), signal: t.signal });
    if (!response.ok) {
      const body = await readErrorBody(response);
      return { ok: false, models: [], contexts: {}, message: `HTTP ${response.status} from the model API. ${body}`.trim() };
    }
    const data = await response.json();
    const items = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
    const contexts = {};
    for (const item of items) {
      const id = item && (item.id || item.name);
      if (!id) continue;
      const window = extractContextWindow(item);
      if (window > 0 || contexts[id] === undefined) contexts[String(id)] = window;
    }
    const models = Object.keys(contexts).sort();
    if (!models.length) return { ok: true, models: [], contexts: {}, message: 'Connection worked, but no models were returned.' };
    return { ok: true, models, contexts, message: `API key is valid. ${models.length} model(s) loaded.` };
  } catch (error) {
    return { ok: false, models: [], contexts: {}, message: describeFetchError(error) };
  } finally {
    t.done();
  }
}

function usageOf(data) {
  const usage = (data && data.usage) || {};
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Number(usage.total_tokens || prompt + completion),
  };
}

/**
 * Parse an SSE body of chat.completion.chunk events into one assistant message.
 * onDelta(text) receives content deltas as they arrive.
 */
async function consumeStream(response, onDelta, signal) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const message = { role: 'assistant', content: '', tool_calls: [] };
  const toolCalls = new Map();
  let usage = null;
  let finishReason = null;
  let buffer = '';
  let reasoning = '';

  const handleEvent = (payload) => {
    if (!payload || payload === '[DONE]') return;
    let data;
    try { data = JSON.parse(payload); } catch (_) { return; }
    if (data.usage) usage = usageOf(data);
    const choice = (data.choices || [])[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string' && delta.content) {
      message.content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = typeof part.index === 'number' ? part.index : toolCalls.size;
        let entry = toolCalls.get(index);
        if (!entry) {
          entry = { id: part.id || `call_${index}`, type: 'function', function: { name: '', arguments: '' } };
          toolCalls.set(index, entry);
        }
        if (part.id) entry.id = part.id;
        if (part.function) {
          if (part.function.name) entry.function.name += part.function.name;
          if (part.function.arguments) entry.function.arguments += part.function.arguments;
        }
      }
    }
  };

  while (true) {
    if (signal && signal.aborted) { try { await reader.cancel(); } catch (_) { /* ignore */ } break; }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
    }
  }
  if (buffer.startsWith('data:')) handleEvent(buffer.slice(5).trim());
  message.tool_calls = [...toolCalls.keys()].sort((a, b) => a - b).map((k) => toolCalls.get(k));
  if (!message.tool_calls.length) delete message.tool_calls;
  if (!message.content && reasoning) message.reasoning_content = reasoning;
  return { message, usage, finishReason };
}

/**
 * One chat completion. Pass `tools` for native tool calling. Pass `onDelta`
 * to stream content. Returns {ok, message, usage, error, finishReason}.
 */
async function chat({
  serviceAddress, apiKey, model, messages, tools, toolChoice, temperature = 0.1,
  maxTokens = 2400, timeoutMs = 120000, signal, onDelta, stream = true, extraBody,
} = {}) {
  const endpoint = buildChatEndpoint(serviceAddress);
  if (!endpoint || !apiKey || !model) {
    return { ok: false, message: null, usage: null, error: 'Missing service address, API key, or model.' };
  }
  const body = { model, messages, temperature, max_tokens: maxTokens, ...(extraBody || {}) };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
    body.parallel_tool_calls = false;
  }
  const streaming = stream && typeof onDelta === 'function';
  if (streaming) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  const t = withTimeout(signal, timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: headers(apiKey, streaming ? { Accept: 'text/event-stream' } : null),
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!response.ok) {
      const detail = await readErrorBody(response);
      // Some servers reject stream_options; retry once without streaming.
      if (streaming && response.status === 400 && /stream_options|stream/i.test(detail)) {
        t.done();
        return chat({ serviceAddress, apiKey, model, messages, tools, toolChoice, temperature, maxTokens, timeoutMs, signal, stream: false, extraBody });
      }
      return { ok: false, message: null, usage: null, error: `HTTP ${response.status} from the model API. ${detail}`.trim() };
    }
    const contentType = String(response.headers.get('content-type') || '');
    if (streaming && contentType.includes('text/event-stream')) {
      const result = await consumeStream(response, onDelta, signal);
      if (signal && signal.aborted) return { ok: false, message: null, usage: result.usage, error: 'cancelled', cancelled: true };
      return { ok: true, message: result.message, usage: result.usage, error: '', finishReason: result.finishReason };
    }
    const data = await response.json();
    const choice = (data.choices || [])[0];
    if (!choice) return { ok: false, message: null, usage: usageOf(data), error: 'The model returned no choices.' };
    const message = choice.message || {};
    if (typeof message !== 'object') return { ok: false, message: null, usage: null, error: 'The model returned an invalid message shape.' };
    if (onDelta && typeof message.content === 'string' && message.content) onDelta(message.content);
    return { ok: true, message, usage: usageOf(data), error: '', finishReason: choice.finish_reason || null };
  } catch (error) {
    if (signal && signal.aborted) return { ok: false, message: null, usage: null, error: 'cancelled', cancelled: true };
    return { ok: false, message: null, usage: null, error: describeFetchError(error) };
  } finally {
    t.done();
  }
}

/** Plain text completion: returns {ok, text, error}. */
async function complete(options) {
  const result = await chat({ ...options, tools: undefined, stream: false });
  if (!result.ok) return { ok: false, text: '', error: result.error, usage: result.usage, cancelled: result.cancelled };
  const message = result.message || {};
  const text = String(message.content || message.reasoning_content || '').trim();
  return { ok: true, text, error: '', usage: result.usage };
}

/** Same call, retried on transient failures with backoff. onRetry(attempt, error). */
async function chatWithRetries(options, { maxAttempts = 6, onRetry, signal } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal && signal.aborted) return { ok: false, message: null, usage: null, error: 'cancelled', cancelled: true };
    last = await chat({ ...options, signal });
    if (last.ok || last.cancelled) return last;
    if (!isRetryableError(last.error) || attempt >= maxAttempts) return last;
    if (onRetry) onRetry(attempt, last.error);
    const wait = Math.min(500 * 2 ** (attempt - 1), 4000);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return last;
}

// ---------------------------------------------------------------------------
// Native tool-calling probe (as first implemented in DAYA Studio's _probe_native_tool_calling)
// ---------------------------------------------------------------------------
const TOOL_UNSUPPORTED_HINTS = [
  'tool-call-parser', 'tool_call_parser', 'tool_choice', 'does not support tools',
  'tools are not supported', 'tool calling is not supported', 'tool use is not supported',
  'function calling is not supported', 'tools is not supported',
];

function parseToolCall(call) {
  if (!call || typeof call !== 'object') return { name: '', args: {}, id: '' };
  const fn = call.function || {};
  const name = String(fn.name || call.name || '');
  const raw = fn.arguments !== undefined ? fn.arguments : (call.arguments !== undefined ? call.arguments : '{}');
  let args = {};
  if (raw && typeof raw === 'object') args = raw;
  else {
    try {
      const parsed = JSON.parse(String(raw || '{}'));
      args = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      args = { __parse_error: String(raw).slice(0, 2000) };
    }
  }
  return { name, args, id: String(call.id || '') };
}

/**
 * Ask the model to call one trivial tool. Returns
 * {verdict:'supported'|'unsupported'|'inconclusive', detail}. Only an actual
 * model response decides a capability; an outage stays inconclusive.
 */
async function probeToolCalling({ serviceAddress, apiKey, model, timeoutMs = 30000, signal } = {}) {
  const result = await chat({
    serviceAddress, apiKey, model, timeoutMs, signal, stream: false, temperature: 0, maxTokens: 64,
    messages: [
      { role: 'system', content: 'You are checking native tool-call support. Call the provided tool.' },
      { role: 'user', content: 'Call the tool with value ok.' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'patch_code_probe',
        description: 'Probe whether this model can emit native tool calls.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string', description: 'Return ok.' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    }],
    toolChoice: 'required',
  });
  if (!result.ok) {
    const status = httpStatusOf(result.error);
    const text = String(result.error || '').toLowerCase();
    if ((status === 400 || status === 422) && TOOL_UNSUPPORTED_HINTS.some((h) => text.includes(h))) {
      return { verdict: 'unsupported', detail: result.error };
    }
    return { verdict: 'inconclusive', detail: result.error };
  }
  const calls = Array.isArray(result.message.tool_calls) ? result.message.tool_calls : [];
  if (calls.length === 1) {
    const { name } = parseToolCall(calls[0]);
    if (name === 'patch_code_probe') return { verdict: 'supported', detail: 'Native tool calling supported.' };
    return { verdict: 'unsupported', detail: `The probe returned an unexpected tool call: ${name || '(missing name)'}.` };
  }
  if (calls.length > 1) return { verdict: 'unsupported', detail: 'The probe returned multiple tool calls.' };
  return { verdict: 'unsupported', detail: 'The probe response did not include message.tool_calls.' };
}

module.exports = {
  buildChatEndpoint, buildModelsEndpoint, extractContextWindow, listModels, chat, complete,
  chatWithRetries, probeToolCalling, parseToolCall, isRetryableError, errorKind, friendlyError,
  httpStatusOf, consumeStream,
};
