// Pan/zoom dragging — a drag moves the map and never starts a text selection.
//
// Contract under test:
//   - enablePanZoom marks the SVG unselectable (user-select: none) for as long as it is bound, and
//     restores the style on cleanup.
//   - The pointer-down that starts a drag cancels its default action, so the browser does not begin
//     selecting text across the page while the pointer moves; the move itself pans the viewBox.
//   - Secondary buttons are left alone (no drag, no preventDefault).

import test from "node:test";
import assert from "node:assert/strict";
import { enablePanZoom } from "../src/index.js";

function fakeSvg() {
  const listeners = new Map();
  const attributes = new Map([["viewBox", "0 0 1000 500"]]);
  return {
    style: {},
    listeners,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 250 }),
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    setPointerCapture() {},
    releasePointerCapture() {}
  };
}

function fakeWindow() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    getComputedStyle: () => ({ position: "static" })
  };
}

test("a drag pans the map and cancels the pointer-down default so no text gets selected", () => {
  const svg = fakeSvg();
  const win = fakeWindow();
  const doc = { defaultView: win, createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {} }) };
  const container = { style: {}, ownerDocument: doc, querySelector: () => svg, appendChild() {} };
  const cleanup = enablePanZoom(container, { panZoomControls: false });
  assert.equal(svg.style.userSelect, "none", "the SVG is unselectable while bound");
  assert.equal(svg.style.webkitUserSelect, "none");
  assert.equal(svg.style.touchAction, "none");

  let prevented = 0;
  const down = { button: 0, clientX: 100, clientY: 100, pointerId: 1, preventDefault: () => { prevented += 1; } };
  svg.listeners.get("pointerdown")(down);
  assert.equal(prevented, 1, "pointer-down default (text selection) is cancelled");
  win.listeners.get("pointermove")({ clientX: 150, clientY: 120 });
  assert.equal(svg.getAttribute("viewBox"), "-100 -40 1000 500", "the move pans the viewBox by the screen delta scaled to the view");
  win.listeners.get("pointerup")({ pointerId: 1 });
  assert.equal(svg.style.cursor, "grab");

  const secondary = { button: 2, clientX: 0, clientY: 0, pointerId: 2, preventDefault: () => { prevented += 1; } };
  svg.listeners.get("pointerdown")(secondary);
  assert.equal(prevented, 1, "a secondary button is not a drag");

  cleanup();
  assert.equal(svg.style.userSelect, "", "cleanup restores selectability");
  assert.equal(svg.style.webkitUserSelect, "");
  assert.equal(svg.listeners.has("pointerdown"), false);
});
