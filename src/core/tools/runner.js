'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * The iTailor runner: execute a generated script in its own directory,
 * capture stdout/stderr/exit code, collect the files it produced, and heal a
 * missing dependency (install, then re-run the SAME code) before the error
 * is handed back to the model - as first implemented in DAYA Studio's itailor.run /
 * _heal_missing_dependency.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const languages = require('../languages');
const shell = require('./shell');
const packages = require('./packages');

const MAX_DEPENDENCY_HEALS = 3;

function runsDir(cwd) {
  return path.join(cwd, '.patchcode', 'runs');
}

function nodeMajor() {
  const m = /^v?(\d+)/.exec(process.versions.node || '');
  return m ? Number(m[1]) : 0;
}

function snapshot(dir) {
  try { return new Set(fs.readdirSync(dir)); } catch (_) { return new Set(); }
}

function newFiles(dir, before, skip) {
  const out = [];
  for (const name of [...snapshot(dir)].sort()) {
    if (before.has(name) || skip.has(name)) continue;
    const full = path.join(dir, name);
    try { if (fs.statSync(full).isFile()) out.push(full); } catch (_) { /* ignore */ }
  }
  return out;
}

/**
 * Execute `code` as a `language` script. Options: {cwd, timeoutMs, env, signal,
 * onOutput, filename, keep, stdin}. Never rejects.
 */
async function execute(code, language, options = {}) {
  const { cwd, timeoutMs = 180000, env, signal, onOutput, filename, stdin } = options;
  const lang = languages.resolve(language, filename);
  if (!lang) return { success: false, error: `Unknown language '${language}'.`, stdout: '', stderr: '', exitCode: null, files: [] };
  if (!lang.run && !lang.compile) return { success: false, error: `${lang.label} files can be edited but not executed by Patch Code.`, stdout: '', stderr: '', exitCode: null, files: [] };

  const token = crypto.randomBytes(6).toString('hex');
  const runDir = path.join(runsDir(cwd), token);
  fs.mkdirSync(runDir, { recursive: true });
  const name = filename ? path.basename(filename) : `patch${lang.extensions[0]}`;
  const scriptPath = path.join(runDir, name);
  fs.writeFileSync(scriptPath, String(code), 'utf8');

  const beforeRun = snapshot(runDir);
  const beforeCwd = snapshot(cwd);
  const ctx = { platform: process.platform, nodeMajor: nodeMajor(), cwd };
  let argv = null;
  let compileResult = null;
  if (lang.compile) {
    const exe = path.join(runDir, process.platform === 'win32' ? 'patch.exe' : 'patch.out');
    compileResult = await shell.runArgv(lang.compile(scriptPath, exe), { cwd: runDir, timeoutMs, env, signal, onOutput });
    if (!compileResult.success) {
      return { success: false, stage: 'compile', exitCode: compileResult.exitCode, stdout: compileResult.stdout, stderr: compileResult.stderr,
        error: compileResult.error || 'Compilation failed.', files: [], scriptPath, runDir, language: lang.id };
    }
    argv = [exe];
  } else {
    argv = lang.run(scriptPath, ctx);
    if (!argv) return { success: false, error: `No runner for ${lang.label} on this platform.`, stdout: '', stderr: '', exitCode: null, files: [], language: lang.id };
  }
  const started = Date.now();
  // The script's working directory is the workspace so relative paths mean what the user expects.
  const result = await shell.runArgv(argv, { cwd, timeoutMs, env: { ...(env || {}), PATCHCODE_RUN_DIR: runDir }, signal, onOutput, stdin });
  const skip = new Set([name, 'patch.exe', 'patch.out']);
  const files = [...newFiles(runDir, beforeRun, skip), ...newFiles(cwd, beforeCwd, new Set())];
  return {
    success: result.success, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
    error: result.error, cancelled: result.cancelled, durationMs: Date.now() - started,
    files, scriptPath, runDir, language: lang.id, command: argv.join(' '),
  };
}

/**
 * Turn "No module named 'matplotlib'" into an installed matplotlib and a re-run
 * of the same code. `gate(tool, args, info)` is the permission gate.
 * Returns {result, notes}.
 */
async function healMissingDependency(result, code, language, options) {
  const { gate, emit, cwd, env, signal, timeoutMs, onOutput } = options;
  const notes = [];
  for (let attempt = 0; attempt < MAX_DEPENDENCY_HEALS; attempt++) {
    if (result.success) return { result, notes };
    const blame = `${result.stderr || ''}\n${result.stdout || ''}\n${result.error || ''}`;
    const missing = packages.missingModuleFrom(blame);
    if (!missing) return { result, notes };
    const pkg = packages.packageFor(missing.manager, missing.module);
    if (!packages.isInstallableName(pkg)) {
      notes.push(`'${missing.module}' is missing, but '${pkg}' is not a name Patch Code will install.`);
      return { result, notes };
    }
    const argv = packages.installCommand(missing.manager, [pkg], {});
    const command = argv ? argv.join(' ') : `${missing.manager} install ${pkg}`;
    if (emit) emit('think', `The script needs '${pkg}', which isn't installed…`);
    const verdict = gate ? await gate('Install', { manager: missing.manager, packages: [pkg] }, {
      summary: `Install the ${missing.manager} package '${pkg}'?`,
      detail: `The script failed with "${blame.match(/No module named[^\n]*|Cannot find[^\n]*|no package called[^\n]*/)?.[0] || 'a missing dependency'}". Installing '${pkg}' lets it finish; the same code is then re-run.`,
      command,
    }) : { allowed: true };
    if (!verdict.allowed) {
      notes.push(`Installing '${pkg}' was declined (${verdict.reason}), so the script could not run.`);
      return { result: { ...result, error: `${result.error || ''} ('${pkg}' is not installed and permission to install it was declined.)`.trim() }, notes };
    }
    if (emit) emit('tool', `Installing ${pkg}…`);
    const install = await packages.install(missing.manager, [pkg], { cwd, env, signal, onOutput });
    if (!install.success) {
      notes.push(`Could not install '${pkg}': ${install.error || 'the package manager failed'}.`);
      if (emit) emit('observe', `Installing ${pkg} failed.`);
      return { result, notes };
    }
    notes.push(`Installed '${pkg}' and re-ran the script.`);
    if (emit) emit('observe', `Installed ${pkg}; re-running…`);
    result = await execute(code, language, { cwd, env, signal, timeoutMs, onOutput });
  }
  return { result, notes };
}

/** Execute, then heal missing dependencies. This is what the RunCode tool calls. */
async function run(code, language, options = {}) {
  let result = await execute(code, language, options);
  if (result.cancelled) return { ...result, notes: [] };
  const { result: healed, notes } = await healMissingDependency(result, code, language, options);
  return { ...healed, notes };
}

/** Delete run directories older than `maxAgeMs` (housekeeping). */
function cleanup(cwd, maxAgeMs = 7 * 24 * 3600 * 1000) {
  const dir = runsDir(cwd);
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > maxAgeMs) { fs.rmSync(full, { recursive: true, force: true }); removed++; }
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* no runs yet */ }
  return removed;
}

module.exports = { execute, run, healMissingDependency, cleanup, runsDir, MAX_DEPENDENCY_HEALS, tmpdir: os.tmpdir };
