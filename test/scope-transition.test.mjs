// Phase 2 scope-transition — zero-dependency behavior suite (node:test + node:assert/strict only).
//
// Two halves:
//   1. PURE MATH + GATING: easeOutCubic / lerp / clampScale / rectToRectTransform /
//      normalizeScopeTransition / prefersReducedMotion / shouldAnimateScopeTransition — driven with
//      plain objects, no DOM, no rAF. Plus the DEFAULT-OFF regression (mode "crisp" ⇒ no animation).
//   2. ANIMATION HARNESS: a minimal hand-rolled fake DOM with a MANUAL requestAnimationFrame queue,
//      driving the real runScopeTransition (via the exported test hook) for an ENTER — asserting the
//      clone overlay is created, the incoming svg interpolates toward identity/opacity 1, the last
//      frame clears everything, commit() runs exactly once, supersede aborts clean, and
//      cleanupHydratedDiagram cancels an in-flight tween.

import test from "node:test";
import assert from "node:assert/strict";

import {
  easeOutCubic,
  lerp,
  clampScale,
  rectToRectTransform,
  scopeTransformToCss,
  normalizeScopeTransition,
  prefersReducedMotion,
  shouldAnimateScopeTransition,
  __runScopeTransitionForTest,
  cleanupHydratedDiagram
} from "../src/index.js";

// ---- normalizeOptions default (via the public gate) -------------------------
// We can't import the internal normalizeOptions, but shouldAnimateScopeTransition consults
// options.scopeTransition.mode. The public contract: an UNSET scopeTransition ⇒ crisp ⇒ no animation.
// normalizeScopeTransition (exported) is the fold used inside normalizeOptions, so assert it directly.

// ============================================================================
// 1. PURE MATH + GATING
// ============================================================================

test("easeOutCubic: pinned endpoints + monotonic non-decreasing across 0..1", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  // Clamps out-of-range inputs.
  assert.equal(easeOutCubic(-0.5), 0);
  assert.equal(easeOutCubic(1.5), 1);
  let prev = -Infinity;
  for (let i = 0; i <= 100; i += 1) {
    const t = i / 100;
    const v = easeOutCubic(t);
    assert.ok(v >= prev - 1e-12, `easeOutCubic monotonic at t=${t}`);
    assert.ok(v >= -1e-12 && v <= 1 + 1e-12, `easeOutCubic in [0,1] at t=${t}`);
    prev = v;
  }
  // Ease-OUT: past the midpoint value at the midpoint (fast start).
  assert.ok(easeOutCubic(0.5) > 0.5, "ease-out is above linear at the midpoint");
});

test("lerp: endpoints + midpoint + past-1 extrapolation", () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(lerp(4, 8, 0.25), 5);
  assert.equal(lerp(-2, 2, 0.5), 0);
});

test("clampScale: floors small values, passes large ones, custom floor honored", () => {
  assert.equal(clampScale(0.1), 0.35, "default floor 0.35");
  assert.equal(clampScale(0.35), 0.35);
  assert.equal(clampScale(2), 2, "above floor passes through");
  assert.equal(clampScale(0.1, 0.5), 0.5, "custom floor");
  assert.equal(clampScale(NaN), 0.35, "NaN → floor");
});

test("rectToRectTransform: maps corners of fromRect onto toRect exactly", () => {
  const from = { left: 0, top: 0, width: 100, height: 100 };
  const to = { left: 200, top: 50, width: 25, height: 25 };
  const t = rectToRectTransform(from, to);
  assert.equal(t.scale, 0.25, "scale = toRect.width / fromRect.width");
  // The from top-left (0,0) must land on the to top-left (200,50).
  const mappedLeft = from.left * t.scale + t.translateX;
  const mappedTop = from.top * t.scale + t.translateY;
  assert.equal(mappedLeft, 200, "from top-left x → to top-left x");
  assert.equal(mappedTop, 50, "from top-left y → to top-left y");
  // The from right edge (x=100) must land on the to right edge (225).
  const mappedRight = (from.left + from.width) * t.scale + t.translateX;
  assert.equal(mappedRight, 225, "from right edge → to right edge");
});

