'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Patches - Michael Bidollahkhani's coding mechanism, first applied in DAYA Studio's iTailor.
 *
 * A *patch* is one natural-language instruction that becomes one block of
 * code. In a source file a patch is delimited by marker comments that survive
 * a round-trip through the model:
 *
 *     # ===== PATCH 2 :: c9f8217d5 =====
 *     # > plot the answer distribution
 *     counts = df["correctOption"].value_counts()
 *
 * The markers are the whole trick: the repair agent may rewrite the WHOLE
 * file and the result still maps back onto individual patches (DAYA's
 * patch_program). A request line the user writes in their own file is
 * spelled `@patch <instruction>` inside a comment, in any language:
 *
 *     // @patch validate the payload and return 400 on failure
 *
 * This module also builds the "knowledge graph": a language-agnostic summary
 * of what a file already defines (imports, functions, classes, top-level
 * variables), handed to the model BEFORE it writes the next patch so it
 * reuses what exists instead of redefining it (DAYA's patch_symbols).
 */

const crypto = require('crypto');
const languages = require('./languages');

const COMMENT_OPEN = '(?:#|\\/\\/|--|<!--|\\/\\*|;|%|\\*)';
const MARKER_RE = new RegExp(`^\\s*${COMMENT_OPEN}\\s*===== PATCH (\\d+) :: ([A-Za-z0-9_\\-]+) =====\\s*(?:-->|\\*\\/)?\\s*$`);
const PROMPT_RE = new RegExp(`^\\s*${COMMENT_OPEN}\\s*>\\s?(.*?)\\s*(?:-->|\\*\\/)?\\s*$`);
const ANY_MARKER_RE = new RegExp(`^\\s*${COMMENT_OPEN}\\s*===== PATCH (CELL |IMPORTS)?`);
const REQUEST_RE = new RegExp(`^(\\s*)${COMMENT_OPEN}\\s*@patch\\b:?\\s*(.*?)\\s*(?:-->|\\*\\/)?\\s*$`, 'i');
const FENCE_RE = /```([a-zA-Z0-9+#_.-]*)[ \t]*\r?\n([\s\S]*?)```/g;

function newId() {
  return crypto.randomBytes(5).toString('hex');
}

function marker(lang, index, id) {
  return languages.commentLine(lang, `===== PATCH ${index} :: ${id} =====`);
}

function promptLine(lang, text) {
  return languages.commentLine(lang, `> ${text}`);
}

/**
 * Join patches into one block of source. Each cell: {id, prompt, code}.
 * Returns {source, mapping:[{id, index, markerLine, start, end}]} with 1-based lines.
 */
function assemble(cells, lang, { header = '' } = {}) {
  const lines = header ? header.split('\n') : [];
  const mapping = [];
  cells.forEach((cell, i) => {
    const code = String(cell.code || '').replace(/\s+$/, '');
    if (!code.trim()) return;
    if (lines.length) lines.push('');
    const index = i + 1;
    const markerLine = lines.length + 1;
    lines.push(marker(lang, index, cell.id));
    for (const p of String(cell.prompt || '').trim().split('\n')) if (p.trim()) lines.push(promptLine(lang, p.trim()));
    const start = lines.length + 1;
    lines.push(...code.split('\n'));
    mapping.push({ id: cell.id, index, markerLine, start, end: lines.length });
  });
  return { source: lines.join('\n') + (lines.length ? '\n' : ''), mapping };
}

/** Inverse of assemble: recover {id, index, prompt, code} per patch from a file. Text outside markers is returned as `preamble`/`epilogue`-less cells with id null. */
function split(source) {
  const cells = [];
  let current = null;
  let preamble = [];
  for (const raw of String(source || '').split(/\r?\n/)) {
    const match = MARKER_RE.exec(raw);
    if (match) {
      if (current) cells.push(current);
      current = { index: Number(match[1]), id: match[2], promptLines: [], codeLines: [] };
      continue;
    }
    if (!current) { preamble.push(raw); continue; }
    const prompt = PROMPT_RE.exec(raw);
    if (prompt && !current.codeLines.length) { current.promptLines.push(prompt[1]); continue; }
    current.codeLines.push(raw);
  }
  if (current) cells.push(current);
  return {
    preamble: preamble.join('\n'),
    cells: cells.map((c) => ({ id: c.id, index: c.index, prompt: c.promptLines.join('\n').trim(), code: c.codeLines.join('\n').replace(/^\n+|\n+$/g, '') })),
  };
}

/** Marker -> line-range mapping straight from a file's text (for a file the model rewrote). */
function mapSource(source) {
  const mapping = [];
  const lines = String(source || '').replace(/\r?\n$/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const match = MARKER_RE.exec(raw);
    if (!match) return;
    const lineno = i + 1;
    if (mapping.length) mapping[mapping.length - 1].end = lineno - 1;
    let start = lineno + 1;
    while (start <= lines.length && PROMPT_RE.test(lines[start - 1])) start++;
    mapping.push({ id: match[2], index: Number(match[1]), markerLine: lineno, start, end: lines.length });
  });
  return mapping;
}

