# Project conventions

- Studio lives in `web-app/`: TypeScript pixel engine and DOM/CSS UI, Tauri/Rust desktop boundary. Windows/macOS packages; mobile is browser-only.
- Four-space indentation; lowerCamelCase values/functions, UpperCamelCase types/classes. Use configured formatters.
- Keep sequential work inside its owner; extract shared semantics/resource ownership rather than individual statements.
- Candidate/commit/cancel must preserve the document and Redo on failure or cancellation.
- No remote content, uploads, telemetry, updater, or shell execution in application runtime. Desktop loads only bundled local UI.
- Bound decoded pixels, dimensions, counts and byte lengths before allocation. Preserve alpha, project format, atomic native replacement and recovery.
- Test observable pixels, editing, persistence and failure behavior. Run Node/Python tests, formatting and build; native Rust checks run on supported hosts.
- Do not claim Windows/macOS or browser UI verification from Linux unit tests.
