// Hover-dwell debounce for the informational popover — zero-dependency behavior suite
// (node:test + node:assert/strict + a hand-rolled fake DOM with a manual timer queue).
//
// Contract under test:
//   - On pointer HOVER the popover only appears after the pointer has rested on the node for
//     `popoverHoverDelayMs` (default 2000). Leaving before the dwell elapses shows nothing;
//     moving to another node restarts the dwell.
//   - FOCUS (keyboard) shows immediately — a deliberate navigation must never wait.
//   - Teardown cancels a pending dwell so a torn-down diagram can't pop a popover later.

import test from "node:test";
import assert from "node:assert/strict";
import {
  bindDiagramPopovers,
  normalizePopoverHoverDelayMs,
  cleanupHydratedDiagram,
  hideDiagramPopover,
} from "../src/index.js";

// ---- Fake DOM ---------------------------------------------------------------
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
  const makeNode = (id) => {
    const n = makeEl("g");
    n.setAttribute("data-diagram-node", id);
    n.parentNode = container;
    container.children.push(n);
    return n;
  };

  return {
    doc,
    win,
    container,
    makeNode,
    timers,
    flush() {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    },
    popover: () => doc.querySelector("#diagram-node-popover"),
  };
}

const DIAGRAM = { nodes: [{ id: "n1", title: "Node 1", description: "first" }, { id: "n2", title: "Node 2", description: "second" }] };

// ---- normalizePopoverHoverDelayMs (the exported fold used by normalizeOptions) ----
test("normalizePopoverHoverDelayMs: default is 2000; finite values clamp to >= 0; junk falls back", () => {
  assert.equal(normalizePopoverHoverDelayMs(undefined), 2000, "default");
  assert.equal(normalizePopoverHoverDelayMs(2000), 2000);
  assert.equal(normalizePopoverHoverDelayMs(0), 0, "0 disables the debounce");
  assert.equal(normalizePopoverHoverDelayMs(500), 500);
  assert.equal(normalizePopoverHoverDelayMs(-100), 0, "negative clamps to 0");
  assert.equal(normalizePopoverHoverDelayMs(Number.NaN), 2000);
  assert.equal(normalizePopoverHoverDelayMs("nope"), 2000);
  assert.equal(normalizePopoverHoverDelayMs(Infinity), 2000, "non-finite falls back");
});

// ---- Hover dwell ------------------------------------------------------------
test("hover: popover does NOT appear immediately — it waits the full dwell, then shows", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: n1 });
  assert.equal(env.timers.length, 1, "a single dwell timer is scheduled");
  assert.equal(env.timers[0].delay, 2000, "scheduled for the configured 2s dwell");
  assert.equal(env.popover(), null, "popover is NOT created/shown before the dwell elapses");

  env.flush(); // dwell elapses
  const pop = env.popover();
  assert.ok(pop, "popover exists after the dwell");
  assert.equal(pop.hidden, false, "popover is visible after the dwell");
});

test("hover then leave before the dwell elapses shows nothing (dwell cancelled)", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: n1 });
  assert.equal(env.timers.length, 1);
  env.container.dispatch("pointerout", { target: n1 }); // leave before 2s
  env.flush(); // fire whatever remains (a hide timer, if any) — never the cancelled show
  assert.equal(env.popover(), null, "no popover ever appears when the pointer leaves early");
});

test("moving to another node restarts the dwell (old timer cancelled, new node wins)", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  const n2 = env.makeNode("n2");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: n1 });
  env.container.dispatch("pointerover", { target: n2, relatedTarget: n1 }); // slide n1 -> n2
  assert.equal(env.timers.length, 1, "exactly one dwell pending — the first was cancelled");

  env.flush();
  assert.equal(n2.getAttribute("aria-describedby"), "diagram-node-popover", "n2 owns the popover");
  assert.equal(n1.getAttribute("aria-describedby"), null, "n1 never got one");
});

test("jittery leave-and-return on the same node: the restarted dwell survives (stale hide cleared)", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: n1 });   // dwell A
  env.container.dispatch("pointerout", { target: n1 });    // cancels A, schedules a ~140ms hide
  env.container.dispatch("pointerover", { target: n1 });   // back on the node: fresh dwell B
  assert.equal(env.timers.length, 1, "only the fresh dwell is pending — the stale hide was cleared");
  assert.equal(env.timers[0].delay, 2000, "and it is a full dwell, not the 140ms hide");

  env.flush();
  const pop = env.popover();
  assert.ok(pop && pop.hidden === false, "the restarted dwell completes and shows the popover");
});

// ---- Focus is immediate -----------------------------------------------------
test("focus (keyboard) shows immediately — no dwell timer", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("focusin", { target: n1 });
  assert.equal(env.timers.length, 0, "focus does not schedule a dwell timer");
  const pop = env.popover();
  assert.ok(pop && pop.hidden === false, "popover is shown immediately on focus");
});

// ---- 0 disables the debounce (legacy immediate-on-hover) --------------------
test("popoverHoverDelayMs:0 shows immediately on hover (no timer)", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 0 });

  env.container.dispatch("pointerover", { target: n1 });
  assert.equal(env.timers.length, 0, "no dwell timer when delay is 0");
  const pop = env.popover();
  assert.ok(pop && pop.hidden === false, "popover shows immediately when the debounce is disabled");
});

// ---- hideDiagramPopover cancels a pending dwell (scope transitions rely on this) ----
test("hideDiagramPopover() cancels a pending dwell — no popover after a scope change", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: n1 });
  assert.equal(env.timers.length, 1, "dwell pending");
  hideDiagramPopover(n1); // scope enter/exit call this mid-dwell
  assert.equal(env.timers.length, 0, "hideDiagramPopover cancelled the pending dwell");
  env.flush();
  assert.equal(env.popover(), null, "no popover appears after the hide");
});

// ---- focus mid-dwell shows immediately and cancels the stale dwell ----------
test("focus during a pending hover dwell shows immediately (stale dwell cleared)", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: n1 }); // dwell pending
  env.container.dispatch("focusin", { target: n1 });     // keyboard focus arrives
  const pop = env.popover();
  assert.ok(pop && pop.hidden === false, "focus shows immediately, not after the dwell");
  assert.equal(env.timers.length, 0, "the stale hover dwell was cleared by the immediate show");
});

// ---- node -> popover grace period still works ------------------------------
test("moving from node onto the popover keeps it open (hide grace survives the debounce)", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: n1 });
  env.flush(); // dwell elapses → popover shown
  const pop = env.popover();
  assert.ok(pop && pop.hidden === false);

  env.container.dispatch("pointerout", { target: n1 }); // leaving the node schedules a ~140ms hide
  pop.dispatch("pointerenter");                          // ...but the pointer landed on the popover
  env.flush();                                           // fire anything left
  assert.equal(pop.hidden, false, "popover stays open when the pointer moves onto it");
});

// ---- Teardown cancels a pending dwell --------------------------------------
test("cleanupHydratedDiagram cancels a pending dwell (no late popover)", () => {
  const env = makeEnv();
  const n1 = env.makeNode("n1");
  bindDiagramPopovers(env.container, DIAGRAM, { showPopovers: true, popoverHoverDelayMs: 2000 });

  env.container.dispatch("pointerover", { target: n1 });
  assert.equal(env.timers.length, 1);
  cleanupHydratedDiagram(env.container);
  assert.equal(env.timers.length, 0, "the pending dwell timer was cancelled on teardown");
  env.flush();
  assert.equal(env.popover(), null, "no popover appears after teardown");
});
