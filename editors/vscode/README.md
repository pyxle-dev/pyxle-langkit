# Pyxle Language Tools

Language support **and full-stack debugging** for [Pyxle](https://pyxle.dev) `.pyxl` files — the format that colocates Python server logic and React/JSX in one file.

## Features

- **Syntax highlighting** for the Python and JSX halves of a `.pyxl` file, with embedded-language support so each half gets the editor's native behavior.
- **Diagnostics** — pyflakes for the Python section, Babel-backed analysis for JSX, mapped to the right line in your `.pyxl`.
- **Completions, hover, and go-to-definition** across the Python↔JSX boundary, powered by jedi.
- **Formatting** — ruff for Python, Prettier for JSX.
- **Breakpoint debugging of `.pyxl` files** — set a breakpoint on a line inside a `@server` loader *and* on a line inside the JSX below it, and both bind. See below.

## Debugging (`.pyxl` breakpoints)

Press **F5** and pick **Debug Pyxle app**. VS Code runs your dev server under the debugger — one clean session with a real **Stop** button (and Restart, and Pause) that tears the whole server down — and opens your app in the browser.

- A breakpoint in a `@server` loader or `@action` pauses the request in VS Code, with the `.pyxl` frame in the call stack.
- To debug the **React** half, run **Debug Pyxle app (React browser)** (`"server": false`) — a standalone Chrome session against the running dev server. A breakpoint in the JSX component pauses there, in the same `.pyxl` file.
- Kept as two sessions on purpose: each has its own unambiguous Stop / Restart / Pause.

Or commit the launch configurations:

```json
{
  "version": "0.2.0",
  "configurations": [
    { "type": "pyxle", "request": "launch", "name": "Debug Pyxle app" },
    { "type": "pyxle", "request": "launch", "name": "Debug Pyxle app (React browser)", "server": false }
  ]
}
```

To attach to an already-running `pyxle dev --inspect` instead of launching, use `"request": "attach"`.

The command **"Pyxle: Open Studio"** opens the running dev server's [Studio dashboard](https://pyxle.dev/docs/guides/studio) — routes, an interactive loader/action tester, a live request feed, and more.

## Requirements

- **[pyxle-framework](https://pypi.org/project/pyxle-framework/) 0.8.0 or newer** in your project's Python environment (the launch model runs `python -m pyxle dev`, and `.pyxl` debugging relies on the framework's line mapping shipped in 0.8.0). Point VS Code at that environment with **Python: Select Interpreter** — the debugger checks it has pyxle before launching and guides you if not.
- The **[Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python)** (`ms-python.python`) for the Python side of debugging. The debugger offers to install it if it's missing, and still debugs the React side without it.
- The language server: `pip install pyxle-langkit` (bundled as a default dependency of `pyxle-framework`, so a normal Pyxle project already has it).

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `pyxle.langserver.command` | `pyxle-langserver` | Command to launch the language server. |
| `pyxle.langserver.args` | `["--stdio"]` | Arguments forwarded to the language server. |

## Learn more

- [Debugging `.pyxl` files](https://pyxle.dev/docs/guides/debugging)
- [Pyxle Studio](https://pyxle.dev/docs/guides/studio)
- [Pyxle documentation](https://pyxle.dev/docs)

## License

MIT
