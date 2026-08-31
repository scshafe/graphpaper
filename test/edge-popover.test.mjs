// Edge annotations — render stamps + hover/focus popovers for EDGES.
//
// Contract under test:
//   - renderDiagramSvg stamps EVERY edge group with data-diagram-edge (previously staged-only),
//     makes it keyboard-focusable, and adds a wide transparent map-edge-hit twin of the path so
//     a 2px stroke is actually hoverable.
//   - bindDiagramPopovers resolves a hover/focus on an edge group to a synthesized popover model:
//     kicker "From → To", title = label, the colloquial description, and type/kind/flavor rows.
//     The same dwell/immediate-focus rules as nodes apply; node popovers are unaffected.
//   - The binder's edge keying agrees with the renderer's stamp (edgeKey over validEdges order),
//     including for edges without an explicit id.

import test from "node:test";
import assert from "node:assert/strict";
import {
  bindDiagramPopovers,
  renderDiagramSvg,
} from "../src/index.js";

// ---- Fake layout (mirrors scope-linking.test.mjs) ---------------------------
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

// ---- Fake DOM (mirrors popover-hover-debounce.test.mjs) ---------------------
function makeEnv() {
  const timers = [];
  let nextTimerId = 1;
  const win = {
    innerWidth: 1024,
    innerHeight: 768,
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.push({ id, fn, delay });
      return id;
    },
    clearTimeout(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };

  const doc = {
    defaultView: win,
    body: null,
    createElement: (tag) => makeEl(tag),
    querySelector: (sel) => (sel === "#diagram-node-popover" ? findById(doc.body, "diagram-node-popover") : null),
  };
  win.document = doc;

  function makeEl(tagName) {
    const listeners = Object.create(null);
    const attrs = Object.create(null);
    const el = {
      tagName,
      ownerDocument: doc,
      parentNode: null,
      children: [],
      id: "",
      className: "",
      hidden: true,
      dataset: {},
      style: {},
      offsetWidth: 360,
      offsetHeight: 220,
      _text: "",
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      removeAttribute: (k) => { delete attrs[k]; },
      append: (child) => { el.children.push(child); if (child) child.parentNode = el; },
      appendChild: (child) => { el.append(child); return child; },
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      removeEventListener: (type, fn) => {
        const a = listeners[type];
        if (!a) return;
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      },
      dispatch: (type, ev = {}) => {
        for (const fn of (listeners[type] || []).slice()) fn({ target: el, relatedTarget: null, ...ev });
      },
      contains: (x) => { let c = x; while (c) { if (c === el) return true; c = c.parentNode; } return false; },
      getBoundingClientRect: () => ({ left: 10, right: 60, top: 20, bottom: 50, width: 50, height: 30 }),
      querySelector: () => null,
    };
    Object.defineProperty(el, "textContent", {
      get: () => el._text,
      set: (v) => { el.children = []; el._text = v; },
    });
    return el;
  }

  function findById(root, id) {
    if (!root) return null;
    if (root.id === id) return root;
    for (const child of root.children || []) {
      const hit = findById(child, id);
      if (hit) return hit;
    }
    return null;
  }

  doc.body = makeEl("body");
  const container = makeEl("div");
  const stamp = (attr, id) => {
    const g = makeEl("g");
    g.setAttribute(attr, id);
    g.parentNode = container;
    container.children.push(g);
    return g;
  };

  return {
    doc,
    win,
    container,
    makeNode: (id) => stamp("data-diagram-node", id),
    makeEdge: (key) => stamp("data-diagram-edge", key),
    timers,
    flush() {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    },
    popover: () => doc.querySelector("#diagram-node-popover"),
  };
}

function collectText(el) {
  if (!el) return "";
  const own = el._text ?? "";
  return [own, ...(el.children ?? []).map(collectText)].filter(Boolean).join(" ");
}

function findByClass(root, className) {
  if (!root) return null;
  if (typeof root.className === "string" && root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const hit = findByClass(child, className);
    if (hit) return hit;
  }
  return null;
}

const DIAGRAM = {
  id: "d-edges",
  title: "Edge annotations",
  kind: "architecture",
  nodes: [
    { id: "a", title: "Alpha", type: "service" },
    { id: "b", title: "Beta", type: "database" }
  ],
  edges: [{
    id: "e1",
    from: "a",
    to: "b",
    type: "sibling_of",
    label: "writes settlements",
    description: "Alpha records every settled turn in Beta so replays stay idempotent.",
    metadata: { kind: "sibling_of", flavor: "writes" }
  }]
};

