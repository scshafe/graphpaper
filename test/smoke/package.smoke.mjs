// Packed-install smoke (scripts/check-pack-install.mjs copies it into an empty
// consumer that installed the packed tarball, then runs it there): import the
// package by its published name, never from the source. The base phase has no
// elkjs installed (it is an optional peer), so layout uses the built-in
// layered fallback, server-side, with no window.
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
assert.equal(layout.sourceLabel, "fallback layered diagram layout — ELK unavailable");
const markup = graphpaper.renderDiagramSvg(model, layout, { direction: "RIGHT" });
assert.match(markup, /<svg[\s>]/);
assert.ok(markup.includes("Postgres"));

const css = fileURLToPath(import.meta.resolve("@scshafe/graphpaper/diagram.css"));
assert.ok(existsSync(css), "diagram.css export resolves to a file");
console.log(`${metadata.name}@${metadata.version} JS smoke passed (fallback layout).`);
