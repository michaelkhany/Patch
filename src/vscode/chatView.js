'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * The chat sidebar: a WebviewView that streams the agent's work, renders
 * tool calls as collapsible steps, and puts permission questions in front
 * of the user with the exact command (DAYA's permission prompt, Claude
 * Code's allow-once / always / deny).
 */

const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const agent = require('../core/agent');
const llm = require('../core/llm');
const providers = require('../core/providers');
const settingsCore = require('../core/settings');
const { makeHost, diagnostics } = require('./host');

const HELP = `**Patch Code** is an autonomous coding agent using your own OpenAI-compatible model.

Ask for anything: *explain this function*, *add input validation to the upload endpoint and test it*, *why does the build fail?*, *write a script that converts these CSVs and run it*.

**Patches in the editor**: write \`@patch <instruction>\` as a comment anywhere in a file and run *Patch Code: Apply @patch Requests* (Ctrl+Alt+Enter). The instruction becomes working code in place, marked with \`===== PATCH n :: id =====\` comments, and the file is run and repaired until it works.

**Slash commands**: /model, /mode, /config, /permissions, /init, /clear, /compact, /cost, /patch, /run, /fix, /diagnostics.

**Permissions**: read-only tools run immediately; edits, commands, scripts and installs ask you first. *Always allow* covers that kind for this session. Rules live in \`.patchcode/settings.json\` (project) and \`~/.patchcode/settings.json\` (user), Claude Code style: \`Shell(npm test *)\`, \`Edit(src/**)\`.`;

class ChatViewProvider {
  static viewType = 'patchCode.chatView';

  constructor(context, config, output) {
    this.context = context;
    this.config = config;
    this.output = output;
    this.view = null;
    this.history = [];
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
    this.abort = null;
    this.pending = new Map();
    this.state = {};
    this.queue = Promise.resolve();
  }

  // -- webview -----------------------------------------------------------
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidDispose(() => { this.view = null; });
    view.onDidChangeVisibility(() => { if (view.visible) this.pushState(); });
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Patch Code</title>
</head>
<body>
<div id="app">
  <div id="header"></div>
  <div id="messages"></div>
  <div id="composer">
    <div id="slash" style="display:none"></div>
    <textarea id="input" placeholder="Ask Patch Code… (Enter to send, Shift+Enter for a newline, / for commands)"></textarea>
    <div class="row">
      <span class="hint">Edits, commands and installs ask before they run.</span>
      <button class="btn secondary" id="stop" style="display:none">Stop</button>
      <button class="btn" id="send">Send</button>
    </div>
  </div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  post(message) {
    if (this.view) this.view.webview.postMessage(message);
  }

  async reveal() {
    try {
      await vscode.commands.executeCommand('patchCode.chatView.focus');
    } catch (_) {
      await vscode.commands.executeCommand('workbench.view.extension.patchCode');
    }
    // Give the webview a moment to resolve on first open.
    for (let i = 0; i < 20 && !this.view; i++) await new Promise((r) => setTimeout(r, 100));
  }

  async pushState() {
    try {
      const resolved = await this.config.resolveLlm();
      const s = resolved.settings;
      this.state = {
        model: resolved.model ? (resolved.configuredModel === 'auto' ? `auto · ${resolved.model}` : resolved.model) : (resolved.configuredModel === 'auto' ? 'auto (load models)' : resolved.configuredModel),
        mode: s.permissionMode,
        provider: (providers.get(providers.detect(resolved.serviceAddress)) || {}).label || resolved.serviceAddress,
        toolMode: this.state.toolMode || '',
        usage: this.usage,
        configured: Boolean(resolved.apiKey && resolved.model && resolved.serviceAddress),
      };
      this.post({ type: 'state', state: this.state });
    } catch (error) {
      this.output.appendLine(`[chat] state: ${error.message}`);
    }
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': await this.pushState(); break;
      case 'send': this.enqueue(() => this.run(m.text)); break;
      case 'slash': await this.slash(m.text); break;
      case 'stop': this.stop(); break;
      case 'permission': {
        const resolve = this.pending.get(m.requestId);
        if (resolve) { this.pending.delete(m.requestId); resolve(m.decision); }
        break;
      }
      case 'command': vscode.commands.executeCommand(`patchCode.${m.command}`); break;
      case 'open': this.openRef(m.ref); break;
      default: break;
    }
  }

  async openRef(ref) {
    const match = /^(.*?)(?::(\d+))?$/.exec(String(ref || ''));
    if (!match) return;
    const root = this.config.workspaceRoot();
    const file = path.isAbsolute(match[1]) ? match[1] : path.join(root || '', match[1]);
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (match[2]) {
        const line = Math.max(0, Number(match[2]) - 1);
        editor.selection = new vscode.Selection(line, 0, line, 0);
        editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
      }
    } catch (_) { /* not a file reference */ }
  }

  enqueue(task) {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  stop() {
    if (this.abort) this.abort.abort();
    for (const [id, resolve] of this.pending) { resolve('deny'); this.pending.delete(id); }
  }

  // -- permission prompt -------------------------------------------------
  ask(question) {
    return new Promise((resolve) => {
      const requestId = crypto.randomBytes(8).toString('hex');
      this.pending.set(requestId, resolve);
      this.post({ type: 'permission', request: { requestId, ...question } });
      if (!this.view || !this.view.visible) {
        // The user may not be looking at the sidebar: mirror the question as a notification.
        vscode.window.showWarningMessage(`Patch Code: ${question.summary}${question.command ? `  —  ${question.command}` : ''}`, 'Allow once', `Always allow ${question.kind}`, "Don't allow")
          .then((choice) => {
            if (!this.pending.has(requestId)) return;
            this.pending.delete(requestId);
            resolve(choice === 'Allow once' ? 'allow' : (choice && choice.startsWith('Always') ? 'always' : 'deny'));
          });
      }
    });
  }

  // -- running the agent -------------------------------------------------
  /** Make sure a model is configured; returns the resolved llm or null (after guiding the user). */
  async ensureReady({ probe = true } = {}) {
    const resolved = await this.config.resolveLlm();
    if (!resolved.apiKey) {
      this.post({ type: 'error', text: 'No API key. Run "Patch Code: Configure Provider & API Key".' });
      vscode.commands.executeCommand('patchCode.configure');
      return null;
    }
    if (!resolved.model) {
      if (resolved.configuredModel === 'auto') {
        this.post({ type: 'think', text: 'Loading the model list…' });
        try {
          await this.config.refreshModels(resolved, { onProgress: (t) => this.post({ type: 'think', text: t }) });
          const again = await this.config.resolveLlm();
          if (again.model) return this.ensureReady({ probe });
        } catch (error) {
          this.post({ type: 'error', text: `Could not load models: ${error.message}` });
          return null;
        }
      }
      this.post({ type: 'error', text: 'No tool-capable model available for "auto". Pick one with "Patch Code: Select Model".' });
      vscode.commands.executeCommand('patchCode.selectModel');
      return null;
    }
    if (probe) {
      this.post({ type: 'think', text: `Checking tool support for ${resolved.model}…` });
      resolved.toolMode = await this.config.toolModeFor(resolved);
      this.state.toolMode = resolved.toolMode === 'native' ? 'tools' : 'text';
    }
    return resolved;
  }

  /**
   * Run one user turn. `extraSystem` adds task-specific instructions;
   * `display` is what the chat shows when the text was built by a command.
   */
  async run(text, { extraSystem, display } = {}) {
    if (this.abort) { this.post({ type: 'error', text: 'A run is already in progress. Stop it first.' }); return null; }
    await this.reveal();
    if (display) this.post({ type: 'user', text: display });
    const resolved = await this.ensureReady();
    if (!resolved) { this.post({ type: 'done' }); return null; }
    await this.pushState();
    const settings = resolved.settings;
    const cwd = this.config.workspaceRoot() || process.cwd();
    const contextFiles = this.config.contextFiles(settings);
    this.abort = new AbortController();
    const started = Date.now();
    this.output.appendLine(`\n[run] ${new Date().toISOString()} model=${resolved.model} mode=${settings.permissionMode} tools=${resolved.toolMode}\n> ${text.slice(0, 500)}`);
    let result = null;
    try {
      result = await agent.runTurn({
        llmConfig: { serviceAddress: resolved.serviceAddress, apiKey: resolved.apiKey, model: resolved.model },
        settings, cwd, history: this.history, userText: text, toolMode: resolved.toolMode,
        contextFiles, extraSystem, contextTokens: settings.contextTokens,
        host: makeHost(cwd, settings), ask: (q) => this.ask(q), signal: this.abort.signal,
        emit: (type, payload) => this.onEvent(type, payload),
      });
      this.history = result.messages;
      if (result.usage) {
        this.usage.promptTokens += result.usage.promptTokens; this.usage.completionTokens += result.usage.completionTokens;
        this.usage.totalTokens += result.usage.totalTokens; this.usage.requests += result.usage.requests;
      }
      if (result.cancelled) this.post({ type: 'system', text: 'Stopped.' });
      else if (!result.ok && result.error) this.post({ type: 'error', text: result.error });
      this.output.appendLine(`[run] done in ${Math.round((Date.now() - started) / 1000)}s, ${result.steps} step(s), ${result.usage ? result.usage.totalTokens : 0} tokens`);
    } catch (error) {
      this.post({ type: 'error', text: `Patch Code failed: ${error.message}` });
      this.output.appendLine(`[run] error: ${error.stack}`);
    } finally {
      this.abort = null;
      this.post({ type: 'done' });
      await this.pushState();
    }
    return result;
  }

  onEvent(type, payload) {
    switch (type) {
      case 'think': this.post({ type: 'think', text: payload }); break;
      case 'observe': this.post({ type: 'observe', text: payload }); this.output.appendLine(`  ${payload}`); break;
      case 'delta': this.post({ type: 'delta', text: payload }); break;
      case 'final': this.post({ type: 'final', text: payload.text }); break;
      case 'tool_call': this.post({ type: 'tool_call', call: payload }); this.output.appendLine(`  → ${payload.description}`); break;
      case 'tool_result': this.post({ type: 'tool_result', result: payload }); break;
      case 'output': this.post({ type: 'output', chunk: payload.chunk }); break;
      case 'usage': this.post({ type: 'state', state: { ...this.state, usage: { ...this.usage, totalTokens: this.usage.totalTokens + (payload.totalTokens || 0) } } }); break;
      case 'error': this.post({ type: 'error', text: payload.message }); break;
      case 'decision': this.output.appendLine(`  [permission] ${payload.tool} ${payload.decision} (${payload.source})`); break;
      default: break;
    }
  }

  /** Programmatic entry used by editor commands. */
  async askAgent(text, options) {
    return this.enqueue(() => this.run(text, options));
  }

  postSystem(text) { this.post({ type: 'system', text }); }
  postAssistant(text) { this.post({ type: 'assistant', text }); }
  postThink(text) { this.post({ type: 'think', text }); }
  postDone() { this.post({ type: 'done' }); }

  newConversation() {
    this.stop();
    this.history = [];
    this.post({ type: 'reset' });
    this.pushState();
  }

  // -- slash commands ----------------------------------------------------
  async slash(text) {
    const [command, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (command) {
      case '/help': this.postAssistant(HELP); break;
      case '/model': vscode.commands.executeCommand('patchCode.selectModel'); break;
      case '/mode':
        if (settingsCore.PERMISSION_MODES.includes(arg)) {
          await vscode.workspace.getConfiguration('patchCode').update('permissionMode', arg, vscode.ConfigurationTarget.Global);
          this.postSystem(`Permission mode: ${arg}`);
          await this.pushState();
        } else vscode.commands.executeCommand('patchCode.selectPermissionMode');
        break;
      case '/config': vscode.commands.executeCommand('patchCode.configure'); break;
      case '/permissions': vscode.commands.executeCommand('patchCode.openSettingsFile'); break;
      case '/init': vscode.commands.executeCommand('patchCode.initProject'); break;
      case '/clear': this.newConversation(); break;
      case '/cost': vscode.commands.executeCommand('patchCode.showCost'); this.postSystem(`This session: ${this.usage.requests} request(s), ${this.usage.promptTokens.toLocaleString()} prompt + ${this.usage.completionTokens.toLocaleString()} completion = ${this.usage.totalTokens.toLocaleString()} tokens.`); break;
      case '/compact': await this.compact(); break;
      case '/patch': vscode.commands.executeCommand('patchCode.applyPatches'); break;
      case '/run': vscode.commands.executeCommand('patchCode.runAndRepairFile'); break;
      case '/fix': vscode.commands.executeCommand('patchCode.fixDiagnostics'); break;
      case '/diagnostics': {
        const d = diagnostics(this.config.workspaceRoot(), null, { max: 60 });
        this.postAssistant(d.count ? '```\n' + d.text + '\n```' : 'No problems reported.');
        break;
      }
      default:
        if (command.startsWith('/')) this.postSystem(`Unknown command ${command}. Type /help.`);
        else this.enqueue(() => this.run(text));
    }
  }

  async compact() {
    if (!this.history.length) { this.postSystem('Nothing to compact.'); return; }
    const resolved = await this.ensureReady({ probe: false });
    if (!resolved) return;
    this.postThink('Summarising the conversation…');
    const transcript = this.history.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 2000) : JSON.stringify(m.tool_calls || '').slice(0, 500)}`).join('\n');
    const result = await llm.complete({
      serviceAddress: resolved.serviceAddress, apiKey: resolved.apiKey, model: resolved.model, temperature: 0.1, maxTokens: 1500,
      messages: [
        { role: 'system', content: 'Summarise this coding session for continuation by the same agent: the goal, what was changed (files, functions), what was verified, open problems and the user\'s preferences. Plain text, concise, concrete.' },
        { role: 'user', content: transcript.slice(-60000) },
      ],
    });
    if (!result.ok) { this.post({ type: 'error', text: llm.friendlyError(result.error, 'compacting') }); this.postDone(); return; }
    this.history = [{ role: 'user', content: `[Conversation summary]\n${result.text}` }, { role: 'assistant', content: 'Understood. Continuing from that summary.' }];
    this.postAssistant(`**Compacted.**\n\n${result.text}`);
    this.postDone();
  }
}

module.exports = { ChatViewProvider, HELP };
