/**
 * Dev-server discovery — pure, VS Code-free helpers.
 *
 * The Pyxle dev server writes `.pyxle-build/dev-server.json` describing the
 * running instance (ports, studio URL, debugpy endpoint). These functions read
 * and liveness-check it. They import only Node built-ins, so they are unit
 * testable without stubbing the `vscode` API (see test/discovery.test.ts).
 */

import * as fs from "fs";
import * as net from "net";
import * as path from "path";

export const DISCOVERY_RELATIVE_PATH = path.join(".pyxle-build", "dev-server.json");

export interface DiscoveryFile {
    pid: number;
    startedAt?: number;
    version?: string;
    projectRoot?: string;
    server?: { host: string; port: number };
    url?: string;
    studio?: string | null;
    debugpy?: { host: string; port: number } | null;
}

/** Read + parse the discovery file, or `undefined` if absent/malformed. */
export function readDiscovery(projectRoot: string): DiscoveryFile | undefined {
    const discoveryPath = path.join(projectRoot, DISCOVERY_RELATIVE_PATH);
    let raw: string;
    try {
        raw = fs.readFileSync(discoveryPath, "utf8");
    } catch {
        return undefined;
    }
    let parsed: DiscoveryFile;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed.pid !== "number") {
        return undefined;
    }
    return parsed;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve true if a TCP connection to host:port succeeds within `timeoutMs`. */
export function isPortLive(host: string, port: number, timeoutMs = 400): Promise<boolean> {
    return new Promise((resolve) => {
        // A racy/partial discovery write can carry a null/out-of-range port;
        // Node's socket.connect throws RangeError synchronously for those, which
        // would reject this promise (→ unhandled rejection up the call chain).
        // Treat an unusable port as simply not live.
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            resolve(false);
            return;
        }
        const socket = new net.Socket();
        let settled = false;
        const done = (live: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(live);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
        try {
            socket.connect(port, host);
        } catch {
            done(false);
        }
    });
}

/** Map a bind-all host to a loopback address a client can actually reach. */
export function loopbackHost(host: string | undefined): string {
    // IPv6 bind-all must map to the IPv6 loopback — on IPv6-only stacks a `::`
    // socket doesn't answer on 127.0.0.1, which would look (wrongly) not live.
    if (host === "::") {
        return "::1";
    }
    return host === "0.0.0.0" || host === "" || !host ? "127.0.0.1" : host;
}

/** True if a local process with `pid` currently exists (best-effort). */
function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but we can't signal it → still alive.
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * True if the host is an explicit loopback literal — the server deliberately
 * bound to *this* machine. A bind-all host (`0.0.0.0`/`::`/empty) is reachable
 * at loopback but may live in another pid namespace (Docker) or on another host,
 * so its recorded pid is not meaningful to check locally.
 */
function isExplicitLoopbackHost(host: string | undefined): boolean {
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** True when the server a discovery file describes is actually reachable. */
export async function discoveryIsLive(discovery: DiscoveryFile): Promise<boolean> {
    if (!discovery.server) {
        return false;
    }
    const rawHost = discovery.server.host;
    const host = loopbackHost(rawHost);
    if (!(await isPortLive(host, discovery.server.port))) {
        return false;
    }
    // A live port on an explicit-loopback bind could be a *foreign* process that
    // took the port after our server crashed without cleaning up the file. Only
    // then is the recorded pid meaningful: a dead pid means the port belongs to
    // someone else. Skip the check for a bind-all bind (`0.0.0.0`/`::`) — it is
    // reachable at loopback but may run in another pid namespace (Docker) or on
    // another machine, so a locally-absent pid must NOT mark it dead.
    if (
        typeof discovery.pid === "number" &&
        isExplicitLoopbackHost(rawHost) &&
        !isPidAlive(discovery.pid)
    ) {
        return false;
    }
    return true;
}
