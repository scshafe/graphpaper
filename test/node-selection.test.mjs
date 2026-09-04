// Node selection — one node picked at a time, marked, and reported to the host.
//
// Contract under test:
//   - OFF BY DEFAULT: without `onNodeSelect` nothing binds, no node is marked, and the rendered
//     markup is byte-identical.
//   - A click (or Enter / Space on a focused node) selects exactly one node: it wears
//     `diagram-node-selected` + `aria-current="true"`, every other node wears neither, and the
//     host hears `{ nodeId, node, previousNodeId, source }`.
//   - Re-picking the selected node is a no-op and does NOT call back.
//   - Escape and a click on empty canvas clear it. A drag-to-pan that ends over a node does not
//     select.
//   - Under drillDown, selection is the INNER gesture: Escape / background clear a selection
//     before they pop a scope level (observable: the handler consumes the event via
//     preventDefault only when it acted). The "dig in" glyph still drills instead of selecting.
//   - The host can drive it: selectDiagramNode / clearDiagramNodeSelection / selectedDiagramNodeId,
//     an unknown id is refused, and `{ notify: false }` moves the mark silently.
//   - A re-render keeps the selection while that level still draws the node, and otherwise clears
//     it and says so (`source: "render"`) — a mark is never left on nothing.

import test from "node:test";
import assert from "node:assert/strict";

import {
  bindDiagramInteractions,
  clearDiagramNodeSelection,
  layoutDiagram,
  renderDiagramSvg,
  selectDiagramNode,
  selectedDiagramNodeId
} from "../src/index.js";

const alpha = { id: "alpha", title: "Alpha", type: "code" };
const beta = { id: "beta", title: "Beta", type: "model" };
const gamma = { id: "gamma", title: "Gamma", type: "human" };
const model = { id: "sel", title: "Selection", nodes: [alpha, beta], edges: [{ from: "alpha", to: "beta", type: "outcome" }] };

// ---- Fake DOM (the shape node-badges.test.mjs uses, plus querySelectorAll) ---
function makeEnv() {
  const win = { innerWidth: 1024, innerHeight: 768, setTimeout(fn) { fn(); return 1; }, clearTimeout() {} };
  const doc = { defaultView: win, body: null, createElement: (tag) => makeEl(tag), querySelector: () => null };
  win.document = doc;
  function makeEl(tagName) {
    const listeners = Object.create(null);
    const attrs = Object.create(null);
    const el = {
      tagName, ownerDocument: doc, parentNode: null, children: [], id: "", className: "", hidden: true, style: {},
      setAttribute: (key, value) => { attrs[key] = String(value); if (key === "class") el.className = String(value); },
      getAttribute: (key) => (key in attrs ? attrs[key] : null),
      removeAttribute: (key) => { delete attrs[key]; },
      append: (...kids) => { for (const kid of kids) { el.children.push(kid); if (kid) kid.parentNode = el; } },
      appendChild: (kid) => { el.append(kid); return kid; },
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((each) => each !== fn); },
      listenerCount: (type) => (listeners[type] || []).length,
      dispatch: (type, event = {}) => { for (const fn of (listeners[type] || []).slice()) fn({ target: el, ...event }); },
      contains: (other) => { let cursor = other; while (cursor) { if (cursor === el) return true; cursor = cursor.parentNode; } return false; },
      querySelector: () => null,
      // Only the one selector the library asks a container for.
      querySelectorAll: (selector) => {
        assert.equal(selector, "[data-diagram-node]");
        const out = [];
        const walk = (node) => { for (const kid of node.children ?? []) { if (kid.getAttribute?.("data-diagram-node")) out.push(kid); walk(kid); } };
        walk(el);
        return out;
      }
    };
    return el;
  }
  doc.body = makeEl("body");
  const container = makeEl("div");
  const makeNode = (id) => { const node = makeEl("g"); node.setAttribute("data-diagram-node", id); container.append(node); return node; };
  const makeChildOf = (parent, attribute, value) => { const kid = makeEl("g"); if (attribute) kid.setAttribute(attribute, value); parent.append(kid); return kid; };
  return { doc, container, makeNode, makeChildOf, makeEl };
}

