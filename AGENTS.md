# Project conventions

- C++20, Qt 6.4+, CMake; Core/Gui in paintcore, Widgets only in the desktop UI.
- Four-space indentation, UpperCamelCase types, lowerCamelCase functions and members.
- Keep sequential work inside its owning function. Extract helpers for shared semantics or resource ownership, not individual statements.
- Edit a candidate document and commit only after validation. Failed/cancelled edits and saves must preserve the current state.
- Never add network, remote resources, telemetry, updater, shell execution, or browser embedding.
- Use QSaveFile with direct-write fallback disabled. Validate dimensions, aggregate decoded pixels, counts and byte lengths before allocation.
- History has unique state IDs and a memory budget. Do not infer saved state from the current history index.
- Tests must exercise observable editing, persistence and failure behavior. Run CTest after core changes; use offscreen UI smoke tests after UI changes.
- Document actual verification and outstanding platform checks. Do not claim macOS/Windows validation from a Linux build.
