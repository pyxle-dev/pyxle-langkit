# Changelog

## 0.3.1

- **Fix: the dev server is no longer interrupted seconds after it starts.** "Debug Pyxle app (React browser)" used to start `pyxle dev` by typing into a shell terminal. Anything may write to a shell terminal, and the Python extension activates your environment in every new one — through an API that sends `^C` first to interrupt whatever is running. The freshly started server was killed and the activation line (`pyenv shell …`, `source .venv/bin/activate`) typed in its place. The extension now owns the process directly, so nothing else can type into it; the panel still shows the server's output and Ctrl-C still stops it cleanly.
- **Fix: both debug configurations now run the same environment.** The React-browser flow ran whatever `pyxle` came first on your shell `PATH` while the Python flow ran VS Code's selected interpreter — routinely two different installs of two different versions. It now uses the selected interpreter for both, with the same pre-launch check.
- **A stale editable install is no longer mistaken for an old one.** The pre-launch check asks what the interpreter *can do* (can it run `python -m pyxle`) rather than what its package metadata claims, so an editable/dev install whose dist-info still says `0.7.5` while the code is current launches normally.
- **The interpreter errors are no longer a dead end.** Both the "pyxle not installed" and the "too old" message now lead with **Select Interpreter** — the usual cause is that the right pyxle lives in a *different* environment — and the launch continues automatically once you pick one. The message also reports the version it found (labelled as package metadata) and offers the matching install/upgrade/repair command.
- **New: the Python interpreter is visible and switchable from `.pyxl` files.** The Python extension only shows its interpreter indicator for `.py` files, so in a `.pyxl` editor you could neither see nor change the interpreter that debugging uses. A status-bar item now shows it (click to change), with a new **Pyxle: Select Python Interpreter** command.
- **A pre-launch check that can't answer no longer blocks the launch.** If the interpreter crashes, times out, or won't start, the debugger now goes ahead and lets the debugger report the real error instead of claiming pyxle isn't installed.
- **A dev server the extension started is stopped when VS Code shuts down normally**, rather than being left running and holding its port. It runs in its own process group so one signal takes the whole tree (Vite and the SSR workers) down with it; that also means a force-quit or an extension-host crash can still leave it running, in which case stop it from the terminal it prints to.
- Command palette entries no longer read "Pyxle: Pyxle: …".

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
