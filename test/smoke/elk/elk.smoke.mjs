// Packed-install smoke, elk phase (scripts/release.config.mjs): the consumer
// has added the optional peer elkjs, and a server-side caller injects
// `new ELK()` as the layout engine (Node has no window.ELK), loaded the way
// README.md's "ELK layout" section shows. JS only: elkjs
// 0.10.2's own declarations fail a skipLibCheck-false typecheck (TS2536 in
// lib/elk-api.d.ts), and graphpaper types the engine structurally.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { layoutDiagram, renderDiagramSvg } from "@scshafe/graphpaper";

const ELK = createRequire(import.meta.url)("elkjs/lib/elk.bundled.js");

const model = {
  id: "elk-smoke",
  title: "ELK smoke",
  nodes: [
    { id: "api", title: "API", type: "service" },
    { id: "worker", title: "Worker", type: "service" },
    { id: "db", title: "Postgres", type: "database" }
  ],
  edges: [
    { from: "api", to: "db", label: "reads/writes" },
    { from: "worker", to: "db" }
  ]
};
const layout = await layoutDiagram(model, { direction: "RIGHT", layoutEngine: new ELK() });
assert.equal(layout.sourceLabel, "ELK layered diagram layout");
assert.equal(layout.positions.size, 3);
assert.equal(layout.edgePaths.size, 2);
const markup = renderDiagramSvg(model, layout, { direction: "RIGHT" });
assert.match(markup, /<svg[\s>]/);
assert.ok(markup.includes("Worker"));
console.log("@scshafe/graphpaper elk smoke passed (ELK layout).");
