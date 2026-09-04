// Node headers off + the colour key.
//
// Contract under test:
//   - `stereotypes: false` drops the «type» line and divider from component and table nodes, moves
//     the rest of the node up by the band, and shrinks measured node heights by the same amount;
//     the default stays byte-identical.
//   - `legend` entries render after the SVG as `.diagram-legend`, each swatch wearing the classes of
//     the node/edge it stands for; `legendVisible: false` renders it hidden; no entries → no markup.
//   - enablePanZoom adds a Key button when a legend is present; it toggles the legend and
//     aria-pressed, and the choice is remembered per diagram id in localStorage.

import test from "node:test";
import assert from "node:assert/strict";
import { enablePanZoom, layoutDiagram, renderDiagramLegend, renderDiagramSvg } from "../src/index.js";

const model = {
  id: "legend-test",
  title: "Legend",
  nodes: [
    { id: "a", title: "Alpha", type: "service", subtitle: "one" },
    { id: "t", title: "Table", type: "table", rows: [{ label: "id", value: "uuid" }] }
  ],
  edges: [{ from: "a", to: "t", type: "reads" }]
};

test("stereotypes off drops the «type» band and shrinks the nodes; the default is unchanged", async () => {
  const withBand = await layoutDiagram(model);
  const without = await layoutDiagram(model, { stereotypes: false });
  assert.equal(withBand.positions.get("a").height, 86);
  assert.equal(without.positions.get("a").height, 60);
  assert.equal(withBand.positions.get("t").height, 110);
  assert.equal(without.positions.get("t").height, 84);
  // The 86px floor has always won over compact's 72px base; without the band both land on 60.
  const compact = await layoutDiagram(model, { stereotypes: false, compact: true });
  assert.equal(compact.positions.get("a").height, 60);

  const svgWith = renderDiagramSvg(model, withBand);
  assert.match(svgWith, /<text class="map-node-stereotype" x="12" y="18">«service»<\/text>/);
  assert.match(svgWith, /<text class="map-node-title" x="12" y="48">Alpha<\/text>/);
  assert.match(svgWith, /<text class="schema-table-name map-node-title" x="14" y="43">Table<\/text>/);
  const svgWithout = renderDiagramSvg(model, without, { stereotypes: false });
  assert.doesNotMatch(svgWithout, /map-node-stereotype/);
  assert.doesNotMatch(svgWithout, /map-node-divider/);
  assert.match(svgWithout, /<text class="map-node-title" x="12" y="22">Alpha<\/text>/);
  assert.match(svgWithout, /<text class="map-node-meta" x="12" y="38">one<\/text>/);
  assert.match(svgWithout, /<text class="schema-table-name map-node-title" x="14" y="17">Table<\/text>/);
  assert.match(svgWithout, /x="14" y="26">id/, "table rows move up with the band");
  assert.ok(svgWithout.includes("«service»") === false);
});

