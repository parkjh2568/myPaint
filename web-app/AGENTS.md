# Qt-free application conventions

- TypeScript and DOM/CSS, Vite static output. Mobile runs in browsers only. Installation packages target Windows and macOS only; do not generate Android/iOS native projects.
- Qt-free engine owns pixels, revisions, history and resource limits. UI owns controls and gestures. Codecs and platform boundaries cannot mutate an unrelated document after an asynchronous operation.
- Keep sequential work inline in the owning function. Split shared algorithms or resource ownership, not individual statements. lowerCamelCase values/functions, UpperCamelCase types/classes; use the configured formatter.
- Desktop may embed only the bundled local UI using the selected desktop runtime. No remote pages, uploads, telemetry, updater or shell commands in application runtime. This scoped architecture replaces the legacy Qt/browser-embedding rule only inside web-app.
- Preserve candidate/commit/cancel, project format, bounded decoding, alpha, atomic native file replacement and recovery. Test observable pixels and failures.
