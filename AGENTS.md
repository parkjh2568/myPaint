# Project conventions

- Studio lives in `web-app/`: TypeScript pixel engine and DOM/CSS UI, Tauri/Rust desktop boundary. Windows/macOS packages; mobile is browser-only.
- Four-space indentation; lowerCamelCase values/functions, UpperCamelCase types/classes. Use configured formatters.
- Keep sequential work inside its owner; extract shared semantics/resource ownership rather than individual statements.
- Candidate/commit/cancel must preserve the document and Redo on failure or cancellation.
- No remote content, uploads, telemetry, updater, or shell execution in application runtime. Desktop loads only bundled local UI.
- Bound decoded pixels, dimensions, counts and byte lengths before allocation. Preserve alpha, project format, atomic native replacement and recovery.
- Test observable pixels, editing, persistence and failure behavior. Run Node/Python tests, formatting and build; native Rust checks run on supported hosts.
- Do not claim Windows/macOS or browser UI verification from Linux unit tests.

## Session handoff

- Start with `PROJECT_HANDOFF.md`, `docs/CURRENT_STATUS.md`, and `docs/PROJECT_HISTORY.md` before implementation. Reconcile their baseline with the checkout and remote head.
- Update those documents at handoff with the actual commit, decision, verification scope and remaining blockers. Historical passing checks are not proof for a newer build.
- Preserve original evidence and date labels. Never turn a blocked browser/native check into a pass or infer merge/deployment authorization from documentation.
