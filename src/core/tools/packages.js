'use strict';
// Patch Code - Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. MIT License.
// The patch mechanism is Michael Bidollahkhani's original design; DAYA Studio's iTailor was its first application.
/**
 * Missing-dependency detection and installation - DAYA's agent_tools
 * generalised to every package manager a Patch Code language may need.
 *
 * "No module named 'sklearn'" becomes `pip install scikit-learn`; "Cannot find
 * module 'lodash'" becomes `npm install lodash`. Import names are mapped to
 * the distribution that actually provides them, names that are not plain
 * packages are rejected, and stdlib modules are never "installed".
 */

const shell = require('./shell');

const IMPORT_TO_PIP = {
  sklearn: 'scikit-learn', cv2: 'opencv-python-headless', PIL: 'pillow', yaml: 'pyyaml',
  bs4: 'beautifulsoup4', dateutil: 'python-dateutil', sm: 'statsmodels', 'statsmodels.api': 'statsmodels',
  skimage: 'scikit-image', OpenSSL: 'pyopenssl', attr: 'attrs', serial: 'pyserial', Bio: 'biopython',
  mpl_toolkits: 'matplotlib', 'matplotlib.pyplot': 'matplotlib', 'google.protobuf': 'protobuf',
  pkg_resources: 'setuptools', dotenv: 'python-dotenv', jwt: 'pyjwt', git: 'gitpython', fitz: 'pymupdf',
  docx: 'python-docx', pptx: 'python-pptx', magic: 'python-magic', wx: 'wxpython', Crypto: 'pycryptodome',
  nacl: 'pynacl', sqlalchemy: 'sqlalchemy', psycopg2: 'psycopg2-binary', MySQLdb: 'mysqlclient',
  lxml: 'lxml', tf: 'tensorflow', torch: 'torch', gi: 'pygobject', ldap: 'python-ldap', zmq: 'pyzmq',
  websocket: 'websocket-client', markdown: 'markdown', xgboost: 'xgboost', lightgbm: 'lightgbm',
};

const PYTHON_STDLIB = new Set(('abc argparse array ast asyncio base64 bisect builtins bz2 calendar cmath collections colorsys ' +
  'concurrent configparser contextlib copy csv ctypes dataclasses datetime decimal difflib dis email enum errno faulthandler ' +
  'fnmatch fractions functools gc getpass gettext glob gzip hashlib heapq hmac html http imaplib importlib inspect io ' +
  'ipaddress itertools json keyword linecache locale logging lzma mailbox math mimetypes multiprocessing numbers operator ' +
  'os pathlib pickle platform plistlib pprint queue random re sched secrets select selectors shelve shlex shutil signal ' +
  'site smtplib socket sqlite3 ssl stat statistics string struct subprocess sys sysconfig tarfile tempfile textwrap threading ' +
  'time timeit tkinter token tokenize traceback types typing unicodedata unittest urllib uuid venv warnings wave weakref ' +
  'webbrowser xml xmlrpc zipfile zipimport zlib zoneinfo tomllib graphlib').split(/\s+/));

const NODE_BUILTINS = new Set(('assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns ' +
  'domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl ' +
  'stream string_decoder timers tls trace_events tty url util v8 vm wasi worker_threads zlib test').split(/\s+/));

const INSTALL_DENYLIST = new Set(['os', 'sys', 'subprocess', 'socket', 'pip', 'setuptools', 'wheel', 'paramiko', 'requests-oauthlib']);

const SAFE_PACKAGE_RE = /^[@A-Za-z0-9][A-Za-z0-9._\-/]*(\[[A-Za-z0-9,_-]+\])?((==|>=|<=|~=|!=|>|<|@)[A-Za-z0-9._*+\-^~]+)?$/;

