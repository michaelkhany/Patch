# Patch Code

**An autonomous coding agent for Visual Studio Code, built on Michael Bidollahkhani's patch mechanism, that works with any OpenAI-compatible model you bring.**

A personal project of **Michael Bidollahkhani**. Copyright (c) 2026 Michael Bidollahkhani, all rights reserved, released under the [MIT License](LICENSE).

The idea behind Patch Code is Michael's: a *patch* is a natural-language instruction that becomes code which is written, **run against the real environment**, read back from its actual error output, and repaired until it works - never handed over unverified. The mechanism was first applied in the *iTailor* engine of [DAYA Studio](../daya-pro-main), where it drives data-analysis Patchbooks; Patch Code is its standalone form for a code editor. Around that loop sit the things a coding agent in an editor needs - file tools, a shell, web search, diagnostics from VS Code - governed by Claude Code-style permissions and settings files.

It is independent of DAYA Studio: nothing here imports from it or needs it installed.

---

## Contents

- [Authorship and license](#authorship-and-license)
- [What it does](#what-it-does)
- [Install](#install)
- [Set up a model](#set-up-a-model)
- [Using the chat](#using-the-chat)
- [Patches in the editor](#patches-in-the-editor)
- [Run & repair](#run--repair)
- [Permissions](#permissions)
- [Settings](#settings)
- [PATCHCODE.md](#patchcodemd)
- [Hooks](#hooks)
- [Languages](#languages)
- [Tools the agent has](#tools-the-agent-has)
- [Models without native tool calling](#models-without-native-tool-calling)
- [How it relates to DAYA Studio](#how-it-relates-to-daya-studio)
- [Development](#development)
- [Privacy and safety](#privacy-and-safety)

---

## Authorship and license

- **Author and rights holder:** Michael Bidollahkhani. Patch Code is his personal project and the patch mechanism is his original design.
- **First application:** DAYA Studio's iTailor engine (Patchbooks, Program mode). The DAYA implementation is in Python; Patch Code is an independent JavaScript implementation of the same design. The [table below](#how-it-relates-to-daya-studio) maps the two.
- **License:** MIT, with all rights reserved to Michael Bidollahkhani. Every source file carries the copyright header; see [LICENSE](LICENSE).

## What it does

| Surface | What happens |
| --- | --- |
| **Chat sidebar** | Ask for anything: *explain this*, *add retries to the upload client and test it*, *why does `npm test` fail?*, *write a script that merges these CSVs and run it*. The agent reads, edits, runs and repairs, streaming every step; edits and commands ask you first. |
| **`@patch` comments** | Write `# @patch validate the payload and return 400 on failure` in any file, run **Apply @patch Requests** (Ctrl+Alt+Enter). The instruction becomes working code in place, under a marker comment, and the file is run and repaired. |
| **Run & Repair** | Run the active file. On failure the agent classifies the error (missing package / system / script / logic), installs, edits or both, and runs again until it exits clean. |
| **Lightbulb** | *Fix with Patch Code* on any diagnostic; *Explain* / *Improve* / *Ask about* a selection from the context menu. |
| **Status bar** | The model in use (or *auto · model*) and the permission mode. Click to change the model. |

## Install

Patch Code has **no build step and no runtime dependencies** - plain JavaScript on the extension host's Node.

**From source (development):**

1. Open the `patch-code` folder in VS Code.
2. Press **F5** (the included `.vscode/launch.json` starts an Extension Development Host).

**As a `.vsix`:**

```bash
cd patch-code
npm install          # devDependencies only: vsce + type stubs
npm run package      # -> patch-code-0.1.0.vsix
code --install-extension patch-code-0.1.0.vsix
```

Requirements: VS Code 1.90 or newer. Interpreters for the languages you want executed (Python, Node, R, …) must be on `PATH`.

## Set up a model

Patch Code speaks the OpenAI chat-completions protocol, so a provider is only a base URL plus a key. The presets mirror DAYA Studio's:

| Provider | Base URL | Note |
| --- | --- | --- |
| **GWDG · KISSKI / AcademicCloud** (default) | `https://chat-ai.academiccloud.de/v1` | Open-weight models: Qwen, Llama, Mistral, gpt-oss, DeepSeek, GLM… |
| **OpenAI** | `https://api.openai.com/v1` | Non-chat models (embeddings, audio, images) are filtered out |
| **DeepSeek** | `https://api.deepseek.com/v1` | deepseek-chat, deepseek-reasoner |
| **Ollama** | `http://127.0.0.1:11434/v1` | Local. Any non-empty key |
| **LM Studio** | `http://127.0.0.1:1234/v1` | Local. Any non-empty key |
| **llama.cpp** | `http://127.0.0.1:8089/v1` | `llama-server --jinja` - the same engine DAYA runs offline |
| **Custom** | anything | vLLM, a gateway, another campus service |

Run **Patch Code: Configure Provider & API Key** (or click *provider* in the chat header):

1. pick a provider, confirm the base URL,
2. paste the API key - it is stored in **VS Code's secret storage**, never in a settings file (alternatively set `PATCHCODE_API_KEY` / `OPENAI_API_KEY`, or name a variable in `patchCode.apiKeyEnv`),
3. the model list is loaded and **each unknown model is probed once** for native tool calling, exactly as DAYA does; verdicts are cached per endpoint.

Then **Patch Code: Select Model**:

- **Auto** - the tool-capable model with the largest context window (ties broken towards coding models). This is DAYA's *Auto - best native-tool model*. The status bar shows what it resolved to.
- or any model; the list shows `128k ctx · native tools` / `no native tools (text protocol)` per model.

`/model`, `/config` and `/mode` in the chat do the same.

## Using the chat

Open the **Patch Code** view in the activity bar (Ctrl+Alt+P). Type a request; the agent streams its reasoning, shows every tool call as a collapsible step (arguments, output, files), and pauses with a permission card when it needs something consequential.

Slash commands:

| Command | Effect |
| --- | --- |
| `/help` | What Patch Code can do |
| `/model` | Choose the model |
| `/mode default\|acceptEdits\|plan\|bypassPermissions` | Permission mode |
| `/config` | Provider, address, key |
| `/permissions` | Open `.patchcode/settings.json` |
| `/init` | Have the agent analyse the workspace and write `PATCHCODE.md` |
| `/clear` | New conversation |
| `/compact` | Summarise the conversation to free context |
| `/cost` | Tokens this session |
| `/patch`, `/run`, `/fix`, `/diagnostics` | Apply @patch requests / run & repair / fix problems in the active file / show problems |

The active file, the selection and the Problems panel are part of the model's context (`patchCode.includeOpenEditors`, `patchCode.includeDiagnostics`). File references in answers (`src/app.py:42`) are clickable.

## Patches in the editor

This is Michael's Patchbook idea (first shipped in DAYA Studio) applied to a source file. A **patch** is one natural-language instruction that becomes one block of code:

```python
import pandas as pd

df = pd.read_csv("sales.csv")

# @patch add a `margin` column = (price - cost) / price and print the 5 worst products
```

**Apply @patch Requests** (Ctrl+Alt+Enter, or the wand in the editor title) turns that into:

```python
# ===== PATCH 1 :: 3f9a2c1d7e =====
# > add a `margin` column = (price - cost) / price and print the 5 worst products
df["margin"] = (df["price"] - df["cost"]) / df["price"]
print(df.nsmallest(5, "margin")[["product", "margin"]])
```

What the model is told before it writes the patch (open **Show Knowledge Graph of This File** to see it):

- the **knowledge graph** of the file - imports and aliases, functions with signatures, classes, top-level variables, files it touches - so it calls `load(path)` with the right arguments and reuses `df` instead of re-reading the CSV (DAYA's `patch_symbols`, made language-aware with per-language rules);
- the code before and after the request (read-only context);
- the rule to emit only the new code, in the file's style.

The marker comments are the point: they survive a round trip through the model, so a later whole-file repair still maps back onto individual patches (`patch.split` / `patch.mapSource` in `src/core/patch.js`, DAYA's `patch_program`). They work in every language - `#`, `//`, `--`, `<!-- -->`, `/* */`.

Several `@patch` lines in one file are applied top to bottom, each seeing the previous ones. If the file's language can be executed, the file is then run and repaired.

## Run & repair

**Patch Code: Run & Repair This File** (or after applying patches) runs the file with the language's interpreter and, on a non-zero exit, does what DAYA's Program-mode agent does:

| Failure | What happens |
| --- | --- |
| **Missing package** | Detected deterministically from the output (`No module named 'sklearn'`, `Cannot find module 'lodash'`, `there is no package called 'ggplot2'`), mapped to the real distribution (`sklearn` → `scikit-learn`, `cv2` → `opencv-python-headless`), **you are asked**, it is installed, the same code re-runs. Decline and the agent solves it in code and never suggests that package again. |
| **System requirement** | The model proposes a command; you are asked; destructive commands are refused even if approved. |
| **Scripting error** | The model receives the numbered source and the real stderr and returns the complete corrected file (markers intact), applied as an undoable edit. |
| **Logic** | Tell the chat what came out wrong. |

It stops when the run exits clean, when the same failure comes back unchanged twice (a diagnosis that did not move is not worth a third try), or after `patchCode.maxIterations` attempts (default 6). Previous attempts are shown to the model so it does not repeat them. A reply that is a fragment (much shorter than the file) is rejected rather than applied.

## Permissions

The same model as Claude Code, with DAYA's prompt in the UI.

**Modes** (`patchCode.permissionMode`, `/mode`, or the shield in the chat header):

| Mode | Read tools | Edit / Write | Shell, RunCode, Install |
| --- | --- | --- | --- |
| `default` | run | ask | ask (read-only inspections such as `git status`, `pip list`, `ls` run) |
| `acceptEdits` | run | run | ask |
| `plan` | run | refused | refused |
| `bypassPermissions` | run | run | run |

**Rules** (`permissions.allow` / `deny` / `ask` in any settings layer) refine that. Syntax `Tool` or `Tool(pattern)`, glob or `prefix:*`:

```json
{
  "permissions": {
    "allow": ["Shell(npm test *)", "Shell(git:*)", "Edit(src/**)", "WebSearch"],
    "deny":  ["Write(.env*)", "Shell(git push*)", "Edit(migrations/**)"],
    "ask":   ["Edit(package.json)"]
  }
}
```

Deny wins over allow; `ask` wins over mode. Tools: `Read Glob Grep ListDir Diagnostics KnowledgeGraph WebSearch WebFetch Edit Write Patch Shell RunCode Install`.

**The prompt** shows the exact command and offers *Allow once*, *Always allow <kind>* (for this session only) and *Don't allow*. No answer within `patchCode.permissionTimeoutSeconds` is a denial, and a refusal is remembered for the rest of the run so a retry loop cannot nag. A short list of destructive commands (`rm -rf /`, `git push --force`, `git reset --hard`, `format C:`, `mkfs`, `shutdown`, …) is refused outright. Commands never go through a shell: the line is split into argv, so pipes, `&&` and redirects cannot be smuggled in.

In an **untrusted workspace** Patch Code runs in plan mode.

## Settings

Two places, merged the way Claude Code merges them.

**VS Code settings** (`patchCode.*`, Settings UI or `settings.json`): provider, service address, model, permission mode, rule lists, timeouts, `maxSteps`, `maxIterations`, `maxTokens`, `temperature`, `contextTokens`, `toolCalling` (`auto | native | text`), `streaming`, `contextFiles`, `includeOpenEditors`, `includeDiagnostics`, `webSearch`, `sandbox.confineToWorkspace`, `sandbox.allowNetwork`, `autoModelExclude`, `env`, `language`.

**Settings files** (JSON with comments allowed; schema in `schemas/settings.schema.json`):

| File | Scope | Typical use |
| --- | --- | --- |
| `~/.patchcode/settings.json` | you, every project | your default mode and rules |
| `<workspace>/.patchcode/settings.json` | the project, committed | the team's allow/deny rules, hooks, `env` |
| `<workspace>/.patchcode/settings.local.json` | the project, git-ignored | your local overrides, a different model for this repo |

Precedence: defaults → user → project → local → VS Code settings. Scalars are overridden; `permissions.*`, `env`, `hooks` and `autoModelExclude` are **merged**. The key itself never belongs in a file: name an environment variable in `apiKeyEnv` instead. **Patch Code: Open .patchcode/settings.json** creates a starter file.

## PATCHCODE.md

The equivalent of `CLAUDE.md`. Every file named in `patchCode.contextFiles` (default `PATCHCODE.md`) is read from `~/.patchcode/`, from every parent folder of the workspace, from the workspace root and from `.patchcode/`, and placed in the system prompt of every conversation. Put in it what you would tell a new colleague: what the project is, how to build, test and lint, what not to touch. `/init` (or **Patch Code: Initialize PATCHCODE.md**) has the agent inspect the workspace and draft it.

## Hooks

Claude Code-style hooks in any settings layer:

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "Shell|Install", "hooks": [{ "type": "command", "command": "python scripts/policy.py" }] }],
    "PostToolUse": [{ "matcher": "Edit|Write",    "hooks": [{ "type": "command", "command": "npm run lint --silent" }] }]
  }
}
```

The command gets a JSON payload on stdin (`{event, tool, cwd, args, result}`). A `PreToolUse` hook that exits with **2** blocks the call and its stderr is shown to the model; any other exit code is reported but does not block.

## Languages

Reading, editing, explaining and refactoring work for **every language VS Code can open** - the file tools are language-agnostic, as in Claude Code. What the language registry (`src/core/languages.js`) adds is what a *patch* needs: the fence tag, the comment syntax for markers, and how to run the file so it can be repaired against real output.

| Executed by Run & Repair / RunCode | Edit-only (markers still work) |
| --- | --- |
| Python, JavaScript, TypeScript (Node ≥ 23 or `tsx`), R, Bash, PowerShell, Go, Rust (`cargo script`), Java (single-file launch), Kotlin script, C and C++ (gcc/g++), C#, Ruby, PHP, Perl, Lua, Swift, Dart, Julia, Scala (`scala-cli`), Elixir, Haskell | SQL, HTML, CSS/SCSS, JSON, YAML, TOML, Markdown, XML/SVG, Dockerfile, Makefile, plain text |

Missing-dependency healing knows pip, npm/pnpm/yarn, R (CRAN), gem, go, cargo, dotnet and composer.

## Tools the agent has

| Tool | Does | Class |
| --- | --- | --- |
| `Read` | numbered lines of a file (unsaved editor content is used when the file is open) | read |
| `Glob`, `Grep`, `ListDir` | find files, search contents, tree view (ignores `node_modules`, `.git`, build output) | read |
| `Diagnostics` | the Problems panel, optionally for one file | read |
| `KnowledgeGraph` | what a file defines | read |
| `WebSearch`, `WebFetch` | DuckDuckGo (no account) and page fetch | read |
| `Edit` | exact string replacement; must match once (CRLF-aware) | edit |
| `Write` | create or overwrite a file (through `WorkspaceEdit`, so Undo works and open editors update) | edit |
| `Shell` | one command, argv only, in the workspace | shell |
| `RunCode` | write a complete script, run it, get stdout/stderr/exit + produced files; heals a missing package | run |
| `Install` | pip / npm / R / … | install |

## Models without native tool calling

DAYA probes every model with one `tool_choice: required` request and remembers the verdict. Patch Code does the same, and then goes one step further: a model that **cannot** emit `tool_calls` still gets every tool through a **text protocol** - it is told to answer with one `<tool name="Read">{"path": …}</tool>` block, which is parsed into the same call the native path produces. `patchCode.toolCalling` forces either mode. Small local models work; large context and native tools work better.

## How it relates to DAYA Studio

Both are implementations of the same design by Michael Bidollahkhani. DAYA Studio applied it first, to data analysis; Patch Code applies it to a code editor. The table maps the two implementations so a reader of one can find the other.

| DAYA Studio (Python, Flask) | Patch Code (JavaScript, VS Code) |
| --- | --- |
| `backend/itailor.py` - write one script, run it, retry on error | `src/core/tools/runner.js` (`RunCode`) and `src/vscode/patchEngine.js` (Run & Repair) |
| `backend/patch_agent.py` - Program-mode generation and repair loop, `FIX_SYSTEM`, repeat detection, fragment rejection | `src/vscode/patchEngine.js` |
| `backend/patch_program.py` - marker comments, assemble/split/locate | `src/core/patch.js` |
| `backend/patch_symbols.py` - knowledge graph via `ast` | `src/core/patch.js` `analyse()` - regex rules per language |
| `backend/agent_tools.py` - missing-module mapping, read-only shell classification, DuckDuckGo | `src/core/tools/packages.js`, `shell.js`, `web.js` |
| `backend/permissions.py` - allow / always / deny gate | `src/core/permissions.js` + Claude Code rules and modes |
| `backend/providers.py`, `models.py`, tool-capability probe and cache | `src/core/providers.js`, `llm.js`, `src/vscode/config.js` |
| Settings dialog: provider presets, *Test & load models*, *Auto - best native-tool model* | `src/vscode/pickers.js`, `src/core/modelselect.js` |
| Chat panel streaming think / tool / observe events | `src/vscode/chatView.js`, `media/chat.js` |

No code is shared at runtime, so the two projects can evolve independently.

## Development

```
patch-code/
  package.json            manifest: commands, views, menus, keybindings, configuration
  src/extension.js        activation
  src/core/               pure Node, no vscode import, unit-tested
    llm.js                OpenAI-compatible client: models, chat (streaming, tools), probe
    agent.js              the tool loop (native or text), retries, context trimming
    tools/                Read/Write/Edit/Glob/Grep/ListDir, Shell, RunCode, Install, Web
    patch.js              markers, knowledge graph, code extraction
    permissions.js        modes, rules, the ask gate
    settings.js           layered settings + PATCHCODE.md loading
    languages.js          language registry
    modelselect.js        Auto model
    hooks.js, context.js, textprotocol.js, providers.js
  src/vscode/             the VS Code layer
  media/                  webview (chat.js, chat.css), icons
  schemas/                JSON schema for settings files
  test/                   node:test suites
```

Tests use Node's built-in runner:

```bash
node test/check-syntax.js       # every module loads
node --test test/               # unit tests (fake model, temp workspaces)
```

No Node on the machine but VS Code installed? Its Electron runs as Node:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" --test test/
```

## Privacy and safety

- The API key lives in VS Code secret storage (or an environment variable) and is sent only to the service address you configured.
- What goes to the model: your request, the files the agent reads, command output, the open editors/diagnostics summary and `PATCHCODE.md`. Nothing is sent anywhere else.
- Generated scripts run **on your machine**, as you, with the workspace as working directory - the same local posture as DAYA's iTailor and Extensions panel, not a hardened sandbox. The workspace confinement (`sandbox.confineToWorkspace`) applies to the file tools; a script you approved can do what you can do. Use plan mode or a throwaway workspace when in doubt.
- Web search goes to DuckDuckGo without an account; disable it with `patchCode.webSearch`.

## License

Copyright (c) 2026 Michael Bidollahkhani. All rights reserved. Released under the MIT License - see [LICENSE](LICENSE).
