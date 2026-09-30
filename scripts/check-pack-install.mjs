import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const temporaryRoot = await mkdtemp(join(tmpdir(), "graphpaper-pack-"));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function runPnpm(arguments_, options = {}) {
  const result = spawnSync("pnpm", arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env
  });
  assert.equal(
    result.status,
    0,
    [
      `pnpm ${arguments_.join(" ")} failed`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n")
  );
  return result.stdout;
}

try {
  // pnpm pack prints one JSON object (npm printed an array); skip lifecycle
  // scripts so nothing but the JSON reaches stdout.
  const packOutput = runPnpm([
    "pack",
    "--json",
    "--config.ignore-scripts=true",
    "--pack-destination",
    temporaryRoot
  ], { cwd: packageRoot });
  const packResult = JSON.parse(packOutput);
  const tarball = join(temporaryRoot, packResult.filename.split("/").pop());

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
  runPnpm([
    "add",
    "--ignore-scripts",
    "--offline",
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
