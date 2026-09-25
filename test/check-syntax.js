'use strict';
// Loads every module that does not need the `vscode` API, so a syntax error
// or a bad require surfaces before the extension host is involved.
const path = require('path');
const files = [
  'src/core/providers.js', 'src/core/llm.js', 'src/core/languages.js', 'src/core/settings.js',
  'src/core/permissions.js', 'src/core/patch.js', 'src/core/textprotocol.js', 'src/core/hooks.js',
  'src/core/modelselect.js', 'src/core/context.js', 'src/core/agent.js',
  'src/core/tools/shell.js', 'src/core/tools/packages.js', 'src/core/tools/fs.js',
  'src/core/tools/web.js', 'src/core/tools/runner.js', 'src/core/tools/index.js',
];
let bad = 0;
for (const file of files) {
  try {
    require(path.resolve(__dirname, '..', file));
    process.stdout.write(`OK   ${file}\n`);
  } catch (error) {
    bad++;
    process.stdout.write(`FAIL ${file}\n${String(error.stack).split('\n').slice(0, 6).join('\n')}\n`);
  }
}
// The vscode-facing modules are checked for syntax only (they require 'vscode').
const vm = require('vm');
const fs = require('fs');
for (const file of fs.existsSync(path.resolve(__dirname, '..', 'src/vscode')) ? fs.readdirSync(path.resolve(__dirname, '..', 'src/vscode')).map((f) => 'src/vscode/' + f) : []) {
  if (!file.endsWith('.js')) continue;
  try {
    new vm.Script(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), { filename: file });
    process.stdout.write(`OK   ${file} (syntax)\n`);
  } catch (error) {
    bad++;
    process.stdout.write(`FAIL ${file}: ${error.message}\n`);
  }
}
for (const file of ['src/extension.js', 'media/chat.js']) {
  const full = path.resolve(__dirname, '..', file);
  if (!fs.existsSync(full)) continue;
  try {
    new vm.Script(fs.readFileSync(full, 'utf8'), { filename: file });
    process.stdout.write(`OK   ${file} (syntax)\n`);
  } catch (error) {
    bad++;
    process.stdout.write(`FAIL ${file}: ${error.message}\n`);
  }
}
process.stdout.write(bad ? `\n${bad} file(s) failed\n` : '\nall modules load\n');
process.exit(bad ? 1 : 0);
