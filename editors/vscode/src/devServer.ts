/**
 * The "Pyxle Dev" terminal — an extension-owned dev server.
 *
 * The React-browser flow needs a running `pyxle dev` but no Python debugger.
 * It used to get one by opening a shell terminal and typing `pyxle dev` into
 * it. That is unsafe: a shell terminal belongs to whoever wants to write to it,
 * and the Python extension auto-activates the selected environment in every new
 * shell terminal. Modern activation goes through
 * `TerminalShellIntegration.executeCommand()`, which is *documented* to send
 * `^C` first to interrupt whatever is running — so the freshly started dev
 * server was killed moments after coming up, then the activation line
 * (`pyenv shell 3.14.4`, `source .venv/bin/activate`, ...) was typed in its
 * place.
 *
 * So we own the process instead. `createTerminal({ pty })` spawns no shell at
 * all: `terminal.shellIntegration` is never populated, so `executeCommand` —
 * the only thing that sends `^C` — cannot be called on it, and a foreign
 * `Terminal.sendText()` is delivered to our `handleInput`, where we drop it.
 * The injection becomes inert rather than merely unlikely.
 *
 * Owning the process also buys precise shutdown: SIGINT to the process *group*
 * is what a real Ctrl-C does, and it is what tears the dev server's children
 * (Vite, esbuild, the SSR workers) down cleanly.
 */

import * as vscode from "vscode";
import * as cp from "child_process";

/** The Ctrl-C (ETX) byte — what a real keystroke sends. */
const ETX = "";

/** Grace between SIGINT and the SIGKILL that guarantees the process is gone. */
const SHUTDOWN_GRACE_MS = 2500;

/** How the dev server should be started. */
export interface DevServerSpec {
    /** Executable to run — a resolved interpreter, or `pyxle` as a fallback. */
    command: string;
    /** Arguments, e.g. `["-m", "pyxle", "dev"]`. */
    args: string[];
    /** Project root; the server is started here. */
    cwd: string;
}

/**
 * A `pyxle dev` process rendered into a VS Code terminal.
 *
 * Implements {@link vscode.Pseudoterminal}: VS Code calls `open`/`close`, and
 * everything the child writes is echoed through `onDidWrite`.
 */
export class DevServerPty implements vscode.Pseudoterminal {
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    private readonly closeEmitter = new vscode.EventEmitter<number | void>();
    private readonly exitEmitter = new vscode.EventEmitter<void>();

    readonly onDidWrite = this.writeEmitter.event;
    readonly onDidClose = this.closeEmitter.event;
    /** Fires when the child exits, however it exited. */
    readonly onDidExit = this.exitEmitter.event;

