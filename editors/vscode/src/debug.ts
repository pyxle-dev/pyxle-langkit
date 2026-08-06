/**
 * Pyxle full-stack debugging — the `pyxle` debug type.
 *
 * Pyxle never implements a debug adapter of its own. It orchestrates the two
 * stock ones:
 *
 *   - `debugpy` (from the Python extension) debugs the Python half — `@server`
 *     loaders and `@action` handlers. The dev server execs compiled page
 *     modules with line numbers remapped to their `.pyxl` sources, so
 *     breakpoints set in a `.pyxl` file bind natively.
 *   - `chrome` (js-debug, built into VS Code) debugs the React half. The dev
 *     pipeline serves source maps pointing generated JSX back at the `.pyxl`,
 *     so the same file debugs in the browser too.
 *
 * The default flow is **launch**: VS Code runs `python -m pyxle dev` under
 * debugpy, so it owns the process — a real Stop button that tears the whole dev
 * server down. Once the server is ready (via the `.pyxle-build/dev-server.json`
 * discovery file it writes), the app opens in the browser — plain, not a debug
 * session — so the Python session stays the single, predictable one in the
 * debug toolbar (stop / restart / pause all act on it, unambiguously).
 *
 * Debugging the React half is a separate, self-contained launch ("Debug Pyxle
 * app (React browser)", i.e. `server: false`): a standalone js-debug Chrome
 * session with its own clean controls. Kept separate on purpose — a browser
 * *child* of the Python session hijacks the toolbar and won't tear down with
 * its parent, so unifying them fought VS Code's multi-session model.
 *
 * `request: "attach"` instead attaches to an already-running
 * `pyxle dev --inspect` — for advanced or remote setups.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    DiscoveryFile,
    discoveryIsLive,
    readDiscovery,
    sleep,
} from "./discovery";
import { probePyxleInterpreter, reportedAtLeast } from "./interpreter";
import {
    PYTHON_EXTENSION_ID,
    pickInterpreter,
    selectedInterpreterPath as selectedInterpreter,
} from "./python";
import { DevServerPty, devServerSpec, startDevServerTerminal } from "./devServer";

// The `debugpy` debug adapter is contributed by a SEPARATE extension from the
// language features. It activates lazily (e.g. on opening a .py file), so a
// launch fired before it wakes up fails with "Couldn't find a debug adapter
// descriptor for debug type 'debugpy'". We activate it explicitly before use.
const PYTHON_DEBUGPY_EXTENSION_ID = "ms-python.debugpy";
const READY_TIMEOUT_MS = 120_000;

/** Monotonic id so each debug-browser launch gets its own throwaway profile. */
let browserProfileSeq = 0;
function nextBrowserProfileId(): string {
    browserProfileSeq += 1;
    return `${Date.now()}-${browserProfileSeq}`;
}

/**
 * Project roots with a React-browser launch already waiting for the dev server.
 * Guards against piling up duplicate `pyxle dev` terminals and Chrome windows
 * when "Debug frontend" is clicked repeatedly before the server is ready — the
 * waits would otherwise all fire at once when discovery finally appears.
 */
const browserLaunchInFlight = new Set<string>();
const POLL_INTERVAL_MS = 400;

/** Marks a Python session that should open the app in the browser once ready. */
const BROWSER_MARKER = "__pyxleBrowser";

/**
 * Marks a React (browser) session with the id of a dev server THIS extension
 * started for it. Set only when the frontend launch actually started (or
 * re-adopted) the server — never when it attached to one something else is
 * running — so only the session(s) that started it can stop it.
 */
const SERVER_OWNER_MARKER = "__pyxleServerOwner";

interface OwnedServer {
    /** The "Pyxle Dev" terminal presenting the dev server. */
    terminal: vscode.Terminal;
    /**
     * The pty that owns the `pyxle dev` process. We spawn it ourselves rather
     * than typing into a shell, so liveness and shutdown are exact — see
     * `devServer.ts` for why a shell terminal is unsafe here.
     */
    pty: DevServerPty;
    projectRoot: string;
    /** Live React debug sessions using this server; it stops when this empties. */
    refs: Set<string>;
    /**
     * The discovery `startedAt` of the server this terminal actually brought up,
     * recorded once it's live. Belt-and-braces against a *foreign* server having
     * taken the port: our own process liveness is already authoritative.
     */
    startedAt?: number;
}

/**
 * Dev servers this extension started, keyed by a unique owner id (NOT project
 * root — a crashed-then-relaunched server means two terminals can briefly exist
 * for one root, and each session must only ever stop the exact terminal it
 * started). A server is reference-counted by the sessions using it and stopped
 * only when the last one ends, so two frontend sessions sharing a server, or a
 * stop-then-relaunch that re-adopts it, never kill it out from under a live one.
 */
