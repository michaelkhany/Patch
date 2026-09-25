'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const providers = require('../src/core/providers');
const llm = require('../src/core/llm');
const languages = require('../src/core/languages');
const settings = require('../src/core/settings');
const permissions = require('../src/core/permissions');
const patch = require('../src/core/patch');
const textprotocol = require('../src/core/textprotocol');
const modelselect = require('../src/core/modelselect');
const shell = require('../src/core/tools/shell');
const packages = require('../src/core/tools/packages');
const fsTools = require('../src/core/tools/fs');
const tools = require('../src/core/tools');
const agent = require('../src/core/agent');
const hooks = require('../src/core/hooks');
const context = require('../src/core/context');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'patchcode-'));
}

test('providers: detect, filter, known tool support', () => {
  assert.equal(providers.detect('https://api.openai.com/v1'), 'openai');
  assert.equal(providers.detect('https://chat-ai.academiccloud.de/v1'), 'gwdg');
  assert.equal(providers.detect('http://127.0.0.1:11434/v1'), 'ollama');
  assert.equal(providers.detect('http://myhost/v1'), 'custom');
  assert.deepEqual(providers.filterModels('https://api.openai.com/v1', ['gpt-4o', 'text-embedding-3-small', 'whisper-1']), ['gpt-4o']);
  assert.equal(providers.knownToolSupport('https://api.openai.com/v1', 'gpt-4.1-mini'), true);
  assert.equal(providers.knownToolSupport('https://chat-ai.academiccloud.de/v1', 'qwen3-coder'), null);
});

test('llm: endpoints, context windows, retry classification', () => {
  assert.equal(llm.buildChatEndpoint('https://x/v1/'), 'https://x/v1/chat/completions');
  assert.equal(llm.buildChatEndpoint('https://x/v1/chat/completions'), 'https://x/v1/chat/completions');
  assert.equal(llm.buildModelsEndpoint('https://x/v1'), 'https://x/v1/models');
  assert.equal(llm.extractContextWindow({ id: 'm', meta: { context_length: 32000 } }), 32000);
  assert.equal(llm.extractContextWindow({ id: 'm' }), 0);
  assert.equal(llm.isRetryableError('HTTP 503 from the model API.'), true);
  assert.equal(llm.isRetryableError('HTTP 401 from the model API.'), false);
  assert.equal(llm.errorKind('HTTP 401 from the model API.'), 'auth');
  assert.deepEqual(llm.parseToolCall({ id: 'c1', function: { name: 'Read', arguments: '{"path":"a.py"}' } }), { id: 'c1', name: 'Read', args: { path: 'a.py' } });
  assert.ok(llm.parseToolCall({ function: { name: 'Read', arguments: '{bad' } }).args.__parse_error);
});

test('llm: consumeStream assembles content and tool calls', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Re","arguments":"{\\"pa"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ad","arguments":"th\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n',
    'data: {"usage":{"prompt_tokens":5,"completion_tokens":3},"choices":[]}\n',
    'data: [DONE]\n',
  ];
  const body = new ReadableStream({
    start(controller) { for (const c of chunks) controller.enqueue(new TextEncoder().encode(c)); controller.close(); },
  });
  const deltas = [];
  const result = await llm.consumeStream({ body }, (d) => deltas.push(d));
  assert.equal(result.message.content, 'Hello');
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(result.message.tool_calls[0].function.name, 'Read');
  assert.equal(result.message.tool_calls[0].function.arguments, '{"path":"x"}');
  assert.equal(result.usage.promptTokens, 5);
  assert.equal(result.finishReason, 'tool_calls');
});

test('languages: resolve by id, alias, extension and filename', () => {
  assert.equal(languages.byId('py').id, 'python');
  assert.equal(languages.byId('typescriptreact').id, 'typescript');
  assert.equal(languages.byFilename('a/b/c.R').id, 'r');
  assert.equal(languages.byFilename('Dockerfile').id, 'dockerfile');
  assert.equal(languages.resolve('auto', 'x.go').id, 'go');
  assert.equal(languages.commentLine(languages.byId('html'), 'hi'), '<!-- hi -->');
  assert.ok(languages.runnable().includes('python'));
  assert.ok(!languages.runnable().includes('sql'));
});

