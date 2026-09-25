'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Hooks, in Claude Code's shape:
 *
 *   "hooks": {
 *     "PreToolUse":  [{ "matcher": "Shell|Write", "hooks": [{ "type": "command", "command": "python check.py" }] }],
 *     "PostToolUse": [{ "matcher": "Edit",        "hooks": [{ "type": "command", "command": "npm run lint" }] }],
 *     "Stop":        [{ "hooks": [{ "type": "command", "command": "..." }] }]
 *   }
 *
 * Each hook command receives a JSON payload on stdin. Exit code 2 blocks the
 * action (PreToolUse) and its stderr is fed back to the model; any other
 * non-zero exit is reported but does not block.
 */

const shell = require('./tools/shell');

function matches(matcher, toolName) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  const text = String(matcher);
  if (text === toolName) return true;
  try { return new RegExp(`^(?:${text})$`).test(toolName); } catch (_) { return text.split('|').map((s) => s.trim()).includes(toolName); }
}

/** Run every hook registered for `event`. Returns {block, reason, results}. */
async function run(event, { settings, cwd, toolName, payload, signal, timeoutMs = 60000 } = {}) {
  const entries = (settings && settings.hooks && settings.hooks[event]) || [];
  const results = [];
  let block = false;
  let reason = '';
  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    if (toolName && !matches(entry.matcher, toolName)) continue;
    for (const hook of entry.hooks) {
      if (!hook || hook.type !== 'command' || !hook.command) continue;
      const result = await shell.run(hook.command, {
        cwd, timeoutMs: Number(hook.timeout) * 1000 || timeoutMs, signal, env: settings.env,
        stdin: JSON.stringify({ event, tool: toolName || null, cwd, ...(payload || {}) }),
      });
      results.push({ command: hook.command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      if (result.exitCode === 2) {
        block = true;
        reason = (result.stderr || result.stdout || `blocked by hook: ${hook.command}`).trim();
        return { block, reason, results };
      }
    }
  }
  return { block, reason, results };
}

module.exports = { run, matches };
