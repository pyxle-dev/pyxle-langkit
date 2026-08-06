/**
 * Status bar management — the language server's health, and the Python
 * interpreter indicator for `.pyxl` files.
 */

import * as vscode from "vscode";
import { activeInterpreter, onDidChangeActiveInterpreter } from "./python";
import { formatInterpreterLabel } from "./interpreter";

export const enum StatusState {
    Starting,
    Running,
    Retrying,
    Failed,
    NotFound,
}

/**
 * Create and register a status bar item.
 */
export function createStatusBar(
    context: vscode.ExtensionContext,
): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        0,
    );
    item.text = "$(loading~spin) Pyxle";
    item.tooltip = "Pyxle Language Server: starting...";
    item.show();
    context.subscriptions.push(item);
    return item;
}

/**
 * Update the status bar to reflect the current server state.
 */
export function updateStatus(
    item: vscode.StatusBarItem,
    state: StatusState,
    attempt?: number,
    maxRetries?: number,
): void {
    switch (state) {
        case StatusState.Starting:
            item.text = "$(loading~spin) Pyxle";
            item.tooltip = "Pyxle Language Server: starting...";
            break;
        case StatusState.Running:
            item.text = "$(check) Pyxle";
            item.tooltip = "Pyxle Language Server: running";
            break;
        case StatusState.Retrying:
            item.text = "$(warning) Pyxle";
            item.tooltip = `Pyxle Language Server: retrying (${attempt}/${maxRetries})...`;
            break;
        case StatusState.Failed:
            item.text = "$(error) Pyxle";
            item.tooltip =
                "Pyxle Language Server: failed to start. Check Output panel.";
            break;
        case StatusState.NotFound:
            item.text = "$(warning) Pyxle";
            item.tooltip =
                "Pyxle Language Server not found. Install via: pip install pyxle-langkit";
            item.command = "pyxle.showInstallGuide";
            break;
    }
}

/* ------------------------------------------------------------------ */
/*  Python interpreter indicator                                      */
/* ------------------------------------------------------------------ */

/**
 * Show which Python interpreter is selected while a `.pyxl` file is open.
 *
 * The Python extension scopes its own interpreter item to Python files, so in a
 * `.pyxl` editor the user is blind: debugging launches `python -m pyxle dev`
 * under an interpreter they can neither see nor change without first opening an
 * unrelated `.py` file. This puts it back — in the same status-bar slot they
 * already look for it — and one click opens the picker.
 */
export function registerInterpreterStatus(
    context: vscode.ExtensionContext,
    languageId: string,
): void {
    const item = vscode.window.createStatusBarItem(
        "pyxle.interpreter",
        vscode.StatusBarAlignment.Right,
        100,
    );
    item.name = "Pyxle Python Interpreter";
    item.command = "pyxle.selectPythonInterpreter";
    context.subscriptions.push(item);

    // Guards against a slow `resolveEnvironment` for a previous editor landing
    // after a newer one and painting a stale label.
    let seq = 0;

    const refresh = async (): Promise<void> => {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.languageId !== languageId) {
            item.hide();
            return;
        }
        const token = (seq += 1);
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const interpreter = await activeInterpreter(folder);
        if (token !== seq) {
            return; // superseded
        }
        if (!interpreter || interpreter.isDefault) {
            item.text = "$(snake) Select Interpreter";
            item.tooltip = interpreter
                ? "No Python interpreter selected for this workspace. Pyxle debugging runs `python -m pyxle dev`, so pick the environment where pyxle is installed."
                : "Pyxle can't determine the Python interpreter (is the Python extension installed?). Click to choose one.";
            item.backgroundColor = new vscode.ThemeColor(
                "statusBarItem.warningBackground",
            );
            item.show();
            return;
        }
        item.text = `$(snake) ${formatInterpreterLabel(
            interpreter.envName,
            interpreter.envFolder,
            interpreter.executable,
            interpreter.versionMajor,
            interpreter.versionMinor,
        )}`;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown("**Pyxle: Python interpreter**\n\n");
        tooltip.appendCodeblock(interpreter.executable, "text");
        tooltip.appendMarkdown(
            "\nPyxle debugging runs `python -m pyxle dev` with this interpreter.\n\nClick to select a different one.",
        );
        item.tooltip = tooltip;
        item.backgroundColor = undefined;
        item.show();
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => void refresh()),
    );
    void onDidChangeActiveInterpreter(() => void refresh()).then((sub) => {
        if (sub) {
            context.subscriptions.push(sub);
        }
    });
    // The Python extension may be installed *after* we activate.
    context.subscriptions.push(
        vscode.extensions.onDidChange(() => void refresh()),
    );
    // Activation is `onLanguage:pyxle`, so the .pyxl editor is already active
    // and onDidChangeActiveTextEditor will not fire for it.
    void refresh();
}
