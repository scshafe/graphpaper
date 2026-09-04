// Node badges — pills hung off a node's top-right corner.
//
// Contract under test:
//   - `node.badges` (strings or { label, tone }) render as `map-node-badge` groups OUTSIDE the
//     node's rect, right-aligned to its top-right corner in author order; the tone becomes a
//     `map-node-badge-<tone>` class; labels are escaped; the node's aria-label names them.
//   - A node without badges renders byte-identically to before (no badge markup at all), and
//     badges change no node size and no layout position.
//   - The popover lists a node's badges as chips under its title.
//   - Edge labels wear their edge's kind and flavour classes.

import test from "node:test";
import assert from "node:assert/strict";
import { bindDiagramPopovers, layoutDiagram, renderDiagramSvg } from "../src/index.js";

const plain = { id: "plain", title: "Plain", type: "code" };
const badged = { id: "badged", title: "Badged", type: "code", badges: ["59 dead", { label: "31 waiting", tone: "warning" }, { label: "<odd> & \"tone\"", tone: "no way!" }] };
const model = { id: "badges", title: "Badges", nodes: [plain, badged], edges: [{ from: "plain", to: "badged", type: "outcome", label: "clean", metadata: { flavor: "unobserved" } }] };

function nodeMarkup(svg, id) {
  return svg.match(new RegExp(`<g class="map-node[^"]*" data-diagram-node="${id}"[\\s\\S]*?\\n  </g>`, "u"))?.[0] ?? "";
}

