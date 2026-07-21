// P1 scope-linking — zero-dependency behavior suite (node:test + node:assert/strict only).
//
// These tests drive the PURE renderer (`renderDiagramSvg`) with a hand-built fake `layout`
// object — no ELK, no DOM. They lock the two load-bearing contracts:
//   1. BYTE-IDENTICAL WHEN OFF: no boundary markup leaks unless a level is a nested scope child
//      under drillDown with scopeExitOnBackground on.
//   2. The boundary renders exactly once (one exit backdrop, one frame, one parent-titled label)
//      and is SVG-safe.
// Plus unit tests for `scopeExitTargetFor` against fake ancestor chains (no real DOM).

import test from "node:test";
import assert from "node:assert/strict";

import {
  renderDiagramSvg,
  scopeExitTargetFor,
  scopeExitOneLevelDepth,
  assertDiagramSvgMarkupSafeForDomReplacement
} from "../src/index.js";

// ---- Fake layout builder ----------------------------------------------------
// renderDiagramSvg reads: layout.width, layout.height, layout.positions (Map id→{x,y,width,
// height,centerX,centerY}), layout.edgePaths (Map), layout.containmentDepths (optional Map),
// layout.drawHierarchyEdges, layout.sourceLabel. Build the minimum it touches.
function fakeLayout(diagram, { width = 400, height = 300 } = {}) {
  const positions = new Map();
  let y = 40;
  for (const node of diagram.nodes ?? []) {
    const w = 160;
    const h = 90;
    const x = 40;
    positions.set(node.id, { x, y, width: w, height: h, centerX: x + w / 2, centerY: y + h / 2 });
    y += h + 30;
  }
  return {
    width,
    height,
    positions,
    edgePaths: new Map(),
    containmentDepths: new Map(),
    drawHierarchyEdges: true,
    sourceLabel: "test layout"
  };
}

function baseDiagram(extraMetadata) {
  return {
    id: "d1",
    title: "Sample",
    kind: "architecture",
    nodes: [
      { id: "a", title: "Alpha", type: "service", metadata: { scopeRef: "child-a" } },
      { id: "b", title: "Beta", type: "service" }
    ],
    edges: [{ from: "a", to: "b", type: "calls" }],
    ...(extraMetadata ? { metadata: extraMetadata } : {})
  };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  for (;;) {
    const at = haystack.indexOf(needle, index);
    if (at === -1) return count;
    count += 1;
    index = at + needle.length;
  }
}

// ---- 1. BYTE-IDENTICAL WHEN OFF ---------------------------------------------

test("drillDown:false is byte-identical to a baseline and emits no boundary markup", () => {
  const diagram = baseDiagram();
  const layout = fakeLayout(diagram);
  const baseline = renderDiagramSvg(diagram, layout, {});
  const withDrillOff = renderDiagramSvg(diagram, layout, { drillDown: false });
  assert.equal(withDrillOff, baseline);
  assert.ok(!baseline.includes("data-diagram-scope-exit"), "no exit backdrop with drillDown off");
  assert.ok(!baseline.includes("diagram-scope-boundary"), "no boundary frame with drillDown off");
});

test("a ROOT model (no metadata.scopeOf) renders identically under drillDown:true vs false", () => {
  const diagram = baseDiagram(); // no scopeOf → this is a top-level model
  const layout = fakeLayout(diagram);
  const off = renderDiagramSvg(diagram, layout, { drillDown: false });
  const on = renderDiagramSvg(diagram, layout, { drillDown: true });
  // drillDown:true still adds the dig-in glyph for scoped node "a", so on != off in general —
  // but the SCOPE-BOUNDARY markup must not leak on a root level.
  assert.ok(!on.includes("data-diagram-scope-exit"), "root level under drillDown emits no exit backdrop");
  assert.ok(!on.includes("diagram-scope-boundary"), "root level under drillDown emits no boundary frame");
  // And the glyph difference is the ONLY scope difference — the boundary is absent from both.
  assert.ok(!off.includes("diagram-scope-boundary"));
});

