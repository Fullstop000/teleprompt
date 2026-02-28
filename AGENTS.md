# AGENTS

## Principles
1. Always add comments for key structs and functions.
2. Always handle errors.
3. Design architecture pragmatically, avoid over-design.
4. Read this `AGENTS.md` first before coding.

## Branch Workflow For New Features (Required)
- When the user explicitly asks to "implement a new feature" or "do refactor", execute this Git workflow first:
  1. Checkout `main`.
  2. Pull latest `origin/main`.
  3. Checkout a new branch with `codex/` prefix.
- Before switching branch or implementing feature work, if local changes are present (staged or unstaged), stop and ask user to confirm how to handle them.
- Do not carry unrelated residual changes into the new feature branch without user confirmation.

## Commit Message Format
- Follow conventional-style commits with scope when possible:
  - `feat(settings): ...`
  - `fix(command): ...`
  - `refactor(config): ...`
  - `ci: ...`

## Add New Target Site Spec (Best Practices)
- Add target using adapter/config abstraction, do not scatter `if/else` in multiple files.
  - In `background.js`, add target metadata in one config map: `id`, `name`, `baseUrl`, `promptParam`.
  - In `content.js`, add one adapter item for the target: `hostnames`, `composerSelectors`, `sendButtonSelectors`.
- Keep storage schema backward compatible.
  - When upgrading target settings (for example `targetSite` -> `targetSites[]`), add normalize logic and migration write-back.
- Support multi-target execution by configuration.
  - Resolve selected targets with dedupe and fallback default.
  - Dispatch send flow per target in a unified pipeline.
- Validate selectors with browser automation before finalizing.
  - Prefer `agent-browser`/Playwright probing over guesswork.
  - Record at least one verified composer selector and one verified send selector.
- Prefer robust selector strategy.
  - Put site-specific stable selectors first.
  - Keep generic fallback selectors after specific ones.
  - Allow non-`button` clickable send controls (for example clickable `div`).
- Keep manifest and permissions aligned.
  - Ensure new target domains are included in `content_scripts.matches`.
- Preserve UX consistency in options/settings page.
  - New target options must be configurable in UI.
  - Validate user input (at least one target selected).
- Minimum verification checklist before commit:
  - `node --check` passes for changed JS files.
  - Manual/automation check confirms open + fill + send behavior on each selected target.
