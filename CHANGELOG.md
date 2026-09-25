# Changelog

Patch Code is a personal project of Michael Bidollahkhani. Copyright (c) 2026 Michael Bidollahkhani, all rights reserved, MIT License.

## 0.1.0 - 2026-09-25

First release - the standalone form of Michael Bidollahkhani's patch mechanism, first applied in DAYA Studio's iTailor.

- Chat sidebar with streaming, collapsible tool steps and inline permission prompts (allow once / always / deny).
- Any OpenAI-compatible provider: GWDG/KISSKI, OpenAI, DeepSeek, Ollama, LM Studio, llama.cpp, custom. API key in VS Code secret storage.
- Model picker with `/models` listing, context windows, a one-time native tool-calling probe per model and an **Auto** choice (largest tool-capable context), as in DAYA Studio.
- Text tool protocol for models without native function calling.
- `@patch` comments → generated code in place under marker comments, with a per-language knowledge graph of the file; then run & repair.
- Run & Repair for the active file: missing-package healing with permission, model-driven repair of the complete file, repeat detection, fragment rejection.
- Tools: Read, Write, Edit, Glob, Grep, ListDir, Diagnostics, KnowledgeGraph, Shell (argv only, read-only classification, destructive hard block), RunCode, Install, WebSearch, WebFetch.
- Claude Code-style permission modes and `Tool(pattern)` rules; settings layers `~/.patchcode/settings.json`, `.patchcode/settings.json`, `.patchcode/settings.local.json`; `PATCHCODE.md` context files; PreToolUse/PostToolUse hooks.
- Code actions (Fix with Patch Code), context-menu commands, status bar, slash commands.