const ownedServers = new Map<string, OwnedServer>();
/** Pending clean-stops keyed by owner id (a restart re-adds the ref → cancel). */
const pendingServerStops = new Map<string, ReturnType<typeof setTimeout>>();
let ownerSeq = 0;
/**
 * How long after the last session ends before offering to stop an owned server.
 * A Restart fires terminate-then-start; this window lets the new session re-add
 * its ref first so the "still running" prompt is suppressed on a normal restart.
 * Kept comfortably above a cold js-debug Chrome relaunch (fresh profile + attach
 * handshake), since the prompt only *offers* to stop — it never auto-kills — so
 * a longer window costs nothing on a real stop but avoids a spurious mid-restart
 * prompt (whose Stop click could otherwise hit the server the restart needs).
 */
const SERVER_RESTART_GUARD_MS = 4000;

/**
 * The owner id of the server THIS extension started that matches the currently
 * live discovery (*liveStartedAt*), if any. Matching on the recorded startedAt —
 * not merely on the terminal shell being open — ensures we only re-adopt a
 * server we genuinely started and that is genuinely the one now serving; a
 * foreign/manual server on the same port is left unowned.
 */
function liveOwnerForRoot(
    projectRoot: string,
    liveStartedAt: number | undefined,
): string | undefined {
    if (liveStartedAt === undefined) {
        return undefined;
    }
    for (const [ownerId, server] of ownedServers) {
        if (
            server.projectRoot === projectRoot &&
            server.pty.running &&
            server.startedAt === liveStartedAt
        ) {
            return ownerId;
        }
    }
    return undefined;
}

/** Cancel a scheduled owned-server stop (a restart/re-launch re-adopted it). */
function cancelServerStop(ownerId: string): void {
    const pending = pendingServerStops.get(ownerId);
    if (pending) {
        clearTimeout(pending);
        pendingServerStops.delete(ownerId);
    }
}

/**
 * Stop the dev server we started: SIGINT to its process group (a clean
 * `pyxle dev` teardown that also takes Vite and the SSR workers down), with a
 * SIGKILL backstop, then the panel closes with the process.
 */
function stopOwnedServer(server: OwnedServer): void {
    server.pty.stop();
}

/**
 * Once the last React session using a server we started ends, offer to stop it.
 *
 * We do NOT auto-kill: a Restart fires terminate-then-start, and no VS Code
 * signal distinguishes a stop from a restart, so any timer that killed the
 * server here could lose the race on a slow relaunch and tear down the very
 * server the restart depends on. Prompting instead makes that race benign — a
 * slow restart yields at worst a dismissable prompt, never a dead server — and
 * the short delay suppresses the prompt entirely on a normal (fast) restart.
 * The action re-checks the ref count, so clicking "Stop" after a session has
 * re-adopted the server is a no-op too.
 */
function scheduleServerStop(ownerId: string): void {
    cancelServerStop(ownerId);
    const timer = setTimeout(() => {
        pendingServerStops.delete(ownerId);
        void promptStopOwnedServer(ownerId);
    }, SERVER_RESTART_GUARD_MS);
    pendingServerStops.set(ownerId, timer);
}

async function promptStopOwnedServer(ownerId: string): Promise<void> {
    // Re-adopted while we waited (restart / another session): nothing to offer.
    if ((ownedServers.get(ownerId)?.refs.size ?? 1) > 0) {
        return;
    }
    const choice = await vscode.window.showInformationMessage(
        "The Pyxle dev server started for React debugging is still running.",
        "Stop server",
    );
    const server = ownedServers.get(ownerId);
    // Re-check after the (awaited) prompt: a session may have re-adopted it.
    if (choice !== "Stop server" || !server || server.refs.size > 0) {
        return;
    }
    ownedServers.delete(ownerId);
    stopOwnedServer(server);
}

interface BrowserRequest {
    projectRoot: string;
    url?: string;
    /** startedAt of the discovery already live at launch time, if any — the
     *  handler waits for a discovery newer than this (the one we just started). */
    since?: number;
}