test('settings: layers merge, permissions concatenate, invalid values clamp', () => {
  const home = tmp();
  const ws = tmp();
  process.env.PATCHCODE_HOME = home;
  fs.mkdirSync(path.join(home, '.patchcode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.patchcode', 'settings.json'), JSON.stringify({ model: 'user-model', permissions: { allow: ['Read'] }, env: { A: '1' } }));
  fs.mkdirSync(path.join(ws, '.patchcode'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.patchcode', 'settings.json'), '// comment\n{ "permissions": { "allow": ["Shell(npm test*)"], "deny": ["Shell(rm*)"] }, "maxIterations": 999, }');
  fs.writeFileSync(path.join(ws, '.patchcode', 'settings.local.json'), JSON.stringify({ model: 'local-model', env: { B: '2' } }));
  fs.writeFileSync(path.join(ws, 'PATCHCODE.md'), '# Project\nUse pytest.');
  const { settings: s, sources, errors } = settings.load({ workspaceRoot: ws, vscodeLayer: { permissionMode: 'acceptEdits' } });
  assert.deepEqual(errors, []);
  assert.equal(sources.length, 4);
  assert.equal(s.model, 'local-model');
  assert.equal(s.permissionMode, 'acceptEdits');
  assert.deepEqual(s.permissions.allow, ['Read', 'Shell(npm test*)']);
  assert.deepEqual(s.permissions.deny, ['Shell(rm*)']);
  assert.deepEqual(s.env, { A: '1', B: '2' });
  assert.equal(s.maxIterations, 50);
  const ctx = settings.loadContextFiles({ workspaceRoot: ws });
  assert.equal(ctx.length, 1);
  assert.match(ctx[0].text, /pytest/);
  settings.addPermissionRule(settings.localSettingsPath(ws), 'allow', 'Shell(git status)');
  settings.addPermissionRule(settings.localSettingsPath(ws), 'allow', 'Shell(git status)');
  const again = settings.load({ workspaceRoot: ws }).settings;
  assert.equal(again.permissions.allow.filter((r) => r === 'Shell(git status)').length, 1);
  delete process.env.PATCHCODE_HOME;
});

test('permissions: rules and modes', () => {
  assert.deepEqual(permissions.parseRule('Shell(npm test *)'), { tool: 'Shell', pattern: 'npm test *' });
  assert.deepEqual(permissions.parseRule('Read'), { tool: 'Read', pattern: null });
  assert.ok(permissions.ruleMatches('Shell(npm test *)', 'Shell', { command: 'npm test -- --watch' }));
  assert.ok(!permissions.ruleMatches('Shell(npm test *)', 'Shell', { command: 'npm run build' }));
  assert.ok(permissions.ruleMatches('Shell(git:*)', 'Shell', { command: 'git status' }));
  assert.ok(permissions.ruleMatches('Edit(src/**)', 'Edit', { path: 'src/a/b.ts' }));
  assert.ok(!permissions.ruleMatches('Edit(src/**)', 'Edit', { path: 'lib/b.ts' }));
  const rules = { allow: ['Shell(npm test*)'], deny: ['Write(secrets/*)'], ask: ['Edit(package.json)'] };
  assert.equal(permissions.decide({ mode: 'default', rules, tool: 'Read', args: { path: 'x' } }).decision, 'allow');
  assert.equal(permissions.decide({ mode: 'default', rules, tool: 'Edit', args: { path: 'x.py' } }).decision, 'ask');
  assert.equal(permissions.decide({ mode: 'acceptEdits', rules, tool: 'Edit', args: { path: 'x.py' } }).decision, 'allow');
  assert.equal(permissions.decide({ mode: 'acceptEdits', rules, tool: 'Edit', args: { path: 'package.json' } }).decision, 'ask');
  assert.equal(permissions.decide({ mode: 'bypassPermissions', rules, tool: 'Write', args: { path: 'secrets/k' } }).decision, 'deny');
  assert.equal(permissions.decide({ mode: 'plan', rules, tool: 'Shell', args: { command: 'npm test' } }).decision, 'deny');
  assert.equal(permissions.decide({ mode: 'default', rules, tool: 'Shell', args: { command: 'npm test' } }).decision, 'allow');
  assert.equal(permissions.decide({ mode: 'default', rules, tool: 'Shell', args: { command: 'ls' }, detail: { readOnly: true } }).decision, 'allow');
  assert.equal(permissions.decide({ mode: 'bypassPermissions', rules, tool: 'Shell', args: { command: 'rm -rf /' }, detail: { destructive: true } }).decision, 'deny');
});

test('permissions: gate asks, remembers always and refusals', async () => {
  const asked = [];
  let answer = 'deny';
  const gate = permissions.makeGate({ mode: 'default', rules: { allow: [], deny: [], ask: [] }, ask: async (q) => { asked.push(q); return answer; } });
  let v = await gate('Shell', { command: 'npm run build' }, { command: 'npm run build' });
  assert.equal(v.allowed, false);
  v = await gate('Shell', { command: 'npm run build' }, { command: 'npm run build' });
  assert.equal(v.allowed, false);
  assert.equal(asked.length, 1, 'a refusal is remembered for the run');
  answer = 'always';
  v = await gate('Shell', { command: 'npm run lint' }, { command: 'npm run lint' });
  assert.equal(v.decision, 'always');
  v = await gate('Shell', { command: 'npm run other' }, { command: 'npm run other' });
  assert.equal(v.allowed, true);
  assert.equal(asked.length, 2, 'standing grant covers the kind');
  v = await gate('Read', { path: 'a' }, {});
  assert.equal(v.allowed, true);
});

test('shell: split, classify, destructive', () => {
  assert.deepEqual(shell.splitCommand('git commit -m "hello world" --amend'), ['git', 'commit', '-m', 'hello world', '--amend']);
  assert.deepEqual(shell.splitCommand("echo 'a b' c"), ['echo', 'a b', 'c']);
  assert.equal(shell.classify('git status').readOnly, true);
  assert.equal(shell.classify('git push').readOnly, false);
  assert.equal(shell.classify('pip list').readOnly, true);
  assert.equal(shell.classify('pip install x').readOnly, false);
  assert.equal(shell.classify('python -c "print(1)"').readOnly, false);
  assert.equal(shell.classify('ls | grep x').readOnly, false);
  assert.equal(shell.classify('npm ls').readOnly, true);
  assert.equal(shell.classify('npm install').readOnly, false);
  assert.equal(shell.isDestructive('rm -rf /'), true);
  assert.equal(shell.isDestructive('rm -rf ./build'), false);
  assert.equal(shell.isDestructive('git push --force origin main'), true);
  assert.equal(shell.isDestructive('git reset --hard HEAD~1'), true);
  assert.equal(shell.isDestructive('format C:'), true);
  assert.equal(shell.isDestructive('npm test'), false);
});

test('shell: run a real command without a shell', async () => {
  const result = await shell.run(process.platform === 'win32' ? 'cmd /c echo hi' : 'echo hi', { cwd: os.tmpdir(), timeoutMs: 20000 });
  assert.equal(result.success, true);
  assert.match(result.stdout, /hi/);
  const missing = await shell.run('definitely-not-a-command-xyz', { cwd: os.tmpdir(), timeoutMs: 5000 });
  assert.equal(missing.success, false);
  assert.match(missing.error, /not found/i);
});

test('packages: detection, mapping, install commands', () => {
  assert.deepEqual(packages.missingModuleFrom("ModuleNotFoundError: No module named 'sklearn'"), { manager: 'pip', module: 'sklearn' });
  assert.equal(packages.missingModuleFrom("No module named 'json'"), null);
  assert.deepEqual(packages.missingModuleFrom("Error: Cannot find module 'lodash/fp'"), { manager: 'npm', module: 'lodash' });
  assert.equal(packages.missingModuleFrom("Cannot find module './local'"), null);
  assert.equal(packages.missingModuleFrom("Cannot find module 'fs'"), null);
  assert.deepEqual(packages.missingModuleFrom("Error in library(ggplot2) : there is no package called ‘ggplot2’"), { manager: 'r', module: 'ggplot2' });
  assert.equal(packages.packageFor('pip', 'sklearn'), 'scikit-learn');
  assert.equal(packages.packageFor('pip', 'matplotlib.pyplot'), 'matplotlib');
  assert.equal(packages.isInstallableName('requests>=2.0'), true);
  assert.equal(packages.isInstallableName('@types/node'), true);
  assert.equal(packages.isInstallableName('pip'), false);
  assert.equal(packages.isInstallableName('--upgrade x'), false);
  assert.equal(packages.isInstallableName('x; rm -rf /'), false);
  assert.deepEqual(packages.installCommand('npm', ['lodash']), ['npm', 'install', '--no-audit', '--no-fund', 'lodash']);
  assert.equal(packages.installCommand('brew', ['x']), null);
});

test('patch: assemble/split round trip across languages', () => {
  for (const id of ['python', 'javascript', 'html', 'lua', 'r']) {
    const lang = languages.byId(id);
    const cells = [{ id: 'a1', prompt: 'first thing', code: 'x = 1\ny = 2' }, { id: 'b2', prompt: 'second\nthing', code: 'z = x + y' }];
    const { source, mapping } = patch.assemble(cells, lang);
    const back = patch.split(source);
    assert.equal(back.cells.length, 2, id);
    assert.equal(back.cells[0].prompt, 'first thing', id);
    assert.equal(back.cells[1].prompt, 'second\nthing', id);
    assert.equal(back.cells[1].code, 'z = x + y', id);
    assert.equal(mapping[1].id, 'b2');
    const map = patch.mapSource(source);
    assert.equal(map[0].start, mapping[0].start, id);
    assert.equal(map[1].end, mapping[1].end, id);
    assert.equal(patch.locate(map, mapping[1].start).id, 'b2');
  }
});

test('patch: markers stripped, requests found, code extracted', () => {
  assert.equal(patch.stripMarkers('# ===== PATCH 1 :: abc =====\n# > prompt\n\nx = 1\n'), 'x = 1');
  const requests = patch.findRequests('import os\n# @patch: load the csv\n  // @patch return 400 on failure\n<!-- @patch add a footer -->\n# not a request');
  assert.deepEqual(requests.map((r) => [r.line, r.prompt]), [[1, 'load the csv'], [2, 'return 400 on failure'], [3, 'add a footer']]);
  assert.equal(patch.extractCode('Here:\n```python\nprint(1)\n```\nthanks'), 'print(1)');
  assert.equal(patch.extractCode('```r\nx <- 1\n```\n```python\nprint(2)\n```', 'python'), 'print(2)');
  assert.equal(patch.extractCode('no fence at all'), 'no fence at all');
});

test('patch: knowledge graph for python and typescript', () => {
  const py = patch.analyse('import pandas as pd\nfrom os import path\n\ndef load(p: str, n=3) -> "pd.DataFrame":\n    return pd.read_csv("data.csv")\n\nclass Thing(Base):\n    pass\n\ndf = load("x")\n', 'python');
  assert.deepEqual(py.imports, ['import pandas as pd', 'from os import path']);
  assert.equal(py.functions[0].name, 'load');
  assert.equal(py.functions[0].signature, '(p: str, n=3)');
  assert.equal(py.classes[0].name, 'Thing');
  assert.equal(py.variables[0].name, 'df');
  assert.deepEqual(py.files, ['data.csv']);
  const ts = patch.analyse("import { x } from './x';\nconst fs = require('fs');\nexport async function main(a: number): Promise<void> {}\nconst go = (n) => n;\nexport interface Foo {}\nclass Bar extends Baz {}\n", 'typescript');
  assert.equal(ts.imports.length, 2);
  assert.deepEqual(ts.functions.map((f) => f.name), ['main', 'go']);
  assert.deepEqual(ts.classes.map((c) => c.name), ['Foo', 'Bar']);
  assert.match(patch.graphPrompt(py), /functions:\n  - load\(p: str, n=3\)/);
});

test('textprotocol: parses tool blocks in three shapes', () => {
  let p = textprotocol.parse('I will read it.\n<tool name="Read">\n{"path": "a.py"}\n</tool>');
  assert.equal(p.content, 'I will read it.');
  assert.deepEqual(p.toolCalls[0].args, { path: 'a.py' });
  p = textprotocol.parse('```tool\n{"tool": "Grep", "args": {"pattern": "x"}}\n```');
  assert.equal(p.toolCalls[0].name, 'Grep');
  assert.deepEqual(p.toolCalls[0].args, { pattern: 'x' });
  p = textprotocol.parse('{"tool": "ListDir", "path": "."}');
  assert.equal(p.toolCalls[0].name, 'ListDir');
  assert.deepEqual(p.toolCalls[0].args, { path: '.' });
  p = textprotocol.parse('Just an answer.');
  assert.equal(p.toolCalls.length, 0);
  assert.match(textprotocol.instructions(tools.specs(['Read']).map((s) => s.function)), /Read: Read a text file/);
});

test('modelselect: auto picks the largest tool-capable context, deterministic tie-break', () => {
  const pick = modelselect.pickBestModel({
    models: ['a-chat', 'qwen3-coder', 'llama-3.1-8b', 'big-no-tools'],
    contexts: { 'a-chat': 32000, 'qwen3-coder': 128000, 'llama-3.1-8b': 128000, 'big-no-tools': 1000000 },
    capabilities: { 'a-chat': { nativeToolCalling: true }, 'qwen3-coder': { nativeToolCalling: true }, 'llama-3.1-8b': { nativeToolCalling: true }, 'big-no-tools': { nativeToolCalling: false } },
  });
  assert.equal(pick, 'qwen3-coder');
  assert.equal(modelselect.pickBestModel({ models: ['gpt-4o'], serviceAddress: 'https://api.openai.com/v1' }), 'gpt-4o');
  assert.equal(modelselect.pickBestModel({ models: ['x'], capabilities: { x: { nativeToolCalling: true } }, exclude: ['x'] }), '');
  assert.equal(modelselect.effectiveModel('auto', { models: ['m'], capabilities: { m: { nativeToolCalling: true } } }), 'm');
  assert.equal(modelselect.effectiveModel('explicit', null), 'explicit');
  assert.equal(modelselect.label('auto', { autoResolved: 'm' }), 'auto · m');
});

test('fs tools: read, write, edit, glob, grep, confinement', async () => {
  const ws = tmp();
  const ctx = { confine: true };
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src', 'a.py'), 'def f():\n    return 1\n\nprint(f())\n');
  const read = fsTools.readFile(ws, { path: 'src/a.py' }, ctx);
  assert.equal(read.totalLines, 5);
  assert.match(read.content, /^1\tdef f\(\):/);
  assert.throws(() => fsTools.readFile(ws, { path: '../outside.txt' }, ctx), /outside the workspace/);
  const write = await fsTools.writeFile(ws, { path: 'src/new/b.txt', content: 'hello' }, ctx);
  assert.equal(write.action, 'created');
  const edit = await fsTools.editFile(ws, { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' }, ctx);
  assert.equal(edit.replaced, 1);
  assert.match(fs.readFileSync(path.join(ws, 'src', 'a.py'), 'utf8'), /return 2/);
  const dup = await fsTools.editFile(ws, { path: 'src/a.py', old_string: '\n', new_string: '\r\n' }, ctx);
  assert.match(dup.error, /occurs \d+ times/);
  const nf = await fsTools.editFile(ws, { path: 'src/a.py', old_string: 'nope', new_string: 'x' }, ctx);
  assert.match(nf.error, /not found/);
  fs.writeFileSync(path.join(ws, 'crlf.txt'), 'a\r\nb\r\nc\r\n');
  const crlf = await fsTools.editFile(ws, { path: 'crlf.txt', old_string: 'a\nb', new_string: 'A\nB' }, ctx);
  assert.equal(crlf.replaced, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'crlf.txt'), 'utf8'), 'A\r\nB\r\nc\r\n');
  const found = fsTools.glob(ws, { pattern: '**/*.py' }, ctx);
  assert.deepEqual(found.files, ['src/a.py']);
  const hits = fsTools.grep(ws, { pattern: 'return \\d', glob: '*.py' }, ctx);
  assert.equal(hits.matches, 1);
  const listing = fsTools.listDir(ws, { path: '.', depth: 3 }, ctx);
  assert.match(listing.listing, /src\//);
  // host writeFile is used when provided
  const calls = [];
  await fsTools.writeFile(ws, { path: 'h.txt', content: 'x' }, { confine: true, host: { writeFile: async (p, c) => calls.push([p, c]) } });
  assert.equal(calls.length, 1);
});

test('tools registry: specs, describe, command', () => {
  const specs = tools.specs();
  assert.ok(specs.find((s) => s.function.name === 'RunCode'));
  assert.equal(tools.specs(['Read']).length, 1);
  assert.equal(tools.describe('Shell', { command: 'npm test' }), 'Shell: npm test');
  assert.match(tools.commandOf('Install', { manager: 'pip', packages: ['numpy'] }), /pip install .*numpy/);
  assert.deepEqual(tools.get('Shell').classify({ command: 'git status' }), { readOnly: true, destructive: false, why: 'read-only inspection' });
});

test('hooks: matcher and blocking exit code', async () => {
  assert.equal(hooks.matches('Shell|Write', 'Write'), true);
  assert.equal(hooks.matches('Shell', 'Read'), false);
  assert.equal(hooks.matches('', 'Read'), true);
  const isWin = process.platform === 'win32';
  const s = { env: {}, hooks: { PreToolUse: [{ matcher: 'Shell', hooks: [{ type: 'command', command: isWin ? 'cmd /c exit 2' : 'sh -c "exit 2"' }] }] } };
  const r = await hooks.run('PreToolUse', { settings: s, cwd: os.tmpdir(), toolName: 'Shell', payload: {} });
  assert.equal(r.block, true);
  const none = await hooks.run('PreToolUse', { settings: s, cwd: os.tmpdir(), toolName: 'Read', payload: {} });
  assert.equal(none.block, false);
});

test('context: system prompt carries mode, rules, files and text protocol', () => {
  const prompt = context.buildSystemPrompt({
    cwd: 'C:/ws', settings: { ...settings.DEFAULTS, permissionMode: 'plan' }, contextFiles: [{ file: 'PATCHCODE.md', scope: 'project', text: 'Use pytest.' }],
    toolMode: 'text', tools: tools.specs(['Read']).map((s) => s.function), editor: { openFiles: [{ path: 'a.py', active: true, selection: { start: 1, end: 2, text: 'x' } }], diagnostics: 'a.py:1 error' },
  });
  assert.match(prompt, /PERMISSION MODE: plan/);
  assert.match(prompt, /Use pytest/);
  assert.match(prompt, /TOOL PROTOCOL/);
  assert.match(prompt, /SELECTED TEXT/);
  assert.match(prompt, /PROBLEMS VS CODE REPORTS/);
  assert.ok(context.estimateTokens([{ role: 'user', content: 'abcd'.repeat(10) }]) === 10);
});

test('agent: trims old tool results and runs a fake native loop end to end', async () => {
  const messages = [{ role: 'system', content: 's' }];
  for (let i = 0; i < 20; i++) messages.push({ role: 'tool', tool_call_id: String(i), content: 'x'.repeat(2000) });
  const trimmed = agent.trimConversation(messages, 3000);
  assert.ok(trimmed[1].content.length < 2000);
  assert.equal(trimmed[20].content.length, 2000);

  // Fake the model: first call asks to Read a file, second answers.
  const ws = tmp();
  fs.writeFileSync(path.join(ws, 'hello.txt'), 'hi there\n');
  let call = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    call++;
    const body = JSON.parse(init.body);
    assert.equal(body.tools.length > 0, true);
    const reply = call === 1
      ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: 'hello.txt' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
      : { choices: [{ message: { role: 'assistant', content: 'The file says: ' + JSON.parse(body.messages[body.messages.length - 1].content).content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const events = [];
    const result = await agent.runTurn({
      llmConfig: { serviceAddress: 'http://fake/v1', apiKey: 'k', model: 'm' },
      settings: { ...settings.DEFAULTS, permissions: { allow: [], deny: [], ask: [] }, streaming: false },
      cwd: ws, userText: 'What does hello.txt say?', toolMode: 'native',
      emit: (type, payload) => events.push([type, payload]),
    });
    assert.equal(result.ok, true);
    assert.match(result.text, /hi there/);
    assert.equal(result.usage.requests, 2);
    assert.ok(events.some(([t]) => t === 'tool_call'));
    assert.ok(events.some(([t, p]) => t === 'tool_result' && p.ok));
    assert.equal(result.messages.filter((m) => m.role === 'tool').length, 1);
  } finally {
    global.fetch = realFetch;
  }
});

test('agent: text-protocol loop and permission denial', async () => {
  const ws = tmp();
  let call = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    call++;
    const body = JSON.parse(init.body);
    assert.equal(body.tools, undefined);
    const reply = call === 1
      ? { choices: [{ message: { role: 'assistant', content: 'Running it.\n<tool name="Shell">\n{"command": "npm run build"}\n</tool>' } }] }
      : { choices: [{ message: { role: 'assistant', content: 'Denied: ' + body.messages[body.messages.length - 1].content.slice(0, 40) } }] };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await agent.runTurn({
      llmConfig: { serviceAddress: 'http://fake/v1', apiKey: 'k', model: 'm' },
      settings: { ...settings.DEFAULTS, permissions: { allow: [], deny: [], ask: [] }, streaming: false },
      cwd: ws, userText: 'build', toolMode: 'text', ask: async () => 'deny',
    });
    assert.equal(result.ok, true);
    assert.match(result.text, /Denied: <tool_result name="Shell">/);
  } finally {
    global.fetch = realFetch;
  }
});