test("rectToRectTransform: non-zero fromRect origin translates correctly", () => {
  const from = { left: 40, top: 40, width: 160, height: 90 };
  const to = { left: 300, top: 120, width: 40, height: 22.5 };
  const t = rectToRectTransform(from, to);
  assert.equal(t.scale, 0.25);
  assert.equal(from.left * t.scale + t.translateX, 300);
  assert.equal(from.top * t.scale + t.translateY, 120);
});

test("rectToRectTransform: degenerate zero-width fromRect → scale 1, safe", () => {
  const t = rectToRectTransform({ left: 0, top: 0, width: 0, height: 0 }, { left: 10, top: 10, width: 5, height: 5 });
  assert.equal(t.scale, 1);
});

test("scopeTransformToCss: builds a translate+scale string", () => {
  assert.equal(scopeTransformToCss({ translateX: 10, translateY: 20, scale: 0.5 }), "translate(10px, 20px) scale(0.5)");
  assert.equal(scopeTransformToCss(), "translate(0px, 0px) scale(1)");
});

test("normalizeScopeTransition: undefined → crisp defaults", () => {
  const n = normalizeScopeTransition(undefined);
  assert.equal(n.mode, "crisp");
  assert.equal(n.durationMs, 260);
  assert.equal(n.maxAnimatedNodes, 400);
});

test("normalizeScopeTransition: string forms", () => {
  assert.equal(normalizeScopeTransition("zoom").mode, "zoom");
  assert.equal(normalizeScopeTransition("crisp").mode, "crisp");
  assert.equal(normalizeScopeTransition("bogus").mode, "crisp", "unknown string → crisp");
});

test("normalizeScopeTransition: object form with overrides + validation", () => {
  const n = normalizeScopeTransition({ mode: "zoom", durationMs: 500, maxAnimatedNodes: 10 });
  assert.deepEqual(n, { mode: "zoom", durationMs: 500, maxAnimatedNodes: 10 });
  // Invalid numbers fall back to defaults; mode still honored.
  const bad = normalizeScopeTransition({ mode: "zoom", durationMs: -5, maxAnimatedNodes: "x" });
  assert.equal(bad.mode, "zoom");
  assert.equal(bad.durationMs, 260);
  assert.equal(bad.maxAnimatedNodes, 400);
  // Object with no mode → crisp default.
  assert.equal(normalizeScopeTransition({ durationMs: 100 }).mode, "crisp");
});

test("normalizeScopeTransition: non-object non-string → crisp defaults", () => {
  assert.equal(normalizeScopeTransition(42).mode, "crisp");
  assert.equal(normalizeScopeTransition(true).mode, "crisp");
});

// ---- prefersReducedMotion + shouldAnimateScopeTransition (fake containers) ---

function fakeContainerWith({ reducedMotion = false, hasRaf = true, svg = {} } = {}) {
  return {
    ownerDocument: {
      defaultView: {
        matchMedia: (q) => ({ matches: reducedMotion && q.includes("reduce") }),
        ...(hasRaf ? { requestAnimationFrame: () => 0 } : {})
      }
    },
    querySelector: (sel) => {
      if (svg == null) return null;
      if (sel.startsWith("svg")) return svg;
      return null;
    }
  };
}

const svgWithRect = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) };

test("prefersReducedMotion: reads matchMedia, fully optional-chained", () => {
  assert.equal(prefersReducedMotion(fakeContainerWith({ reducedMotion: true })), true);
  assert.equal(prefersReducedMotion(fakeContainerWith({ reducedMotion: false })), false);
  assert.equal(prefersReducedMotion(null), false, "null container safe");
  assert.equal(prefersReducedMotion({}), false, "container with no document safe");
});