interface PyxleDebugConfig extends vscode.DebugConfiguration {
    cwd?: string;
    server?: boolean;
    browser?: boolean;
    autoStart?: boolean;
    url?: string;
    args?: string[];
    justMyCode?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Discovery (pure helpers live in ./discovery)                     */
/* ------------------------------------------------------------------ */

/**
 * Poll for a live discovery file until `timeoutMs`, honouring cancellation.
 *
 * Used after launching the dev server to learn its browser URL: the server
 * writes the discovery file once it is ready to serve.
 */
async function waitForLiveDiscovery(
    projectRoot: string,
    token: vscode.CancellationToken,
    timeoutMs = READY_TIMEOUT_MS,
    minStartedAt?: number,
): Promise<DiscoveryFile | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !token.isCancellationRequested) {
        const discovery = readDiscovery(projectRoot);
        // When minStartedAt is set, ignore a discovery that isn't newer than it
        // (an already-running server) and keep waiting for the one we started.
        const fresh =
            minStartedAt === undefined ||
            (typeof discovery?.startedAt === "number" &&
                discovery.startedAt > minStartedAt);
        if (discovery && fresh && (await discoveryIsLive(discovery))) {
            return discovery;
        }
        await sleep(POLL_INTERVAL_MS);
    }
    return undefined;
}

/* ------------------------------------------------------------------ */
/*  Python extension gate                                            */
/* ------------------------------------------------------------------ */

/**
 * Ensure the Python extension (which provides the debugpy adapter) is present,
 * offering to install it. Returns true when the Python side can proceed.
 */
async function ensurePythonExtension(): Promise<"ok" | "react-only" | "abort"> {
    const python = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
    if (!python) {
        const choice = await vscode.window.showWarningMessage(
            "Pyxle: debugging the Python side (loaders and actions) needs the Python extension (ms-python.python).",
            "Install",
            "Debug React only",
        );
        if (choice === "Install") {
            await vscode.commands.executeCommand(
                "workbench.extensions.installExtension",
                PYTHON_EXTENSION_ID,
            );
            // The freshly installed extension isn't active yet in this window;
            // ask the user to retry rather than racing activation.
            void vscode.window.showInformationMessage(
                "Python extension installed. Press F5 again to start debugging.",
            );
            return "abort";
        }
        // Only an explicit "Debug React only" falls back to the browser flow;
        // dismissing (Esc) must not silently launch an unrequested React session.
        return choice === "Debug React only" ? "react-only" : "abort";
    }
    // Wake up the Python Debugger extension so its `debugpy` adapter is
    // registered before VS Code resolves our launch — otherwise a debug fired
    // in a fresh window (no .py file opened yet) fails to find the adapter.
    const debugpy = vscode.extensions.getExtension(PYTHON_DEBUGPY_EXTENSION_ID);
    try {
        if (debugpy && !debugpy.isActive) {
            await debugpy.activate();
        }
        if (!python.isActive) {
            await python.activate();
        }
    } catch {
        // Activation is best-effort; if it throws, the launch surfaces the
        // adapter error itself. Don't block the happy path on it.
    }
    return "ok";
}

/* ------------------------------------------------------------------ */
/*  Python interpreter resolution                                    */
/* ------------------------------------------------------------------ */

/**
 * How many times a failed interpreter check may be retried after the user picks
 * a different interpreter, before we stop re-prompting.
 */
const MAX_INTERPRETER_RETRIES = 2;

/**
 * The `pyxle dev ...` argv both launch paths use.
 *
 * Shared so the Python-debug and React-browser flows can never drift apart, and
 * forgives a stray leading "dev" in user args (e.g. copied from a shell
 * command) so we never emit `pyxle dev dev`.
 */
export function devServerArgs(userArgs: readonly string[] | undefined): string[] {
    const args = userArgs ?? [];
    return args[0] === "dev" ? [...args] : ["dev", ...args];
}

/**
 * Ensure the interpreter debugpy will launch actually has pyxle installed.
 *
 * The launch model runs `python -m pyxle dev` under the Python extension's
 * selected interpreter. A very common setup has pyxle installed in one
 * environment while VS Code has a different interpreter selected — which fails
 * with a cryptic "No module named pyxle". This resolves the selected
 * interpreter and, when it can't launch, guides the user to fix it rather than
 * starting a doomed session.
 *
 * Both failure modes lead with **Select Interpreter**, because the usual cause
 * is that the right pyxle lives in a *different* environment — telling the user
 * to upgrade the one VS Code happens to have selected is, in that case, wrong
 * advice and a dead end. When they pick a new interpreter we re-check and carry
 * on, so a fixable mistake doesn't cost another F5.
 *
 * Returns the interpreter path to pin on the debug config (so debugpy uses
 * exactly the one we checked), `undefined` to proceed with debugpy's default
 * (interpreter couldn't be determined — no/old Python extension), or `false`
 * to abort (the interpreter is known and can't launch; the user was prompted).
 */
