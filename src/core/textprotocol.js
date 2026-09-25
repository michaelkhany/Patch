'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Tool calling for models WITHOUT native function calling.
 *
 * DAYA probes every model once; the ones that cannot emit `tool_calls`
 * still work because the code they write comes back in a fenced block. Patch
 * Code generalises that: such a model is told to answer with exactly one
 * <tool> block, which is parsed here into the same {name, args} shape the
 * native path produces, and tool results go back as plain text.
 */

const TOOL_BLOCK_RE = /<tool\s+name\s*=\s*["']([A-Za-z_][\w]*)["']\s*>\s*([\s\S]*?)\s*<\/tool>/i;
const FENCED_TOOL_RE = /```tool[ \t]*\r?\n([\s\S]*?)```/i;
const JSON_LINE_RE = /^\s*\{\s*"tool"\s*:\s*"([A-Za-z_]\w*)"[\s\S]*\}\s*$/m;

function parseArgs(text) {
  const body = String(text || '').trim();
  if (!body) return {};
  const cleaned = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    const match = /\{[\s\S]*\}/.exec(cleaned);
    if (match) {
      try { const parsed = JSON.parse(match[0]); return parsed && typeof parsed === 'object' ? parsed : {}; } catch (_2) { /* fall through */ }
    }
    return { __parse_error: cleaned.slice(0, 2000) };
  }
}

/**
 * Parse an assistant reply. Returns {content, toolCalls:[{id,name,args}]}.
 * `content` is the text before the first tool block (the model's narration).
 */
function parse(text) {
  const s = String(text || '');
  let match = TOOL_BLOCK_RE.exec(s);
  if (match) {
    return { content: s.slice(0, match.index).trim(), toolCalls: [{ id: `text_${Date.now()}`, name: match[1], args: parseArgs(match[2]) }] };
  }
  match = FENCED_TOOL_RE.exec(s);
  if (match) {
    const args = parseArgs(match[1]);
    const name = args.tool || args.name;
    if (name) {
      const rest = { ...args };
      delete rest.tool; delete rest.name;
      const inner = rest.args && typeof rest.args === 'object' ? rest.args : rest;
      return { content: s.slice(0, match.index).trim(), toolCalls: [{ id: `text_${Date.now()}`, name: String(name), args: inner }] };
    }
  }
  match = JSON_LINE_RE.exec(s);
  if (match) {
    const args = parseArgs(match[0]);
    if (args.tool) {
      const inner = args.args && typeof args.args === 'object' ? args.args : (() => { const r = { ...args }; delete r.tool; return r; })();
      return { content: s.slice(0, match.index).trim(), toolCalls: [{ id: `text_${Date.now()}`, name: String(args.tool), args: inner }] };
    }
  }
  return { content: s.trim(), toolCalls: [] };
}

/** The instructions appended to the system prompt in text mode. */
function instructions(tools) {
  const lines = tools.map((t) => {
    const props = t.parameters && t.parameters.properties ? t.parameters.properties : {};
    const required = new Set((t.parameters && t.parameters.required) || []);
    const params = Object.entries(props).map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${v.type || 'any'}${v.description ? ' - ' + v.description : ''}`).join('; ');
    return `- ${t.name}: ${t.description}\n    parameters: ${params || '(none)'}`;
  });
  return [
    'TOOL PROTOCOL (this model has no native function calling, so tools are called in text):',
    'To use a tool, reply with a short sentence of intent and then EXACTLY ONE block in this shape, and nothing after it:',
    '<tool name="Read">',
    '{"path": "src/app.py"}',
    '</tool>',
    'The arguments are a single JSON object. You will receive the result in the next message as <tool_result>. ',
    'Call one tool per reply. When the task is complete, reply with plain text and NO tool block.',
    '',
    'AVAILABLE TOOLS:',
    ...lines,
  ].join('\n');
}

/** Render a tool result for the next user turn. */
function formatResult(name, result) {
  const body = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
  return `<tool_result name="${name}">\n${body.slice(0, 30000)}\n</tool_result>`;
}

module.exports = { parse, parseArgs, instructions, formatResult, TOOL_BLOCK_RE };
