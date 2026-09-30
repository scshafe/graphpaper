import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "npm_execpath is required");

const temporaryRoot = await mkdtemp(join(tmpdir(), "graphpaper-pack-"));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function runNpm(arguments_, options = {}) {
  const result = spawnSync(process.execPath, [npmCli, ...arguments_], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false"
    }
  });
  assert.equal(
    result.status,
    0,
    [
      `npm ${arguments_.join(" ")} failed`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n")
  );
  return result.stdout;
}

try {
  const packOutput = runNpm([
    "pack",
    "--json",
    "--pack-destination",
    temporaryRoot
  ], { cwd: packageRoot });
  const packResult = JSON.parse(packOutput);
  assert.equal(packResult.length, 1);
  const tarball = join(temporaryRoot, packResult[0].filename);

  await writeFile(
    join(temporaryRoot, "package.json"),
    JSON.stringify({
      name: "graphpaper-packed-consumer",
      private: true,
      type: "module"
    })
  );
  await writeFile(
    join(temporaryRoot, "smoke.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import * as graphpaper from "@scshafe/graphpaper";',
      'assert.equal(typeof graphpaper.hydrateDiagram, "function");',
      'assert.equal(typeof graphpaper.renderDiagramSvg, "function");',
      'assert.equal(typeof graphpaper.layoutDiagram, "function");'
    ].join("\n")
  );
  runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball
  ], { cwd: temporaryRoot });

  const smoke = spawnSync(process.execPath, ["smoke.mjs"], {
    cwd: temporaryRoot,
    encoding: "utf8"
  });
  assert.equal(
    smoke.status,
    0,
    [smoke.stdout, smoke.stderr].filter(Boolean).join("\n")
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