async function ensurePyxleInterpreter(
    folder: vscode.WorkspaceFolder | undefined,
    projectRoot: string,
    attempt = 0,
): Promise<string | undefined | false> {
    const python = await selectedInterpreter(folder);
    if (!python) {
        return undefined; // can't determine — let debugpy use its default
    }
    // Probe in the project root so imports resolve the way the launch will.
    const probe = await probePyxleInterpreter(python, projectRoot);
    if (probe.status === "ok") {
        return python; // pin it, so what we checked is what launches
    }
    if (probe.status === "unknown") {
        // The probe couldn't answer (the interpreter crashed, timed out, or
        // wouldn't spawn). Never block on that: launch anyway and let debugpy
        // report the real failure, exactly as it did before this check existed.
        return python;
    }

    // The version is ADVISORY. An editable install carries the dist-info from
    // `pip install -e` time, so a 0.8.0 checkout can still report 0.7.5 — the
    // capability probe above stays authoritative, and the number is only shown
    // (labelled as metadata) and used to pick the right remediation.
    const reported = probe.reportedVersion
        ? ` It reports pyxle-framework ${probe.reportedVersion} (package metadata, which can be stale in an editable install).`
        : "";
    let message: string;
    let copyLabel: string;
    let copyCommand: string;
    if (probe.status === "too-old") {
        // Metadata already claims >= 0.8.0 but `pyxle.__main__` is missing, so
        // this is a broken/partial install, not an old one — "upgrade" would be
        // a no-op. Repair it instead.
        const looksIncomplete = reportedAtLeast(probe.reportedVersion, [0, 8, 0]);
        message = looksIncomplete
            ? `Pyxle: the selected Python interpreter (${python}) has a pyxle install that can't be ` +
              `launched as \`python -m pyxle\` — it looks incomplete.${reported} ` +
              "Reinstall it, or switch to the environment where a working pyxle is installed."
            : "Pyxle: debugging needs pyxle-framework 0.8.0 or newer, and the selected interpreter " +
              `(${python}) has an older one.${reported} ` +
              "If pyxle 0.8.0+ is installed in a different environment, switch to it — " +
              "otherwise upgrade this one.";
        copyLabel = looksIncomplete ? "Copy repair command" : "Copy upgrade command";
        copyCommand = looksIncomplete
            ? "pip install --force-reinstall pyxle-framework"
            : "pip install --upgrade pyxle-framework";
    } else {
        message =
            `Pyxle: the selected Python interpreter (${python}) doesn't have pyxle installed, ` +
            "so debugging can't launch the dev server. Select the environment where pyxle " +
            "is installed — the one your terminal's `pyxle` command uses.";
        copyLabel = "Copy install command";
        copyCommand = "pip install pyxle-framework";
    }

    const choice = await vscode.window.showErrorMessage(
        message,
        "Select Interpreter",
        copyLabel,
    );
    if (choice === copyLabel) {
        await vscode.env.clipboard.writeText(copyCommand);
        return false;
    }
    if (choice !== "Select Interpreter") {
        return false; // dismissed
    }
    // Always open the picker when that button is clicked. The retry budget
    // bounds how often *we* re-prompt; it must never turn the button into a
    // silent no-op.
    const switched = await pickInterpreter(folder);
    if (switched && attempt < MAX_INTERPRETER_RETRIES) {
        // A different interpreter — re-check from the top, so a still-bad one
        // gets the same guidance instead of failing mid-launch.
        return ensurePyxleInterpreter(folder, projectRoot, attempt + 1);
    }
    // Dismissed, re-picked the same one, or the budget is spent. Probe once
    // more anyway — the user may have fixed *this* environment (a pip install
    // in another window) rather than switching away from it — then give up
    // quietly rather than re-opening the same dialog.
    const current = await selectedInterpreter(folder);
    if (current) {
        const recheck = await probePyxleInterpreter(current, projectRoot);
        if (recheck.status === "ok" || recheck.status === "unknown") {
            return current;
        }
    }
    return false;
}

/* ------------------------------------------------------------------ */
/*  Debug configuration provider                                     */
/* ------------------------------------------------------------------ */

