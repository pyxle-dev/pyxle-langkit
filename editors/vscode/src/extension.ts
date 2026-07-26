/**
 * Pyxle Language Tools — VS Code extension.
 *
 * This is a thin LSP client.  All language intelligence (completions, hover,
 * diagnostics, formatting, semantic tokens, go-to-definition) is provided by
 * the ``pyxle-langserver`` Python process.  The extension's only job is to
 * launch that process, wire up the Language Client, and manage the status bar.
 *
 * JSX intelligence comes from two sources:
 * 1. The LSP server provides Pyxle-specific completions (components, props)
 * 2. The ``embeddedLanguages`` mapping in the grammar contribution tells
 *    VS Code that ``source.js.jsx`` regions are ``javascriptreact``, which
 *    enables basic word-based completions and bracket matching from VS Code's
 *    built-in TypeScript/JavaScript extension.
 *
 * Full semantic JSX intelligence (type-aware completions, go-to-definition
 * into React types) requires embedding TypeScript's language service in the
 * LSP server — planned for a future release.
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
} from "vscode-languageclient/node";
import { createStatusBar, updateStatus, StatusState } from "./status";
import { registerDebugSupport } from "./debug";

const LANGUAGE_ID = "pyxle";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;

/* ------------------------------------------------------------------ */
/*  Activation                                                        */
/* ------------------------------------------------------------------ */

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel("Pyxle Language Server");
    context.subscriptions.push(outputChannel);

    statusBar = createStatusBar(context);

    context.subscriptions.push(
        vscode.commands.registerCommand("pyxle.showInstallGuide", () => {
            vscode.window
                .showInformationMessage(
                    "Install the Pyxle language server with: pip install pyxle-langkit",
                    "Copy Command",
                )
                .then((choice) => {
                    if (choice === "Copy Command") {
                        vscode.env.clipboard.writeText(
                            "pip install pyxle-langkit",
                        );
                        vscode.window.showInformationMessage("Copied to clipboard.");
                    }
                });
        }),
    );

    registerDebugSupport(context);

    resolveAndStart(context);
}

/* ------------------------------------------------------------------ */
/*  Deactivation                                                      */
/* ------------------------------------------------------------------ */

export function deactivate(): Thenable<void> | undefined {
    return client?.stop();
}

/* ------------------------------------------------------------------ */
/*  Server resolution                                                 */
/* ------------------------------------------------------------------ */

/**
 * Resolve the ``pyxle-langserver`` command and start the LSP client.
 *
 * Resolution order:
 * 1. User-configured ``pyxle.langserver.command`` (if explicitly changed)
 * 2. Python environment detection (``python3 -m pyxle_langkit.server``)
 * 3. Common install paths (``~/.local/bin``, pyenv shims)
 * 4. System PATH (bare ``pyxle-langserver``)
 */
async function resolveAndStart(
    context: vscode.ExtensionContext,
): Promise<void> {
    updateStatus(statusBar, StatusState.Starting);

    const config = vscode.workspace.getConfiguration("pyxle.langserver");
    const userCommand = config.get<string>("command", "pyxle-langserver");

    // If the user explicitly set a custom command, trust it.
    const inspected = config.inspect<string>("command");
    const isExplicitlySet =
        inspected?.workspaceValue !== undefined ||
        inspected?.workspaceFolderValue !== undefined ||
        inspected?.globalValue !== undefined;

    if (isExplicitlySet) {
        outputChannel.appendLine(
            `Using configured command: ${userCommand}`,
        );
        startClient(context, userCommand, 0);
        return;
    }

    // Auto-detect: try to find pyxle-langserver.
    const resolved = await detectLangserver();
    if (resolved) {
        outputChannel.appendLine(`Auto-detected language server: ${resolved}`);
        startClient(context, resolved, 0);
        return;
    }

    // Not found anywhere.
    outputChannel.appendLine(
        "pyxle-langserver not found. Install via: pip install pyxle-langkit",
    );
    updateStatus(statusBar, StatusState.NotFound);
    vscode.window
        .showWarningMessage(
            "Pyxle Language Server not found. Install it with: pip install pyxle-langkit",
            "Copy Command",
        )
        .then((choice) => {
            if (choice === "Copy Command") {
                vscode.env.clipboard.writeText("pip install pyxle-langkit");
                vscode.window.showInformationMessage("Copied to clipboard.");
            }
        });
}

/**
 * Try to find ``pyxle-langserver`` in common locations.
 */
async function detectLangserver(): Promise<string | undefined> {
    const home = process.env.HOME || process.env.USERPROFILE || "";

    // 1. Check if bare command is on PATH.
    const onPath = await whichCommand("pyxle-langserver");
    if (onPath) return onPath;

    // 2. Check common install locations.
    const candidates = [
        path.join(home, ".local", "bin", "pyxle-langserver"),
        path.join(home, ".pyenv", "shims", "pyxle-langserver"),
    ];
    for (const p of candidates) {
        if (isExecutable(p)) return p;
    }

    return undefined;
}

function isExecutable(p: string): boolean {
    try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function whichCommand(cmd: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        cp.exec(
            process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`,
            (err, stdout) => {
                if (err || !stdout.trim()) {
                    resolve(undefined);
                } else {
                    resolve(stdout.trim().split("\n")[0]);
                }
            },
        );
    });
}

/* ------------------------------------------------------------------ */
/*  Client lifecycle                                                  */
/* ------------------------------------------------------------------ */

function startClient(
    context: vscode.ExtensionContext,
    command: string,
    attempt: number,
): void {
    const config = vscode.workspace.getConfiguration("pyxle.langserver");
    const args = config.get<string[]>("args", ["--stdio"]);

    const serverOptions: ServerOptions = {
        run: { command, args },
        debug: { command, args },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file", language: LANGUAGE_ID }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher("**/*.pyxl"),
        },
        outputChannel,
    };

    client = new LanguageClient(
        "pyxle",
        "Pyxle Language Server",
        serverOptions,
        clientOptions,
    );

    const startPromise = client.start();

    client.onDidChangeState((event) => {
        if (event.newState === 2 /* Running */) {
            updateStatus(statusBar, StatusState.Running);
        }
    });

    const onReady = (): void => {
        updateStatus(statusBar, StatusState.Running);
    };

    const onError = (error: unknown): void => {
        const message =
            error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(
            `Language server failed to start: ${message}`,
        );

        if (attempt < MAX_RETRIES) {
            const next = attempt + 1;
            updateStatus(statusBar, StatusState.Retrying, next, MAX_RETRIES);
            outputChannel.appendLine(
                `Retrying in ${RETRY_DELAY_MS}ms (attempt ${next}/${MAX_RETRIES})...`,
            );
            setTimeout(() => startClient(context, command, next), RETRY_DELAY_MS);
        } else {
            updateStatus(statusBar, StatusState.Failed);
            vscode.window
                .showErrorMessage(
                    `Pyxle Language Server failed after ${MAX_RETRIES} attempts. Is pyxle-langserver installed?\nInstall via: pip install pyxle-langkit`,
                    "Copy Install Command",
                    "Show Output",
                )
                .then((choice) => {
                    if (choice === "Show Output") {
                        outputChannel.show();
                    } else if (choice === "Copy Install Command") {
                        vscode.env.clipboard.writeText(
                            "pip install pyxle-langkit",
                        );
                    }
                });
        }
    };

    startPromise.then(onReady, onError);

    context.subscriptions.push({ dispose: () => { client?.stop(); } });
}
