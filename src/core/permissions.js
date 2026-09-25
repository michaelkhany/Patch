'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * The permission gate.
 *
 * Two ideas combined:
 *
 * 1. Claude Code's permission model - a mode (default / acceptEdits / plan /
 *    bypassPermissions) plus allow / deny / ask rules written as
 *    `Tool` or `Tool(pattern)`, e.g. `Shell(npm test *)`, `Edit(src/**)`,
 *    `WebSearch`. Deny wins over allow; a matching allow skips the prompt.
 *
 * 2. DAYA's ask-the-user gate - a tool that needs something consequential
 *    blocks, the question is put in front of the user with the exact command,
 *    and the answer is `allow` (once), `always` (for this kind, this session)
 *    or `deny`. No answer within the timeout is a denial; a refusal is
 *    remembered for the rest of the run so a retry loop cannot nag.
 */

const DECISION_ALLOW = 'allow';
const DECISION_ALWAYS = 'always';
const DECISION_DENY = 'deny';

/** Tool -> how consequential it is when no rule applies. */
const TOOL_CLASS = {
  Read: 'read', Glob: 'read', Grep: 'read', ListDir: 'read', Diagnostics: 'read',
  WebSearch: 'read', WebFetch: 'read', KnowledgeGraph: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', Patch: 'edit',
  Shell: 'shell', RunCode: 'run', Install: 'install',
};

function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; } else re += '[^/\\\\]*';
    } else if (ch === '?') re += '.';
    else if ('\\^$+.()|{}[]'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$', 'i');
}

/** Parse "Tool(pattern)" -> {tool, pattern}. */
function parseRule(rule) {
  const match = /^\s*([A-Za-z_]+)\s*(?:\((.*)\))?\s*$/.exec(String(rule || ''));
  if (!match) return null;
  return { tool: match[1], pattern: match[2] !== undefined ? match[2].trim() : null };
}

/** The string a rule's pattern is matched against for a given tool call. */
function subjectOf(tool, args) {
  args = args || {};
  switch (tool) {
    case 'Shell': return String(args.command || '');
    case 'Install': return `${args.manager || ''} ${(args.packages || []).join(' ')}`.trim();
    case 'RunCode': return String(args.language || '');
    case 'WebFetch': return String(args.url || '');
    case 'WebSearch': return String(args.query || '');
    default: return String(args.path || args.file || args.pattern || '').replace(/\\/g, '/');
  }
}

function ruleMatches(rule, tool, args) {
  const parsed = typeof rule === 'string' ? parseRule(rule) : rule;
  if (!parsed) return false;
  if (parsed.tool !== tool && parsed.tool !== '*') return false;
  if (parsed.pattern === null || parsed.pattern === '' || parsed.pattern === '*') return true;
  const subject = subjectOf(tool, args);
  if (parsed.pattern.endsWith(':*')) {
    // Claude Code prefix form: Shell(npm:*) matches any command starting with "npm".
    return subject.startsWith(parsed.pattern.slice(0, -2));
  }
  return globToRegExp(parsed.pattern).test(subject) || globToRegExp(parsed.pattern).test(subject.split('/').pop() || '');
}

function firstMatch(rules, tool, args) {
  return (rules || []).find((rule) => ruleMatches(rule, tool, args)) || null;
}

/**
 * Decide without asking: 'allow' | 'deny' | 'ask'.
 * `detail` may carry {readOnly, destructive} from the tool's own classifier.
 */
