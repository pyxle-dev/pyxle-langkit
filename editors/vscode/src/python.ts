/**
 * The bridge to the Python extension (`ms-python.python`).
 *
 * Every read of the selected interpreter goes through here so the debug launch,
 * the status bar, and the palette command all agree on one code path — and so
 * the defensive optional-chaining around another extension's API exists once
 * rather than three times.
 */

import * as vscode from "vscode";

export const PYTHON_EXTENSION_ID = "ms-python.python";

/** The interpreter the Python extension has selected, resolved for display. */
export interface ActiveInterpreter {
    /** Absolute path to the executable — what we probe and what we launch. */
    executable: string;
    /** Environment name (`venv`, `3.12.4`, a conda env name), when known. */
    envName?: string;
    /** The environment folder, used to derive a name when `envName` is absent. */
    envFolder?: string;
    versionMajor?: number;
    versionMinor?: number;
    /**
     * True when the Python extension has no real selection yet and is falling
     * back to a bare `python` on PATH — worth surfacing, since it is the state
     * most likely to launch something other than what the user expects.
     */
    isDefault: boolean;
}

/**
 * The subset of the `ms-python.python` API surface we use, declared
 * structurally.
 *
 * Depending on `@vscode/python-extension` for types would pull a dependency for
 * shapes we consume defensively anyway; a missing field must degrade to a
 * shorter label, never throw.
 */
interface PythonEnvironmentsApi {
    getActiveEnvironmentPath?: (resource?: vscode.Uri) => {
        id?: string;
        path?: string;
    };
    resolveEnvironment?: (env: unknown) => Promise<
        | {
              executable?: { uri?: vscode.Uri };
              environment?: { name?: string; folderUri?: vscode.Uri };
              version?: { major?: number; minor?: number };
          }
        | undefined
    >;
    onDidChangeActiveEnvironmentPath?: vscode.Event<unknown>;
}

interface PythonApi {
    environments?: PythonEnvironmentsApi;
}

/** Activate `ms-python.python` and return its API, or `undefined` if absent. */
async function pythonApi(): Promise<PythonApi | undefined> {
    try {
        const ext = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
        if (!ext) {
            return undefined;
        }
        return (ext.isActive ? ext.exports : await ext.activate()) as PythonApi;
    } catch {
        return undefined;
    }
}

/**
 * The interpreter path the Python extension has selected for *folder*.
 *
 * Returns `undefined` when the Python extension is missing or too old to expose
 * the environments API — callers then fall back to debugpy's own default.
 */
export async function selectedInterpreterPath(
    folder: vscode.WorkspaceFolder | undefined,
): Promise<string | undefined> {
    return (await activeInterpreter(folder))?.executable;
}

/** The selected interpreter with the extra detail a label/tooltip needs. */
export async function activeInterpreter(
    folder: vscode.WorkspaceFolder | undefined,
): Promise<ActiveInterpreter | undefined> {
    try {
        const envs = (await pythonApi())?.environments;
        const envPath = envs?.getActiveEnvironmentPath?.(folder?.uri);
        if (!envPath?.path) {
            return undefined;
        }
        // "DEFAULT_PYTHON" is what the API reports when nothing has been chosen.
        const isDefault =
            envPath.id === "DEFAULT_PYTHON" || !isAbsolutePath(envPath.path);
        const resolved = await envs?.resolveEnvironment?.(envPath);
        return {
            executable: resolved?.executable?.uri?.fsPath ?? envPath.path,
            envName: resolved?.environment?.name,
            envFolder: resolved?.environment?.folderUri?.fsPath,
            versionMajor: resolved?.version?.major,
            versionMinor: resolved?.version?.minor,
            isDefault,
        };
    } catch {
        return undefined;
    }
}

/** Cheap absolute-path test that works for both POSIX and Windows shapes. */
function isAbsolutePath(value: string): boolean {
    return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Subscribe to interpreter changes.
 *
 * Fires unconditionally rather than filtering on the event's resource: the
 * active environment is per-resource, and the active editor may live in a
 * different workspace folder than the one that changed.
 */
export async function onDidChangeActiveInterpreter(
    listener: () => void,
): Promise<vscode.Disposable | undefined> {
    try {
        const envs = (await pythonApi())?.environments;
        return envs?.onDidChangeActiveEnvironmentPath?.(() => listener());
    } catch {
        return undefined;
    }
}

/**
 * Open the Python extension's interpreter picker.
 *
 * Resolves to `true` once the picker has been shown. The selection itself is
 * applied asynchronously by the Python extension — callers that need to react
 * to the new value must subscribe to {@link onDidChangeActiveInterpreter}
 * *before* calling this, or they race the write.
 */
export async function showInterpreterPicker(): Promise<boolean> {
    const ext = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
    if (!ext) {
        const choice = await vscode.window.showErrorMessage(
            "Pyxle: selecting a Python interpreter needs the Python extension (ms-python.python).",
            "Install Python extension",
        );
        if (choice === "Install Python extension") {
            await vscode.commands.executeCommand(
                "workbench.extensions.installExtension",
                PYTHON_EXTENSION_ID,
            );
        }
        return false;
    }
    if (!ext.isActive) {
        try {
            await ext.activate();
        } catch {
            /* fall through — the command may still work */
        }
    }
    await vscode.commands.executeCommand("python.setInterpreter");
    return true;
}

/**
 * How long to wait, after the picker closes, for the Python extension to write
 * the new selection. It applies the change asynchronously, so reading the
 * active interpreter the instant the quick pick closes can race the write.
 */
const PICKER_SETTLE_MS = 2000;

/**
 * Show the interpreter picker and report whether the selection actually
 * changed.
 *
 * Waits only until the picker closes plus a short settle window — never on the
 * change event alone. A dismissed picker (Esc) and a re-pick of the *same*
 * interpreter both fire no event, so waiting for one would hang a launch that
 * `resolveDebugConfiguration` is blocking on, with no UI and no way to cancel.
 *
 * The return value says "the interpreter is different now", which callers use
 * to decide whether re-prompting is worthwhile — it is never the only signal:
 * they re-probe regardless, since the user may have fixed the environment
 * rather than switched away from it.
 */
export async function pickInterpreter(
    folder: vscode.WorkspaceFolder | undefined,
): Promise<boolean> {
    const before = await selectedInterpreterPath(folder);
    let subscription: vscode.Disposable | undefined;
    // Subscribe BEFORE opening the picker so a fast change can't be missed.
    const changed = new Promise<void>((resolve) => {
        let done = false;
        const settle = (): void => {
            if (!done) {
                done = true;
                resolve();
            }
        };
        void onDidChangeActiveInterpreter(settle).then((sub) => {
            subscription = sub;
            if (done) {
                sub?.dispose();
            }
        });
    });
    try {
        if (!(await showInterpreterPicker())) {
            return false;
        }
        // The command resolves when the quick pick closes. Give the write a
        // moment to land, but never block on an event that may never come.
        await Promise.race([
            changed,
            new Promise<void>((resolve) =>
                setTimeout(resolve, PICKER_SETTLE_MS),
            ),
        ]);
        const after = await selectedInterpreterPath(folder);
        return Boolean(after) && after !== before;
    } finally {
        subscription?.dispose();
    }
}
