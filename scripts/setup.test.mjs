import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const version of ["10.9.4", "11.19.0", "11.19.1", "11.20.0", "12.0.0"]) {
  test("setup checks npm before ci: " + version, () => {
    const directory = mkdtempSync(join(tmpdir(), "fake-openai-setup-"));
    try {
      writeFileSync(join(directory, "version"), version);
      writeFileSync(join(directory, "npm"), `#!/usr/bin/env bash
set -eu
if [[ "$*" == "--version" ]]; then cat "$FIXTURE/version"; exit; fi
echo "$*" >> "$FIXTURE/calls"
if [[ "$1" == install ]]; then echo 11.19.1 > "$FIXTURE/version"; fi
`);
      chmodSync(join(directory, "npm"), 0o755);
      const result = spawnSync("bash", [new URL("../.agents/setup", import.meta.url).pathname], {
        env: { ...process.env, PATH: directory + ":" + process.env.PATH, FIXTURE: directory },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(join(directory, "calls"), "utf8").trim().split("\n");
      const needsUpgrade = ["10.9.4", "11.19.0"].includes(version);
      assert.deepEqual(calls, needsUpgrade
        ? ["install --global npm@11.19.1 --ignore-scripts --no-audit --no-fund", "ci"]
        : ["ci"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