export class PyxleDebugConfigurationProvider
    implements vscode.DebugConfigurationProvider
{
    /** F5 with no launch.json, and the Run-and-Debug dropdown. */
    provideDebugConfigurations(): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return [
            {
                type: "pyxle",
                request: "launch",
                name: "Debug Pyxle app",
            },
            {
                // Debug the React/JSX half — a standalone Chrome session against
                // the running dev server (starts one if none is up).
                type: "pyxle",
                request: "launch",
                name: "Debug Pyxle app (React browser)",
                server: false,
            },
        ];
    }

    /**
     * Resolve a config that arrives without an explicit one.
     *
     * A config with a `name` came from launch.json or one of our provided
     * configurations — honour it untouched. Otherwise this is "Run and Debug" /
     * F5 with **no launch.json** (or picking "Pyxle" from the debugger list):
     * VS Code routes an empty config here because a `.pyxl` file is open, and we
     * ask which half to debug rather than silently defaulting to one. The real
     * work — turning the choice into a debugpy or Chrome launch — happens in the
     * substituted-variables pass.
     */
    async resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration | undefined> {
        if (!config.name) {
            type Half = vscode.QuickPickItem & { server: boolean };
            const pick = await vscode.window.showQuickPick<Half>(
                [
                    {
                        label: "Backend — Python",
                        detail: "@server loaders and @action handlers. Opens your app in the browser.",
                        server: true,
                    },
                    {
                        label: "Frontend — React",
                        detail: "The JSX, in a Chrome session against the running dev server.",
                        server: false,
                    },
                ],
                {
                    placeHolder: "Debug your Pyxle app — which half?",
                    matchOnDetail: true,
                },
            );
            if (!pick) {
                return undefined; // cancelled — start nothing
            }
            config.type = "pyxle";
            config.request = "launch";
            config.server = pick.server;
            config.name = pick.server
                ? "Debug Pyxle app"
                : "Debug Pyxle app (React browser)";
        }
        // Belt-and-braces for any still-partial config.
        if (!config.type) {
            config.type = "pyxle";
        }
        if (!config.request) {
            config.request = "launch";
        }
        return config;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration | undefined | null> {
        const pyxle = config as PyxleDebugConfig;
        const projectRoot = pyxle.cwd ?? folder?.uri.fsPath;
        if (!projectRoot) {
            void vscode.window.showErrorMessage(
                "Pyxle: open a folder to debug (no workspace folder found).",
            );
            return undefined;
        }

        const wantServer = pyxle.server !== false;
        const wantBrowser = pyxle.browser !== false;
        const browserRequest: BrowserRequest | undefined = wantBrowser
            ? { projectRoot, url: pyxle.url }
            : undefined;

        if (pyxle.request === "attach") {
            return this.resolveAttach(folder, pyxle, projectRoot, browserRequest);
        }

        // --- launch (default) ---
        if (wantServer) {
            const gate = await ensurePythonExtension();
            if (gate !== "ok") {
                // Only an explicit "Debug React only" choice falls back to the
                // browser flow; an install/dismiss must start nothing.
                if (gate === "react-only" && browserRequest) {
                    void this.launchBrowserOnly(
                        folder,
                        projectRoot,
                        browserRequest,
                        devServerArgs(pyxle.args),
                    );
                }
                return undefined;
            }
            // The launch model runs `python -m pyxle dev` under the selected
            // interpreter — verify that interpreter actually has pyxle, or the
            // session dies with a cryptic "No module named pyxle".
            const interpreter = await ensurePyxleInterpreter(folder, projectRoot);
            if (interpreter === false) {
                return undefined; // wrong interpreter — the user was guided to fix it
            }
            // Remember any discovery that's already live, so the handler opens
            // the server THIS launch starts — not a stale one, or a different
            // `pyxle dev` already running for the project (wrong URL, and the
            // breakpoints would bind to a debugpy process that never served it).
            if (browserRequest) {
                browserRequest.since = readDiscovery(projectRoot)?.startedAt;
            }
            const args = devServerArgs(pyxle.args);
            // Hand VS Code a debugpy launch of `python -m pyxle dev`. VS Code
            // owns the process → a real Stop button that tears the dev server
            // (Vite, SSR workers) down. Breakpoints in .pyxl bind because the
            // dev server execs page modules mapped to their .pyxl sources.
            const launch: vscode.DebugConfiguration = {
                type: "debugpy",
                request: "launch",
                name: "Pyxle",
                module: "pyxle",
                args,
                console: "integratedTerminal",
                cwd: projectRoot,
                // Don't attach the debugger to the SSR worker / Vite / esbuild
                // subprocesses the dev server spawns — only the server itself.
                subProcess: false,
                justMyCode: pyxle.justMyCode ?? true,
                // Consumed by onDidStartDebugSession to spawn the React child.
                [BROWSER_MARKER]: browserRequest,
            };
            // Pin the interpreter we verified so debugpy launches exactly that
            // one (not whatever it might otherwise resolve). Omitted when it
            // couldn't be determined — debugpy then uses its own default.
            if (interpreter) {
                launch.python = interpreter;
            }
            return launch;
        }

        // Server debugging off, browser on: no python session at all.
        if (browserRequest) {
            void this.launchBrowserOnly(
                        folder,
                        projectRoot,
                        browserRequest,
                        devServerArgs(pyxle.args),
                    );
        }
        return undefined;
    }

    /** Attach to an already-running `pyxle dev --inspect`. */
    private async resolveAttach(
        folder: vscode.WorkspaceFolder | undefined,
        pyxle: PyxleDebugConfig,
        projectRoot: string,
        browserRequest: BrowserRequest | undefined,
    ): Promise<vscode.DebugConfiguration | undefined> {
        const discovery = readDiscovery(projectRoot);
        if (!discovery || !(await discoveryIsLive(discovery))) {
            void vscode.window.showErrorMessage(
                "Pyxle: no running dev server found to attach to. Start one with `pyxle dev --inspect`, or use the default launch configuration.",
            );
            return undefined;
        }
        if (browserRequest && !browserRequest.url) {
            browserRequest.url = discovery.url;
        }
        if (pyxle.server === false) {
            // Browser-only attach.
            if (browserRequest?.url) {
                void this.startBrowser(folder, browserRequest.url);
            }
            return undefined;
        }
        if (!discovery.debugpy) {
            void vscode.window.showWarningMessage(
                "Pyxle: the dev server is running without --inspect, so the Python debugger can't attach. Restart it with `pyxle dev --inspect`.",
            );
            if (browserRequest?.url) {
                void this.startBrowser(folder, browserRequest.url);
            }
            return undefined;
        }
        const gate = await ensurePythonExtension();
        if (gate !== "ok") {
            // "react-only" = the user chose to debug React without the Python
            // extension. The dev server is already live (discovery checked above),
            // so attach the browser like the branches above; "abort" starts nothing.
            if (gate === "react-only" && browserRequest?.url) {
                void this.startBrowser(folder, browserRequest.url);
            }
            return undefined;
        }
        return {
            type: "debugpy",
            request: "attach",
            name: "Pyxle (attach)",
            connect: { host: discovery.debugpy.host, port: discovery.debugpy.port },
            justMyCode: pyxle.justMyCode ?? true,
            [BROWSER_MARKER]: browserRequest,
        } as vscode.DebugConfiguration;
    }

    /** Run `pyxle dev` in a terminal (no Python debugging) + a React session. */
    private async launchBrowserOnly(
        folder: vscode.WorkspaceFolder | undefined,
        projectRoot: string,
        browserRequest: BrowserRequest,
        devArgs: string[],
    ): Promise<void> {
        // One launch per project at a time. Re-clicking "Debug frontend" before
        // the dev server is up must not spawn a second server or a second
        // Chrome — otherwise every queued wait fires together once discovery
        // appears (e.g. when the backend session later starts the server).
        if (browserLaunchInFlight.has(projectRoot)) {
            return;
        }
        browserLaunchInFlight.add(projectRoot);
        // A fresh, independent token: this runs detached from the debug-config
        // resolution that spawned it (that call returns immediately), so it must
        // not ride the resolver's cancellation token.
        const source = new vscode.CancellationTokenSource();
        try {
            // Start a dev server only if there's no LIVE one. A leftover
            // discovery file from a crashed/killed server (its process gone,
            // port dead) must NOT be mistaken for a running server — otherwise
            // we'd skip starting one and wait forever on a dead endpoint.
            const existing = readDiscovery(projectRoot);
            // A server WE start (or re-adopt) here is ours to stop when the last
            // session using it ends; a server something else is running is not.
            let ownerId: string | undefined;
            let createdServer = false;
            if (!existing || !(await discoveryIsLive(existing))) {
                // Validate the interpreter for THIS flow too. Previously it just
                // typed `pyxle dev` into a shell, so it ran whatever `pyxle` was
                // first on PATH — which is routinely a different environment
                // than the one the Python-debug flow verifies and launches.
                // `undefined` means the interpreter couldn't be determined (no
                // Python extension); `false` means it can't launch and the user
                // was already guided, so start nothing.
                const interpreter = await ensurePyxleInterpreter(
                    folder,
                    projectRoot,
                );
                if (interpreter === false) {
                    return;
                }
                // Own the process rather than typing into a shell: a shell
                // terminal is writable by any extension, and the Python
                // extension's environment activation interrupts (^C) whatever
                // is running in it — killing the server seconds after it starts.
                const { terminal, pty } = startDevServerTerminal(
                    devServerSpec(interpreter, projectRoot, devArgs),
                );
                terminal.show(true);
                ownerId = `${process.pid}-${(ownerSeq += 1)}`;
                ownedServers.set(ownerId, {
                    terminal,
                    pty,
                    projectRoot,
                    refs: new Set(),
                });
                createdServer = true;
            } else {
                // A live server exists. If WE own the one that's actually serving
                // (matched by its discovery startedAt, not just an open terminal),
                // re-adopt it so this session keeps it alive and stops it when the
                // last one ends. A foreign/manual server is left unowned.
                ownerId = liveOwnerForRoot(projectRoot, existing.startedAt);
                if (ownerId) {
                    cancelServerStop(ownerId);
                }
            }
            const discovery = await waitForLiveDiscovery(projectRoot, source.token);
            // Record which server our terminal actually brought up, so later
            // re-adoption can tell it apart from a foreign server on the port.
            if (createdServer && ownerId) {
                const server = ownedServers.get(ownerId);
                if (server) {
                    server.startedAt = discovery?.startedAt;
                }
            }
            const url = browserRequest.url ?? discovery?.url;
            const started = url
                ? await this.startBrowser(folder, url, ownerId)
                : false;
            if (!started) {
                // The browser never attached. If we own the server (started it,
                // or re-adopted it and cancelled its pending stop above) and no
                // session references it, stop it cleanly so it can't leak. Covers
                // both the create and re-adopt paths — the latter must re-arm the
                // stop it just cancelled.
                if (ownerId) {
                    const server = ownedServers.get(ownerId);
                    if (server && server.refs.size === 0) {
                        scheduleServerStop(ownerId);
                    }
                }
                if (!url) {
                    void vscode.window.showErrorMessage(
                        "Pyxle: the dev server didn't come up, so the React debugger couldn't attach. Start it with `pyxle dev` and try again.",
                    );
                }
            }
        } finally {
            browserLaunchInFlight.delete(projectRoot);
            source.dispose();
        }
    }

    /**
     * Start a standalone js-debug Chrome session for the React/JSX side.
     *
     * Deliberately a top-level session, never a child of the Python session: a
     * child would hijack the debug toolbar and refuse to tear down with its
     * parent (js-debug keeps the browser alive independently). Standalone, it
     * has its own clean single-session controls.
     *
     * When *ownerId* is set, this session started (or re-adopted) that dev
     * server, so it's tagged to be counted against it and stop it cleanly when
     * the last such session ends (see registerDebugSupport). A session that
     * attached to a server something else runs passes nothing and leaves it be.
     *
     * Returns whether the debug session actually started.
     */
    async startBrowser(
        folder: vscode.WorkspaceFolder | undefined,
        url: string,
        ownerId?: string,
    ): Promise<boolean> {
        const config: vscode.DebugConfiguration = {
            type: "chrome",
            request: "launch",
            name: "Pyxle: React",
            url,
            // Resolve source-mapped .pyxl paths against the project.
            webRoot: folder?.uri.fsPath,
            // A fresh throwaway profile per launch. js-debug's default reuses
            // one profile per workspace, so a Restart — where the previous
            // debug Chrome is still shutting down — collides ("a browser is
            // already running from an old debug session" → "Unable to
            // attach"). A unique userDataDir avoids the clash. The profile
            // dir is reaped on session terminate (see registerDebugSupport).
            userDataDir: path.join(
                os.tmpdir(),
                `pyxle-debug-chrome-${process.pid}-${nextBrowserProfileId()}`,
            ),
        };
        if (ownerId) {
            config[SERVER_OWNER_MARKER] = ownerId;
        }
        let started = false;
        try {
            started = await vscode.debug.startDebugging(folder, config);
        } catch (err) {
            void vscode.window.showErrorMessage(
                `Pyxle: couldn't start the React debugger — ${(err as Error).message ?? err}`,
            );
            return false;
        }
        if (!started) {
            void vscode.window.showErrorMessage(
                "Pyxle: couldn't start the React debug session (is VS Code's built-in JavaScript debugger available?).",
            );
        }
        return started;
    }
}