function locate(mapping, lineno) {
  return mapping.find((m) => m.markerLine <= lineno && lineno <= m.end) || null;
}

/** Scrub marker and leading prompt lines out of freshly generated code (models copy what they see). */
function stripMarkers(code) {
  const lines = String(code || '').split('\n').filter((l) => !ANY_MARKER_RE.test(l));
  while (lines.length && (PROMPT_RE.test(lines[0]) || !lines[0].trim())) lines.shift();
  return lines.join('\n').replace(/\n+$/, '');
}

/** Find `@patch` request lines in a document: [{line (0-based), indent, prompt}]. */
function findRequests(source) {
  const out = [];
  String(source || '').split(/\r?\n/).forEach((raw, i) => {
    const match = REQUEST_RE.exec(raw);
    if (match && match[2]) out.push({ line: i, indent: match[1] || '', prompt: match[2].trim() });
  });
  return out;
}

/** Pull code out of the first fenced block (preferring the wanted fence); fall back to the whole reply. */
function extractCode(text, wantedFence) {
  const s = String(text || '');
  const blocks = [];
  FENCE_RE.lastIndex = 0;
  let match;
  while ((match = FENCE_RE.exec(s))) blocks.push({ fence: (match[1] || '').toLowerCase(), code: match[2] });
  if (!blocks.length) return s.trim().replace(/^`+|`+$/g, '').trim();
  const wanted = wantedFence ? blocks.find((b) => b.fence === String(wantedFence).toLowerCase()) : null;
  const chosen = wanted || blocks.reduce((best, b) => (b.code.length > best.code.length ? b : best), blocks[0]);
  return chosen.code.replace(/\s+$/, '');
}

function numbered(source, first = 1) {
  return String(source || '').split('\n').map((line, i) => `${String(i + first).padStart(4)}| ${line}`).join('\n');
}

function excerpt(source, lineno, radius = 6) {
  const lines = String(source || '').split('\n');
  const low = Math.max(1, lineno - radius);
  const high = Math.min(lines.length, lineno + radius);
  const out = [];
  for (let i = low; i <= high; i++) out.push(`${i === lineno ? '>>' : '  '}${String(i).padStart(4)}| ${lines[i - 1]}`);
  return out.join('\n');
}