test("the legend renders swatches in the nodes' and edges' own classes, after the SVG", async () => {
  const layout = await layoutDiagram(model);
  const plain = renderDiagramSvg(model, layout);
  assert.ok(plain.trimEnd().endsWith("</svg>"), "no legend option → nothing after the SVG");
  assert.equal(renderDiagramLegend({}), "");
  const legend = [
    { type: "service", label: "Service" },
    { type: "store", status: "degraded", label: "Degraded store" },
    { edge: { kind: "reads" }, label: "Reads" },
    { edge: { kind: "flow", flow: true }, label: "Flow" },
    { label: "" }
  ];
  const svg = renderDiagramSvg(model, layout, { legend, legendTitle: "What the colours mean" });
  const legendStart = svg.indexOf('<div class="diagram-legend"');
  assert.ok(legendStart > svg.indexOf("</svg>"), "the legend follows the SVG");
  assert.match(svg, /<div class="diagram-legend" role="group" aria-label="What the colours mean"><div class="diagram-legend-title">What the colours mean<\/div><ul class="diagram-legend-list">/);
  assert.match(svg, /<li class="diagram-legend-item"><span class="diagram-legend-chip"><svg class="diagram-legend-chip-bg" aria-hidden="true"><g class="map-node component-node node-type-service"><rect width="100%" height="100%" rx="5"><\/rect><\/g><\/svg><span class="diagram-legend-label">Service<\/span><\/span><\/li>/, "a node entry is a chip with the label inside the node-coloured box");
  assert.match(svg, /<g class="map-node component-node node-type-store component-status-degraded">/);
  assert.match(svg, /<path class="map-edge edge-kind-reads edge-flavor-reads" d="M 1 7 L 21 7"><\/path>/);
  assert.match(svg, /<path class="map-edge edge-kind-flow edge-flavor-flow map-edge-flow"/);
  assert.equal((svg.match(/diagram-legend-item/g) ?? []).length, 4, "an entry without a label is skipped");
  assert.doesNotMatch(svg, / on[a-z]+=/, "nothing the DOM-replacement guard would refuse");
  const hidden = renderDiagramLegend({ legend, legendVisible: false });
  assert.match(hidden, /^<div class="diagram-legend" role="group" aria-label="Key" hidden="">/);
});

function fakeElement(tag) {
  return {
    tag, style: {}, attributes: new Map(), handlers: new Map(), children: [], className: "", textContent: "", hidden: false,
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    addEventListener(type, handler) { this.handlers.set(type, handler); },
    removeEventListener(type) { this.handlers.delete(type); },
    appendChild(child) { this.children.push(child); return child; },
    remove() {}
  };
}

test("pan/zoom adds a Key button that toggles the legend and remembers the choice", () => {
  const stored = new Map();
  const win = {
    localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ position: "static" })
  };
  const doc = { defaultView: win, createElement: (tag) => fakeElement(tag) };
  const svg = fakeElement("svg");
  svg.attributes.set("viewBox", "0 0 100 100");
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  const legendEl = fakeElement("div");
  const container = {
    style: {}, ownerDocument: doc, children: [],
    querySelector: (selector) => (selector === ".diagram-legend" ? legendEl : svg),
    appendChild(child) { this.children.push(child); return child; }
  };
  const cleanup = enablePanZoom(container, { diagramId: "legend-test" });
  const controls = container.children[0];
  const key = controls.children.find((child) => child.className.includes("diagram-panzoom-key"));
  assert.ok(key, "a Key button joins + − ⤢");
  assert.equal(controls.children.length, 4);
  assert.equal(key.textContent, "Key");
  assert.equal(key.getAttribute("aria-pressed"), "true", "the legend starts shown");
  key.handlers.get("click")({ preventDefault() {} });
  assert.equal(legendEl.hidden, true);
  assert.equal(key.getAttribute("aria-pressed"), "false");
  assert.equal(stored.get("graphpaper.legend.legend-test"), "hidden");
  key.handlers.get("click")({ preventDefault() {} });
  assert.equal(legendEl.hidden, false);
  assert.equal(stored.get("graphpaper.legend.legend-test"), "shown");
  cleanup();

  // A remembered choice applies when the diagram is bound again.
  stored.set("graphpaper.legend.legend-test", "hidden");
  legendEl.hidden = false;
  container.children.length = 0;
  const cleanupAgain = enablePanZoom(container, { diagramId: "legend-test" });
  assert.equal(legendEl.hidden, true, "remembered hidden");
  assert.equal(container.children[0].children.find((child) => child.className.includes("diagram-panzoom-key")).getAttribute("aria-pressed"), "false");
  cleanupAgain();

  // Without a legend there is no Key button.
  const bare = { style: {}, ownerDocument: doc, children: [], querySelector: (selector) => (selector === ".diagram-legend" ? null : svg), appendChild(child) { this.children.push(child); return child; } };
  enablePanZoom(bare, { diagramId: "bare" });
  assert.equal(bare.children[0].children.length, 3);
});