function classesOf(env, id) {
  const node = env.container.querySelectorAll("[data-diagram-node]").find((each) => each.getAttribute("data-diagram-node") === id);
  return { className: node?.className ?? "", ariaCurrent: node?.getAttribute("aria-current") ?? null };
}

function pressEvent(key, target) {
  let prevented = false;
  return { event: { key, target, preventDefault: () => { prevented = true; } }, prevented: () => prevented };
}

function selectionEnv({ nodes = ["alpha", "beta"], diagram = model, options = {} } = {}) {
  const env = makeEnv();
  const elements = new Map(nodes.map((id) => [id, env.makeNode(id)]));
  const calls = [];
  const opts = { onNodeSelect: (info) => calls.push(info), ...options };
  bindDiagramInteractions(env.container, diagram, opts);
  return { env, elements, calls, opts };
}

// ---- 1. Off by default ------------------------------------------------------

test("without onNodeSelect nothing binds, nothing is marked, and the markup is byte-identical", async () => {
  const layout = await layoutDiagram(model, { compact: true });
  assert.equal(
    renderDiagramSvg(model, layout, { compact: true, onNodeSelect: () => {} }),
    renderDiagramSvg(model, layout, { compact: true }),
    "selection is an interaction, not a render concern"
  );
  assert.ok(!renderDiagramSvg(model, layout, { compact: true }).includes("diagram-node-selected"));

  const env = makeEnv();
  const node = env.makeNode("alpha");
  bindDiagramInteractions(env.container, model, {});           // neither drillDown nor onNodeSelect
  assert.equal(env.container.listenerCount("click"), 1, "the binder still owns the gesture pair");
  env.container.dispatch("click", { target: node });
  assert.equal(classesOf(env, "alpha").className, "", "no class, because there is no selection to have");
  assert.equal(selectedDiagramNodeId(env.container), null);
  assert.equal(selectDiagramNode(env.container, "alpha"), false, "the host cannot select where selection is off");
});

// ---- 2. Picking -------------------------------------------------------------

test("a click marks exactly one node and tells the host which", () => {
  const { env, elements, calls } = selectionEnv();
  env.container.dispatch("click", { target: elements.get("alpha"), preventDefault() {} });
  assert.deepEqual(classesOf(env, "alpha"), { className: "diagram-node-selected", ariaCurrent: "true" });
  assert.deepEqual(classesOf(env, "beta"), { className: "", ariaCurrent: null });
  assert.equal(selectedDiagramNodeId(env.container), "alpha");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { nodeId: "alpha", node: alpha, previousNodeId: null, source: "pointer" });

  // A second node moves the mark and names what it replaced.
  env.container.dispatch("click", { target: elements.get("beta"), preventDefault() {} });
  assert.deepEqual(classesOf(env, "alpha"), { className: "", ariaCurrent: null }, "only one node is ever marked");
  assert.deepEqual(classesOf(env, "beta"), { className: "diagram-node-selected", ariaCurrent: "true" });
  assert.deepEqual(calls[1], { nodeId: "beta", node: beta, previousNodeId: "alpha", source: "pointer" });

  // The same node again is a no-op: a second click must never make a host re-fetch.
  env.container.dispatch("click", { target: elements.get("beta"), preventDefault() {} });
  assert.equal(calls.length, 2, "re-picking the selected node does not call back");
  assert.equal(selectedDiagramNodeId(env.container), "beta");
});

test("a click on a node's child still picks the node (the ancestor walk)", () => {
  const { env, elements, calls } = selectionEnv();
  const label = env.makeChildOf(elements.get("alpha"), null, null);
  env.container.dispatch("click", { target: label, preventDefault() {} });
  assert.equal(calls.at(-1)?.nodeId, "alpha");
});

