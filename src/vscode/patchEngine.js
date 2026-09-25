'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * The iTailor patch engine inside the editor.
 *
 * Two operations, both first implemented in DAYA Studio:
 *
 * applyPatches(editor)   Every `@patch <instruction>` comment in the file
 *                        becomes code in place. The model is shown the
 *                        knowledge graph of the file and the code around the
 *                        request, and replies with ONLY the new code, which is
 *                        inserted under a marker comment. If the file can be
 *                        executed, it is then run and repaired.
 *
 * runAndRepair(editor)   Run the file, and on failure hand the numbered
 *                        source plus the real error to the model, apply the
 *                        COMPLETE corrected file (markers intact, undoable
 *                        WorkspaceEdit), and run again - until it exits clean,
 *                        the same failure comes back twice, or the attempt
 *                        budget is spent. A missing package is installed
 *                        (with permission) and the same code re-run.
 */

const vscode = require('vscode');
const path = require('path');
const llm = require('../core/llm');
const patch = require('../core/patch');
const languages = require('../core/languages');
const permissions = require('../core/permissions');
const context = require('../core/context');
const shell = require('../core/tools/shell');
const packages = require('../core/tools/packages');
const host = require('./host');

const REPEAT_LIMIT = 2;

const FIX_SYSTEM = `You are the debugging half of Patch Code. You are given a source file, how it was run, and how it failed. Diagnose and repair it.

Classify the failure as exactly one of "package" (a dependency is missing or too old), "system" (something outside the code is missing: an executable, a service, a variable, a file), "script" (a coding mistake) or "logic" (ran, but the result is wrong).

Reply in EXACTLY this shape and nothing else:

<json>
{"kind": "script", "analysis": "one or two sentences on what actually went wrong",
 "plan": "what you are about to change", "commands": [{"cmd": "pip install foo", "reason": "why"}]}
</json>

\`\`\`
# the COMPLETE corrected file
\`\`\`

Rules:
- "commands" is [] unless kind is "package" or "system". Commands must be non-interactive and a single command each - no pipes, no chaining.
- Omit the code block entirely when a command alone fixes it and the code is already correct.
- When you return code, return the WHOLE file. Keep every "===== PATCH n :: id =====" marker line and the "> " description lines under it byte-identical and in order - they map code back to the user's patches.
- Change as little as possible. Do not restyle working code. Never delete the user's intent to silence an error, never replace real work with a stub or a fake result.
- If a package is missing, do NOT rewrite the code to avoid it unless the user already refused to install it.`;

function jsonBlock(text) {
  const m = /<json>([\s\S]*?)<\/json>/.exec(text || '');
  const raw = (m ? m[1] : '').trim().replace(/^```(?:json)?|```$/g, '');
  try { return JSON.parse(raw); } catch (_) {
    const inner = /\{[\s\S]*\}/.exec(raw);
    if (inner) { try { return JSON.parse(inner[0]); } catch (_2) { /* ignore */ } }
    return {};
  }
}

function reindent(code, indent) {
  if (!indent) return code;
  return code.split('\n').map((l) => (l.trim() ? indent + l : l)).join('\n');
}

class PatchEngine {
  constructor(config, chat, output) {
    this.config = config;
    this.chat = chat;
    this.output = output;
    this.abort = null;
  }

  stop() { if (this.abort) this.abort.abort(); }

  languageOf(document, settings) {
    return languages.resolve(document.languageId, document.fileName) || languages.byId(settings.language) || languages.byId('plaintext');
  }

  async prepare() {
    await this.chat.reveal();
    const resolved = await this.chat.ensureReady({ probe: false });
    if (!resolved) { this.chat.postDone(); return null; }
    if (resolved.settings.permissionMode === 'plan') {
      this.chat.post({ type: 'error', text: 'Plan mode is read-only. Switch the permission mode to apply patches.' });
      this.chat.postDone();
      return null;
    }
    this.abort = new AbortController();
    const cwd = this.config.workspaceRoot() || path.dirname(vscode.window.activeTextEditor.document.fileName);
    const gate = permissions.makeGate({
      mode: resolved.settings.permissionMode, rules: resolved.settings.permissions, ask: (q) => this.chat.ask(q), signal: this.abort.signal,
      timeoutMs: 1000 * (Number(resolved.settings.permissionTimeoutSeconds) || 300),
    });
    return { resolved, settings: resolved.settings, cwd, gate, signal: this.abort.signal };
  }

