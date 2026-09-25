'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * The agent loop.
 *
 * The same loop as DAYA Studio's chat agent and Program-mode agent, generalised
 * for a code workspace: ask the model, execute the one tool it asked for
 * (after the permission gate and the hooks), hand the result back, repeat
 * until the model answers in plain text or the step budget is spent.
 *
 * Native tool calling is used when the model supports it; otherwise the same
 * tools are exposed through the text protocol. Transient API failures are
 * retried with backoff; a run can be cancelled at any await point.
 */

const llm = require('./llm');
const tools = require('./tools');
const permissions = require('./permissions');
const textprotocol = require('./textprotocol');
const hooks = require('./hooks');
const context = require('./context');

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'ListDir', 'Diagnostics', 'KnowledgeGraph', 'WebSearch', 'WebFetch'];
const MAX_TOOL_RESULT_CHARS = 30000;
const KEEP_RECENT_TOOL_RESULTS = 8;

function clip(text, limit) {
  const s = String(text || '');
  return s.length > limit ? s.slice(0, limit) + `\n…[${s.length - limit} more characters truncated]` : s;
}

function serializeResult(result) {
  if (typeof result === 'string') return clip(result, MAX_TOOL_RESULT_CHARS);
  try { return clip(JSON.stringify(result, null, 1), MAX_TOOL_RESULT_CHARS); } catch (_) { return clip(String(result), MAX_TOOL_RESULT_CHARS); }
}

/**
 * Keep the conversation within budget: older tool results are collapsed to a
 * one-line note, newest ones stay verbatim (the model rarely needs a file it
 * read ten steps ago in full).
 */
