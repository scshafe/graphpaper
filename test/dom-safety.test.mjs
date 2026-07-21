// DOM-safety source self-audit — zero-dependency (node:test + node:assert/strict only).
//
// The renderer hydrates untrusted diagram MODELS into live SVG/DOM. The load-bearing
// security invariant is that it NEVER assigns `.innerHTML` (an XSS sink): every DOM
// mutation goes through PARSED-and-validated node replacement
// (assertDiagramSvgMarkupSafeForDomReplacement → parsed nodes), and popovers are built
// from DOM nodes / textContent, never markup strings.
//
// These assertions previously lived in the mission-control consumer's web test suite
// (test/web.test.mjs), which read this file's source directly. When graphpaper was
// decoupled into its own project, MC stopped white-box-auditing the external renderer's
// source and this invariant moved HERE, to the repo that owns it. MC now guards only its
// OWN React wrappers + consumes the renderer through the public package entry.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("renderer source keeps its DOM-safety invariants: no innerHTML sink, parsed-DOM replacement only", () => {
  // The security invariant: ZERO `.innerHTML =` assignments anywhere in the renderer.
  assert.equal(
    (source.match(/\.innerHTML\s*=/g) ?? []).length,
    0,
    "the renderer must never assign .innerHTML (an XSS sink) — SVG/popover hydration uses parsed DOM replacement"
  );

  // The safe-replacement pipeline: markup is validated, parsed, and swapped as DOM nodes.
  assert.match(source, /function assertDiagramSvgMarkupSafeForDomReplacement\(markup\)/);
  assert.match(source, /function diagramSvgMarkupForTrustedDomReplacement\(diagram, layout, options\)/);
  assert.match(source, /function diagramNodesFromParsedMarkup\(documentRef, markup, contextElement\)/);
  assert.match(source, /function replaceDiagramSvgNodes\(container, diagram, layout, options\)/);
  // The trusted-markup helper routes renderDiagramSvg output through the safety assertion.
  assert.match(
    source,
    /function diagramSvgMarkupForTrustedDomReplacement\(diagram, layout, options\) {\n\s*return assertDiagramSvgMarkupSafeForDomReplacement\(renderDiagramSvg\(diagram, layout, options\)\);\n}/
  );

  // Popovers are built from DOM nodes / textContent, cleared with textContent (never markup).
  assert.match(source, /function replaceDiagramPopoverContent\(popover, node\) {\n\s*popover\.textContent = "";\n\s*if \(!node\) return;/);
  assert.match(source, /appendPopoverSection\(documentRef, popover, section\)/);

  // Hydration is per-container and WeakMap-scoped (no global popover element, no global
  // node registry) so multiple mounted figures never cross-bind or leak listeners.
  assert.match(source, /delegatedDiagramPopoverBindings/);
  assert.match(source, /diagramDocumentFor/);
  assert.match(source, /diagramPopoverForDocument/);
  assert.match(source, /export function cleanupHydratedDiagram/);
  assert.match(source, /export function hideDiagramPopoverForPageEvent/);

  // The anti-patterns the design forbids: a singleton popover looked up by id, and a
  // global querySelectorAll sweep over diagram nodes.
  assert.doesNotMatch(source, /document\.querySelector\("#diagram-node-popover"\)/);
  assert.doesNotMatch(source, /querySelectorAll\("\[data-diagram-node\]"\)\.forEach/);
});
