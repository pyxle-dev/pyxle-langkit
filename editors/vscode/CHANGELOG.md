# Changelog

## 0.3.0

- **Breakpoint debugging of `.pyxl` files.** New `pyxle` debug type. Press **F5** ("Debug Pyxle app") to run your dev server under the debugger — one clean session with a real Stop/Restart/Pause — and open your app. Breakpoints bind in the Python half (`@server` loaders, `@action` handlers). Debug the React half (JSX) with the separate "Debug Pyxle app (React browser)" configuration (`"server": false`), a standalone Chrome session against the same dev server. Both halves of a page are breakpointable in the one `.pyxl` file you already have open. Also supports `"request": "attach"` for an already-running `pyxle dev --inspect`.
- **The React session cleans up after itself.** When the "Debug Pyxle app (React browser)" session has to start its own `pyxle dev`, stopping the session offers to stop that server too — one click, a clean shutdown (a restart keeps it up, and it never touches a server Backend or a terminal you started).
- **"Pyxle: Open Studio" command** — opens the running dev server's Studio dashboard.
- Before launching, the debugger checks that VS Code's selected Python interpreter can actually run the dev server. If pyxle isn't installed there it points you to **Select Interpreter**; if the version is older than 0.8.0 it tells you to upgrade — instead of failing mid-launch with an opaque "No module named" error.
- Requires `pyxle-framework` 0.8.0+ and, for the Python side, the Python extension (`ms-python.python`) — the debugger offers to install it if missing.

## 0.2.2

- Language server resolution improvements and diagnostics fixes.

## 0.2.0

- Initial public release: syntax highlighting, diagnostics (pyflakes + Babel), completions, hover, go-to-definition, and formatting for `.pyxl` files.
