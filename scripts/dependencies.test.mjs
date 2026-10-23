import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root)));
const lock = JSON.parse(readFileSync(new URL("package-lock.json", root)));

test("cloudflared's floating binary installer is explicitly denied", () => {
  assert.equal(manifest.allowScripts?.cloudflared, false);
});

test("fling archive identity stays fixed", () => {
  const fling = lock.packages["node_modules/flingit"];
  assert.equal(fling.version, "0.0.70");
  assert.equal(fling.resolved, "https://registry.npmjs.org/flingit/-/flingit-0.0.70.tgz");
  assert.equal(fling.integrity, "sha512-OpjCWlRfDf7uvgYBHlNMzrAdSem7/iwe8T/K3wLaZqL/0XCf/vdNNn0yG+z4ELWhIEzmPz4UZZAYKhZ8xew84g==");
});

test("security refresh stays on maintained owner-compatible versions", () => {
  const minimums = {
    vite: "7.3.7", vitest: "4.1.12", "@vitest/mocker": "4.1.12",
    hono: "4.13.13", browserslist: "4.29.4", "baseline-browser-mapping": "2.11.31",
    nanoid: "3.3.20", postcss: "8.5.31", "source-map-js": "1.2.2",
  };
  for (const [name, minimum] of Object.entries(minimums)) {
    const records = Object.entries(lock.packages).filter(([path]) => path.endsWith("/node_modules/" + name) || path === "node_modules/" + name);
    assert.ok(records.length, name);
    for (const [, record] of records) {
      assert.equal(record.version, minimum, name);
    }
  }
});

test("npm suppresses the denied registry hook, not unreviewed hooks (no internet)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fake-openai-install-policy-"));
  const run = (command, args, cwd = directory) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  const archives = new Map();
  const registry = createServer((request, response) => {
    const name = request.url.split("/")[1];
    const archive = archives.get(name);
    if (!archive) { response.writeHead(404).end(); return; }
    if (request.url.endsWith(".tgz")) { response.end(archive); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ name, "dist-tags": { latest: "0.0.0" }, versions: {
      "0.0.0": { name, version: "0.0.0", scripts: { postinstall: "node hook.cjs" }, dist: {
        tarball: `http://127.0.0.1:${registry.address().port}/${name}/-/${name}-0.0.0.tgz`,
        integrity: "sha512-" + createHash("sha512").update(archive).digest("base64"),
      } },
    } }));
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  try {
    const dependencies = {};
    for (const name of ["cloudflared", "required-hook"]) {
      const source = join(directory, name, "package");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "package.json"), JSON.stringify({
        name, version: "0.0.0", scripts: { postinstall: "node hook.cjs" },
      }));
      writeFileSync(join(source, "hook.cjs"), 'require("node:fs").writeFileSync("hook-ran", "yes");');
      run("tar", ["-czf", join(directory, name + ".tgz"), "-C", join(directory, name), "package"]);
      archives.set(name, readFileSync(join(directory, name + ".tgz")));
      dependencies[name] = "0.0.0";
    }
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: "install-policy-fixture", version: "0.0.0", dependencies,
      allowScripts: manifest.allowScripts,
    }));
    const npmArgs = ["--no-audit", "--no-fund",
      "--registry=http://127.0.0.1:" + registry.address().port, "--cache=" + join(directory, "cache")];
    await promisify(execFile)("npm", ["install", "--package-lock-only", "--ignore-scripts", ...npmArgs],
      { cwd: directory, timeout: 30_000 });
    await promisify(execFile)("npm", ["ci", "--ignore-scripts=false", ...npmArgs],
      { cwd: directory, timeout: 30_000 });
    assert.equal(existsSync(join(directory, "node_modules/cloudflared/hook-ran")), false);
    assert.equal(existsSync(join(directory, "node_modules/required-hook/hook-ran")), true);
  } finally {
    await new Promise((resolve) => registry.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
