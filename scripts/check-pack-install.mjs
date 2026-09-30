// Pack the package with pnpm (the packer `pnpm publish` uses), install the
// tarball into an empty consumer, and run JS and TypeScript smoke imports
// against the installed copy by its published name. Structure ported from
// @scshafe/mission-pipeline (scripts/check-pack-install.mjs).
//
// With GRAPHPAPER_SMOKE_CONSUMER set to a directory that already has the
// package installed (the publish workflow's install-back of the registry
// version), skip pack+install and run the same smokes there.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNPM_PACK_ARGS, singlePackReport } from "./release-identity.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const installedConsumer = process.env.GRAPHPAPER_SMOKE_CONSUMER;
const scratch = installedConsumer
  ? undefined
  : await mkdtemp(join(tmpdir(), "graphpaper-pack-"));

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit"
  });
  let stdout = "";
  if (options.capture) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
  }
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}`);
  return stdout;
}

async function packAndInstall() {
  const packed = singlePackReport(await run("pnpm", [
    ...PNPM_PACK_ARGS,
    "--pack-destination",
    scratch
  ], { capture: true }));

  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`
  );
  await run("pnpm", [
    "add",
    "--ignore-scripts",
    "--offline",
    join(scratch, packed.basename)
  ], { cwd: consumer });
  return consumer;
}

try {
  const consumer = installedConsumer === undefined
    ? await packAndInstall()
    : resolve(installedConsumer);

  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const smoke = `
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    import * as graphpaper from "@scshafe/graphpaper";
    import metadata from "@scshafe/graphpaper/package.json" with { type: "json" };

    for (const name of [
      "hydrateDiagram",
      "layoutDiagram",
      "renderDiagramSvg",
      "renderDiagramLegend",
      "cleanupHydratedDiagram",
      "enablePanZoom",
      "disablePanZoom",
      "selectDiagramNode",
      "clearDiagramNodeSelection",
      "selectedDiagramNodeId",
      "bindDiagramInteractions"
    ]) {
      assert.equal(typeof graphpaper[name], "function", name);
    }
    assert.equal(metadata.name, "@scshafe/graphpaper");
    assert.equal(metadata.version, ${JSON.stringify(packageJson.version)});

    // Server-side render with no window and no ELK: the built-in layered
    // fallback lays out and renders SVG markup.
    const model = {
      id: "install-smoke",
      title: "Install smoke",
      nodes: [
        { id: "api", title: "API", type: "service", status: "active" },
        { id: "db", title: "Postgres", type: "database" }
      ],
      edges: [{ from: "api", to: "db", label: "reads/writes" }]
    };
    const layout = await graphpaper.layoutDiagram(model, { direction: "RIGHT" });
    const markup = graphpaper.renderDiagramSvg(model, layout, { direction: "RIGHT" });
    assert.match(markup, /<svg[\\s>]/);
    assert.ok(markup.includes("Postgres"));

    const css = fileURLToPath(import.meta.resolve("@scshafe/graphpaper/diagram.css"));
    assert.ok(existsSync(css), "diagram.css export resolves to a file");

    // The unscoped name is an unrelated registry.npmjs.org package; it must
    // not resolve here.
    await assert.rejects(import("graphpaper"));
  `;
  await writeFile(join(consumer, "smoke.mjs"), smoke);
  await run("node", ["smoke.mjs"], { cwd: consumer });

  const typeSmoke = `
    import {
      hydrateDiagram,
      layoutDiagram,
      renderDiagramSvg,
      selectDiagramNode,
      type DiagramLayout,
      type DiagramModel,
      type DiagramModelInput,
      type DiagramRenderOptions,
      type PanZoomOptions
    } from "@scshafe/graphpaper";

    const model: DiagramModel = {
      id: "types",
      title: "Types",
      nodes: [{ id: "a", title: "A" }],
      edges: []
    };
    // 0.5.x: an interface-typed DiagramModel lacks DiagramModelInput's index
    // signature (a known index.d.ts gap), so the smoke passes a literal.
    const input: DiagramModelInput = { id: model.id, title: model.title, nodes: model.nodes, edges: model.edges };
    const options: DiagramRenderOptions = { direction: "DOWN" };
    const layout: Promise<DiagramLayout> = layoutDiagram(input, options);
    const render: (m: DiagramModelInput, l: DiagramLayout) => string = renderDiagramSvg;
    const hydrate: (c: Element, m: DiagramModelInput) => Promise<void> = hydrateDiagram;
    const panZoom = undefined as unknown as PanZoomOptions;
    // @ts-expect-error renderDiagramSvg needs a layout
    renderDiagramSvg(model);
    // @ts-expect-error a node id is a string
    selectDiagramNode(null, 1);
    void layout;
    void render;
    void hydrate;
    void panZoom;
  `;
  await writeFile(join(consumer, "smoke.ts"), typeSmoke);
  await writeFile(join(consumer, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
      lib: ["ES2022", "DOM"],
      strict: true,
      noEmit: true,
      skipLibCheck: false
    },
    files: ["smoke.ts"]
  }, null, 2)}\n`);
  await run(process.execPath, [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--project",
    "tsconfig.json"
  ], { cwd: consumer });
  console.log(
    installedConsumer === undefined
      ? "Graphpaper packed-install runtime + TypeScript smoke passed."
      : `Graphpaper installed-consumer runtime + TypeScript smoke passed (${consumer}).`
  );
} finally {
  if (scratch !== undefined) await rm(scratch, { force: true, recursive: true });
}