function codeVolume(source) {
  return String(source || '').split('\n').filter((l) => l.trim() && !/^\s*(#|\/\/|--)/.test(l)).length;
}

// ---------------------------------------------------------------------------
// Knowledge graph (regex-based, language-aware)
// ---------------------------------------------------------------------------
const SYMBOL_RULES = {
  python: {
    imports: [/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/, /^\s*from\s+([\w.]+)\s+import\s+(.+)$/],
    functions: [/^\s*(?:async\s+)?def\s+(\w+)\s*(\([^)]*\))\s*(?:->\s*([^:]+))?:/],
    classes: [/^\s*class\s+(\w+)\s*(\([^)]*\))?\s*:/],
    variables: [/^(\w+)\s*(?::\s*[^=]+)?=\s*(.+)$/],
  },
  javascript: {
    imports: [/^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/, /^\s*(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/],
    functions: [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*(\([^)]*\))/, /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(\([^)]*\)|\w+)\s*=>/],
    classes: [/^\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?/],
    variables: [/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(.+)$/],
  },
  go: {
    imports: [/^\s*import\s+"([^"]+)"/, /^\s*"([^"]+)"\s*$/],
    functions: [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)\s*(\([^)]*\))\s*([^{]*)\{/],
    classes: [/^\s*type\s+(\w+)\s+(struct|interface)\b/],
    variables: [/^(?:var|const)\s+(\w+)\s*=?\s*(.*)$/],
  },
  rust: {
    imports: [/^\s*use\s+([\w:{}, *]+);/],
    functions: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*(\([^)]*\))\s*(?:->\s*([^{]+))?/],
    classes: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/],
    variables: [/^\s*(?:pub\s+)?(?:static|const)\s+(\w+)\s*:\s*(.+?)=/],
  },
  java: {
    imports: [/^\s*import\s+(?:static\s+)?([\w.*]+);/],
    functions: [/^\s*(?:public|private|protected|static|final|synchronized|abstract|\s)+[\w<>[\],\s]+\s+(\w+)\s*(\([^)]*\))\s*(?:throws[^{]+)?\{?/],
    classes: [/^\s*(?:public|private|protected|abstract|final|static|\s)*(?:class|interface|enum|record)\s+(\w+)/],
    variables: [],
  },
  r: {
    imports: [/^\s*library\(([\w.]+)\)/, /^\s*require\(([\w.]+)\)/],
    functions: [/^\s*(\w[\w.]*)\s*(?:<-|=)\s*function\s*(\([^)]*\))/],
    classes: [/^\s*setClass\(\s*"(\w+)"/],
    variables: [/^(\w[\w.]*)\s*(?:<-|=)\s*(.+)$/],
  },
  ruby: {
    imports: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/],
    functions: [/^\s*def\s+([\w.?!]+)\s*(\([^)]*\))?/],
    classes: [/^\s*(?:class|module)\s+([\w:]+)/],
    variables: [/^([A-Z]\w*)\s*=\s*(.+)$/],
  },
  shellscript: {
    imports: [/^\s*(?:source|\.)\s+(\S+)/],
    functions: [/^\s*(?:function\s+)?(\w+)\s*\(\)\s*\{?/],
    classes: [],
    variables: [/^(\w+)=(.*)$/],
  },
};
SYMBOL_RULES.typescript = {
  ...SYMBOL_RULES.javascript,
  classes: [...SYMBOL_RULES.javascript.classes, /^\s*(?:export\s+)?(?:interface|type|enum)\s+(\w+)/],
};
SYMBOL_RULES.c = { imports: [/^\s*#include\s+[<"]([^>"]+)[>"]/], functions: [/^[\w*\s]+?\b(\w+)\s*(\([^)]*\))\s*\{?\s*$/], classes: [/^\s*(?:typedef\s+)?(?:struct|enum|union)\s+(\w+)/], variables: [] };
SYMBOL_RULES.cpp = { ...SYMBOL_RULES.c, classes: [...SYMBOL_RULES.c.classes, /^\s*class\s+(\w+)/] };
SYMBOL_RULES.csharp = SYMBOL_RULES.java;
SYMBOL_RULES.kotlin = { imports: [/^\s*import\s+([\w.*]+)/], functions: [/^\s*(?:(?:public|private|internal|override|suspend|inline)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*(\([^)]*\))/], classes: [/^\s*(?:(?:data|sealed|open|abstract|enum)\s+)*(?:class|object|interface)\s+(\w+)/], variables: [/^\s*(?:val|var)\s+(\w+)\s*(?::[^=]+)?=\s*(.+)$/] };
SYMBOL_RULES.php = { imports: [/^\s*(?:use|require(?:_once)?|include(?:_once)?)\s+([^;]+);/], functions: [/^\s*(?:public|private|protected|static|\s)*function\s+(\w+)\s*(\([^)]*\))/], classes: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/], variables: [] };
SYMBOL_RULES.swift = { imports: [/^\s*import\s+(\w+)/], functions: [/^\s*(?:(?:public|private|internal|static|override)\s+)*func\s+(\w+)\s*(\([^)]*\))/], classes: [/^\s*(?:(?:public|private|internal|final)\s+)*(?:class|struct|enum|protocol)\s+(\w+)/], variables: [/^\s*(?:let|var)\s+(\w+)/] };
SYMBOL_RULES.dart = SYMBOL_RULES.java;
SYMBOL_RULES.scala = { imports: [/^\s*import\s+([\w.{}_, ]+)/], functions: [/^\s*(?:override\s+)?def\s+(\w+)\s*(\([^)]*\))?/], classes: [/^\s*(?:case\s+)?(?:class|object|trait)\s+(\w+)/], variables: [/^\s*(?:val|var)\s+(\w+)/] };
SYMBOL_RULES.julia = { imports: [/^\s*(?:using|import)\s+([\w.]+)/], functions: [/^\s*function\s+(\w+)\s*(\([^)]*\))/], classes: [/^\s*(?:mutable\s+)?struct\s+(\w+)/], variables: [/^(\w+)\s*=\s*(.+)$/] };
SYMBOL_RULES.lua = { imports: [/^\s*(?:local\s+)?\w+\s*=\s*require\s*\(?['"]([^'"]+)['"]/], functions: [/^\s*(?:local\s+)?function\s+([\w.:]+)\s*(\([^)]*\))/], classes: [], variables: [/^(\w+)\s*=\s*(.+)$/] };
SYMBOL_RULES.perl = { imports: [/^\s*use\s+([\w:]+)/], functions: [/^\s*sub\s+(\w+)/], classes: [/^\s*package\s+([\w:]+)/], variables: [/^\s*(?:my|our)\s+([$@%]\w+)\s*=\s*(.+)$/] };
SYMBOL_RULES.powershell = { imports: [/^\s*Import-Module\s+(\S+)/i], functions: [/^\s*function\s+([\w-]+)\s*(\([^)]*\))?/i], classes: [/^\s*class\s+(\w+)/i], variables: [/^\$(\w+)\s*=\s*(.+)$/] };