const PATTERNS = [
  { manager: 'pip', re: /No module named ['"]([A-Za-z0-9_.]+)['"]/ },
  { manager: 'npm', re: /Cannot find (?:module|package) '((?:@[^/']+\/)?[^'/]+)(?:\/[^']*)?'/ },
  { manager: 'r', re: /there is no package called ['‘"]([A-Za-z0-9_.]+)['’"]/ },
  { manager: 'gem', re: /cannot load such file -- ([A-Za-z0-9_\-/]+)/ },
  { manager: 'go', re: /no required module provides package ([^\s:]+)/ },
  { manager: 'cargo', re: /unresolved import `([A-Za-z0-9_]+)`|use of undeclared crate or module `([A-Za-z0-9_]+)`/ },
];

/** {manager, module} or null. */
function missingModuleFrom(text) {
  const s = String(text || '');
  for (const { manager, re } of PATTERNS) {
    const match = re.exec(s);
    if (match) {
      const module = match[1] || match[2];
      if (manager === 'npm' && (NODE_BUILTINS.has(module) || module.startsWith('node:') || module.startsWith('.') || module.startsWith('/'))) return null;
      if (manager === 'pip' && PYTHON_STDLIB.has(module.split('.')[0])) return null;
      return { manager, module };
    }
  }
  return null;
}

/** The distribution to install for an import name. */
function packageFor(manager, importName) {
  const name = String(importName || '').trim();
  if (manager === 'pip') {
    if (IMPORT_TO_PIP[name]) return IMPORT_TO_PIP[name];
    const root = name.split('.')[0];
    return IMPORT_TO_PIP[root] || root;
  }
  if (manager === 'npm') return name;
  if (manager === 'gem') return name.split('/')[0];
  if (manager === 'go') return name;
  return name;
}

function isInstallableName(name) {
  const candidate = String(name || '').trim();
  if (!candidate || candidate.length > 160) return false;
  const bare = candidate.split('[')[0].split(/==|>=|<=|~=|!=|>|<|@(?!$)/)[0].trim().toLowerCase();
  if (INSTALL_DENYLIST.has(bare)) return false;
  if (candidate.startsWith('-')) return false;
  return SAFE_PACKAGE_RE.test(candidate);
}

/** The argv that installs `packages` with `manager`, or null for an unknown manager. */
function installCommand(manager, packages, { python, cwd } = {}) {
  const names = (packages || []).map((p) => String(p).trim()).filter(isInstallableName);
  if (!names.length) return null;
  switch (manager) {
    case 'pip': return [python || (process.platform === 'win32' ? 'python' : 'python3'), '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...names];
    case 'npm': return ['npm', 'install', '--no-audit', '--no-fund', ...names];
    case 'npm-dev': return ['npm', 'install', '--save-dev', '--no-audit', '--no-fund', ...names];
    case 'pnpm': return ['pnpm', 'add', ...names];
    case 'yarn': return ['yarn', 'add', ...names];
    case 'r': return ['Rscript', '-e', `options(repos = c(CRAN = 'https://cloud.r-project.org')); install.packages(c(${names.map((n) => `'${n}'`).join(', ')}), quiet = TRUE); missing <- setdiff(c(${names.map((n) => `'${n}'`).join(', ')}), rownames(installed.packages())); if (length(missing)) { cat('MISSING:', paste(missing, collapse=', '), '\\n'); quit(status = 1) }`];
    case 'gem': return ['gem', 'install', ...names];
    case 'go': return ['go', 'get', ...names];
    case 'cargo': return ['cargo', 'add', ...names];
    case 'dotnet': return ['dotnet', 'add', 'package', ...names];
    case 'composer': return ['composer', 'require', ...names];
    default: return null;
  }
}

/** Run the install. Resolves to shell.run's result plus {installed, rejected}. */
async function install(manager, packages, { cwd, python, timeoutMs = 900000, signal, onOutput, env } = {}) {
  const names = (packages || []).map((p) => String(p).trim()).filter(Boolean);
  const rejected = names.filter((n) => !isInstallableName(n));
  const accepted = names.filter(isInstallableName);
  if (!accepted.length) return { success: false, installed: [], rejected, stdout: '', stderr: '', error: 'No installable package name was given.' };
  const argv = installCommand(manager, accepted, { python, cwd });
  if (!argv) return { success: false, installed: [], rejected, stdout: '', stderr: '', error: `Unknown package manager '${manager}'.` };
  const result = await shell.runArgv(argv, { cwd, timeoutMs, signal, onOutput, env });
  return { ...result, installed: result.success ? accepted : [], rejected, error: result.success ? null : (result.error || `${manager} could not install the package(s).`) };
}

module.exports = { missingModuleFrom, packageFor, isInstallableName, installCommand, install, IMPORT_TO_PIP, PYTHON_STDLIB };