test("Enter and Space on a focused node pick it, and Space does not scroll the page", () => {
  const { env, elements, calls } = selectionEnv();
  const enter = pressEvent("Enter", elements.get("alpha"));
  env.container.dispatch("keydown", enter.event);
  assert.deepEqual(calls.at(-1), { nodeId: "alpha", node: alpha, previousNodeId: null, source: "keyboard" });
  assert.equal(enter.prevented(), true);

  const space = pressEvent(" ", elements.get("beta"));
  env.container.dispatch("keydown", space.event);
  assert.equal(calls.at(-1)?.nodeId, "beta");
  assert.equal(space.prevented(), true, "Space would otherwise scroll");

  // A key the diagram does not own is left alone.
  const tab = pressEvent("Tab", elements.get("alpha"));
  env.container.dispatch("keydown", tab.event);
  assert.equal(calls.length, 2);
  assert.equal(tab.prevented(), false);
});

test("a drag that ends over a node pans, it does not pick", () => {
  const { env, elements, calls } = selectionEnv();
  env.container.dispatch("pointerdown", { clientX: 100, clientY: 100 });
  env.container.dispatch("pointermove", { clientX: 140, clientY: 100 });
  env.container.dispatch("click", { target: elements.get("alpha"), preventDefault() {} });
  assert.equal(calls.length, 0, "the gesture was a pan");
  assert.equal(selectedDiagramNodeId(env.container), null);

  // A press that barely moves is still a click.
  env.container.dispatch("pointerdown", { clientX: 100, clientY: 100 });
  env.container.dispatch("pointermove", { clientX: 102, clientY: 101 });
  env.container.dispatch("click", { target: elements.get("alpha"), preventDefault() {} });
  assert.equal(calls.at(-1)?.nodeId, "alpha");
});

// ---- 3. Clearing ------------------------------------------------------------

test("Escape and a click on empty canvas clear the selection", () => {
  const { env, elements, calls } = selectionEnv();
  env.container.dispatch("click", { target: elements.get("alpha"), preventDefault() {} });

  const escape = pressEvent("Escape", elements.get("alpha"));
  env.container.dispatch("keydown", escape.event);
  assert.equal(selectedDiagramNodeId(env.container), null);
  assert.deepEqual(classesOf(env, "alpha"), { className: "", ariaCurrent: null });
  assert.deepEqual(calls.at(-1), { nodeId: null, node: null, previousNodeId: "alpha", source: "keyboard" });
  assert.equal(escape.prevented(), true, "Escape was consumed to drop the selection");

  // Escape with nothing selected is not consumed: it falls through to the drill-up branch, which
  // at the root level is itself a no-op. Precedence, made observable.
  const again = pressEvent("Escape", elements.get("alpha"));
  env.container.dispatch("keydown", again.event);
  assert.equal(again.prevented(), false, "nothing to drop, so Escape belongs to drill-up");
  assert.equal(calls.length, 2, "and no spurious null callback");

  env.container.dispatch("click", { target: elements.get("beta"), preventDefault() {} });
  let backgroundPrevented = false;
  env.container.dispatch("click", { target: env.container, preventDefault: () => { backgroundPrevented = true; } });
  assert.equal(selectedDiagramNodeId(env.container), null);
  assert.deepEqual(calls.at(-1), { nodeId: null, node: null, previousNodeId: "beta", source: "background" });
  assert.equal(backgroundPrevented, true, "the background click was consumed to drop the selection");

  // With nothing selected, a background click is left to drill-up.
  let secondPrevented = false;
  env.container.dispatch("click", { target: env.container, preventDefault: () => { secondPrevented = true; } });
  assert.equal(secondPrevented, false);
  assert.equal(calls.length, 4);
});

test("a drag released on empty canvas does not clear either", () => {
  const { env, elements, calls } = selectionEnv();
  env.container.dispatch("click", { target: elements.get("alpha"), preventDefault() {} });
  env.container.dispatch("pointerdown", { clientX: 10, clientY: 10 });
  env.container.dispatch("pointermove", { clientX: 90, clientY: 10 });
  env.container.dispatch("click", { target: env.container, preventDefault() {} });
  assert.equal(selectedDiagramNodeId(env.container), "alpha", "panning the canvas is not a dismissal");
  assert.equal(calls.length, 1);
});

// ---- 4. Under drillDown -----------------------------------------------------