// ---- Render stamps ----------------------------------------------------------

test("render: every edge group is stamped, focusable, and carries a wide hit path (no stages needed)", () => {
  const svg = renderDiagramSvg(DIAGRAM, fakeLayout(DIAGRAM), {});
  assert.match(svg, /data-diagram-edge="e1"/, "un-staged diagrams stamp edges now");
  const edgeGroup = svg.slice(svg.indexOf('data-diagram-edge="e1"') - 400, svg.indexOf("</g>"));
  assert.match(svg, /<g class="map-edge-group[^"]*"[^>]*data-diagram-edge="e1"[^>]*tabindex="0"/u, "edge group is keyboard-focusable");
  assert.match(svg, /aria-label="Alpha · → · Beta · writes settlements[^"]*Hover or focus to inspect details\."/u, "edge group announces its relationship");
  const hitCount = (svg.match(/class="map-edge-hit"/g) ?? []).length;
  assert.equal(hitCount, 1, "one transparent hit twin per edge");
  assert.match(svg, /<path class="map-edge-hit" d="[^"]+" pointer-events="stroke"><\/path>\s*<path class="map-edge /u, "hit path precedes the visible path");
  assert.ok(edgeGroup.length > 0);
});

test("render: an id-less edge stamps the derived key the binder also computes", () => {
  const diagram = {
    ...DIAGRAM,
    edges: [{ from: "a", to: "b", type: "calls" }]
  };
  const svg = renderDiagramSvg(diagram, fakeLayout(diagram), {});
  // The markup HTML-escapes ">" — the parsed DOM attribute yields "a->b:calls:0", which is
  // exactly the key the binder computes (see the id-less behavioral test below).
  assert.match(svg, /data-diagram-edge="a-&gt;b:calls:0"/u);
});

// ---- Popover behavior -------------------------------------------------------

test("hover an edge: popover appears after the dwell with kicker, label, description, and flavor", () => {
  const env = makeEnv();
  const e1 = env.makeEdge("e1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: e1 });
  assert.equal(env.popover(), null, "nothing before the dwell");
  env.flush();
  const popover = env.popover();
  assert.ok(popover, "popover exists after the dwell");
  assert.equal(popover.hidden, false);
  const text = collectText(popover);
  assert.match(text, /Alpha → Beta/, "kicker names the endpoints");
  assert.match(text, /writes settlements/, "title is the edge label");
  assert.match(text, /replays stay idempotent/, "colloquial description renders");
  assert.match(text, /flavor/, "flavor row present");
  assert.ok(findByClass(popover, "diagram-popover-description"), "description uses the dedicated element");
  assert.equal(e1.getAttribute("aria-describedby"), "diagram-node-popover");
});

test("focus an edge: popover shows immediately (keyboard users never wait)", () => {
  const env = makeEnv();
  const e1 = env.makeEdge("e1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("focusin", { target: e1 });
  const popover = env.popover();
  assert.ok(popover);
  assert.equal(popover.hidden, false);
  assert.match(collectText(popover), /Alpha → Beta/);
});

test("leaving an edge before its dwell elapses shows nothing", () => {
  const env = makeEnv();
  const e1 = env.makeEdge("e1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: e1 });
  env.container.dispatch("pointerout", { target: e1 });
  env.flush();
  const popover = env.popover();
  assert.ok(!popover || popover.hidden, "cancelled dwell never shows");
});

test("an id-less edge resolves through the same derived key the renderer stamps", () => {
  const diagram = { ...DIAGRAM, edges: [{ from: "a", to: "b", type: "calls", description: "plain call" }] };
  const env = makeEnv();
  const edge = env.makeEdge("a->b:calls:0");
  bindDiagramPopovers(env.container, diagram, { showPopovers: true, popoverHoverDelayMs: 0 });

  env.container.dispatch("pointerover", { target: edge });
  const popover = env.popover();
  assert.ok(popover);
  assert.equal(popover.hidden, false);
  assert.match(collectText(popover), /plain call/);
});

test("node popovers are unaffected: a node hover still resolves to the node model", () => {
  const env = makeEnv();
  const n = env.makeNode("a");
  env.makeEdge("e1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 0 });

  env.container.dispatch("pointerover", { target: n });
  const popover = env.popover();
  assert.ok(popover);
  assert.match(collectText(popover), /Alpha/);
  assert.doesNotMatch(collectText(popover), /Alpha → Beta/, "node popover, not the edge model");
});
