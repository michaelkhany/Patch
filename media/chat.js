// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
// Patch Code chat webview. Talks to the extension host through postMessage.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $('messages');
  const input = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const slash = $('slash');
  let running = false;
  let currentAssistant = null;
  let currentThinking = null;
  const steps = new Map();
  const permissions = new Map();
  let state = { model: '', mode: 'default', provider: '', toolMode: '', usage: null, configured: false };
  const SLASH = [
    ['/help', 'What Patch Code can do'],
    ['/model', 'Choose the model'],
    ['/mode', 'Permission mode: default | acceptEdits | plan | bypassPermissions'],
    ['/config', 'Provider, address and API key'],
    ['/permissions', 'Open the permission rules'],
    ['/init', 'Create PATCHCODE.md for this project'],
    ['/clear', 'Start a new conversation'],
    ['/compact', 'Summarise the conversation to save context'],
    ['/cost', 'Tokens used this session'],
    ['/patch', 'Apply @patch requests in the active file'],
    ['/run', 'Run & repair the active file'],
    ['/fix', 'Fix the problems in the active file'],
    ['/diagnostics', 'Show current problems'],
  ];

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Small, safe markdown: fences, inline code, bold/italic, links, lists, headings, tables, quotes.
  function renderMarkdown(text) {
    const src = String(text || '').replace(/\r\n/g, '\n');
    const blocks = [];
    const withFences = src.replace(/```([\w+#.-]*)[ \t]*\n([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
      blocks.push(`<pre><button class="btn secondary copy" data-copy>copy</button><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    const lines = withFences.split('\n');
    const out = [];
    let list = null;
    let para = [];
    let table = null;
    const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.type}>` + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + `</${list.type}>`); list = null; } };
    const flushTable = () => {
      if (!table) return;
      const rows = table.map((cells, i) => '<tr>' + cells.map((c) => `<${i === 0 ? 'th' : 'td'}>${inline(c)}</${i === 0 ? 'th' : 'td'}>`).join('') + '</tr>').join('');
      out.push('<table>' + rows + '</table>'); table = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const placeholder = /^\u0000(\d+)\u0000$/.exec(line.trim());
      if (placeholder) { flushPara(); flushList(); flushTable(); out.push(blocks[Number(placeholder[1])]); continue; }
      if (!line.trim()) { flushPara(); flushList(); flushTable(); continue; }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) { flushPara(); flushList(); flushTable(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
      if (/^\|.*\|$/.test(line.trim())) {
        if (/^\|?\s*:?-{2,}/.test(line.trim().replace(/^\|/, ''))) continue;
        flushPara(); flushList();
        table = table || [];
        table.push(line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        continue;
      }
      flushTable();
      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) { flushPara(); flushList(); out.push('<blockquote>' + inline(quote[1]) + '</blockquote>'); continue; }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || number) {
        flushPara();
        const type = bullet ? 'ul' : 'ol';
        if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
        list.items.push((bullet || number)[1]);
        continue;
      }
      if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList(); flushTable();
    return out.join('\n');
  }

  function inline(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    s = s.replace(/(^|[\s(])((?:[A-Za-z]:)?[\w./\\-]+\.(?:py|js|ts|tsx|jsx|json|md|R|r|go|rs|java|cs|cpp|c|h|rb|php|sh|ps1|yml|yaml|toml|html|css|sql)(?::\d+)?)(?=[\s,.;)]|$)/g, (m, pre, ref) => `${pre}<a href="#" data-open="${ref}">${ref}</a>`);
    return s;
  }

  function scrollDown() { messages.scrollTop = messages.scrollHeight; }

  function add(kind, html) {
    const el = document.createElement('div');
    el.className = 'msg ' + kind;
    const who = { user: 'You', assistant: 'Patch Code', system: '', error: 'Error' }[kind];
    el.innerHTML = (who ? `<div class="who">${who}</div>` : '') + `<div class="body">${html}</div>`;
    messages.appendChild(el);
    scrollDown();
    return el;
  }

  function showEmpty() {
    messages.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML = state.configured
      ? `Ask for anything a coding agent can do in this workspace: explain code, add a feature, fix the failing test, write a script and run it.<br><br>
         Write <code>@patch &lt;instruction&gt;</code> as a comment in any file and run <b>Apply @patch Requests</b> to turn it into working code in place.<br><br>
         Type <code>/</code> for commands. <code>Shift+Enter</code> for a newline.`
      : `Patch Code needs a model. Choose a provider and add your API key, then pick a model.<br>
         <button class="btn" data-cmd="configure">Configure provider & API key</button>`;
    messages.appendChild(el);
  }

  function setRunning(value) {
    running = value;
    sendBtn.disabled = value;
    stopBtn.style.display = value ? '' : 'none';
    if (!value) { removeThinking(); }
  }

  function ensureAssistant() {
    if (!currentAssistant) {
      currentAssistant = add('assistant', '');
      currentAssistant.raw = '';
    }
    return currentAssistant;
  }

  function appendDelta(text) {
    removeThinking();
    const el = ensureAssistant();
    el.raw += text;
    el.querySelector('.body').innerHTML = renderMarkdown(el.raw);
    scrollDown();
  }

  function finishAssistant(text) {
    const el = ensureAssistant();
    if (text !== undefined && text !== el.raw) { el.raw = text; el.querySelector('.body').innerHTML = renderMarkdown(text); }
    if (!el.raw.trim()) el.remove();
    currentAssistant = null;
    scrollDown();
  }

  function showThinking(text) {
    if (!currentThinking) {
      currentThinking = document.createElement('div');
      currentThinking.className = 'thinking';
      messages.appendChild(currentThinking);
    }
    currentThinking.innerHTML = `<span class="dot"></span><span>${escapeHtml(text)}</span>`;
    messages.appendChild(currentThinking);
    scrollDown();
  }

  function removeThinking() { if (currentThinking) { currentThinking.remove(); currentThinking = null; } }

  function addStep(call) {
    // A tool call ends the current streamed narration block.
    if (currentAssistant) { currentAssistant = null; }
    removeThinking();
    const el = document.createElement('details');
    el.className = 'step running';
    el.innerHTML = `<summary><span class="icon">◐</span><span class="label">${escapeHtml(call.description || call.name)}</span><span class="status">running</span></summary>
      <div class="detail"><div class="k">arguments</div><pre>${escapeHtml(JSON.stringify(call.args, null, 1).slice(0, 4000))}</pre><div class="out"></div></div>`;
    messages.appendChild(el);
    steps.set(call.id, el);
    scrollDown();
    return el;
  }

  function finishStep(result) {
    const el = steps.get(result.id) || [...steps.values()].reverse().find((s) => s.classList.contains('running'));
    if (!el) return;
    el.classList.remove('running');
    el.classList.add(result.ok ? 'ok' : 'fail');
    el.querySelector('.icon').textContent = result.ok ? '✓' : '✗';
    el.querySelector('.status').textContent = result.ok ? 'done' : 'failed';
    const out = el.querySelector('.out');
    const r = result.result || {};
    const parts = [];
    const push = (k, v) => { if (v !== undefined && v !== null && String(v).trim()) parts.push(`<div class="k">${k}</div><pre>${escapeHtml(String(v).slice(0, 6000))}</pre>`); };
    if (typeof r === 'string') push('result', r);
    else {
      push('error', r.error);
      push('stdout', r.stdout);
      push('stderr', r.stderr);
      push('content', r.content);
      push('listing', r.listing);
      push('results', r.results);
      push('summary', r.summary);
      push('text', r.text);
      if (r.files && r.files.length) push('files', r.files.join('\n'));
      if (r.problems) push('problems', r.text);
      if (r.results && Array.isArray(r.results)) push('results', r.results.map((x) => `${x.title}\n${x.url}\n${x.snippet}`).join('\n\n'));
      if (r.notes && r.notes.length) push('notes', r.notes.join('\n'));
      if (!parts.length) push('result', JSON.stringify(r, null, 1));
    }
    out.innerHTML = parts.join('');
    scrollDown();
  }

  function addPermission(req) {
    removeThinking();
    const el = document.createElement('div');
    el.className = 'permission';
    el.innerHTML = `<div class="title">🔐 ${escapeHtml(req.summary)}</div>
      ${req.detail ? `<div class="detail">${escapeHtml(req.detail)}</div>` : ''}
      ${req.command ? `<code class="cmd">${escapeHtml(req.command)}</code>` : ''}
      <div class="buttons">
        <button class="btn" data-decision="allow">Allow once</button>
        <button class="btn secondary" data-decision="always">Always allow ${escapeHtml(req.kind)}</button>
        <button class="btn danger" data-decision="deny">Don't allow</button>
      </div><div class="answer"></div>`;
    el.querySelectorAll('[data-decision]').forEach((b) => b.addEventListener('click', () => {
      vscode.postMessage({ type: 'permission', requestId: req.requestId, decision: b.dataset.decision });
      el.classList.add('answered');
      el.querySelector('.answer').textContent = { allow: 'Allowed once', always: `Always allowed (${req.kind}) for this session`, deny: 'Declined' }[b.dataset.decision];
    }));
    messages.appendChild(el);
    permissions.set(req.requestId, el);
    scrollDown();
  }

  function renderHeader() {
    const modeLabel = { default: 'default', acceptEdits: 'accept edits', plan: 'plan (read-only)', bypassPermissions: 'bypass permissions' }[state.mode] || state.mode;
    const usage = state.usage ? ` · ${state.usage.totalTokens.toLocaleString()} tok` : '';
    $('header').innerHTML = `
      <button class="pill ${state.configured ? '' : 'warn'}" data-cmd="selectModel" title="Change model">${escapeHtml(state.model || 'no model')}${state.toolMode ? ' · ' + state.toolMode : ''}</button>
      <button class="pill ${state.mode === 'bypassPermissions' ? 'warn' : ''}" data-cmd="selectPermissionMode" title="Change permission mode">${escapeHtml(modeLabel)}</button>
      <button class="pill" data-cmd="configure" title="Provider & API key">${escapeHtml(state.provider || 'provider')}</button>
      <span style="flex:1"></span><span title="Tokens this session">${escapeHtml(usage)}</span>`;
  }

  document.addEventListener('click', (event) => {
    const cmd = event.target.closest('[data-cmd]');
    if (cmd) { vscode.postMessage({ type: 'command', command: cmd.dataset.cmd }); return; }
    const open = event.target.closest('[data-open]');
    if (open) { event.preventDefault(); vscode.postMessage({ type: 'open', ref: open.dataset.open }); return; }
    const copy = event.target.closest('[data-copy]');
    if (copy) { const code = copy.parentElement.querySelector('code'); navigator.clipboard.writeText(code.textContent); copy.textContent = 'copied'; setTimeout(() => (copy.textContent = 'copy'), 1200); }
  });

  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    input.value = '';
    slash.style.display = 'none';
    autosize();
    if (text.startsWith('/')) {
      add('user', escapeHtml(text));
      vscode.postMessage({ type: 'slash', text });
      return;
    }
    if (messages.querySelector('.empty')) messages.innerHTML = '';
    add('user', escapeHtml(text));
    setRunning(true);
    showThinking('Thinking…');
    vscode.postMessage({ type: 'send', text });
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(240, Math.max(56, input.scrollHeight)) + 'px';
  }

  let slashIndex = 0;
  function updateSlash() {
    const value = input.value;
    if (!value.startsWith('/') || value.includes('\n') || value.includes(' ')) { slash.style.display = 'none'; return; }
    const items = SLASH.filter(([c]) => c.startsWith(value));
    if (!items.length) { slash.style.display = 'none'; return; }
    slashIndex = Math.min(slashIndex, items.length - 1);
    slash.innerHTML = items.map(([c, d], i) => `<div class="${i === slashIndex ? 'sel' : ''}" data-slash="${c}">${c}<span>${escapeHtml(d)}</span></div>`).join('');
    slash.style.display = '';
    slash.querySelectorAll('[data-slash]').forEach((el) => el.addEventListener('click', () => { input.value = el.dataset.slash + ' '; slash.style.display = 'none'; input.focus(); }));
  }

  input.addEventListener('input', () => { autosize(); slashIndex = 0; updateSlash(); });
  input.addEventListener('keydown', (event) => {
    if (slash.style.display !== 'none' && slash.children.length) {
      if (event.key === 'ArrowDown') { slashIndex = (slashIndex + 1) % slash.children.length; updateSlash(); event.preventDefault(); return; }
      if (event.key === 'ArrowUp') { slashIndex = (slashIndex - 1 + slash.children.length) % slash.children.length; updateSlash(); event.preventDefault(); return; }
      if (event.key === 'Tab' || (event.key === 'Enter' && slash.children[slashIndex])) {
        input.value = slash.children[slashIndex].dataset.slash + ' '; slash.style.display = 'none'; event.preventDefault(); return;
      }
      if (event.key === 'Escape') { slash.style.display = 'none'; return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    if (event.key === 'Escape' && running) vscode.postMessage({ type: 'stop' });
  });
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'state': state = { ...state, ...m.state }; renderHeader(); if (!messages.children.length || messages.querySelector('.empty')) showEmpty(); break;
      case 'reset': messages.innerHTML = ''; steps.clear(); permissions.clear(); currentAssistant = null; removeThinking(); showEmpty(); setRunning(false); break;
      case 'user': if (messages.querySelector('.empty')) messages.innerHTML = ''; add('user', escapeHtml(m.text)); setRunning(true); showThinking('Thinking…'); break;
      case 'think': showThinking(m.text); break;
      case 'observe': removeThinking(); add('system', escapeHtml(m.text)); break;
      case 'delta': appendDelta(m.text); break;
      case 'final': finishAssistant(m.text); break;
      case 'tool_call': addStep(m.call); break;
      case 'tool_result': finishStep(m.result); break;
      case 'output': { const running = [...steps.values()].reverse().find((s) => s.classList.contains('running')); if (running) { const out = running.querySelector('.out'); let pre = out.querySelector('pre.live'); if (!pre) { out.innerHTML = '<div class="k">output</div><pre class="live"></pre>'; pre = out.querySelector('pre.live'); } pre.textContent += m.chunk; } break; }
      case 'permission': addPermission(m.request); break;
      case 'error': removeThinking(); add('error', escapeHtml(m.text)); break;
      case 'system': removeThinking(); add('system', m.html || escapeHtml(m.text)); break;
      case 'assistant': add('assistant', renderMarkdown(m.text)); break;
      case 'done': setRunning(false); currentAssistant = null; break;
      case 'focus': input.focus(); break;
      case 'setInput': input.value = m.text; autosize(); input.focus(); break;
    }
  });

  showEmpty();
  vscode.postMessage({ type: 'ready' });
})();