test("the dig-in glyph still drills, and never picks the node it sits on", () => {
  const { env, elements, calls } = selectionEnv({ options: { drillDown: true } });
  // The glyph carries data-diagram-scope-enter; `alpha` declares no scope, so the drill resolves
  // to nothing and returns — what matters here is that it did not become a selection.
  const glyph = env.makeChildOf(elements.get("alpha"), "data-diagram-scope-enter", "alpha");
  env.container.dispatch("click", { target: glyph, preventDefault() {} });
  assert.equal(calls.length, 0, "drilling in is not selecting");
  assert.equal(selectedDiagramNodeId(env.container), null);
  // The node's own face still picks.
  env.container.dispatch("click", { target: elements.get("alpha"), preventDefault() {} });
  assert.equal(calls.at(-1)?.nodeId, "alpha");
});

// ---- 5. Host-driven selection ----------------------------------------------

test("the host can select, clear, and read the selection, and cannot mark a node that is not drawn", () => {
  const { env, calls } = selectionEnv();
  assert.equal(selectDiagramNode(env.container, "beta"), true);
  assert.deepEqual(classesOf(env, "beta"), { className: "diagram-node-selected", ariaCurrent: "true" });
  assert.deepEqual(calls.at(-1), { nodeId: "beta", node: beta, previousNodeId: null, source: "api" });

  assert.equal(selectDiagramNode(env.container, "nowhere"), false, "an id this level does not draw is refused");
  assert.equal(selectedDiagramNodeId(env.container), "beta", "and the mark did not move");
  assert.equal(calls.length, 1);

  assert.equal(selectDiagramNode(env.container, "alpha", { notify: false }), true);
  assert.equal(selectedDiagramNodeId(env.container), "alpha");
  assert.deepEqual(classesOf(env, "alpha"), { className: "diagram-node-selected", ariaCurrent: "true" });
  assert.equal(calls.length, 1, "{ notify: false } moves the mark silently");

  assert.equal(clearDiagramNodeSelection(env.container), true);
  assert.equal(selectedDiagramNodeId(env.container), null);
  assert.deepEqual(calls.at(-1), { nodeId: null, node: null, previousNodeId: "alpha", source: "api" });
  assert.equal(selectedDiagramNodeId(null), null, "no container, no selection");
  assert.equal(selectDiagramNode(null, "alpha"), false);
});

// ---- 6. Across a re-render --------------------------------------------------

test("a re-render keeps the selection while the level still draws it, and otherwise says it dropped it", () => {
  const { env, elements, calls, opts } = selectionEnv();
  env.container.dispatch("click", { target: elements.get("beta"), preventDefault() {} });
  assert.equal(calls.length, 1);

  // Re-bind the same level (what a re-render does): the mark is re-applied to the fresh groups.
  elements.get("beta").removeAttribute("aria-current");
  elements.get("beta").setAttribute("class", "");
  bindDiagramInteractions(env.container, model, opts);
  assert.equal(selectedDiagramNodeId(env.container), "beta");
  assert.deepEqual(classesOf(env, "beta"), { className: "diagram-node-selected", ariaCurrent: "true" });
  assert.equal(calls.length, 1, "carrying a selection forward is not a new pick");

  // A level that no longer draws it: the mark is dropped and the host told, so a panel about a
  // node nobody can see does not stay open.
  bindDiagramInteractions(env.container, { id: "other", nodes: [alpha, gamma], edges: [] }, opts);
  assert.equal(selectedDiagramNodeId(env.container), null);
  assert.deepEqual(calls.at(-1), { nodeId: null, node: null, previousNodeId: "beta", source: "render" });
  assert.deepEqual(classesOf(env, "beta"), { className: "", ariaCurrent: null });
});

test("a host callback that throws never breaks the gesture", () => {
  const env = makeEnv();
  const node = env.makeNode("alpha");
  bindDiagramInteractions(env.container, model, { onNodeSelect: () => { throw new Error("host exploded"); } });
  assert.doesNotThrow(() => env.container.dispatch("click", { target: node, preventDefault() {} }));
  assert.equal(selectedDiagramNodeId(env.container), "alpha", "the mark landed even though the host threw");
});