function trimConversation(messages, maxTokens) {
  if (context.estimateTokens(messages) <= maxTokens) return messages;
  const out = messages.map((m) => ({ ...m }));
  let seen = 0;
  for (let i = out.length - 1; i >= 1; i--) {
    const m = out[i];
    const isToolResult = m.role === 'tool' || (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<tool_result'));
    if (!isToolResult) continue;
    seen++;
    if (seen <= KEEP_RECENT_TOOL_RESULTS) continue;
    if (typeof m.content === 'string' && m.content.length > 400) m.content = m.content.slice(0, 300) + '\n…[earlier tool result trimmed to save context]';
    if (context.estimateTokens(out) <= maxTokens) break;
  }
  return out;
}

/**
 * Run one turn of the agent.
 * @param {Object} o
 * @param {{serviceAddress:string, apiKey:string, model:string}} o.llmConfig
 * @param {Object} o.settings              merged settings
 * @param {string} o.cwd                   workspace root
 * @param {Array} [o.history]              prior messages (without the system prompt)
 * @param {string} o.userText
 * @param {'native'|'text'} [o.toolMode]
 * @param {Function} [o.emit]              (type, payload) -> void
 * @param {Function} [o.ask]               permission prompt -> Promise<'allow'|'always'|'deny'>
 * @param {AbortSignal} [o.signal]
 * @param {Object} [o.host]                VS Code services (diagnostics, writeFile, readOverride, editorContext)
 * @param {Array} [o.contextFiles]
 * @param {string} [o.extraSystem]
 * @returns {Promise<{ok:boolean, text:string, messages:Array, usage:Object, steps:number, error?:string, cancelled?:boolean}>}
 */
async function runTurn(o) {
  const emit = o.emit || (() => {});
  const settings = o.settings;
  const signal = o.signal;
  const toolMode = o.toolMode === 'text' ? 'text' : 'native';
  const planMode = settings.permissionMode === 'plan';
  const toolNames = planMode ? READ_ONLY_TOOLS : tools.names().filter((n) => !(n === 'WebSearch' || n === 'WebFetch') || settings.webSearch !== false);
  const specs = tools.specs(toolNames);
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
  const addUsage = (u) => { if (!u) return; usage.promptTokens += u.promptTokens || 0; usage.completionTokens += u.completionTokens || 0; usage.totalTokens += u.totalTokens || 0; usage.requests++; };

  const gate = permissions.makeGate({
    mode: settings.permissionMode, rules: settings.permissions, ask: o.ask, signal,
    timeoutMs: 1000 * (Number(settings.permissionTimeoutSeconds) || 300),
    onDecision: (d) => emit('decision', d),
  });

  const ctx = {
    cwd: o.cwd, settings, gate, signal, emit, host: o.host || null,
    readOverride: o.host && o.host.readOverride ? o.host.readOverride : null,
    confine: !(settings.sandbox && settings.sandbox.confineToWorkspace === false),
    onOutput: (chunk, stream) => emit('output', { chunk, stream }),
  };

  const editor = o.host && o.host.editorContext ? await o.host.editorContext() : null;
  const system = context.buildSystemPrompt({
    cwd: o.cwd, settings, contextFiles: o.contextFiles, toolMode,
    tools: specs.map((s) => s.function), editor, extra: o.extraSystem,
  });
  const contextBudget = Math.max(8000, Number(o.contextTokens) || 60000);

  let messages = [{ role: 'system', content: system }, ...(o.history || []), { role: 'user', content: o.userText }];
  let steps = 0;
  let emptyTurns = 0;
  let finalText = '';

  const cancelled = () => ({ ok: false, cancelled: true, text: finalText, messages: messages.slice(1), usage, steps, error: 'Stopped by user.' });

  for (steps = 0; steps < settings.maxSteps; steps++) {
    if (signal && signal.aborted) return cancelled();
    messages = trimConversation(messages, contextBudget);
    emit('think', steps === 0 ? 'Thinking…' : 'Deciding the next step…');
    let streamed = '';
    const result = await llm.chatWithRetries({
      serviceAddress: o.llmConfig.serviceAddress, apiKey: o.llmConfig.apiKey, model: o.llmConfig.model,
      messages, tools: toolMode === 'native' ? specs : undefined, toolChoice: 'auto',
      temperature: settings.temperature, maxTokens: settings.maxTokens,
      timeoutMs: 1000 * (Number(settings.modelTimeoutSeconds) || 180),
      // In text mode the reply may contain a <tool> block, which must not be
      // streamed into the chat as prose - the parsed narration is emitted instead.
      stream: settings.streaming !== false && toolMode === 'native',
      onDelta: toolMode === 'native' ? (delta) => { streamed += delta; emit('delta', delta); } : undefined,
    }, {
      maxAttempts: 8, signal,
      onRetry: (attempt, error) => emit('think', attempt === 1 ? 'The model API is slow or busy; retrying…' : `Still retrying the model API (${attempt})…`),
    });
    if (result.cancelled) return cancelled();
    addUsage(result.usage);
    emit('usage', { ...usage });
    if (!result.ok) {
      const message = llm.friendlyError(result.error, 'running the agent');
      emit('error', { message, kind: llm.errorKind(result.error) });
      return { ok: false, text: finalText, messages: messages.slice(1), usage, steps, error: message, errorKind: llm.errorKind(result.error) };
    }

    const message = result.message || {};
    const content = String(message.content || '').trim();
    let calls = [];
    let narration = content;
    if (toolMode === 'native' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      calls = message.tool_calls.map((c) => ({ ...llm.parseToolCall(c), raw: c }));
    } else if (content) {
      const parsed = textprotocol.parse(content);
      if (parsed.toolCalls.length) { calls = parsed.toolCalls; narration = parsed.content; }
    }

    if (!calls.length) {
      if (!content) {
        emptyTurns++;
        if (emptyTurns >= 2) {
          messages.push({ role: 'user', content: 'Your last reply was empty. Reply with your answer, or call a tool.' });
          continue;
        }
        messages.push({ role: 'user', content: 'Continue.' });
        continue;
      }
      if (!streamed) emit('delta', content);
      finalText = content;
      messages.push({ role: 'assistant', content });
      emit('final', { text: content });
      return { ok: true, text: content, messages: messages.slice(1), usage, steps: steps + 1 };
    }
    emptyTurns = 0;

    // Record the assistant turn exactly as the model produced it.
    if (toolMode === 'native') messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls.map((c) => c.raw) });
    else messages.push({ role: 'assistant', content });
    if (narration && streamed === '') emit('delta', narration);

    for (const call of calls) {
      if (signal && signal.aborted) return cancelled();
      const output = await executeCall(call, { ctx, toolNames, settings, emit, planMode });
      if (toolMode === 'native') messages.push({ role: 'tool', tool_call_id: call.id || call.raw?.id || `call_${steps}`, name: call.name, content: serializeResult(output) });
      else messages.push({ role: 'user', content: textprotocol.formatResult(call.name, output) });
    }
  }

  emit('think', `Stopped after ${settings.maxSteps} steps.`);
  // Salvage: ask for a plain answer from what was gathered.
  const summary = await llm.complete({
    serviceAddress: o.llmConfig.serviceAddress, apiKey: o.llmConfig.apiKey, model: o.llmConfig.model,
    messages: [...trimConversation(messages, contextBudget), { role: 'user', content: 'You are out of tool steps. Summarise what you did, what is verified, and what remains, in plain text.' }],
    temperature: 0.2, maxTokens: 1200, signal,
  });
  addUsage(summary.usage);
  finalText = summary.ok ? summary.text : `Stopped after ${settings.maxSteps} steps without a final answer.`;
  messages.push({ role: 'assistant', content: finalText });
  emit('final', { text: finalText });
  return { ok: summary.ok, text: finalText, messages: messages.slice(1), usage, steps, error: summary.ok ? undefined : 'step budget exhausted' };
}