function decide({ mode, rules, tool, args, detail }) {
  rules = rules || { allow: [], deny: [], ask: [] };
  const klass = TOOL_CLASS[tool] || 'shell';
  if (detail && detail.destructive) return { decision: 'deny', reason: 'destructive command (hard block)' };
  const denied = firstMatch(rules.deny, tool, args);
  if (denied) return { decision: 'deny', reason: `deny rule ${denied}` };
  if (mode === 'plan' && klass !== 'read') return { decision: 'deny', reason: 'plan mode: read-only' };
  const asked = firstMatch(rules.ask, tool, args);
  if (asked) return { decision: 'ask', reason: `ask rule ${asked}` };
  const allowed = firstMatch(rules.allow, tool, args);
  if (allowed) return { decision: 'allow', reason: `allow rule ${allowed}` };
  if (mode === 'bypassPermissions') return { decision: 'allow', reason: 'bypassPermissions mode' };
  if (klass === 'read') return { decision: 'allow', reason: 'read-only tool' };
  if (klass === 'edit' && mode === 'acceptEdits') return { decision: 'allow', reason: 'acceptEdits mode' };
  if (klass === 'shell' && detail && detail.readOnly) return { decision: 'allow', reason: 'read-only command' };
  return { decision: 'ask', reason: `${klass} needs confirmation` };
}

/**
 * Build the gate for one session.
 *   ask(question) -> Promise<'allow'|'always'|'deny'>, provided by the UI.
 *   Returns gate(tool, args, {summary, detail, command, readOnly, destructive}) -> Promise<{allowed, reason, decision}>.
 */
function makeGate({ mode, rules, ask, timeoutMs = 300000, signal, onDecision }) {
  const grants = new Set();
  const refused = new Set();

  const report = (payload) => {
    if (!onDecision) return;
    try { onDecision(payload); } catch (_) { /* audit must not break the run */ }
  };

  return async function gate(tool, args, info) {
    info = info || {};
    const klass = TOOL_CLASS[tool] || 'shell';
    const verdict = decide({ mode, rules, tool, args, detail: info });
    if (verdict.decision === 'deny') {
      report({ tool, args, decision: DECISION_DENY, source: verdict.reason });
      return { allowed: false, reason: verdict.reason, decision: DECISION_DENY };
    }
    if (verdict.decision === 'allow') {
      report({ tool, args, decision: DECISION_ALLOW, source: verdict.reason });
      return { allowed: true, reason: verdict.reason, decision: DECISION_ALLOW };
    }
    if (grants.has(klass)) {
      report({ tool, args, decision: DECISION_ALWAYS, source: 'standing grant' });
      return { allowed: true, reason: 'always allowed this session', decision: DECISION_ALWAYS };
    }
    const signature = `${tool}|${info.command || info.summary || subjectOf(tool, args)}`;
    if (refused.has(signature)) {
      report({ tool, args, decision: DECISION_DENY, source: 'refused earlier in this run' });
      return { allowed: false, reason: 'you declined this earlier in the run', decision: DECISION_DENY };
    }
    if (!ask) {
      refused.add(signature);
      return { allowed: false, reason: 'no one to ask', decision: DECISION_DENY };
    }
    let decision = DECISION_DENY;
    try {
      decision = await Promise.race([
        ask({ tool, kind: klass, args, summary: info.summary || `${tool}?`, detail: info.detail || '', command: info.command || subjectOf(tool, args) }),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(DECISION_DENY), timeoutMs);
          if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(DECISION_DENY); }, { once: true });
        }),
      ]);
    } catch (_) {
      decision = DECISION_DENY;
    }
    if (decision === DECISION_ALWAYS) {
      grants.add(klass);
      report({ tool, args, decision, source: 'user' });
      return { allowed: true, reason: 'always allowed', decision };
    }
    if (decision === DECISION_ALLOW) {
      report({ tool, args, decision, source: 'user' });
      return { allowed: true, reason: 'allowed once', decision };
    }
    refused.add(signature);
    report({ tool, args, decision: DECISION_DENY, source: 'user or timeout' });
    return { allowed: false, reason: 'declined', decision: DECISION_DENY };
  };
}

module.exports = {
  DECISION_ALLOW, DECISION_ALWAYS, DECISION_DENY, TOOL_CLASS,
  parseRule, ruleMatches, decide, makeGate, globToRegExp, subjectOf,
};