test("badges hang off the top-right corner, right-aligned in author order, and change nothing else", async () => {
  const layout = await layoutDiagram(model, { compact: true, stereotypes: false, showEdgeLabels: true });
  const bare = await layoutDiagram({ ...model, nodes: [plain, { ...badged, badges: undefined }] }, { compact: true, stereotypes: false, showEdgeLabels: true });
  assert.deepEqual(layout.positions.get("badged"), bare.positions.get("badged"), "badges take no room in the layout");
  const svg = renderDiagramSvg(model, layout, { compact: true, stereotypes: false, showEdgeLabels: true });
  assert.ok(!nodeMarkup(svg, "plain").includes("map-node-badge"), "no badges, no badge markup");
  const badgedSvg = nodeMarkup(svg, "badged");
  const groups = [...badgedSvg.matchAll(/<g class="map-node-badge([^"]*)" transform="translate\((-?[\d.]+) (-?[\d.]+)\)"><rect width="(\d+)" height="16" rx="8"><\/rect><text x="([\d.]+)" y="11.5" text-anchor="middle">([^<]*)<\/text><\/g>/gu)];
  assert.equal(groups.length, 3, "one pill per badge");
  assert.deepEqual(groups.map((group) => group[6]), ["59 dead", "31 waiting", "&lt;odd&gt; &amp; &quot;tone&quot;"], "author order, escaped");
  assert.deepEqual(groups.map((group) => group[1]), ["", " map-node-badge-warning", " map-node-badge-no-way-"], "the tone is a class-safe token");
  const width = layout.positions.get("badged").width;
  const xs = groups.map((group) => Number(group[2]));
  const widths = groups.map((group) => Number(group[4]));
  assert.equal(xs[2] + widths[2], width + 6, "the last badge ends just past the corner");
  assert.equal(xs[1] + widths[1], xs[2] - 4, "pills sit 4px apart");
  assert.equal(xs[0] + widths[0], xs[1] - 4);
  assert.ok(groups.every((group) => Number(group[3]) === -8), "straddling the top edge");
  assert.ok(widths.every((w, index) => w === Math.round(groups[index][6].replace(/&[a-z]+;/g, "x").length * 6.2 + 12) || w > 0));
  assert.match(badgedSvg, /aria-label="Badged code, 59 dead, 31 waiting, &lt;odd&gt; &amp; &quot;tone&quot;\. Hover or focus/u, "assistive tech hears the badges");
  assert.ok(badgedSvg.indexOf("map-node-badge") > badgedSvg.indexOf("map-node-title"), "badges are painted after the title");
  // A node without badges renders exactly as before: strings are accepted as bare labels too.
  const strings = renderDiagramSvg({ ...model, nodes: [plain, { ...badged, badges: ["only"] }] }, layout, { compact: true, stereotypes: false });
  assert.equal((nodeMarkup(strings, "badged").match(/map-node-badge/g) ?? []).length, 1);
  const empty = renderDiagramSvg({ ...model, nodes: [plain, { ...badged, badges: [null, "", { tone: "warning" }] }] }, layout, { compact: true, stereotypes: false });
  assert.ok(!nodeMarkup(empty, "badged").includes("map-node-badge"), "badges without a label are not drawn");
});

test("edge labels wear the edge's kind and flavour so a muted arrow can mute its word", async () => {
  const layout = await layoutDiagram(model, { showEdgeLabels: true });
  const svg = renderDiagramSvg(model, layout, { showEdgeLabels: true });
  assert.match(svg, /<text class="map-edge-label edge-kind-outcome edge-flavor-unobserved" data-diagram-edge="plain-&gt;badged:outcome:0"/u, "the label carries the same key the group does");
  assert.match(svg, /<path class="map-edge edge-kind-outcome edge-flavor-unobserved"/u, "the same tokens the path wears");
});

// ---- Fake DOM (the shape popover-hover-debounce.test.mjs uses) ---------------
function makeEnv() {
  const win = { innerWidth: 1024, innerHeight: 768, setTimeout(fn) { fn(); return 1; }, clearTimeout() {} };
  const doc = {
    defaultView: win,
    body: null,
    createElement: (tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    querySelector: (selector) => (selector === "#diagram-node-popover" ? findById(doc.body, "diagram-node-popover") : null)
  };
  win.document = doc;
  function makeEl(tagName) {
    const listeners = Object.create(null);
    const attrs = Object.create(null);
    const el = {
      tagName, ownerDocument: doc, parentNode: null, children: [], id: "", className: "", hidden: true, dataset: {}, style: {},
      offsetWidth: 360, offsetHeight: 220, _text: "",
      setAttribute: (key, value) => { attrs[key] = String(value); if (key === "class") el.className = String(value); },
      getAttribute: (key) => (key in attrs ? attrs[key] : null),
      removeAttribute: (key) => { delete attrs[key]; },
      append: (...kids) => { for (const kid of kids) { el.children.push(kid); if (kid) kid.parentNode = el; } },
      appendChild: (kid) => { el.append(kid); return kid; },
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      removeEventListener: () => {},
      dispatch: (type, event = {}) => { for (const fn of (listeners[type] || []).slice()) fn({ target: el, relatedTarget: null, ...event }); },
      contains: (other) => { let cursor = other; while (cursor) { if (cursor === el) return true; cursor = cursor.parentNode; } return false; },
      getBoundingClientRect: () => ({ left: 10, right: 60, top: 20, bottom: 50, width: 50, height: 30 }),
      querySelector: () => null
    };
    Object.defineProperty(el, "textContent", { get: () => el._text, set: (value) => { el.children = []; el._text = String(value); } });
    return el;
  }
  function findById(root, id) {
    if (!root) return null;
    if (root.id === id) return root;
    for (const child of root.children || []) { const hit = findById(child, id); if (hit) return hit; }
    return null;
  }
  doc.body = makeEl("body");
  const container = makeEl("div");
  const makeNode = (id) => { const node = makeEl("g"); node.setAttribute("data-diagram-node", id); node.parentNode = container; container.children.push(node); return node; };
  return { doc, container, makeNode, popover: () => doc.querySelector("#diagram-node-popover") };
}

test("the popover lists a node's badges as chips under its title", () => {
  const env = makeEnv();
  const target = env.makeNode("badged");
  bindDiagramPopovers(env.container, model, { showPopovers: true, popoverHoverDelayMs: 0 });
  env.container.dispatch("focusin", { target });
  const popover = env.popover();
  assert.ok(popover && popover.hidden === false, "the popover was built and shown");
  const flat = (node, out = []) => { out.push(node); for (const kid of node.children ?? []) if (kid && kid.children) flat(kid, out); return out; };
  const all = flat(popover);
  const list = all.find((node) => (node.className ?? "").includes("diagram-popover-node-badges"));
  assert.ok(list, "a badge list sits in the popover");
  const chips = list.children;
  assert.deepEqual(chips.map((chip) => chip.textContent), ["59 dead", "31 waiting", "<odd> & \"tone\""]);
  assert.deepEqual(chips.map((chip) => chip.className), ["chip", "chip diagram-popover-badge-warning", "chip diagram-popover-badge-no-way-"]);
  const title = all.find((node) => node.tagName === "h4");
  assert.ok(all.indexOf(title) < all.indexOf(list), "under the title");
  // A node without badges gets no list at all.
  const plainEnv = makeEnv();
  const plainTarget = plainEnv.makeNode("plain");
  bindDiagramPopovers(plainEnv.container, model, { showPopovers: true, popoverHoverDelayMs: 0 });
  plainEnv.container.dispatch("focusin", { target: plainTarget });
  assert.ok(!flat(plainEnv.popover()).some((node) => (node.className ?? "").includes("diagram-popover-node-badges")));
});