async function executeCall(call, { ctx, toolNames, settings, emit, planMode }) {
  const name = call.name;
  const args = call.args || {};
  const tool = tools.get(name);
  const description = tools.describe(name, args);
  emit('tool_call', { id: call.id, name, args, description });
  const finish = (output, ok) => { emit('tool_result', { id: call.id, name, ok, result: output }); return output; };

  if (!tool || !toolNames.includes(name)) {
    return finish({ error: `Unknown tool '${name}'. Available tools: ${toolNames.join(', ')}.${planMode ? ' (plan mode: read-only tools only)' : ''}` }, false);
  }
  if (args.__parse_error) {
    return finish({ error: `The arguments for ${name} were not valid JSON: ${args.__parse_error.slice(0, 300)}. Send a single JSON object.` }, false);
  }
  const missing = (tool.parameters.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length) return finish({ error: `${name} needs: ${missing.join(', ')}.` }, false);

  const classification = tool.classify ? tool.classify(args) : {};
  const command = tools.commandOf(name, args);
  const verdict = await ctx.gate(name, args, {
    summary: description, detail: args.reason || classification.why || '', command,
    readOnly: classification.readOnly, destructive: classification.destructive,
  });
  if (!verdict.allowed) {
    emit('observe', `${description} - not allowed (${verdict.reason}).`);
    return finish({ error: `Permission denied for ${name}: ${verdict.reason}. Do not retry the same action; choose another approach or ask the user.` }, false);
  }

  const pre = await hooks.run('PreToolUse', { settings, cwd: ctx.cwd, toolName: name, payload: { args }, signal: ctx.signal });
  if (pre.block) return finish({ error: `Blocked by a PreToolUse hook: ${pre.reason}` }, false);

  let output;
  try {
    output = await tool.execute(args, ctx);
  } catch (error) {
    output = { error: `${error.name || 'Error'}: ${error.message}` };
  }
  if (ctx.signal && ctx.signal.aborted) return finish({ error: 'Stopped by user.' }, false);
  const post = await hooks.run('PostToolUse', { settings, cwd: ctx.cwd, toolName: name, payload: { args, result: output }, signal: ctx.signal });
  if (post.results.length) output = { ...output, hookOutput: post.results.map((r) => `${r.command}: exit ${r.exitCode}\n${r.stdout}\n${r.stderr}`.trim()).join('\n') };
  const ok = !(output && output.error) && output?.success !== false;
  const summaryLine = summarize(name, args, output);
  if (summaryLine) emit('observe', summaryLine);
  return finish(output, ok);
}

function summarize(name, args, output) {
  if (!output || typeof output !== 'object') return '';
  if (output.error) return `${name}: ${String(output.error).slice(0, 200)}`;
  switch (name) {
    case 'Read': return `Read ${output.path} (${output.shown}/${output.totalLines} lines)`;
    case 'Write': return `${output.action === 'created' ? 'Created' : 'Updated'} ${output.path} (${output.lines} lines)`;
    case 'Edit': return `Edited ${output.path} (${output.replaced} replacement${output.replaced === 1 ? '' : 's'})`;
    case 'Glob': return `Glob ${args.pattern}: ${output.count} file(s)`;
    case 'Grep': return `Grep /${args.pattern}/: ${output.matches} match(es) in ${output.filesScanned} file(s)`;
    case 'Shell': return `${args.command} → exit ${output.exitCode}${output.durationMs ? ` (${Math.round(output.durationMs / 1000 * 10) / 10}s)` : ''}`;
    case 'RunCode': return `${output.language} script → exit ${output.exitCode}${(output.files || []).length ? `, ${output.files.length} file(s) produced` : ''}`;
    case 'Install': return `Installed ${(output.installed || []).join(', ') || 'nothing'}`;
    case 'WebSearch': return `WebSearch: ${(output.results || []).length} result(s)`;
    case 'WebFetch': return `Fetched ${args.url}`;
    case 'Diagnostics': return `Diagnostics: ${output.count === undefined ? 'collected' : output.count + ' problem(s)'}`;
    default: return '';
  }
}

module.exports = { runTurn, trimConversation, READ_ONLY_TOOLS, serializeResult };
