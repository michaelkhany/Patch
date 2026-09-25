'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * File tools: Read, Write, Edit, ListDir, Glob, Grep.
 *
 * Every path is resolved against the workspace root and, when the sandbox
 * confines the agent to the workspace, a path that escapes it is refused
 * before anything is touched. Writes go through `host.writeFile` when the
 * extension provides one, so open editors update and the change is undoable.
 */

const fs = require('fs');
const path = require('path');
const { globToRegExp } = require('../permissions');

const IGNORED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv', '.tox',
  '.mypy_cache', '.pytest_cache', '.idea', 'target', '.next', '.nuxt', 'coverage', '.patchcode', '.cache', '.gradle', 'bin', 'obj']);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_GREP_FILE_BYTES = 1024 * 1024;

function resolvePath(cwd, p, { confine = true, mustExist = false } = {}) {
  const raw = String(p || '').trim();
  if (!raw) throw new Error('A path is required.');
  const abs = path.resolve(cwd, raw);
  if (confine) {
    const root = path.resolve(cwd);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`'${raw}' is outside the workspace (${root}). The sandbox confines Patch Code to the workspace; set patchCode.sandbox.confineToWorkspace to false to allow it.`);
    }
  }
  if (mustExist && !fs.existsSync(abs)) throw new Error(`No such file or directory: ${raw}`);
  return abs;
}

function relOf(cwd, abs) {
  return path.relative(cwd, abs).split(path.sep).join('/') || '.';
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

/** Read a text file as numbered lines (cat -n style). */
function readFile(cwd, args, ctx) {
  const abs = resolvePath(cwd, args.path, { confine: ctx.confine, mustExist: true });
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return { error: `'${args.path}' is a directory. Use ListDir.` };
  let text;
  const override = ctx.readOverride && ctx.readOverride(abs);
  if (typeof override === 'string') text = override;
  else {
    if (stat.size > MAX_READ_BYTES) return { error: `File is ${stat.size} bytes; the limit is ${MAX_READ_BYTES}. Read a slice with offset/limit or Grep it.` };
    const buffer = fs.readFileSync(abs);
    if (looksBinary(buffer)) return { path: relOf(cwd, abs), binary: true, bytes: stat.size, note: 'Binary file; contents not shown.' };
    text = buffer.toString('utf8');
  }
  const lines = text.split(/\r?\n/);
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.max(1, Math.min(Number(args.limit) || 2000, 5000));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const width = String(offset + slice.length).length;
  const body = slice.map((line, i) => `${String(offset + i).padStart(width)}\t${line}`).join('\n');
  return {
    path: relOf(cwd, abs), totalLines: lines.length, offset, shown: slice.length,
    truncated: offset - 1 + slice.length < lines.length, content: body,
  };
}

async function writeFile(cwd, args, ctx) {
  const abs = resolvePath(cwd, args.path, { confine: ctx.confine });
  const content = String(args.content === undefined ? '' : args.content);
  const existed = fs.existsSync(abs);
  if (ctx.host && ctx.host.writeFile) await ctx.host.writeFile(abs, content);
  else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return { path: relOf(cwd, abs), action: existed ? 'updated' : 'created', bytes: Buffer.byteLength(content, 'utf8'), lines: content.split(/\r?\n/).length };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) { count++; index += needle.length; }
  return count;
}

/** Exact string replacement; the old string must be unique unless replace_all. */
async function editFile(cwd, args, ctx) {
  const abs = resolvePath(cwd, args.path, { confine: ctx.confine, mustExist: true });
  const oldString = String(args.old_string === undefined ? '' : args.old_string);
  const newString = String(args.new_string === undefined ? '' : args.new_string);
  if (!oldString) return { error: 'old_string must not be empty. Use Write to create a file.' };
  if (oldString === newString) return { error: 'old_string and new_string are identical.' };
  const override = ctx.readOverride && ctx.readOverride(abs);
  let text = typeof override === 'string' ? override : fs.readFileSync(abs, 'utf8');
  let needle = oldString;
  let count = countOccurrences(text, needle);
  if (count === 0 && text.includes('\r\n') && !needle.includes('\r\n')) {
    // The editor shows LF while the file is CRLF: match on the normalised text.
    needle = oldString.replace(/\n/g, '\r\n');
    count = countOccurrences(text, needle);
  }
  if (count === 0) {
    // Last resort: ignore trailing whitespace differences per line.
    const normalize = (s) => s.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).join('\n');
    const nText = normalize(text);
    const nOld = normalize(oldString);
    if (nText.includes(nOld) && countOccurrences(nText, nOld) === 1) {
      const start = nText.indexOf(nOld);
      const before = nText.slice(0, start).split('\n').length - 1;
      const oldLines = nOld.split('\n').length;
      const lines = text.split(/\r?\n/);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      lines.splice(before, oldLines, ...newString.split(/\r?\n/));
      const updated = lines.join(eol);
      await commit(abs, updated, ctx);
      return { path: relOf(cwd, abs), replaced: 1, note: 'Matched ignoring trailing whitespace.', preview: newString.slice(0, 400) };
    }
    return { error: `old_string was not found in ${args.path}. Read the file again and copy the exact text (whitespace matters).` };
  }
  if (count > 1 && !args.replace_all) {
    return { error: `old_string occurs ${count} times in ${args.path}. Include more surrounding context to make it unique, or pass replace_all: true.` };
  }
  const replacement = newString.includes('\n') && needle.includes('\r\n') ? newString.replace(/\r?\n/g, '\r\n') : newString;
  const updated = args.replace_all ? text.split(needle).join(replacement) : text.replace(needle, () => replacement);
  await commit(abs, updated, ctx);
  return { path: relOf(cwd, abs), replaced: args.replace_all ? count : 1, preview: newString.slice(0, 400) };
}