    private child: cp.ChildProcess | undefined;
    private exited = false;
    private stopping = false;
    private killTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly spec: DevServerSpec) {}

    /** Whether the dev server process is still alive. */
    get running(): boolean {
        return this.child !== undefined && !this.exited;
    }

    /** VS Code opens the terminal — start the server. */
    open(): void {
        const { command, args, cwd } = this.spec;
        this.writeEmitter.fire(
            `\x1b[2m${command} ${args.join(" ")}\x1b[0m\r\n\r\n`,
        );
        let child: cp.ChildProcess;
        try {
            child = cp.spawn(command, args, {
                cwd,
                // A process group of its own, so one SIGINT reaches the whole
                // tree (Vite, esbuild, SSR workers) exactly like a real Ctrl-C.
                // Not on Windows, which has no process groups to signal — there
                // the tree is torn down with taskkill (see `terminate`).
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                    ...process.env,
                    // No tty means block buffering: without this the dev
                    // server's output arrives in multi-KB bursts and looks
                    // like a hang.
                    PYTHONUNBUFFERED: "1",
                    // ...and no tty also makes most CLIs strip colour.
                    FORCE_COLOR: "1",
                    PY_COLORS: "1",
                },
            });
        } catch (error) {
            this.writeEmitter.fire(
                `\r\n\x1b[31mFailed to start the dev server: ${String(error)}\x1b[0m\r\n`,
            );
            this.exited = true;
            this.exitEmitter.fire();
            return;
        }
        this.child = child;
        const pump = (chunk: Buffer): void => {
            // A raw pty performs no newline translation: without this the
            // output stair-steps down the terminal.
            this.writeEmitter.fire(chunk.toString().replace(/\r?\n/g, "\r\n"));
        };
        child.stdout?.on("data", pump);
        child.stderr?.on("data", pump);
        child.once("error", (error) => {
            this.writeEmitter.fire(`\r\n\x1b[31m${String(error)}\x1b[0m\r\n`);
        });
        // Settle on "close", not "exit" — and be idempotent.
        //
        // "close" fires once the piped stdio has drained, so the traceback of a
        // server that died on startup is already on the panel when we print the
        // "stopped" line, and a deliberate stop doesn't close the terminal on
        // top of output still in flight. "exit" fires first, before the drain.
        //
        // "close" also covers the case that motivated listening to both: a
        // process that never started (ENOENT, EACCES) emits "error" then
        // "close" and never "exit", so liveness still settles for a command
        // that does not exist — verified against Node directly.
        const settleExit = (code: number | null, signal: string | null): void => {
            if (this.exited) {
                return;
            }
            this.exited = true;
            if (this.killTimer) {
                clearTimeout(this.killTimer);
                this.killTimer = undefined;
            }
            this.exitEmitter.fire();
            if (this.stopping) {
                // A stop we asked for: close the panel with the process.
                this.closeEmitter.fire(code ?? 0);
                return;
            }
            // An exit we did NOT ask for is usually a crash or a bad command.
            // Leave the panel open so the traceback stays readable.
            const how = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
            this.writeEmitter.fire(
                `\r\n\x1b[2mThe dev server stopped (${how}).\x1b[0m\r\n`,
            );
        };
        child.once("close", settleExit);
    }

    /** VS Code closes the terminal (user hit the trash can) — stop the server. */
    close(): void {
        this.terminate();
    }

    /**
     * Keystrokes — and anything another extension writes with
     * `Terminal.sendText()`, which VS Code routes here for a pty terminal.
     *
     * Only Ctrl-C is honoured. Everything else is dropped on purpose: at this
     * API a real keystroke and a foreign `sendText` are indistinguishable, so
     * forwarding input would reintroduce exactly the injection this class
     * exists to prevent.
     */
    handleInput(data: string): void {
        if (data.includes(ETX)) {
            this.stop();
        }
    }

    /** Ask the dev server to shut down cleanly, then guarantee it is gone. */
    stop(): void {
        if (!this.running || this.stopping) {
            return;
        }
        this.stopping = true;
        this.writeEmitter.fire("\r\n\x1b[2mStopping the dev server...\x1b[0m\r\n");
        this.terminate();
    }

    /**
     * Extension shutdown — take the server down with us.
     *
     * The child runs in its own process group so one SIGINT reaches its whole
     * tree, but that also means nothing reaps it if we go away: on POSIX a
     * parent's death never kills its children. Without this, a window close or
     * an extension-host crash would leave `pyxle dev` (and Vite) running and
     * holding their ports, with no terminal left to stop them from.
     */
    dispose(): void {
        this.terminate();
    }

    /**
     * Signal the process tree: SIGINT for a clean `pyxle dev` teardown, with a
     * SIGKILL backstop. Windows has no SIGINT delivery to another process, so
     * the tree is taken down with `taskkill /T /F`.
     */
    private terminate(): void {
        const child = this.child;
        if (!child || this.exited || child.pid === undefined) {
            return;
        }
        this.stopping = true;
        if (process.platform === "win32") {
            // `cp.spawn` reports a missing/blocked taskkill ASYNCHRONOUSLY as an
            // "error" event — a try/catch here would never see it, and an
            // unhandled "error" on a ChildProcess throws. Listen for it and fall
            // back immediately rather than waiting out the SIGKILL timer, which
            // would only reach the leader and strand Vite holding its port.
            const killer = cp.spawn(
                "taskkill",
                ["/pid", String(child.pid), "/T", "/F"],
                { windowsHide: true, stdio: "ignore" },
            );
            killer.on("error", () => {
                try {
                    child.kill();
                } catch {
                    /* already gone */
                }
            });
        } else {
            // Negative pid = the whole process group (we spawned detached).
            try {
                process.kill(-child.pid, "SIGINT");
            } catch {
                try {
                    child.kill("SIGINT");
                } catch {
                    /* already gone */
                }
            }
        }
        this.killTimer = setTimeout(() => {
            if (this.exited || child.pid === undefined) {
                return;
            }
            try {
                if (process.platform !== "win32") {
                    process.kill(-child.pid, "SIGKILL");
                } else {
                    child.kill();
                }
            } catch {
                /* already gone */
            }
        }, SHUTDOWN_GRACE_MS);
    }
}

/**
 * Open a "Pyxle Dev" terminal running the dev server.
 *
 * Returns the terminal and its pty so callers can watch liveness and stop it.
 */
export function startDevServerTerminal(spec: DevServerSpec): {
    terminal: vscode.Terminal;
    pty: DevServerPty;
} {
    const pty = new DevServerPty(spec);
    const terminal = vscode.window.createTerminal({ name: "Pyxle Dev", pty });
    return { terminal, pty };
}

/**
 * Build the argv that starts the dev server.
 *
 * Prefers `<interpreter> -m pyxle dev` so the React-browser flow runs the SAME
 * environment the Python-debug flow verified and launched — the two used to
 * disagree whenever the shell's `pyxle` came from a different environment than
 * the interpreter VS Code had selected. Falls back to a bare `pyxle` only when
 * no interpreter could be resolved (no Python extension installed).
 */
export function devServerSpec(
    interpreter: string | undefined,
    projectRoot: string,
    devArgs: readonly string[],
): DevServerSpec {
    const args = devArgs.length > 0 ? [...devArgs] : ["dev"];
    return interpreter
        ? { command: interpreter, args: ["-m", "pyxle", ...args], cwd: projectRoot }
        : { command: "pyxle", args, cwd: projectRoot };
}