test("scopeExitOnBackground:false suppresses the boundary on a nested child", () => {
  const child = baseDiagram({ scopeOf: "parent-node", scopeOfTitle: "Parent Thing" });
  const layout = fakeLayout(child);
  const suppressed = renderDiagramSvg(child, layout, { drillDown: true, scopeExitOnBackground: false });
  assert.ok(!suppressed.includes("data-diagram-scope-exit"), "no backdrop when scopeExitOnBackground:false");
  assert.ok(!suppressed.includes("diagram-scope-boundary"), "no frame when scopeExitOnBackground:false");
});

// ---- 2. BOUNDARY RENDERS ----------------------------------------------------

test("a nested child (metadata.scopeOf) under drillDown emits exactly one boundary + label", () => {
  const child = baseDiagram({ scopeOf: "parent-node", scopeOfTitle: "Parent Thing" });
  const layout = fakeLayout(child, { width: 500, height: 360 });
  const svg = renderDiagramSvg(child, layout, { drillDown: true });

  // Exactly one exit backdrop.
  assert.equal(countOccurrences(svg, "data-diagram-scope-exit=\"1\""), 1, "exactly one exit backdrop");
  assert.ok(svg.includes("class=\"diagram-scope-exit-backdrop\""));
  // The backdrop spans the full viewBox.
  assert.ok(svg.includes(`width="${layout.width}"`) && svg.includes(`height="${layout.height}"`));
  assert.ok(svg.includes("fill=\"transparent\""));

  // Exactly one visible frame.
  assert.equal(countOccurrences(svg, "class=\"diagram-scope-boundary\""), 1, "exactly one frame");
  // Inset = DEFAULT_LAYOUT_PADDING/2 = 16 (frame is aria-hidden decoration per §2.2).
  assert.ok(svg.includes("class=\"diagram-scope-boundary\" aria-hidden=\"true\" pointer-events=\"none\" x=\"16\" y=\"16\""));

  // The label chip carries the parent scope title.
  assert.ok(svg.includes("class=\"diagram-scope-boundary-label\""));
  assert.ok(svg.includes("class=\"diagram-scope-boundary-label-text\""));
  assert.ok(svg.includes("Parent Thing"), "label names the scopeOfTitle");
  assert.ok(svg.includes("click outside to zoom out"), "label carries the exit hint");
});

test("the boundary falls back to 'parent scope' when only scopeOf is stamped", () => {
  const child = baseDiagram({ scopeOf: "parent-node" }); // no scopeOfTitle
  const layout = fakeLayout(child);
  const svg = renderDiagramSvg(child, layout, { drillDown: true });
  assert.ok(svg.includes("data-diagram-scope-exit"), "boundary still renders");
  assert.ok(svg.includes("parent scope"), "falls back to 'parent scope'");
});

test("a long parent title is truncated by shortRef (≤ 32 chars + ellipsis)", () => {
  const longTitle = "X".repeat(80);
  const child = baseDiagram({ scopeOf: "parent-node", scopeOfTitle: longTitle });
  const layout = fakeLayout(child);
  const svg = renderDiagramSvg(child, layout, { drillDown: true });
  assert.ok(!svg.includes("X".repeat(40)), "the full 80-char title is not emitted verbatim");
  assert.ok(svg.includes("X".repeat(32) + "…"), "truncated to 32 chars + ellipsis");
});

test("scopeOfTitle is HTML-escaped in the boundary label", () => {
  const child = baseDiagram({ scopeOf: "parent-node", scopeOfTitle: "<script>&\"'" });
  const layout = fakeLayout(child);
  const svg = renderDiagramSvg(child, layout, { drillDown: true });
  assert.ok(!svg.includes("<script>&\"'"), "raw dangerous title is not present");
  assert.ok(svg.includes("&lt;script&gt;"), "angle brackets escaped");
});