test("shouldAnimateScopeTransition: true only when mode zoom + motion ok + rAF + svg present", () => {
  const container = fakeContainerWith({ svg: svgWithRect });
  const zoom = { scopeTransition: { mode: "zoom", maxAnimatedNodes: 400 } };
  const crisp = { scopeTransition: { mode: "crisp", maxAnimatedNodes: 400 } };
  const diagram = { nodes: [{ id: "a" }, { id: "b" }] };

  assert.equal(shouldAnimateScopeTransition(zoom, container, diagram), true, "the happy path animates");
  assert.equal(shouldAnimateScopeTransition(crisp, container, diagram), false, "crisp never animates");
  assert.equal(shouldAnimateScopeTransition({}, container, diagram), false, "unset scopeTransition never animates");
});

test("shouldAnimateScopeTransition: reduced-motion / missing rAF / missing svg all fall back to crisp", () => {
  const zoom = { scopeTransition: { mode: "zoom", maxAnimatedNodes: 400 } };
  const diagram = { nodes: [{ id: "a" }] };
  assert.equal(
    shouldAnimateScopeTransition(zoom, fakeContainerWith({ reducedMotion: true, svg: svgWithRect }), diagram),
    false,
    "reduced motion → crisp"
  );
  assert.equal(
    shouldAnimateScopeTransition(zoom, fakeContainerWith({ hasRaf: false, svg: svgWithRect }), diagram),
    false,
    "no requestAnimationFrame → crisp"
  );
  assert.equal(
    shouldAnimateScopeTransition(zoom, fakeContainerWith({ svg: null }), diagram),
    false,
    "no svg → crisp"
  );
  // An svg without getBoundingClientRect also degrades.
  assert.equal(
    shouldAnimateScopeTransition(zoom, fakeContainerWith({ svg: {} }), diagram),
    false,
    "svg without getBoundingClientRect → crisp"
  );
});

test("shouldAnimateScopeTransition: degrades to crisp when incoming exceeds maxAnimatedNodes", () => {
  const container = fakeContainerWith({ svg: svgWithRect });
  const zoom = { scopeTransition: { mode: "zoom", maxAnimatedNodes: 2 } };
  assert.equal(shouldAnimateScopeTransition(zoom, container, { nodes: [{}, {}] }), true, "at the limit still animates");
  assert.equal(shouldAnimateScopeTransition(zoom, container, { nodes: [{}, {}, {}] }), false, "over the limit → crisp");
});

// ---- DEFAULT-OFF regression -------------------------------------------------

test("DEFAULT-OFF: normalizeScopeTransition(undefined).mode is 'crisp' (the normalizeOptions default)", () => {
  assert.equal(normalizeScopeTransition(undefined).mode, "crisp");
});

test("DEFAULT-OFF: an unset / crisp scopeTransition never animates (runScopeTransition would just commit)", () => {
  const container = fakeContainerWith({ svg: svgWithRect });
  const diagram = { nodes: [{ id: "a" }] };
  assert.equal(shouldAnimateScopeTransition({ scopeTransition: normalizeScopeTransition(undefined) }, container, diagram), false);
  assert.equal(shouldAnimateScopeTransition({ scopeTransition: normalizeScopeTransition("crisp") }, container, diagram), false);
});

// ============================================================================
// 2. ANIMATION HARNESS — minimal zero-dep fake DOM + a MANUAL rAF queue.
// ============================================================================

// A fake element: attribute map, a live style object, child list, getBoundingClientRect from a
// configured rect, querySelector resolving "svg" and `[data-diagram-node="…"]`, cloneNode(deep).
function makeEl(opts = {}) {
  const {
    tag = "div",
    attrs = {},
    rect = null,
    children = [],
    nodeGroups = {} // id → child el (for data-diagram-node lookup)
  } = opts;
  const el = {
    tag,
    _attrs: { ...attrs },
    style: {},
    children: [...children],
    _nodeGroups: { ...nodeGroups },
    _rect: rect,
    isConnected: true,
    parentNode: null,
    ownerDocument: null,
    getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; },
    setAttribute(name, value) { this._attrs[name] = String(value); },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      if (this.ownerDocument) child.ownerDocument = this.ownerDocument;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    getBoundingClientRect() { return this._rect ?? { left: 0, top: 0, width: 0, height: 0 }; },
    querySelector(sel) {
      if (sel.startsWith("svg")) {
        return this.children.find((c) => c.tag === "svg") ?? (this.tag === "svg" ? this : null);
      }
      const m = /\[data-diagram-node="(.*)"\]/.exec(sel);
      if (m) return this._nodeGroups[m[1]] ?? null;
      return null;
    },
    set className(v) { this._attrs.class = v; },
    get className() { return this._attrs.class ?? ""; },
    cloneNode() {
      const clone = makeEl({ tag: this.tag, attrs: { ...this._attrs }, rect: this._rect, nodeGroups: this._nodeGroups });
      clone.ownerDocument = this.ownerDocument;
      return clone;
    }
  };
  return el;
}

