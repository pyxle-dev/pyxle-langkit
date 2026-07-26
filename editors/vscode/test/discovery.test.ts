/**
 * Unit tests for the VS Code-free discovery helpers (src/discovery.ts).
 *
 * These use only node:test + node built-ins — no VS Code host required — so
 * `npm test` runs fast and in CI. The vscode-dependent orchestration in
 * debug.ts is exercised manually (F5 in a real window).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
    discoveryIsLive,
    isPortLive,
    loopbackHost,
    readDiscovery,
} from "../src/discovery";

function tmpProject(discovery?: unknown): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pyxle-disc-"));
    if (discovery !== undefined) {
        const dir = path.join(root, ".pyxle-build");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, "dev-server.json"),
            typeof discovery === "string" ? discovery : JSON.stringify(discovery),
        );
    }
    return root;
}

test("loopbackHost maps bind-all hosts to a reachable loopback", () => {
    assert.equal(loopbackHost("0.0.0.0"), "127.0.0.1");
    // IPv6 bind-all must map to the IPv6 loopback, not 127.0.0.1 — on an
    // IPv6-only stack a `::` socket doesn't answer on 127.0.0.1.
    assert.equal(loopbackHost("::"), "::1");
    assert.equal(loopbackHost(""), "127.0.0.1");
    assert.equal(loopbackHost(undefined), "127.0.0.1");
    assert.equal(loopbackHost("127.0.0.1"), "127.0.0.1");
    assert.equal(loopbackHost("192.168.1.5"), "192.168.1.5");
});

test("readDiscovery returns the parsed payload for a valid file", () => {
    const root = tmpProject({ pid: 1234, url: "http://127.0.0.1:8000" });
    const d = readDiscovery(root);
    assert.ok(d);
    assert.equal(d?.pid, 1234);
    assert.equal(d?.url, "http://127.0.0.1:8000");
});

test("readDiscovery returns undefined when the file is absent", () => {
    assert.equal(readDiscovery(tmpProject()), undefined);
});

test("readDiscovery returns undefined for malformed JSON", () => {
    assert.equal(readDiscovery(tmpProject("{not json")), undefined);
});

test("readDiscovery returns undefined when pid is missing/non-numeric", () => {
    assert.equal(readDiscovery(tmpProject({ url: "x" })), undefined);
    assert.equal(readDiscovery(tmpProject({ pid: "nope" })), undefined);
});

test("isPortLive resolves true for a listening port, false otherwise", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
        assert.equal(await isPortLive("127.0.0.1", port), true);
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
    // Port is closed now.
    assert.equal(await isPortLive("127.0.0.1", port, 300), false);
});

test("isPortLive resolves false for an invalid port (never rejects)", async () => {
    // A racy/partial discovery write can carry these; socket.connect would throw
    // RangeError synchronously, which must not become an unhandled rejection.
    for (const bad of [null, undefined, 0, -1, 99999, 3.5, NaN] as unknown[]) {
        assert.equal(await isPortLive("127.0.0.1", bad as number, 100), false);
    }
});

test("discoveryIsLive is false without a server block, true when the port answers", async () => {
    assert.equal(await discoveryIsLive({ pid: 1 }), false);

    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
        assert.equal(
            await discoveryIsLive({ pid: 1, server: { host: "0.0.0.0", port } }),
            true,
        );
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
});

// A pid far above any OS maximum — process.kill(pid, 0) always throws ESRCH, so
// isPidAlive returns false. Deterministic, no spawn/reap race.
const DEAD_PID = 2147483646;

test("discoveryIsLive keeps a bind-all server live even when its pid is not local (Docker)", async () => {
    // `pyxle dev --host 0.0.0.0` in a container: the port is published and
    // reachable at loopback, but the recorded pid lives in the container's pid
    // namespace and is absent on the host. It must NOT be reported dead.
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
        assert.equal(
            await discoveryIsLive({ pid: DEAD_PID, server: { host: "0.0.0.0", port } }),
            true,
        );
        // `::` (IPv6 bind-all) takes the identical branch — isExplicitLoopbackHost
        // is false for it too — so it needs no separate reachable-port assertion
        // here (loopbackHost's `::`→`::1` mapping is covered by its own unit test).
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("discoveryIsLive treats an explicit-loopback bind with a dead pid as stale", async () => {
    // The crashed server bound to 127.0.0.1 explicitly and a foreign process now
    // holds the port; a dead recorded pid means the file is stale, not live.
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
        assert.equal(
            await discoveryIsLive({ pid: DEAD_PID, server: { host: "127.0.0.1", port } }),
            false,
        );
        // A live pid on the same explicit-loopback bind is live.
        assert.equal(
            await discoveryIsLive({
                pid: process.pid,
                server: { host: "127.0.0.1", port },
            }),
            true,
        );
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
});
