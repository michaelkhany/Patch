'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Web tools: DuckDuckGo search (no API key) and page fetch, as first
 * implemented in DAYA Studio's agent_tools.web_search. Used to look up an API or an error message
 * rather than guessing.
 */

const USER_AGENT = 'Mozilla/5.0 (compatible; PatchCode/1.0; +https://github.com/)';
const RESULT_RE = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
const TAG_RE = /<[^>]+>/g;

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function clean(text) {
  return decodeEntities(String(text || '').replace(TAG_RE, '')).replace(/\s+/g, ' ').trim();
}

function unwrapRedirect(url) {
  if (!url.includes('duckduckgo.com/l/')) return url;
  try {
    const parsed = new URL(url.startsWith('//') ? 'https:' + url : url);
    const target = parsed.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url;
  } catch (_) {
    return url;
  }
}

async function fetchText(url, { method = 'GET', body, timeoutMs = 20000, signal, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method, body, signal: controller.signal, redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...(headers || {}) },
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text, contentType: response.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function search(query, { maxResults = 6, timeoutMs = 20000, signal } = {}) {
  const text = String(query || '').trim();
  if (!text) return { success: false, query: '', results: [], error: 'No search query was given.' };
  maxResults = Math.max(1, Math.min(Number(maxResults) || 6, 10));
  const results = [];
  let error = null;
  try {
    const page = await fetchText('https://html.duckduckgo.com/html/', {
      method: 'POST', body: new URLSearchParams({ q: text }).toString(), timeoutMs, signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!page.ok) error = `DuckDuckGo returned HTTP ${page.status}.`;
    RESULT_RE.lastIndex = 0;
    let match;
    while ((match = RESULT_RE.exec(page.text))) {
      let url = unwrapRedirect(decodeEntities(match[1] || ''));
      if (url.startsWith('//')) url = 'https:' + url;
      const title = clean(match[2]);
      if (!url || !title) continue;
      results.push({ title, url, snippet: clean(match[3] || '').slice(0, 400) });
      if (results.length >= maxResults) break;
    }
  } catch (err) {
    error = `Could not reach DuckDuckGo: ${err.message || err}`;
  }
  let abstract = '';
  try {
    const instant = await fetchText('https://api.duckduckgo.com/?' + new URLSearchParams({ q: text, format: 'json', no_html: '1', skip_disambig: '1' }).toString(), { timeoutMs: Math.min(timeoutMs, 10000), signal });
    const data = JSON.parse(instant.text);
    abstract = String(data.AbstractText || data.Answer || '').slice(0, 600);
  } catch (_) { abstract = ''; }
  return {
    success: Boolean(results.length || abstract), query: text, abstract, results,
    error: results.length || abstract ? null : (error || 'No results were found.'),
  };
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre)>/gi, '\n');
  s = s.replace(TAG_RE, '');
  s = decodeEntities(s);
  return s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function fetchPage(url, { maxChars = 12000, timeoutMs = 20000, signal } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { success: false, url: target, error: 'Only http(s) URLs can be fetched.' };
  try {
    const page = await fetchText(target, { timeoutMs, signal });
    if (!page.ok) return { success: false, url: target, status: page.status, error: `HTTP ${page.status}` };
    const isHtml = /html/i.test(page.contentType) || /^\s*</.test(page.text);
    const text = isHtml ? htmlToText(page.text) : page.text;
    const limit = Math.max(500, Math.min(Number(maxChars) || 12000, 60000));
    return { success: true, url: target, status: page.status, contentType: page.contentType, truncated: text.length > limit, text: text.slice(0, limit) };
  } catch (error) {
    return { success: false, url: target, error: `Could not fetch: ${error.message || error}` };
  }
}

module.exports = { search, fetchPage, htmlToText, clean, unwrapRedirect };
