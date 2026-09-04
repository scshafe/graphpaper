// Injected layout engine — `layoutEngine` in the render options is used instead of `window.ELK`.
//
// Contract under test:
//   - layoutDiagram hands the ELK graph (children with measured sizes, edges with sources/targets)
//     to options.layoutEngine and reads positions + edge sections back from what it resolves,
//     stamping the layout with the ELK source label rather than the fallback one.
//   - The injected engine takes precedence over window.ELK.
//   - An engine that throws degrades to the built-in layered layout with the ELK-error label;
//     with neither an injected engine nor window.ELK the fallback runs with the unavailable label.

import test from "node:test";
import assert from "node:assert/strict";
import { layoutDiagram, renderDiagramSvg } from "../src/index.js";

const model = {
  id: "engine-test",
  title: "Engine",
  nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
  edges: [{ from: "a", to: "b", label: "goes" }]
};

function fakeEngine() {
  const calls = [];
  return {
    calls,
    async layout(graph) {
      calls.push(graph);
      return {
        ...graph,
        width: 500,
        height: 200,
        children: graph.children.map((child, index) => ({ ...child, x: 100 * (index + 1), y: 10 })),
        edges: graph.edges.map((edge) => ({
          ...edge,
          sections: [{ startPoint: { x: 0, y: 0 }, bendPoints: [{ x: 25, y: 0 }], endPoint: { x: 50, y: 50 } }]
        }))
      };
    }
  };
}

test("layoutDiagram lays out with an injected engine and reads its result back", async () => {
  const engine = fakeEngine();
  const layout = await layoutDiagram(model, { layoutEngine: engine, sourceLabel: "injected engine" });
  assert.equal(engine.calls.length, 1, "the engine ran once");
  const graph = engine.calls[0];
  assert.deepEqual(graph.children.map((child) => child.id), ["a", "b"]);
  assert.ok(graph.children.every((child) => child.width > 0 && child.height > 0), "children carry measured sizes");
  assert.deepEqual(graph.edges.map((edge) => [edge.sources, edge.targets]), [[["a"], ["b"]]]);
  assert.equal(layout.sourceLabel, "injected engine");
  assert.equal(layout.positions.get("b").x - layout.positions.get("a").x, 100, "positions come from the engine");
  assert.equal(layout.edgePaths.size, 1, "edge paths come from the engine's sections");
  assert.match([...layout.edgePaths.values()][0], /^M/);
});

test("an injected engine takes precedence over window.ELK", async () => {
  const previous = globalThis.window;
  let globalUsed = false;
  globalThis.window = { ELK: class { layout() { globalUsed = true; throw new Error("global engine used"); } } };
  try {
    const engine = fakeEngine();
    const layout = await layoutDiagram(model, { layoutEngine: engine });
    assert.equal(engine.calls.length, 1);
    assert.equal(globalUsed, false);
    assert.equal(layout.sourceLabel, "ELK layered diagram layout");
  } finally {
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
  }
});

test("a failing engine degrades to the built-in layout; no engine at all uses the unavailable label", async () => {
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warned.push(args);
  try {
    const failing = { async layout() { throw new Error("boom"); } };
    const errored = await layoutDiagram(model, { layoutEngine: failing, elkErrorSourceLabel: "fell back after error" });
    assert.equal(errored.sourceLabel, "fell back after error");
    assert.equal(errored.positions.size, 2, "the fallback still positions every node");
    assert.equal(warned.length, 1, "the failure is reported, not swallowed");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(globalThis.window, undefined, "this test runs without a window");
  const unavailable = await layoutDiagram(model, { elkUnavailableSourceLabel: "no engine anywhere" });
  assert.equal(unavailable.sourceLabel, "no engine anywhere");
  const ignored = await layoutDiagram(model, { layoutEngine: { notAnEngine: true }, elkUnavailableSourceLabel: "not an engine" });
  assert.equal(ignored.sourceLabel, "not an engine", "an object without layout() is not an engine");
});

test("shown edge labels are handed to the engine and rendered where it placed them", async () => {
  const engine = {
    calls: [],
    async layout(graph) {
      this.calls.push(graph);
      return {
        ...graph,
        width: 400,
        height: 300,
        children: graph.children.map((child, index) => ({ ...child, x: 10, y: 120 * index })),
        edges: graph.edges.map((edge) => ({
          ...edge,
          sections: [{ startPoint: { x: 80, y: 90 }, endPoint: { x: 80, y: 120 } }],
          labels: edge.labels?.map((label) => ({ ...label, x: 100, y: 95 }))
        }))
      };
    }
  };
  const shown = await layoutDiagram(model, { layoutEngine: engine, showEdgeLabels: true });
  const sent = engine.calls[0].edges[0].labels;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "goes");
  assert.ok(sent[0].width > 0 && sent[0].height > 0, "the engine gets a box to reserve");
  assert.deepEqual(sent[0].layoutOptions, { "elk.edgeLabels.inline": "true" }, "centre placement is inline by default");
  const key = [...shown.edgePaths.keys()][0];
  assert.deepEqual(shown.edgeLabelBoxes.get(key), { x: 132, y: 127, width: sent[0].width, height: 14 }, "the box comes back offset like the sections");
  const svg = renderDiagramSvg(model, shown, { showEdgeLabels: true });
  assert.ok(svg.includes(`<text class="map-edge-label" x="${(132 + sent[0].width / 2).toFixed(1)}" y="138.0" text-anchor="middle">goes</text>`), "the label is centred in the placed box");

  // Decision-style placement: the label sits beside the edge at its source, adding no layers.
  engine.calls.length = 0;
  await layoutDiagram(model, { layoutEngine: engine, showEdgeLabels: true, edgeLabelPlacement: "tail" });
  assert.deepEqual(engine.calls[0].edges[0].labels[0].layoutOptions, { "elk.edgeLabels.placement": "TAIL" });
  engine.calls.length = 0;
  await layoutDiagram(model, { layoutEngine: engine, showEdgeLabels: true, edgeLabelPlacement: "nonsense" });
  assert.deepEqual(engine.calls[0].edges[0].labels[0].layoutOptions, { "elk.edgeLabels.inline": "true" }, "an unknown placement falls back to centre");

  // A label the diagram will not show is not sent to the engine at all, and a layout without
  // boxes renders labels at the path midpoint exactly as before.
  engine.calls.length = 0;
  const hidden = await layoutDiagram(model, { layoutEngine: engine });
  assert.equal(engine.calls[0].edges[0].labels, undefined);
  assert.equal(hidden.edgeLabelBoxes.size, 0);
  const midpoint = renderDiagramSvg(model, hidden, { showEdgeLabels: true });
  assert.ok(midpoint.includes('class="map-edge-label"') && !midpoint.includes('text-anchor="middle"'), "midpoint placement without a box");
});
