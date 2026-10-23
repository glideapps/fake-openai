import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("local CLI serves SQLite-backed routes without invoking cloudflared", { timeout: 45_000 }, async () => {
  const root = new URL("../", import.meta.url).pathname;
  const directory = mkdtempSync(join(tmpdir(), "fake-openai-local-cli-"));
  const ports = [];
  // Hold both reservations until both distinct ports have been selected.
  for (let i = 0; i < 2; i++) {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    ports.push(server);
  }
  const [backend, frontend] = ports.map((server) => server.address().port);
  const sentinel = join(directory, "tunnel-ran");
  const binary = join(directory, "cloudflared");
  writeFileSync(binary, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "unexpected tunnel");
process.exit(1);
`, { mode: 0o755 });
  for (const name of ["src", "public", "index.html", "package.json", "vite.config.ts"]) {
    cpSync(join(root, name), join(directory, name), { recursive: true });
  }
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  await Promise.all(ports.map((server) => new Promise((resolve) => server.close(resolve))));
  const child = spawn(process.execPath, [
    join(root, "node_modules/flingit/dist/cli/index.js"), "--cli", "dev",
    "--be-port", String(backend), "--fe-port", String(frontend),
  ], {
    cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLOUDFLARED_BIN: binary },
  });
  let output = "";
  const closed = once(child, "close");
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CLI readiness deadline\n" + output)), 30_000);
      const collect = (chunk) => {
        output += chunk;
        if (output.includes("API server: http://localhost:" + backend)) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error("CLI exited " + code + "\n" + output));
      });
    });
    const response = await fetch(`http://127.0.0.1:${backend}/api/__mock__/sessions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 201, output);
    const session = await response.json();
    assert.match(session.sessionKey, /^sess_/);
    const sessions = await fetch(`http://127.0.0.1:${backend}/api/__mock__/sessions`);
    assert.ok(JSON.stringify(await sessions.json()).includes(session.sessionKey));
    assert.equal(existsSync(sentinel), false);
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
});
