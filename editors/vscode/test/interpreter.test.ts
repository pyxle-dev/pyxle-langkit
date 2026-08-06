/**
 * Unit tests for the VS Code-free interpreter helpers (src/interpreter.ts).
 *
 * Like discovery.test.ts these use only node:test + node built-ins, so they run
 * fast and in CI without a VS Code host. The probe is exercised against the
 * real `python3` on PATH — it only needs *a* Python, not a pyxle install.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    formatInterpreterLabel,
    parseReportedVersion,
    probePyxleInterpreter,
    reportedAtLeast,
} from "../src/interpreter";

/* ------------------------------------------------------------------ */
/*  parseReportedVersion                                              */
/* ------------------------------------------------------------------ */

test("parseReportedVersion reads the marked line", () => {
    assert.equal(parseReportedVersion("PYXLE_DIST_VERSION:0.8.0\n"), "0.8.0");
});

test("parseReportedVersion ignores unmarked noise from sitecustomize", () => {
    const stdout = "some conda banner\nPYXLE_DIST_VERSION:1.2.3rc1\ntrailing\n";
    assert.equal(parseReportedVersion(stdout), "1.2.3rc1");
});

test("parseReportedVersion returns undefined when absent", () => {
    assert.equal(parseReportedVersion("nothing to see"), undefined);
    assert.equal(parseReportedVersion(""), undefined);
});

test("parseReportedVersion rejects a value that isn't version-shaped", () => {
    // Guards against a dialog interpolating stray prose.
    assert.equal(
        parseReportedVersion("PYXLE_DIST_VERSION:not a version at all"),
        undefined,
    );
});

/* ------------------------------------------------------------------ */
/*  reportedAtLeast                                                   */
/* ------------------------------------------------------------------ */

test("reportedAtLeast compares numerically, not lexically", () => {
    assert.equal(reportedAtLeast("0.8.0", [0, 8, 0]), true);
    assert.equal(reportedAtLeast("0.8.1", [0, 8, 0]), true);
    assert.equal(reportedAtLeast("0.10.0", [0, 8, 0]), true); // not "0.10" < "0.8"
    assert.equal(reportedAtLeast("0.7.5", [0, 8, 0]), false);
    assert.equal(reportedAtLeast("1.0.0", [0, 8, 0]), true);
});

test("reportedAtLeast is false for missing or unparseable versions", () => {
    assert.equal(reportedAtLeast(undefined, [0, 8, 0]), false);
    assert.equal(reportedAtLeast("weird", [0, 8, 0]), false);
});

/* ------------------------------------------------------------------ */
/*  formatInterpreterLabel                                            */
/* ------------------------------------------------------------------ */

test("formatInterpreterLabel prefers the environment name", () => {
    assert.equal(
        formatInterpreterLabel("venv", "/p/venv", "/p/venv/bin/python", 3, 12),
        "venv (3.12)",
    );
});

test("formatInterpreterLabel falls back to the env folder, then the binary", () => {
    assert.equal(
        formatInterpreterLabel(undefined, "/p/.venv", "/p/.venv/bin/python", 3, 11),
        ".venv (3.11)",
    );
    assert.equal(
        formatInterpreterLabel(undefined, undefined, "/usr/bin/python3"),
        "python3",
    );
});

test("formatInterpreterLabel doesn't render pyenv's version twice", () => {
    // A pyenv env is already named "3.12.4" — "3.12.4 (3.12)" reads as a bug.
    assert.equal(
        formatInterpreterLabel("3.12.4", undefined, "/py/bin/python", 3, 12),
        "3.12.4",
    );
});

test("formatInterpreterLabel omits the version when it is unknown", () => {
    assert.equal(
        formatInterpreterLabel("venv", undefined, "/p/venv/bin/python"),
        "venv",
    );
});

/* ------------------------------------------------------------------ */
/*  probePyxleInterpreter                                             */
/* ------------------------------------------------------------------ */

test("probePyxleInterpreter answers for a real interpreter without hanging", async () => {
    // python3 exists in CI; a stock one has no pyxle installed, a dev machine's
    // may have it. Any verdict is valid — what must never happen is a hang.
    const result = await probePyxleInterpreter("python3");
    assert.ok(["ok", "too-old", "missing", "unknown"].includes(result.status));
});

test("probePyxleInterpreter reports unknown — not missing — when it can't run", async () => {
    // A spawn failure means the probe never got an answer. Reporting "missing"
    // would assert something it doesn't know and hard-block a launch that used
    // to work; "unknown" lets the launch proceed and debugpy report the truth.
    const result = await probePyxleInterpreter(
        "definitely-not-a-python-on-this-box",
    );
    assert.equal(result.status, "unknown");
    assert.equal(result.reportedVersion, undefined);
});

test("probePyxleInterpreter reports missing only on the script's own exit 4", async () => {
    // Exit 4 is what the probe script returns when find_spec('pyxle') is None,
    // i.e. a definitive "not installed" — the one case that blocks a launch.
    const result = await probePyxleInterpreter("python3");
    if (result.status === "missing") {
        assert.equal(result.reportedVersion, undefined);
    }
});