  async complete(run, messages, { maxTokens = 4000, temperature = 0.1 } = {}) {
    const result = await llm.chatWithRetries({
      serviceAddress: run.resolved.serviceAddress, apiKey: run.resolved.apiKey, model: run.resolved.model,
      messages, temperature, maxTokens, stream: false, timeoutMs: 1000 * (Number(run.settings.modelTimeoutSeconds) || 180),
    }, { maxAttempts: 6, signal: run.signal, onRetry: () => this.chat.postThink('The model API is slow or busy; retrying…') });
    if (result.cancelled) throw new Error('Stopped by user.');
    if (!result.ok) throw new Error(llm.friendlyError(result.error, 'generating a patch'));
    return String((result.message && (result.message.content || result.message.reasoning_content)) || '');
  }

  // -- apply @patch requests ----------------------------------------------
  async applyPatches(editor) {
    const document = editor.document;
    const run = await this.prepare();
    if (!run) return;
    const lang = this.languageOf(document, run.settings);
    const rel = host.relative(run.cwd, document.fileName);
    this.chat.post({ type: 'user', text: `Apply @patch requests in ${rel}` });
    try {
      let requests = patch.findRequests(document.getText());
      if (!requests.length) {
        this.chat.postSystem(`No @patch requests in ${rel}. Write one as a comment, e.g. ${languages.commentLine(lang, '@patch validate the input and raise on empty rows')}`);
        return;
      }
      this.chat.postSystem(`${requests.length} patch request(s) in ${rel} (${lang.label}).`);
      let generated = 0;
      let index = 0;
      while (true) {
        if (run.signal.aborted) throw new Error('Stopped by user.');
        requests = patch.findRequests(document.getText());
        if (!requests.length) break;
        const request = requests[0];
        index++;
        const source = document.getText();
        const lines = source.split(/\r?\n/);
        const before = lines.slice(Math.max(0, request.line - 80), request.line).join('\n');
        const after = lines.slice(request.line + 1, request.line + 41).join('\n');
        const graphSource = lines.filter((_, i) => i !== request.line).join('\n');
        const graph = patch.graphPrompt(patch.analyse(graphSource, lang.id));
        const existing = patch.mapSource(source).length;
        const id = patch.newId();
        this.chat.postThink(`Writing code for patch ${index}: ${request.prompt.slice(0, 80)}`);
        this.chat.post({ type: 'tool_call', call: { id, name: 'Patch', args: { file: rel, instruction: request.prompt }, description: `Patch ${index}: ${request.prompt.slice(0, 70)}` } });

        const verdict = await run.gate('Patch', { path: rel }, { summary: `Insert generated code for patch ${index} into ${rel}?`, detail: request.prompt, command: '' });
        if (!verdict.allowed) {
          this.chat.post({ type: 'tool_result', result: { id, name: 'Patch', ok: false, result: { error: `Not allowed (${verdict.reason}).` } } });
          break;
        }
        let code = '';
        let previousError = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          const prompt = context.buildPatchPrompt({ filePath: rel, language: lang, graph, before, after, request: request.prompt, previousError, requestIndex: index });
          const reply = await this.complete(run, [
            { role: 'system', content: `You are Patch Code, a coding engine built on the patch mechanism that also powers DAYA Studio's Patchbooks. You write ${lang.label} code for one patch at a time.` },
            { role: 'user', content: prompt },
          ]);
          code = patch.stripMarkers(patch.extractCode(reply, lang.fence));
          if (code.trim()) break;
          previousError = 'The reply contained no code. Reply with the patch code inside a single fenced block.';
        }
        if (!code.trim()) {
          this.chat.post({ type: 'tool_result', result: { id, name: 'Patch', ok: false, result: { error: 'The model returned no code for this patch.' } } });
          break;
        }
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const block = [
          request.indent + patch.marker(lang, existing + 1, id),
          ...request.prompt.split('\n').map((p) => request.indent + patch.promptLine(lang, p)),
          reindent(code, request.indent),
        ].join(eol);
        const lineRange = document.lineAt(request.line).range;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, lineRange, block);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) throw new Error('VS Code refused the edit.');
        generated++;
        this.chat.post({ type: 'tool_result', result: { id, name: 'Patch', ok: true, result: { content: code, lines: code.split('\n').length } } });
        this.chat.post({ type: 'observe', text: `Patch ${index} written (${code.split('\n').length} lines).` });
      }
      if (document.isDirty) await document.save();
      if (generated && (lang.run || lang.compile)) {
        this.chat.postSystem('Running the file to verify the patches…');
        await this.repairLoop(editor, run, lang);
      } else if (generated) {
        this.chat.postAssistant(`Applied ${generated} patch(es) to ${rel}. ${lang.label} files are not executed by Patch Code, so review the result and run it yourself.`);
      }
    } catch (error) {
      this.chat.post({ type: 'error', text: error.message });
    } finally {
      this.abort = null;
      this.chat.postDone();
    }
  }

  // -- run & repair --------------------------------------------------------
  async runAndRepair(editor) {
    const run = await this.prepare();
    if (!run) return;
    const lang = this.languageOf(editor.document, run.settings);
    const rel = host.relative(run.cwd, editor.document.fileName);
    this.chat.post({ type: 'user', text: `Run & repair ${rel}` });
    try {
      if (!lang.run && !lang.compile) { this.chat.postSystem(`${lang.label} files cannot be executed by Patch Code.`); return; }
      if (editor.document.isDirty) await editor.document.save();
      await this.repairLoop(editor, run, lang);
    } catch (error) {
      this.chat.post({ type: 'error', text: error.message });
    } finally {
      this.abort = null;
      this.chat.postDone();
    }
  }

  async execute(run, lang, filePath) {
    const cwd = path.dirname(filePath);
    const timeoutMs = 1000 * run.settings.runTimeoutSeconds;
    const ctx = { platform: process.platform, nodeMajor: Number((process.versions.node || '0').split('.')[0]), cwd };
    let argv;
    if (lang.compile) {
      const exe = path.join(cwd, process.platform === 'win32' ? 'patchcode_run.exe' : 'patchcode_run.out');
      const compiled = await shell.runArgv(lang.compile(filePath, exe), { cwd, timeoutMs, env: run.settings.env, signal: run.signal, onOutput: (c) => this.chat.post({ type: 'output', chunk: c }) });
      if (!compiled.success) return { ...compiled, stage: 'compile', command: lang.compile(filePath, exe).join(' ') };
      argv = [exe];
    } else {
      argv = lang.run(filePath, ctx);
      if (!argv) return { success: false, error: `No runner for ${lang.label} on this platform.`, stdout: '', stderr: '' };
    }
    const result = await shell.runArgv(argv, { cwd, timeoutMs, env: run.settings.env, signal: run.signal, onOutput: (c) => this.chat.post({ type: 'output', chunk: c }) });
    return { ...result, command: argv.join(' ') };
  }

  async repairLoop(editor, run, lang) {
    const document = editor.document;
    const filePath = document.fileName;
    const rel = host.relative(run.cwd, filePath);
    const refused = new Set();
    const history = [];
    let lastBlame = '';
    let repeats = 0;
    let attempt = 0;
    const maxIterations = run.settings.maxIterations;

    while (attempt <= maxIterations) {
      if (run.signal.aborted) throw new Error('Stopped by user.');
      const runId = patch.newId();
      const verdict = await run.gate('RunCode', { language: lang.id, path: rel }, { summary: `Run ${rel}?`, detail: attempt ? `Repair attempt ${attempt} of ${maxIterations}.` : 'Execute the file to check that it works.', command: (lang.run ? lang.run(filePath, { platform: process.platform, nodeMajor: 99, cwd: run.cwd }) || [] : ['compile+run']).join(' ') });
      if (!verdict.allowed) { this.chat.postSystem(`Not run (${verdict.reason}).`); return; }
      this.chat.post({ type: 'tool_call', call: { id: runId, name: 'RunCode', args: { file: rel, attempt: attempt + 1 }, description: attempt ? `Run ${rel} (attempt ${attempt + 1})` : `Run ${rel}` } });
      const result = await this.execute(run, lang, filePath);
      this.chat.post({ type: 'tool_result', result: { id: runId, name: 'RunCode', ok: result.success, result: { stdout: result.stdout, stderr: result.stderr, error: result.error, exitCode: result.exitCode } } });
      if (result.cancelled) throw new Error('Stopped by user.');

      if (result.success) {
        const tail = (result.stdout || '').trim().slice(-3000);
        this.chat.postAssistant(`${attempt ? `Fixed after ${attempt} repair attempt(s) - ` : ''}${rel} ran to completion (exit 0${result.durationMs ? `, ${Math.round(result.durationMs / 100) / 10}s` : ''}).${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''}`);
        return;
      }

      const blame = `${result.error || ''}\n${(result.stderr || '').trim().split('\n').slice(-1)[0] || ''}`.trim();
      repeats = lastBlame && blame === lastBlame ? repeats + 1 : 0;
      if (history.length && !history[history.length - 1].outcome) history[history.length - 1].outcome = repeats ? 'the same error came back unchanged' : `a different failure: ${blame.slice(0, 160)}`;
      lastBlame = blame;
      if (repeats >= REPEAT_LIMIT) {
        this.chat.postAssistant(`The same failure came back unchanged after ${repeats} repair attempts (${blame.slice(0, 160)}). Stopping rather than spending the rest of the budget on it. The last error is in the step above.`);
        return;
      }
      attempt++;
      if (attempt > maxIterations) break;
      this.chat.post({ type: 'observe', text: `Run failed: ${blame.slice(0, 200)}` });

      // 1. A missing package: deterministic, no model call.
      const missing = packages.missingModuleFrom(`${result.stderr}\n${result.stdout}`);
      if (missing) {
        const pkg = packages.packageFor(missing.manager, missing.module);
        if (packages.isInstallableName(pkg) && !refused.has(pkg)) {
          const argv = packages.installCommand(missing.manager, [pkg], {});
          this.chat.postThink(`Missing package detected: '${missing.module}' → ${argv ? argv.join(' ') : pkg}`);
          const allowed = await run.gate('Install', { manager: missing.manager, packages: [pkg] }, { summary: `Install the ${missing.manager} package '${pkg}'?`, detail: `${rel} failed because '${missing.module}' is not installed. Installing it lets the file run; your code is untouched.`, command: argv ? argv.join(' ') : '' });
          if (allowed.allowed) {
            const installId = patch.newId();
            this.chat.post({ type: 'tool_call', call: { id: installId, name: 'Install', args: { manager: missing.manager, packages: [pkg] }, description: `Install ${pkg}` } });
            const installed = await packages.install(missing.manager, [pkg], { cwd: run.cwd, env: run.settings.env, signal: run.signal, onOutput: (c) => this.chat.post({ type: 'output', chunk: c }) });
            this.chat.post({ type: 'tool_result', result: { id: installId, name: 'Install', ok: installed.success, result: { stdout: installed.stdout, stderr: installed.stderr, error: installed.error } } });
            if (installed.success) { history.push({ attempt, kind: 'package', analysis: `installed ${pkg}` }); continue; }
          } else {
            refused.add(pkg);
            this.chat.post({ type: 'observe', text: `Installing '${pkg}' was declined - solving it in code instead.` });
          }
        }
      }

      // 2. Everything else: the whole file, with the evidence and what was tried.
      this.chat.postThink(`Analysing the failure with ${run.resolved.model}…`);
      const source = document.getText();
      const evidence = [
        `Command: ${result.command || ''}`, `Exit code: ${result.exitCode}${result.stage === 'compile' ? ' (compilation)' : ''}`,
        (result.stderr || '').trim() ? `stderr (tail):\n${result.stderr.trim().slice(-4000)}` : '', (result.stdout || '').trim() ? `stdout (tail):\n${result.stdout.trim().slice(-2000)}` : '',
      ].filter(Boolean).join('\n\n');
      const tried = history.filter((h) => h.kind !== 'package').map((h) => `- attempt ${h.attempt}: diagnosis: ${h.analysis || '?'} | change: ${h.plan || '?'} | outcome: ${h.outcome || 'not run yet'}`).join('\n');
      const user = [
        `FILE: ${rel} (${lang.label})`, `PLATFORM: ${process.platform}`, `FIX ATTEMPT: ${attempt} of ${maxIterations}`,
        refused.size ? `The user has REFUSED to install these packages, so solve it without them: ${[...refused].join(', ')}` : '',
        tried ? `PREVIOUS REPAIR ATTEMPTS - none of these worked, do NOT repeat them:\n${tried}` : '',
        `THE FILE (line numbers match the traceback):\n\`\`\`${lang.fence}\n${patch.numbered(source)}\n\`\`\``,
        `WHAT HAPPENED:\n${evidence}`,
      ].filter(Boolean).join('\n\n');
      const reply = await this.complete(run, [{ role: 'system', content: FIX_SYSTEM }, { role: 'user', content: user }], { maxTokens: Math.max(run.settings.maxTokens, 8000), temperature: 0 });
      const meta = jsonBlock(reply);
      const code = patch.extractCode(reply.replace(/<json>[\s\S]*?<\/json>/, ''), lang.fence);
      const label = { package: 'missing package', system: 'system requirement', script: 'scripting error', logic: 'logical error' }[meta.kind] || meta.kind || 'script';
      if (meta.analysis) this.chat.post({ type: 'observe', text: `Diagnosis (${label}): ${meta.analysis}` });
      if (meta.plan) this.chat.post({ type: 'observe', text: `Plan: ${meta.plan}` });
      history.push({ attempt, kind: meta.kind || 'script', analysis: meta.analysis, plan: meta.plan });

      for (const command of (Array.isArray(meta.commands) ? meta.commands : []).filter((c) => c && c.cmd)) {
        if (shell.isDestructive(command.cmd)) { this.chat.post({ type: 'observe', text: `Refused as destructive: ${command.cmd}` }); continue; }
        const ok = await run.gate('Shell', { command: command.cmd }, { summary: meta.kind === 'package' ? 'Install what the file needs?' : 'Run a system command the file needs?', detail: command.reason || meta.analysis || '', command: command.cmd, ...shell.classify(command.cmd) });
        if (!ok.allowed) { const target = command.cmd.replace(/.*install\s+/, '').split(/\s+/).pop(); if (target) refused.add(target); this.chat.post({ type: 'observe', text: 'Command declined - solving it in code instead.' }); continue; }
        const cmdId = patch.newId();
        this.chat.post({ type: 'tool_call', call: { id: cmdId, name: 'Shell', args: { command: command.cmd }, description: `Shell: ${command.cmd}` } });
        const out = await shell.run(command.cmd, { cwd: run.cwd, timeoutMs: 600000, env: run.settings.env, signal: run.signal, onOutput: (c) => this.chat.post({ type: 'output', chunk: c }) });
        this.chat.post({ type: 'tool_result', result: { id: cmdId, name: 'Shell', ok: out.success, result: { stdout: out.stdout, stderr: out.stderr, error: out.error } } });
      }

      if (code && code.trim() && code.trim() !== source.trim()) {
        const oldVolume = patch.codeVolume(source);
        const newVolume = patch.codeVolume(code);
        if (oldVolume > 8 && newVolume < oldVolume * 0.6) {
          this.chat.post({ type: 'observe', text: `The model replied with a fragment (${newVolume} lines of code against the file's ${oldVolume}), so it was not applied.` });
        } else {
          const markersBefore = patch.mapSource(source).length;
          const markersAfter = patch.mapSource(code).length;
          if (markersBefore && markersAfter < markersBefore) this.chat.post({ type: 'observe', text: 'The model dropped patch markers; applying the fix to the whole file.' });
          await host.writeFile(filePath, code.endsWith('\n') ? code : code + '\n');
          this.chat.post({ type: 'observe', text: `Applied the fix to ${rel} (undo with Ctrl+Z).` });
        }
      } else if (!(meta.commands || []).length) {
        this.chat.postAssistant('The model proposed neither a code change nor a command, so I stopped rather than loop pointlessly. The error is in the step above.');
        return;
      }
    }
    this.chat.postAssistant(`Gave up after ${maxIterations} repair attempts. The last error is in the step above; ask me about it in the chat if you want a different approach.`);
  }
}

module.exports = { PatchEngine, FIX_SYSTEM };