// The backdrop + frame are decorative (aria-hidden) per the locked design §2.2. The parent <svg>
// is role="img" (which already collapses descendants), but the attribute is asserted so a future
// edit can't silently regress the documented decoration contract.
test("the exit backdrop and boundary frame are aria-hidden decoration", () => {
  const child = baseDiagram({ scopeOf: "parent-node", scopeOfTitle: "Parent Thing" });
  const svg = renderDiagramSvg(child, fakeLayout(child), { drillDown: true });
  assert.ok(
    svg.includes("class=\"diagram-scope-exit-backdrop\" aria-hidden=\"true\""),
    "exit backdrop carries aria-hidden"
  );
  assert.ok(
    svg.includes("class=\"diagram-scope-boundary\" aria-hidden=\"true\""),
    "boundary frame carries aria-hidden"
  );
});

// STRUCTURAL INVARIANT (the sole reason scopeExitTargetFor's DOM-ancestry discrimination is safe):
// the backdrop must be a SIBLING emitted BETWEEN </g class=map-edges> and <g class=map-nodes>, so
// it paints below every node yet is never a node's ancestor. Guard the injection point against a
// future edit moving it above the nodes (which would make empty-canvas exit swallow node clicks).
test("the exit backdrop is a sibling between map-edges and map-nodes (never a node ancestor)", () => {
  const child = baseDiagram({ scopeOf: "parent-node", scopeOfTitle: "Parent Thing" });
  const svg = renderDiagramSvg(child, fakeLayout(child), { drillDown: true });
  const edgesClose = svg.indexOf("</g>", svg.indexOf("class=\"map-edges\""));
  const backdropAt = svg.indexOf("data-diagram-scope-exit");
  const nodesOpen = svg.indexOf("class=\"map-nodes\"");
  assert.ok(edgesClose !== -1 && backdropAt !== -1 && nodesOpen !== -1, "all three anchors present");
  assert.ok(backdropAt > edgesClose, "backdrop comes after the map-edges group closes");
  assert.ok(backdropAt < nodesOpen, "backdrop comes before the map-nodes group opens");
});

// ---- 3. SVG-SAFETY ----------------------------------------------------------

test("the injected boundary markup passes the SVG-safety scanner", () => {
  const child = baseDiagram({ scopeOf: "parent-node", scopeOfTitle: "Parent Thing" });
  const layout = fakeLayout(child);
  const svg = renderDiagramSvg(child, layout, { drillDown: true });
  // Must not throw — no <script>/<foreignObject>, no on*, no javascript:/data: URLs.
  assert.doesNotThrow(() => assertDiagramSvgMarkupSafeForDomReplacement(svg));
  // Even an adversarial title stays safe (escaping neutralizes it).
  const evil = baseDiagram({ scopeOf: "p", scopeOfTitle: "\" onload=\"alert(1)" });
  const evilSvg = renderDiagramSvg(evil, fakeLayout(evil), { drillDown: true });
  assert.doesNotThrow(() => assertDiagramSvgMarkupSafeForDomReplacement(evilSvg));
});

// ---- 4. scopeExitTargetFor (fake ancestor chains, no real DOM) --------------

// A minimal fake element: getAttribute(name) reads from `attrs`, parentNode walks up.
function fakeEl(attrs = {}, parentNode = null) {
  return { getAttribute: (name) => (name in attrs ? attrs[name] : null), parentNode };
}

test("scopeExitTargetFor returns the backdrop element for a backdrop target", () => {
  const container = fakeEl({});
  const backdrop = fakeEl({ "data-diagram-scope-exit": "1" }, container);
  assert.equal(scopeExitTargetFor(backdrop, container), backdrop);
});

test("scopeExitTargetFor walks ancestors to reach the backdrop", () => {
  const container = fakeEl({});
  const backdrop = fakeEl({ "data-diagram-scope-exit": "1" }, container);
  const inner = fakeEl({}, backdrop);
  assert.equal(scopeExitTargetFor(inner, container), backdrop);
});

test("scopeExitTargetFor returns null when a data-diagram-node ancestor is hit first", () => {
  const container = fakeEl({});
  const nodeGroup = fakeEl({ "data-diagram-node": "a" }, container);
  const rect = fakeEl({}, nodeGroup); // click on a node's inner rect
  assert.equal(scopeExitTargetFor(rect, container), null);
});