/**
 * Summarise what a piece of code defines. Returns
 * {language, imports:[], functions:[{name, signature, returns}], classes:[], variables:[{name, value}], files:[]}.
 */
function analyse(code, langId) {
  const lang = languages.byId(langId);
  const rules = SYMBOL_RULES[lang ? lang.id : ''] || SYMBOL_RULES.javascript;
  const graph = { language: lang ? lang.id : 'unknown', imports: [], functions: [], classes: [], variables: [], files: [] };
  const seen = { imports: new Set(), functions: new Set(), classes: new Set(), variables: new Set(), files: new Set() };
  const push = (kind, entry, key) => { if (!seen[kind].has(key)) { seen[kind].add(key); graph[kind].push(entry); } };
  const lines = String(code || '').split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.trim() || ANY_MARKER_RE.test(raw)) continue;
    let matched = false;
    for (const re of rules.imports) {
      const m = re.exec(raw);
      if (m) { const text = raw.trim().replace(/;$/, ''); push('imports', text, text); matched = true; break; }
    }
    if (matched) continue;
    for (const re of rules.functions) {
      const m = re.exec(raw);
      if (m && m[1] && !/^(if|for|while|switch|return|else|catch)$/.test(m[1])) {
        push('functions', { name: m[1], signature: (m[2] || '()').replace(/\s+/g, ' '), returns: (m[3] || '').trim() || undefined }, m[1]);
        matched = true; break;
      }
    }
    if (matched) continue;
    for (const re of rules.classes) {
      const m = re.exec(raw);
      if (m && m[1]) { push('classes', { name: m[1], bases: (m[2] || '').replace(/[()]/g, '').trim() || undefined }, m[1]); matched = true; break; }
    }
    if (matched) continue;
    for (const re of rules.variables) {
      const m = re.exec(raw);
      if (m && m[1]) { push('variables', { name: m[1], value: String(m[2] || '').trim().slice(0, 60) || undefined }, m[1]); break; }
    }
    const file = /['"]([^'"\s]+\.(?:csv|xlsx?|json|ya?ml|txt|parquet|png|jpg|svg|pdf|db|sqlite|md|html|log))['"]/i.exec(raw);
    if (file) push('files', file[1], file[1]);
  }
  return graph;
}

/** Render a graph for the model. */
function graphPrompt(graph, title) {
  const out = [];
  if (title) out.push(title);
  out.push(`language: ${graph.language}`);
  out.push('imports:' + (graph.imports.length ? '\n' + graph.imports.map((i) => `  - ${i}`).join('\n') : ' (none)'));
  out.push('functions:' + (graph.functions.length ? '\n' + graph.functions.map((f) => `  - ${f.name}${f.signature}${f.returns ? ' -> ' + f.returns : ''}`).join('\n') : ' (none)'));
  out.push('classes:' + (graph.classes.length ? '\n' + graph.classes.map((c) => `  - ${c.name}${c.bases ? ' (' + c.bases + ')' : ''}`).join('\n') : ' (none)'));
  out.push('variables:' + (graph.variables.length ? '\n' + graph.variables.map((v) => `  - ${v.name}${v.value ? ' = ' + v.value : ''}`).join('\n') : ' (none)'));
  if (graph.files.length) out.push('files touched:\n' + graph.files.map((f) => `  - ${f}`).join('\n'));
  return out.join('\n');
}

module.exports = {
  MARKER_RE, PROMPT_RE, REQUEST_RE, newId, marker, promptLine, assemble, split, mapSource, locate,
  stripMarkers, findRequests, extractCode, numbered, excerpt, codeVolume, analyse, graphPrompt,
};