async function commit(abs, content, ctx) {
  if (ctx.host && ctx.host.writeFile) await ctx.host.writeFile(abs, content);
  else fs.writeFileSync(abs, content, 'utf8');
}

function walk(root, { maxEntries = 5000, maxDepth = 12, includeIgnored = false } = {}, visit) {
  let count = 0;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!includeIgnored && (IGNORED_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.isDirectory() && entry.name !== '.github'))) continue;
      const full = path.join(dir, entry.name);
      if (visit(full, entry, depth) === false) return;
      if (++count >= maxEntries) return;
      if (entry.isDirectory() && depth + 1 < maxDepth) stack.push({ dir: full, depth: depth + 1 });
    }
  }
}

function listDir(cwd, args, ctx) {
  const abs = resolvePath(cwd, args.path || '.', { confine: ctx.confine, mustExist: true });
  const depth = Math.max(1, Math.min(Number(args.depth) || 2, 6));
  const lines = [];
  let total = 0;
  walk(abs, { maxDepth: depth, maxEntries: 800 }, (full, entry, level) => {
    total++;
    let size = '';
    if (entry.isFile()) { try { size = `  ${fs.statSync(full).size} B`; } catch (_) { /* ignore */ } }
    lines.push(`${'  '.repeat(level)}${entry.name}${entry.isDirectory() ? '/' : size}`);
  });
  return { path: relOf(cwd, abs), entries: total, listing: lines.join('\n') || '(empty)' };
}

function glob(cwd, args, ctx) {
  const base = resolvePath(cwd, args.path || '.', { confine: ctx.confine, mustExist: true });
  const pattern = String(args.pattern || '').trim();
  if (!pattern) return { error: 'pattern is required, e.g. "**/*.py".' };
  const re = globToRegExp(pattern.replace(/\\/g, '/'));
  const matches = [];
  walk(base, { maxEntries: 20000, maxDepth: 20 }, (full, entry) => {
    if (!entry.isFile()) return;
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (re.test(rel) || re.test(entry.name)) {
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (_) { /* ignore */ }
      matches.push({ rel: relOf(cwd, full), mtime });
      if (matches.length >= 500) return false;
    }
  });
  matches.sort((a, b) => b.mtime - a.mtime);
  return { pattern, count: matches.length, files: matches.map((m) => m.rel), truncated: matches.length >= 500 };
}

function grep(cwd, args, ctx) {
  const base = resolvePath(cwd, args.path || '.', { confine: ctx.confine, mustExist: true });
  const pattern = String(args.pattern || '');
  if (!pattern) return { error: 'pattern is required.' };
  let re;
  try { re = new RegExp(pattern, args.case_insensitive ? 'i' : ''); } catch (error) { return { error: `Invalid regular expression: ${error.message}` }; }
  const fileFilter = args.glob ? globToRegExp(String(args.glob)) : null;
  const maxResults = Math.max(1, Math.min(Number(args.max_results) || 100, 500));
  const context = Math.max(0, Math.min(Number(args.context) || 0, 5));
  const results = [];
  let scanned = 0;
  const stat = fs.statSync(base);
  const files = [];
  if (stat.isFile()) files.push(base);
  else walk(base, { maxEntries: 20000, maxDepth: 20 }, (full, entry) => {
    if (!entry.isFile()) return;
    if (fileFilter && !(fileFilter.test(entry.name) || fileFilter.test(path.relative(base, full).split(path.sep).join('/')))) return;
    files.push(full);
  });
  for (const file of files) {
    if (results.length >= maxResults) break;
    let buffer;
    try {
      if (fs.statSync(file).size > MAX_GREP_FILE_BYTES) continue;
      buffer = fs.readFileSync(file);
    } catch (_) { continue; }
    if (looksBinary(buffer)) continue;
    scanned++;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const rel = relOf(cwd, file);
      if (context) {
        const from = Math.max(0, i - context);
        const to = Math.min(lines.length - 1, i + context);
        const block = [];
        for (let j = from; j <= to; j++) block.push(`${rel}${j === i ? ':' : '-'}${j + 1}${j === i ? ':' : '-'} ${lines[j]}`);
        results.push(block.join('\n'));
      } else results.push(`${rel}:${i + 1}: ${lines[i].slice(0, 400)}`);
      if (results.length >= maxResults) break;
    }
  }
  return { pattern, filesScanned: scanned, matches: results.length, truncated: results.length >= maxResults, results: results.join('\n') || '(no matches)' };
}

module.exports = { readFile, writeFile, editFile, listDir, glob, grep, resolvePath, walk, relOf, IGNORED_DIRS, looksBinary };
