'use strict';
// The iTailor runner against a real interpreter. Skipped when Python is not on PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runner = require('../src/core/tools/runner');
const tools = require('../src/core/tools');
const settings = require('../src/core/settings');

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(python, ['--version'], { windowsHide: true }).status === 0;

test('runner: executes a python script, captures output and produced files', { skip: !hasPython && 'python not on PATH' }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'patchcode-run-'));
  const result = await runner.execute('import os\nprint("hello from patch")\nopen("out.txt", "w").write("x")\nprint(os.getcwd())', 'python', { cwd: ws, timeoutMs: 60000 });
  assert.equal(result.success, true, result.stderr);
  assert.match(result.stdout, /hello from patch/);
  assert.equal(result.files.length, 1, 'a file written to the working directory is collected');
  assert.ok(fs.existsSync(result.scriptPath));
  assert.match(result.command, /python/);
});

test('runner: a missing module is detected and a declined install is reported', { skip: !hasPython && 'python not on PATH' }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'patchcode-run-'));
  const asked = [];
  const result = await runner.run('import definitely_missing_module_xyz_123\nprint(1)', 'python', {
    cwd: ws, timeoutMs: 60000,
    gate: async (tool, args, info) => { asked.push([tool, args, info.command]); return { allowed: false, reason: 'declined' }; },
  });
  assert.equal(result.success, false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], 'Install');
  assert.deepEqual(asked[0][1], { manager: 'pip', packages: ['definitely_missing_module_xyz_123'] });
  assert.match(asked[0][2], /pip install .*definitely_missing_module_xyz_123/);
  assert.match(result.notes.join(' '), /declined/);
  assert.match(result.error, /permission to install it was declined/);
});

test('runner: unknown and edit-only languages are refused cleanly', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'patchcode-run-'));
  assert.match((await runner.execute('x', 'klingon', { cwd: ws })).error, /Unknown language/);
  assert.match((await runner.execute('SELECT 1', 'sql', { cwd: ws })).error, /not executed/);
});

test('RunCode tool: end to end through the registry with a permissive gate', { skip: !hasPython && 'python not on PATH' }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'patchcode-run-'));
  const tool = tools.get('RunCode');
  const out = await tool.execute({ language: 'python', code: 'print(2 + 2)' }, {
    cwd: ws, settings: { ...settings.DEFAULTS, env: {} }, gate: async () => ({ allowed: true }), confine: true, emit() {},
  });
  assert.equal(out.success, true, out.stderr);
  assert.match(out.stdout, /4/);
  assert.match(out.scriptPath, /^\.patchcode\/runs\//);
});