/* ------------------------------------------------------------------ */
/*  Registration                                                     */
/* ------------------------------------------------------------------ */

export function registerDebugSupport(context: vscode.ExtensionContext): void {
    const provider = new PyxleDebugConfigurationProvider();

    context.subscriptions.push(
        // Dev servers we started run in their own process group, so nothing
        // reaps them if the extension goes away. Take them down with us —
        // otherwise closing the window leaves `pyxle dev` and Vite holding
        // their ports with no terminal left to stop them from.
        {
            dispose: () => {
                for (const server of ownedServers.values()) {
                    server.pty.dispose();
                }
            },
        },
        // Default trigger powers launch.json resolution AND the resolve chain.
        vscode.debug.registerDebugConfigurationProvider("pyxle", provider),
        // The Dynamic trigger makes "Debug Pyxle app" appear in the Run-and-Debug
        // dropdown so F5 works from a .pyxl file with no launch.json. It MUST be a
        // provide-only object: `triggerKind` applies solely to
        // provideDebugConfigurations, so registering the full provider twice would
        // run the resolve chain twice — feeding the first pass's output back in,
        // where already-consumed fields (`browser`, `url`, `cwd`) are gone and get
        // silently re-defaulted. See the note in vscode.d.ts on
        // registerDebugConfigurationProvider.
        vscode.debug.registerDebugConfigurationProvider(
            "pyxle",
            {
                provideDebugConfigurations: () =>
                    provider.provideDebugConfigurations(),
            },
            vscode.DebugConfigurationProviderTriggerKind.Dynamic,
        ),

        // When a Pyxle Python session starts, wait for the dev server to become
        // ready, then OPEN the app in the browser — plain, not a debug session.
        // Keeping the browser out of the debug tree is deliberate: a second
        // (js-debug) session would hijack the debug toolbar (stop/restart/pause
        // would target the browser tab, not Python) and wouldn't tear down with
        // its parent. The Python session stays the single, predictable session.
        // React/JSX breakpoints are a separate, self-contained launch (below).
        vscode.debug.onDidStartDebugSession(async (session) => {
            const request = session.configuration[BROWSER_MARKER] as
                | BrowserRequest
                | undefined;
            if (!request) {
                return;
            }
            const source = new vscode.CancellationTokenSource();
            const ended = vscode.debug.onDidTerminateDebugSession((s) => {
                if (s === session) {
                    source.cancel();
                }
            });
            try {
                const discovery = await waitForLiveDiscovery(
                    request.projectRoot,
                    source.token,
                    READY_TIMEOUT_MS,
                    request.since,
                );
                if (source.token.isCancellationRequested) {
                    return; // session ended while we waited — nothing to open
                }
                const url = request.url ?? discovery?.url;
                if (url) {
                    await vscode.env.openExternal(vscode.Uri.parse(url));
                } else {
                    void vscode.window.showWarningMessage(
                        "Pyxle: the dev server didn't become ready, so the app couldn't be opened. Check the debug terminal for errors.",
                    );
                }
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `Pyxle: couldn't open the app in the browser — ${(err as Error).message ?? err}`,
                );
            } finally {
                ended.dispose();
                source.dispose();
            }
        }),

        // Reap the throwaway Chrome profile a React-debug session created (js-debug
        // never deletes a user-supplied userDataDir), so temp doesn't accumulate.
        // And drop the session's reference on any dev server it started: once the
        // last such session ends, that server is stopped cleanly (see below).
        vscode.debug.onDidTerminateDebugSession((session) => {
            const dir = session.configuration?.userDataDir;
            if (
                typeof dir === "string" &&
                path.basename(dir).startsWith("pyxle-debug-chrome-")
            ) {
                fs.rm(dir, { recursive: true, force: true }, () => {
                    /* best-effort */
                });
            }
            const ownerId = session.configuration?.[SERVER_OWNER_MARKER];
            if (typeof ownerId === "string") {
                const server = ownedServers.get(ownerId);
                if (server) {
                    server.refs.delete(session.id);
                    if (server.refs.size === 0) {
                        scheduleServerStop(ownerId);
                    }
                }
            }
        }),

        // Count a session against the server it owns. A restart fires terminate-
        // then-start; re-adding the ref (and cancelling the pending stop) keeps
        // the server alive across the restart instead of stopping it.
        vscode.debug.onDidStartDebugSession((session) => {
            const ownerId = session.configuration?.[SERVER_OWNER_MARKER];
            if (typeof ownerId === "string") {
                cancelServerStop(ownerId);
                ownedServers.get(ownerId)?.refs.add(session.id);
            }
        }),

        // If the user closes an owned dev-server terminal themselves, forget it
        // (and cancel any pending stop) so we never send Ctrl-C to a dead one.
        vscode.window.onDidCloseTerminal((closed) => {
            for (const [ownerId, server] of ownedServers) {
                if (server.terminal === closed) {
                    ownedServers.delete(ownerId);
                    cancelServerStop(ownerId);
                }
            }
        }),

        vscode.commands.registerCommand("pyxle.openStudio", async () => {
            const folders = vscode.workspace.workspaceFolders ?? [];
            if (folders.length === 0) {
                void vscode.window.showErrorMessage(
                    "Pyxle: open a Pyxle project folder first.",
                );
                return;
            }
            // Try the active editor's folder first, then any folder with a live
            // dev server — so multi-root workspaces (where the Pyxle app isn't
            // folder[0]) still find Studio.
            const activeUri = vscode.window.activeTextEditor?.document.uri;
            const activeFolder = activeUri
                ? vscode.workspace.getWorkspaceFolder(activeUri)
                : undefined;
            const ordered = activeFolder
                ? [activeFolder, ...folders.filter((f) => f !== activeFolder)]
                : [...folders];
            for (const folder of ordered) {
                const discovery = readDiscovery(folder.uri.fsPath);
                if (discovery?.studio && (await discoveryIsLive(discovery))) {
                    await vscode.env.openExternal(vscode.Uri.parse(discovery.studio));
                    return;
                }
            }
            void vscode.window.showErrorMessage(
                "Pyxle: no running dev server found. Start one with `pyxle dev` and try again.",
            );
        }),
    );
}
