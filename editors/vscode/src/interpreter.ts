/**
 * Interpreter probing and labelling — pure helpers, no `vscode` import.
 *
 * Like `discovery.ts`, this module stays VS Code-free so it can be unit tested
 * without stubbing the editor API. The `vscode` <-> ms-python bridge lives in
 * `python.ts`; everything that only needs a Python executable path lives here.
 */

import * as cp from "child_process";
import * as path from "path";

/** What a candidate interpreter can do, from one short probe. */
export type PyxleProbeStatus =
    /** Has pyxle AND `python -m pyxle` works — good to launch. */
    | "ok"
    /** pyxle imports, but `pyxle.__main__` is missing (pyxle-framework < 0.8.0). */
    | "too-old"
    /** pyxle is definitively not installed in this interpreter. */
    | "missing"
    /**
     * The probe itself couldn't answer — the interpreter crashed, timed out, or
     * wouldn't spawn. Callers must NOT block on this: before the probe existed
     * the launch simply went ahead, and debugpy's own error is more useful than
     * a guess. Blocking here would turn "your sitecustomize raises" into the
     * wrong message ("pyxle is not installed") and an unfixable dialog.
     */
    | "unknown";

export interface PyxleProbeResult {
    /** Authoritative verdict — derived from `find_spec`, never from a version. */
    status: PyxleProbeStatus;
    /**
     * The version `importlib.metadata` reports for the distribution, if any.
     *
     * ADVISORY ONLY. An editable/dev install carries the dist-info recorded at
     * `pip install -e` time, so a checkout running 0.8.0 code can still report
     * 0.7.5. It is shown to the user (labelled as package metadata) and used to
     * pick the right remediation wording — never to decide whether to launch.
     */
    reportedVersion?: string;
}

/**
 * Sentinel prefix around the version line.
 *
 * A `sitecustomize`, a conda banner, or a noisy `.pth` file can write to stdout
 * before our script runs, so the version is matched by marker rather than by
 * trusting the whole stream.
 */
const VERSION_MARKER = "PYXLE_DIST_VERSION:";

/** How long to wait for the probe before treating the interpreter as unusable. */
const PROBE_TIMEOUT_MS = 6000;

/**
 * The probe script.
 *
 * `find_spec` locates modules *without importing* them and `importlib.metadata`
 * reads dist-info without importing pyxle, so this stays cheap and side-effect
 * free even against a half-broken install. Exit codes: 0 = ok, 3 = pyxle
 * present but no `__main__` (pre-0.8.0), 4 = pyxle absent.
 */
const PROBE_SCRIPT = [
    "import importlib.util as u, sys",
    "if u.find_spec('pyxle') is None: sys.exit(4)",
    "try:",
    "    from importlib.metadata import version, PackageNotFoundError",
    "    try: v = version('pyxle-framework')",
    "    except PackageNotFoundError: v = version('pyxle')",
    `    sys.stdout.write('${VERSION_MARKER}' + v + '\\n')`,
    "except Exception: pass",
    "sys.exit(0 if u.find_spec('pyxle.__main__') else 3)",
].join("\n");

/**
 * Pull the marked version line out of probe stdout; ignore everything else.
 *
 * Scans from the end so the last marker wins, and only accepts something that
 * actually looks like a version — a dialog must never interpolate stray prose.
 */
export function parseReportedVersion(stdout: string): string | undefined {
    const lines = stdout.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line.startsWith(VERSION_MARKER)) {
            continue;
        }
        const value = line.slice(VERSION_MARKER.length).trim();
        if (/^[0-9][A-Za-z0-9._+!-]{0,31}$/.test(value)) {
            return value;
        }
    }
    return undefined;
}

/**
 * Whether a reported version parses to at least *min*.
 *
 * Used ONLY to choose remediation wording (upgrade vs. repair) — never to gate
 * a launch, because the reported version can be stale (see `reportedVersion`).
 */
export function reportedAtLeast(
    reported: string | undefined,
    min: readonly [number, number, number],
): boolean {
    if (!reported) {
        return false;
    }
    const parts = reported.split(".").map((piece) => parseInt(piece, 10));
    for (let i = 0; i < min.length; i += 1) {
        const got = parts[i];
        if (!Number.isFinite(got)) {
            return false;
        }
        if (got !== min[i]) {
            return got > min[i];
        }
    }
    return true;
}

/**
 * A short, unambiguous label for an interpreter — e.g. `venv (3.12)`.
 *
 * Falls back through the environment folder name and the executable's own name
 * so an unresolved environment still reads as something a human recognises.
 */
export function formatInterpreterLabel(
    envName: string | undefined,
    envFolderPath: string | undefined,
    executablePath: string,
    major?: number,
    minor?: number,
): string {
    const name =
        envName ||
        (envFolderPath ? path.basename(envFolderPath) : undefined) ||
        path.basename(executablePath || "") ||
        "Python";
    if (typeof major !== "number" || typeof minor !== "number") {
        return name;
    }
    // A pyenv version directory is already called "3.12.4" — don't render
    // "3.12.4 (3.12)".
    return name.startsWith(`${major}.${minor}`) ? name : `${name} (${major}.${minor})`;
}

/**
 * Probe what *python* can actually do (short, timeout-guarded).
 *
 * Checks the CAPABILITY the launch needs, not just that pyxle is present: the
 * debug launch runs `python -m pyxle dev`, which requires `pyxle.__main__` —
 * added in pyxle-framework 0.8.0. Probing only `import pyxle` would pass on an
 * 0.7.x install and then die with a cryptic "No module named pyxle.__main__".
 *
 * Runs in *cwd* (the project root) so the probe resolves imports the same way
 * the launch will — a project containing a local `pyxle/` directory would
 * otherwise make the two disagree.
 */
export function probePyxleInterpreter(
    python: string,
    cwd?: string,
): Promise<PyxleProbeResult> {
    return new Promise((resolve) => {
        let settled = false;
        let stdout = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (
            status: PyxleProbeStatus,
            proc?: cp.ChildProcess,
        ): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            if (proc) {
                try {
                    proc.kill();
                } catch {
                    /* ignore */
                }
            }
            resolve({ status, reportedVersion: parseReportedVersion(stdout) });
        };
        try {
            const proc = cp.spawn(python, ["-c", PROBE_SCRIPT], {
                cwd,
                windowsHide: true,
                stdio: ["ignore", "pipe", "ignore"],
            });
            proc.stdout?.setEncoding("utf8");
            proc.stdout?.on("data", (chunk: string) => {
                // Bounded: a runaway sitecustomize must not grow this forever.
                if (stdout.length < 8192) {
                    stdout += chunk;
                }
            });
            // Settle on "close", not "exit": with stdout piped, "exit" can fire
            // before the stream drains and the version would be lost.
            //
            // Only the exit codes the script itself produces are meaningful.
            // Anything else means the interpreter never got far enough to
            // answer — report "unknown" rather than asserting pyxle is absent.
            proc.once("close", (code) =>
                finish(
                    code === 0
                        ? "ok"
                        : code === 3
                          ? "too-old"
                          : code === 4
                            ? "missing"
                            : "unknown",
                ),
            );
            proc.once("error", () => finish("unknown"));
            timer = setTimeout(() => finish("unknown", proc), PROBE_TIMEOUT_MS);
        } catch {
            finish("unknown");
        }
    });
}