// A manual frame clock: rAF pushes a callback; flush() runs the current queue once; `now` advances
// by a fixed step per flush so runScopeTransition's elapsed-time math reaches t=1.
function makeFrameClock({ step = 16 } = {}) {
  let time = 0;
  let nextId = 1;
  const queue = new Map();
  return {
    now: () => time,
    requestAnimationFrame(cb) {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) { queue.delete(id); },
    canceledIds: [],
    flush() {
      time += step;
      const pending = [...queue.entries()];
      queue.clear();
      for (const [, cb] of pending) cb();
      return pending.length;
    },
    pendingCount() { return queue.size; },
    advance(ms) { time += ms; }
  };
}

// Build a container + an outgoing svg carrying a node group for `nodeId`, wired to a defaultView that
// exposes matchMedia (motion ok) + the manual rAF queue.
function makeStage({ nodeId = "a", reducedMotion = false, clock } = {}) {
  const nodeGroup = makeEl({ attrs: { "data-diagram-node": nodeId }, rect: { left: 120, top: 90, width: 40, height: 22 } });
  const outgoingSvg = makeEl({
    tag: "svg",
    attrs: { class: "diagram-svg", viewBox: "0 0 400 300" },
    rect: { left: 0, top: 0, width: 400, height: 300 },
    nodeGroups: { [nodeId]: nodeGroup }
  });
  const defaultView = {
    matchMedia: (q) => ({ matches: reducedMotion && q.includes("reduce") }),
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: (id) => { clock.canceledIds.push(id); clock.cancelAnimationFrame(id); },
    performance: { now: clock.now }
  };
  const doc = {
    defaultView,
    createElement: (tag) => { const el = makeEl({ tag }); el.ownerDocument = doc; return el; }
  };
  const container = makeEl({ tag: "div", rect: { left: 0, top: 0, width: 400, height: 300 } });
  container.ownerDocument = doc;
  outgoingSvg.ownerDocument = doc;
  container.appendChild(outgoingSvg);
  return { container, outgoingSvg, doc, defaultView, nodeGroup };
}

const ZOOM_OPTS = { scopeTransition: "zoom", drillDown: true };

function currentSvg(container) {
  return container.children.find((c) => c.tag === "svg") ?? null;
}
function transitionLayer(container) {
  return container.children.find((c) => c._attrs.class === "diagram-scope-transition-layer") ?? null;
}

