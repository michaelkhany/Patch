# PATCHCODE.md

Instructions for Patch Code (and any coding agent) working on this repository.

## Project

- Purpose: a VS Code extension - an autonomous coding agent built on Michael Bidollahkhani's patch mechanism (first applied in DAYA Studio's iTailor), for any OpenAI-compatible model.
- Author and rights holder: Michael Bidollahkhani (personal project). Copyright (c) 2026, all rights reserved, MIT License. Keep the copyright header at the top of every new source file.
- Language: plain JavaScript (CommonJS), no build step, no runtime dependencies.
- Entry point: `src/extension.js`. Pure logic lives in `src/core/` and must not `require('vscode')`; the editor layer is `src/vscode/`; the webview is `media/`.

## Build & test

- Install (dev only): `npm install`
- Test: `node test/check-syntax.js && node --test test/`
  - Without Node: `ELECTRON_RUN_AS_NODE=1 <path to Code.exe> --test test/`
- Package: `npm run package` (vsce)
- Run: press F5 in VS Code.

## Conventions

- Keep `src/core/*` free of VS Code imports so it stays unit-testable; add a test in `test/core.test.js` for every core change.
- Tools return result objects and never throw on expected failures (`{error: ...}`); the agent turns them into model feedback.
- Every consequential action (edit, command, install, run) goes through the permission gate. Never add a path around it.
- New commands must be added to `package.json` `contributes.commands` **and** registered in `src/vscode/commands.js` (a test enforces the pairing).
- Prefer small, exact `Edit`s; match the existing style (2-space indent, single quotes, semicolons).
