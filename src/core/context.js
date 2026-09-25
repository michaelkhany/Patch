'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * The system prompt. It is assembled fresh for every run from what is true
 * right now: the workspace, the platform, the permission mode, the sandbox
 * rules, the user's PATCHCODE.md files, the editors that are open and the
 * problems VS Code reports - and, in text mode, the tool protocol.
 */

const os = require('os');
const path = require('path');
const languages = require('./languages');
const textprotocol = require('./textprotocol');

const IDENTITY = `You are Patch Code, an autonomous coding agent running inside Visual Studio Code. You help with software engineering tasks in any language: reading and editing files, writing new code, running commands and tests, fixing errors, explaining code and performing analyses.

You work in PATCHES - Michael Bidollahkhani's coding mechanism, first applied in DAYA Studio's iTailor: a natural-language request becomes a block of code that is written, RUN against the real environment, and repaired from its actual error output until it works. Never hand the user code you could have verified but did not.`;

const METHOD = `HOW TO WORK
- Understand before changing: Read the files involved (or their KnowledgeGraph) before you Edit them. Never guess file contents.
- Prefer Edit (exact string replacement) for changes to existing files; Write only for new files or full rewrites. Keep changes minimal and in the project's existing style.
- Verify: after a change run the relevant test, build, lint or a small RunCode script. When something fails, read the real error, fix the actual defect, and run again. Do not hide failures behind try/except and never replace real work with a stub.
- A missing library is not a coding mistake: use Install (or let RunCode heal it) rather than rewriting around it - unless the user declined the install, in which case solve it in code.
- Use WebSearch/WebFetch to look up an API or an error instead of guessing when you are unsure.
- One tool call at a time; wait for its result. Narrate briefly what you are doing and why.
- When the task is done, reply with a short plain-language summary of what you changed and how you verified it. Reference files as path:line.
- Ask the user only when you genuinely cannot proceed; otherwise make the routine decision and say what you assumed.
- Refuse destructive actions (deleting the repository, force-pushing, wiping disks) and say so plainly.`;

function sandboxRules(settings) {
  const lines = ['SANDBOX - enforced at runtime, not advice:'];
  if (settings.sandbox && settings.sandbox.confineToWorkspace !== false) {
    lines.push('* Read and write only inside the workspace folder. Paths outside it are refused.');
  }
  if (settings.sandbox && settings.sandbox.allowNetwork === false) lines.push('* No network access: WebSearch/WebFetch are disabled.');
  lines.push('* Commands run without a shell: no pipes, no &&, no redirects. Run one command per Shell call.');
  lines.push('* Scripts run through RunCode are written under .patchcode/runs/ and execute with the workspace as working directory.');
  return lines.join('\n');
}

function permissionNote(mode) {
  switch (mode) {
    case 'plan': return 'PERMISSION MODE: plan. You may only READ (Read, Glob, Grep, ListDir, Diagnostics, KnowledgeGraph, WebSearch, WebFetch). Produce a concrete plan; do not edit or run anything.';
    case 'acceptEdits': return 'PERMISSION MODE: acceptEdits. File edits are applied without asking; commands, scripts and installs still ask the user.';
    case 'bypassPermissions': return 'PERMISSION MODE: bypassPermissions. Nothing asks the user. Be careful.';
    default: return 'PERMISSION MODE: default. Read-only tools run immediately; edits, commands, scripts and installs pause and ask the user (allow once / always / deny). A denied request is final for this run - respect it.';
  }
}

/**
 * @param {Object} o
 * @param {string} o.cwd
 * @param {Object} o.settings
 * @param {Array<{file:string, scope:string, text:string}>} [o.contextFiles]
 * @param {'native'|'text'} o.toolMode
 * @param {Array} o.tools   tool specs (for text mode)
 * @param {Object} [o.editor] {openFiles:[{path, language, active, selection:{start,end,text}}], diagnostics:string}
 * @param {string} [o.extra]
 */
function buildSystemPrompt({ cwd, settings, contextFiles, toolMode, tools, editor, extra } = {}) {
  const parts = [IDENTITY];
  parts.push(`ENVIRONMENT
- Workspace root: ${cwd}
- Platform: ${process.platform} ${os.release()} (${os.arch()}), Node ${process.versions.node}
- Shell for the user: ${process.platform === 'win32' ? 'PowerShell / cmd' : (process.env.SHELL || 'sh')}
- Date: ${new Date().toISOString().slice(0, 10)}
- Languages Patch Code can run here: ${languages.runnable().join(', ')}. Every other language can be read and edited.`);
  parts.push(METHOD);
  parts.push(permissionNote(settings.permissionMode));
  parts.push(sandboxRules(settings));
  if (contextFiles && contextFiles.length) {
    for (const item of contextFiles) {
      parts.push(`PROJECT INSTRUCTIONS from ${item.file} (${item.scope}) - follow them:\n${item.text.trim()}`);
    }
  }
  if (editor) {
    const open = (editor.openFiles || []).slice(0, 12).map((f) => `- ${f.path}${f.language ? ' [' + f.language + ']' : ''}${f.active ? ' (active editor)' : ''}`);
    if (open.length) parts.push('OPEN EDITORS:\n' + open.join('\n'));
    const active = (editor.openFiles || []).find((f) => f.active);
    if (active && active.selection && active.selection.text) {
      parts.push(`SELECTED TEXT in ${active.path} (lines ${active.selection.start}-${active.selection.end}):\n\`\`\`\n${active.selection.text.slice(0, 6000)}\n\`\`\``);
    }
    if (editor.diagnostics) parts.push('PROBLEMS VS CODE REPORTS RIGHT NOW:\n' + editor.diagnostics.slice(0, 6000));
  }
  if (extra) parts.push(extra);
  if (toolMode === 'text') parts.push(textprotocol.instructions(tools || []));
  return parts.join('\n\n');
}

/** The prompt for generating ONE patch in place (the @patch editor command). */
function buildPatchPrompt({ filePath, language, graph, before, after, request, previousError, requestIndex }) {
  const fence = languages.fenceOf(language) || '';
  return [
    `You are writing patch ${requestIndex} of the file ${filePath} (${language ? language.label : 'unknown language'}).`,
    'The user wrote a natural-language instruction where the code should go. Reply with ONLY the code for THAT patch inside a single fenced block (```' + fence + ' … ```), no prose.',
    'Rules: reuse what the file already defines (see the knowledge graph) - never re-import or redefine it; write code that really runs (no placeholders, no TODOs); match the file\'s style and indentation; emit only the new code, never the surrounding lines.',
    graph ? `KNOWLEDGE GRAPH of the file so far:\n${graph}` : '',
    before ? `CODE BEFORE THE PATCH (read-only context):\n\`\`\`${fence}\n${before}\n\`\`\`` : '',
    after ? `CODE AFTER THE PATCH (read-only context):\n\`\`\`${fence}\n${after}\n\`\`\`` : '',
    previousError ? `YOUR PREVIOUS ATTEMPT FAILED WITH:\n${previousError}\nReturn the COMPLETE corrected patch.` : '',
    `INSTRUCTION FOR THIS PATCH:\n${request}`,
  ].filter(Boolean).join('\n\n');
}

/** Rough token estimate (4 chars per token) for context trimming. */
function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

module.exports = { buildSystemPrompt, buildPatchPrompt, estimateTokens, sandboxRules, permissionNote, IDENTITY, path };