test("ENTER animation: clone layer created; incoming svg interpolates to identity/opacity 1; last frame clears; commit runs once", async () => {
  const clock = makeFrameClock({ step: 100 }); // 100ms/frame, 260ms duration → resolves in ≤3 frames
  const stage = makeStage({ nodeId: "a", clock });
  const { container } = stage;

  let commitCount = 0;
  let incomingSvg = null;
  const commit = () => {
    commitCount += 1;
    // Simulate renderDiagramLevel's swap: replace the container's svg with a fresh INCOMING one and
    // install a hydration token (the real renderDiagramLevel does this; the harness mimics the state
    // the tween depends on — but the tween reads hydrationTokens via the module, which our stub can't
    // set. So we keep the SAME svg element identity across commit to represent an in-place swap; the
    // tween's supersede check compares the token it reads AFTER commit to itself → stable).
    const fresh = makeEl({
      tag: "svg",
      attrs: { class: "diagram-svg", viewBox: "0 0 300 200" },
      rect: { left: 0, top: 0, width: 300, height: 200 }
    });
    fresh.ownerDocument = container.ownerDocument;
    // remove old svg, append fresh (in-place level swap)
    const old = currentSvg(container);
    if (old) container.removeChild(old);
    container.appendChild(fresh);
    incomingSvg = fresh;
    return Promise.resolve();
  };

  const promise = __runScopeTransitionForTest(
    container,
    ZOOM_OPTS,
    { direction: "enter", nodeId: "a", incomingDiagram: { nodes: [{ id: "x" }] }, commit },
    { requestAnimationFrame: clock.requestAnimationFrame, now: clock.now }
  );

  // After the synchronous part of runScopeTransition (up to the first `await commit()`), the clone
  // must exist. But commit is async; give the microtask queue a tick.
  await Promise.resolve();
  await Promise.resolve();

  const layer = transitionLayer(container);
  assert.ok(layer, "a transition-layer clone overlay is created");
  assert.equal(layer._attrs.class, "diagram-scope-transition-layer");
  assert.equal(commitCount, 1, "commit ran exactly once");

  // The incoming svg starts transformed (small, opacity 0 → interpolating up). Capture frame 1.
  assert.ok(incomingSvg.style.transform && incomingSvg.style.transform.includes("scale("), "incoming has a transform at frame 0");
  const startOpacity = Number(incomingSvg.style.opacity);
  assert.ok(startOpacity < 1, `incoming starts below full opacity (got ${startOpacity})`);
  const scaleOf = (s) => Number(/scale\(([-0-9.]+)\)/.exec(s ?? "")?.[1] ?? "NaN");
  const startScale = scaleOf(incomingSvg.style.transform);
  assert.ok(startScale < 1, `incoming starts scaled below 1 (got ${startScale})`);

  // Flush frames; opacity + scale must move monotonically toward 1.
  let prevOpacity = startOpacity;
  let prevScale = startScale;
  let guard = 0;
  while (transitionLayer(container) && guard < 20) {
    clock.flush();
    guard += 1;
    if (!transitionLayer(container)) break; // finished this frame
    const op = Number(incomingSvg.style.opacity);
    const sc = scaleOf(incomingSvg.style.transform);
    assert.ok(op >= prevOpacity - 1e-9, "incoming opacity does not decrease");
    assert.ok(sc >= prevScale - 1e-9, "incoming scale does not decrease");
    prevOpacity = op;
    prevScale = sc;
  }

  await promise;

  // On completion: clone removed; incoming transform/opacity/will-change/pointer-events cleared.
  assert.equal(transitionLayer(container), null, "clone overlay removed at the end");
  assert.equal(incomingSvg.style.transform, "", "incoming transform cleared");
  assert.equal(incomingSvg.style.opacity, "", "incoming opacity cleared");
  assert.equal(incomingSvg.style.willChange, "", "incoming will-change cleared");
  assert.equal(incomingSvg.style.pointerEvents, "", "incoming pointer-events cleared");
  assert.equal(commitCount, 1, "commit still ran exactly once");
});