test("scopeExitTargetFor returns null when a data-diagram-scope-enter ancestor is hit first", () => {
  const container = fakeEl({});
  const glyph = fakeEl({ "data-diagram-scope-enter": "a" }, container);
  const glyphText = fakeEl({}, glyph);
  assert.equal(scopeExitTargetFor(glyphText, container), null);
});

test("scopeExitTargetFor returns null at the container root (empty chain)", () => {
  const container = fakeEl({});
  assert.equal(scopeExitTargetFor(container, container), null);
  // A bare target with no exit attr and container as parent → null.
  const bare = fakeEl({}, container);
  assert.equal(scopeExitTargetFor(bare, container), null);
});

test("a node click wins even if a backdrop is a further ancestor (node short-circuits)", () => {
  const container = fakeEl({});
  const backdrop = fakeEl({ "data-diagram-scope-exit": "1" }, container);
  const nodeGroup = fakeEl({ "data-diagram-node": "a" }, backdrop);
  const rect = fakeEl({}, nodeGroup);
  assert.equal(scopeExitTargetFor(rect, container), null);
});

// ---- 5. one-level-pop depth math (pure) -------------------------------------
// The background-click / Escape gesture pops EXACTLY ONE level. exitToScopeDepth slices the stack
// to depth+1, so a one-level pop off a stack of length N targets depth N-2. Lock that arithmetic.
test("scopeExitOneLevelDepth pops exactly one level (N -> N-2 target depth)", () => {
  // depth 1 (root only) is never popped by the gesture (guarded by stack.length <= 1), but the
  // arithmetic still holds; the guard lives in the handler, not the math.
  assert.equal(scopeExitOneLevelDepth(2), 0, "one child -> back to root (depth 0)");
  assert.equal(scopeExitOneLevelDepth(3), 1, "two levels deep -> back to depth 1");
  assert.equal(scopeExitOneLevelDepth(4), 2, "three levels deep -> back to depth 2");
  // Depth-agnostic: each successive level pops exactly one frame (target depth drops by 1).
  for (let n = 2; n <= 8; n += 1) {
    assert.equal(scopeExitOneLevelDepth(n) + 1, n - 1, "target keeps exactly the parent's frames");
  }
});

// ---- 6. falsy-but-non-null scopeRootId consistency --------------------------
// scopedNodeClass / scopeAffordanceMarkup use `scopeRootId != null` (matching the boundary gate),
// so a degenerate scope-root id of "" / 0 / false still suppresses that node's own self-drill glyph
// AND renders the boundary — the level is uniformly treated as a scope child on all three sites.
for (const degenerateId of ["", 0, false]) {
  test(`falsy-but-non-null scopeOf (${JSON.stringify(degenerateId)}) suppresses the self-drill glyph`, () => {
    const child = {
      id: "d1",
      title: "Sample",
      kind: "architecture",
      // The scope root node carries that degenerate id AND a scopeRef, so absent suppression it
      // would emit its own dig-in glyph. Suppression must win.
      nodes: [
        { id: degenerateId, title: "Root Node", type: "service", metadata: { scopeRef: "child-x" } },
        { id: "b", title: "Beta", type: "service", metadata: { scopeRef: "child-y" } }
      ],
      edges: [],
      metadata: { scopeOf: degenerateId, scopeOfTitle: "Parent" }
    };
    const layout = fakeLayout(child);
    const svg = renderDiagramSvg(child, layout, { drillDown: true });
    // The boundary renders (this level IS a scope child).
    assert.ok(svg.includes("data-diagram-scope-exit"), "boundary renders for a falsy-but-non-null scopeOf");
    // The scope-root node's OWN dig-in glyph is suppressed; only sibling "b" keeps its glyph.
    assert.equal(
      countOccurrences(svg, "data-diagram-scope-enter"),
      1,
      "only the non-root scoped node keeps its dig-in glyph"
    );
    assert.ok(svg.includes("data-diagram-scope-enter=\"b\""), "sibling b keeps its glyph");
  });
}