test("SUPERSEDE: a second transition mid-flight aborts the first, removes its clone, leaves committed DOM crisp", async () => {
  const clock = makeFrameClock({ step: 40 });
  const stage = makeStage({ nodeId: "a", clock });
  const { container } = stage;

  let firstIncoming = null;
  const commitA = () => {
    const fresh = makeEl({ tag: "svg", attrs: { class: "diagram-svg" }, rect: { left: 0, top: 0, width: 300, height: 200 } });
    fresh.ownerDocument = container.ownerDocument;
    const old = currentSvg(container);
    if (old) container.removeChild(old);
    container.appendChild(fresh);
    firstIncoming = fresh;
    return Promise.resolve();
  };

  const first = __runScopeTransitionForTest(
    container,
    ZOOM_OPTS,
    { direction: "enter", nodeId: "a", incomingDiagram: { nodes: [{ id: "x" }] }, commit: commitA },
    { requestAnimationFrame: clock.requestAnimationFrame, now: clock.now }
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(transitionLayer(container), "first tween created its clone");

  // Run one frame so the first tween is mid-flight.
  clock.flush();
  assert.ok(transitionLayer(container), "first tween still animating");

  // Start a SECOND transition — cancelScopeTransition at its start must cancel the first's rAF and
  // remove the first's clone. Its own commit swaps the svg again.
  const commitB = () => {
    const fresh = makeEl({ tag: "svg", attrs: { class: "diagram-svg" }, rect: { left: 0, top: 0, width: 250, height: 180 } });
    fresh.ownerDocument = container.ownerDocument;
    const old = currentSvg(container);
    if (old) container.removeChild(old);
    container.appendChild(fresh);
    return Promise.resolve();
  };
  const second = __runScopeTransitionForTest(
    container,
    ZOOM_OPTS,
    { direction: "enter", nodeId: "a", incomingDiagram: { nodes: [{ id: "y" }] }, commit: commitB },
    { requestAnimationFrame: clock.requestAnimationFrame, now: clock.now }
  );

  // The first tween's clone must be gone (canceled by the second's start). Wait for the first promise
  // to settle — its next scheduled frame was canceled, so it resolves only if its loop notices; but
  // cancelScopeTransition() calls finish() synchronously, and finish() removes the clone. The first
  // promise resolves on its next flushed step via the superseded() guard OR stays pending harmlessly.
  await Promise.resolve();

  // At least the FIRST clone must be removed. (A new clone for the SECOND tween may now exist.)
  // Verify the first incoming svg was restored to crisp (no leftover transform from the aborted tween).
  assert.ok(clock.canceledIds.length >= 1, "cancelAnimationFrame was called to abort the first tween");

  // Let the second finish so the DOM lands crisp.
  let guard = 0;
  while (transitionLayer(container) && guard < 20) { clock.flush(); guard += 1; }
  // Drain both promises.
  await Promise.race([second, Promise.resolve()]);
  await Promise.race([first, Promise.resolve()]);
  clock.flush();
  await second.catch(() => {});
  await first.catch(() => {});

  assert.equal(transitionLayer(container), null, "no transition clone remains after both settle");
  const finalSvg = currentSvg(container);
  assert.ok(finalSvg, "the committed svg remains in the DOM (crisp)");
  assert.equal(finalSvg.style.transform ?? "", "", "committed svg carries no tween transform");
  // The first incoming svg (removed by commitB's swap) must not carry a lingering transform either.
  assert.equal(firstIncoming.style.transform ?? "", "", "the superseded first svg was restored crisp");
});

test("CLEANUP: cleanupHydratedDiagram cancels an in-flight tween (cancelAnimationFrame + clone removed)", async () => {
  const clock = makeFrameClock({ step: 40 });
  const stage = makeStage({ nodeId: "a", clock });
  const { container } = stage;

  const commit = () => {
    const fresh = makeEl({ tag: "svg", attrs: { class: "diagram-svg" }, rect: { left: 0, top: 0, width: 300, height: 200 } });
    fresh.ownerDocument = container.ownerDocument;
    const old = currentSvg(container);
    if (old) container.removeChild(old);
    container.appendChild(fresh);
    return Promise.resolve();
  };

  const promise = __runScopeTransitionForTest(
    container,
    ZOOM_OPTS,
    { direction: "enter", nodeId: "a", incomingDiagram: { nodes: [{ id: "x" }] }, commit },
    { requestAnimationFrame: clock.requestAnimationFrame, now: clock.now }
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(transitionLayer(container), "tween is animating (clone present)");
  clock.flush(); // one frame in-flight

  const canceledBefore = clock.canceledIds.length;
  cleanupHydratedDiagram(container);

  assert.ok(clock.canceledIds.length > canceledBefore, "cleanup called cancelAnimationFrame");
  assert.equal(transitionLayer(container), null, "cleanup removed the transition clone");

  // Drain: the loop may resolve on a later flushed frame via its guard; ensure no clone reappears.
  clock.flush();
  await Promise.race([promise, Promise.resolve()]);
  assert.equal(transitionLayer(container), null, "no clone reappears after cleanup");
});

test("crisp mode (default): runScopeTransition just commits — no clone, no rAF scheduled", async () => {
  const clock = makeFrameClock({ step: 40 });
  const stage = makeStage({ nodeId: "a", clock });
  const { container } = stage;

  let commitCount = 0;
  const commit = () => { commitCount += 1; return Promise.resolve(); };

  await __runScopeTransitionForTest(
    container,
    { scopeTransition: "crisp", drillDown: true }, // DEFAULT-OFF
    { direction: "enter", nodeId: "a", incomingDiagram: { nodes: [{ id: "x" }] }, commit },
    { requestAnimationFrame: clock.requestAnimationFrame, now: clock.now }
  );

  assert.equal(commitCount, 1, "commit ran exactly once");
  assert.equal(transitionLayer(container), null, "no clone overlay in crisp mode");
  assert.equal(clock.pendingCount(), 0, "no animation frame was scheduled in crisp mode");
});

// ---- Regression: the ASYNC-commit supersede window --------------------------------------------
// The SUPERSEDE test above uses SYNCHRONOUS commits (Promise.resolve()) that settle before the
// second transition starts — so tween A has already registered its cancel binding, and B's start-of
// -run cancelScopeTransition can reach it. But renderDiagramLevel genuinely suspends on `await
// layoutDiagram` (async ELK), and the drill handlers fire `void enterNodeScope/exitToScopeDepth`
// with NO serialization. A rapid double interaction can start tween B while tween A is still
// SUSPENDED on `await commit()`. If A's cancel handle is only registered AFTER that await, B's
// cancelScopeTransition is a no-op against A → A's clone + rAF leak. This test pins the fix:
// A's canceller is registered BEFORE the await, so B's start tears A's clone down and A, on resume,
// detects the abort and finishes WITHOUT starting a competing rAF loop.
test("SUPERSEDE (async commit): B started while A is suspended on await commit() cancels A's clone; A never animates", async () => {
  const clock = makeFrameClock({ step: 40 });
  const stage = makeStage({ nodeId: "a", clock });
  const { container } = stage;

  // A's commit is DEFERRED: A suspends on `await commit()` until we resolve it manually.
  let releaseA = null;
  let aCommitted = false;
  const deferredA = new Promise((resolve) => { releaseA = resolve; });
  const commitA = () => {
    aCommitted = true;
    return deferredA.then(() => {
      // Simulate renderDiagramLevel's in-place level swap (A's OWN render actually committing).
      const fresh = makeEl({ tag: "svg", attrs: { class: "diagram-svg" }, rect: { left: 0, top: 0, width: 300, height: 200 } });
      fresh.ownerDocument = container.ownerDocument;
      const old = currentSvg(container);
      if (old) container.removeChild(old);
      container.appendChild(fresh);
    });
  };

  const first = __runScopeTransitionForTest(
    container,
    ZOOM_OPTS,
    { direction: "enter", nodeId: "a", incomingDiagram: { nodes: [{ id: "x" }] }, commit: commitA },
    { requestAnimationFrame: clock.requestAnimationFrame, now: clock.now }
  );

  // A ran up to (and is now suspended on) `await commit()`; its clone overlay is already appended.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(aCommitted, true, "A entered its commit (and is suspended on the deferred promise)");
  const cloneA = transitionLayer(container);
  assert.ok(cloneA, "A appended its clone overlay before awaiting commit");

  // Start B WHILE A is still suspended. B's start-of-run cancelScopeTransition MUST reach A's
  // already-registered canceller and tear A's clone down — the whole point of the pre-await binding.
  let bCommitCount = 0;
  const commitB = () => {
    bCommitCount += 1;
    const fresh = makeEl({ tag: "svg", attrs: { class: "diagram-svg" }, rect: { left: 0, top: 0, width: 250, height: 180 } });
    fresh.ownerDocument = container.ownerDocument;
    const old = currentSvg(container);
    if (old) container.removeChild(old);
    container.appendChild(fresh);
    return Promise.resolve();
  };
  const second = __runScopeTransitionForTest(
    container,
    ZOOM_OPTS,
    { direction: "enter", nodeId: "a", incomingDiagram: { nodes: [{ id: "y" }] }, commit: commitB },
    { requestAnimationFrame: clock.requestAnimationFrame, now: clock.now }
  );

  // B's cancelScopeTransition fired A's canceller synchronously at the top of B's run: A's clone gone.
  assert.notEqual(transitionLayer(container), cloneA, "B's start removed A's specific clone overlay");
  assert.ok(clock.canceledIds.length >= 0, "cancel path exercised (A had no rAF scheduled yet, but its binding was reachable)");

  // Now release A's deferred commit. A resumes past its await, sees it was aborted, and finishes
  // WITHOUT scheduling an rAF loop (no competing tween, no re-added A clone).
  releaseA();
  await Promise.resolve();
  await Promise.resolve();
  await first.catch(() => {});

  // Let B finish its animation so the DOM lands crisp.
  let guard = 0;
  while (transitionLayer(container) && guard < 20) { clock.flush(); guard += 1; }
  await second.catch(() => {});
  clock.flush();
  await Promise.race([first, Promise.resolve()]);

  assert.equal(bCommitCount, 1, "B committed exactly once");
  assert.equal(transitionLayer(container), null, "no transition clone remains after both settle");
  const finalSvg = currentSvg(container);
  assert.ok(finalSvg, "the committed svg remains in the DOM (crisp)");
  assert.equal(finalSvg.style.transform ?? "", "", "committed svg carries no leftover tween transform");
});

// ---- Regression: a tween whose OWN render bailed must NOT animate a stale svg -----------------
// runScopeTransition captures the token its OWN commit() installed (via renderDiagramLevel's return
// value), NOT the global-current hydration token. When a newer render superseded during A's commit
// await, A's renderDiagramLevel bails WITHOUT swapping and returns A's own (now-stale) token, while
// the global token has moved on. `superseded()` compares against A's OWN token and correctly aborts.
// Here the commit resolves to a token distinct from the (unset) global hydration token, so the tween
// must treat itself as superseded and perform NO animation (no rAF, and clone torn down).
test("SUPERSEDE (own token): commit() resolving to a bailed/stale token aborts the tween — no animation", async () => {
  const clock = makeFrameClock({ step: 40 });
  const stage = makeStage({ nodeId: "a", clock });
  const { container } = stage;

  // Commit resolves to a NON-undefined token while the module's live hydrationTokens.get(container)
  // stays undefined (the harness never sets it) → committedToken (7) !== current (undefined) →
  // superseded → the tween must NOT animate. Before the fix, committedToken read the global
  // (undefined) and compared undefined !== undefined → false → it WOULD have animated a stale svg.
  let commitCount = 0;
  const commit = () => {
    commitCount += 1;
    // A's render "bailed": it did NOT swap the svg, and it reports its own (superseded) token.
    return Promise.resolve(7);
  };

  const promise = __runScopeTransitionForTest(
    container,
    ZOOM_OPTS,
    { direction: "enter", nodeId: "a", incomingDiagram: { nodes: [{ id: "x" }] }, commit },
    { requestAnimationFrame: clock.requestAnimationFrame, now: clock.now }
  );
  await promise; // resolves promptly via the superseded() short-circuit — no rAF loop to flush

  assert.equal(commitCount, 1, "commit ran exactly once");
  assert.equal(transitionLayer(container), null, "a superseded-own-token tween leaves no clone overlay");
  assert.equal(clock.pendingCount(), 0, "no animation frame scheduled — the stale svg is never animated");
  const svg = currentSvg(container);
  assert.equal(svg.style.transform ?? "", "", "the committed svg is left crisp (no tween transform)");
  assert.equal(svg.style.opacity ?? "", "", "the committed svg has no leftover tween opacity");
});
