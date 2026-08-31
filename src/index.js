/**
 * @typedef {{ label: string, value?: string, description?: string, badges?: string[] }} DiagramRow
 * @typedef {{ title?: string, rows?: DiagramRow[] }} DiagramDetailsSection
 * @typedef {{ title?: string, kicker?: string, sections?: DiagramDetailsSection[] }} DiagramDetails
 * @typedef {{ id: string, type?: string, title: string, subtitle?: string, status?: string, description?: string, rows?: DiagramRow[], details?: DiagramDetails, metadata?: Record<string, unknown>, scope?: DiagramModel, stage?: number | string, stages?: Array<number | string> }} DiagramNode
 * @typedef {{ id?: string, from: string, to: string, type?: string, label?: string, description?: string, metadata?: Record<string, unknown>, stage?: number | string, stages?: Array<number | string> }} DiagramEdge
 * @typedef {{ id?: string, title?: string, caption?: string }} DiagramStage
 * @typedef {{ state: string, label?: string, note?: string }} DiagramLifecycle
 * @typedef {{ id: string, title: string, kind?: string, description?: string, nodes: DiagramNode[], edges: DiagramEdge[], metadata?: Record<string, unknown>, lifecycle?: string | DiagramLifecycle, stages?: Array<string | DiagramStage> }} DiagramModel
 * @typedef {{ x: number, y: number, width: number, height: number, centerX: number, centerY: number }} DiagramNodePosition
 * @typedef {{ width: number, height: number, positions: Map<string, DiagramNodePosition>, edgePaths: Map<string, string>, containmentDepths?: Map<string, number>, drawHierarchyEdges?: boolean, sourceLabel: string }} DiagramLayout
 */

const DEFAULT_LAYOUT_PADDING = 32;
const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 86;
const TABLE_NODE_WIDTH = 260;
const TABLE_ROW_HEIGHT = 15;
const COMPONENT_ROW_HEIGHT = 15;

let elkLayoutEngine = null;
let nextHydrationToken = 0;
const hydrationTokens = new WeakMap();
const delegatedDiagramPopoverBindings = new WeakMap();
let activePopoverTarget = null;
let popoverHideTimer = null;
let popoverHideTimerWindow = null;
// Hover-dwell debounce: the informational popover only appears after the pointer has rested on a
// node continuously for `popoverHoverDelayMs` (default 2000). Mirrors the hide-timer pair below.
let popoverShowTimer = null;
let popoverShowTimerWindow = null;

function diagramDocumentFor(target = activePopoverTarget, root = globalThis) {
  return target?.ownerDocument ?? root?.document ?? null;
}

function diagramWindowFor(target = activePopoverTarget, root = globalThis) {
  const documentRef = diagramDocumentFor(target, root);
  return documentRef?.defaultView ?? root?.window ?? null;
}

function diagramNodeCtorFor(target) {
  return diagramWindowFor(target)?.Node ?? globalThis.Node;
}

function isDiagramNode(candidate, context) {
  const NodeCtor = diagramNodeCtorFor(context ?? candidate);
  return typeof NodeCtor === "function" ? candidate instanceof NodeCtor : Boolean(candidate && typeof candidate === "object");
}

function diagramPopoverForDocument(documentRef) {
  return documentRef?.querySelector?.("#diagram-node-popover") ?? null;
}

function readTagAttributes(tagMarkup) {
  const attributes = [];
  let index = 1;
  const length = tagMarkup.length;

  while (index < length && /[\s/]/.test(tagMarkup[index] ?? "")) index += 1;
  while (index < length && !/[\s>/]/.test(tagMarkup[index] ?? "")) index += 1;

  while (index < length) {
    while (index < length && /[\s/]/.test(tagMarkup[index] ?? "")) index += 1;
    if (tagMarkup[index] === ">" || index >= length) break;

    const nameStart = index;
    while (index < length && !/[\s=>/]/.test(tagMarkup[index] ?? "")) index += 1;
    const name = tagMarkup.slice(nameStart, index).toLowerCase();
    while (index < length && /\s/.test(tagMarkup[index] ?? "")) index += 1;

    let value = "";
    if (tagMarkup[index] === "=") {
      index += 1;
      while (index < length && /\s/.test(tagMarkup[index] ?? "")) index += 1;
      const quote = tagMarkup[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < length && tagMarkup[index] !== quote) index += 1;
        value = tagMarkup.slice(valueStart, index);
        if (tagMarkup[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < length && !/[\s>]/.test(tagMarkup[index] ?? "")) index += 1;
        value = tagMarkup.slice(valueStart, index);
      }
    }

    if (name) attributes.push({ name, value });
  }

  return attributes;
}

// Exported for tests (P1 scope-linking asserts the injected boundary markup is SVG-safe); keep
// the export narrow — it is otherwise an internal guard on the string→DOM replacement path.
export function assertDiagramSvgMarkupSafeForDomReplacement(markup) {
  for (const tagMarkup of markup.match(/<[^>]+>/g) ?? []) {
    const tagName = tagMarkup.match(/^<\s*\/?\s*([^\s>/]+)/)?.[1]?.toLowerCase() ?? "";
    if (tagName === "script" || tagName === "foreignobject") {
      throw new Error(`Mission Control DiagramRenderer refused unsafe SVG markup tag before DOM replacement: ${tagName}`);
    }
    for (const attribute of readTagAttributes(tagMarkup)) {
      if (attribute.name.startsWith("on")) {
        throw new Error(`Mission Control DiagramRenderer refused unsafe SVG event handler attribute before DOM replacement: ${attribute.name}`);
      }
      if (["href", "xlink:href", "src"].includes(attribute.name) && /^\s*(?:javascript|data):/i.test(attribute.value)) {
        throw new Error(`Mission Control DiagramRenderer refused unsafe SVG URL attribute before DOM replacement: ${attribute.name}`);
      }
    }
  }
  return markup;
}

function diagramSvgMarkupForTrustedDomReplacement(diagram, layout, options) {
  return assertDiagramSvgMarkupSafeForDomReplacement(renderDiagramSvg(diagram, layout, options));
}

function adoptDiagramNode(documentRef, node) {
  if (!node) return node;
  return typeof documentRef?.adoptNode === "function" ? documentRef.adoptNode(node) : node;
}

function diagramNodesFromParsedMarkup(documentRef, markup, contextElement) {
  const range = documentRef?.createRange?.();
  if (range?.createContextualFragment) {
    range.selectNode?.(contextElement ?? documentRef?.body ?? documentRef?.documentElement ?? documentRef);
    const fragment = range.createContextualFragment(markup);
    return Array.from(fragment?.childNodes ?? []).map((node) => adoptDiagramNode(documentRef, node));
  }

  const Parser = documentRef?.defaultView?.DOMParser ?? globalThis.DOMParser;
  if (typeof Parser === "function") {
    const parsed = new Parser().parseFromString(markup, "text/html");
    return Array.from(parsed?.body?.childNodes ?? []).map((node) => adoptDiagramNode(documentRef, node));
  }

  throw new Error("Mission Control DiagramRenderer could not parse generated SVG markup for DOM replacement.");
}

function diagramSvgNodesForTrustedDomReplacement(container, diagram, layout, options) {
  const markup = diagramSvgMarkupForTrustedDomReplacement(diagram, layout, options);
  const documentRef = container?.ownerDocument ?? diagramDocumentFor(container);
  const nodes = diagramNodesFromParsedMarkup(documentRef, markup, container);
  if (nodes.length === 0) {
    throw new Error("Mission Control DiagramRenderer generated no SVG nodes for DOM replacement.");
  }
  return nodes;
}

function replaceDiagramSvgNodes(container, diagram, layout, options) {
  const nodes = diagramSvgNodesForTrustedDomReplacement(container, diagram, layout, options);
  if (typeof container.replaceChildren === "function") {
    container.replaceChildren(...nodes);
    return;
  }
  while (container.firstChild) container.removeChild(container.firstChild);
  container.append(...nodes);
}

function setDiagramElementClass(element, className) {
  element.className = className;
  element.setAttribute?.("class", className);
}

function createDiagramPopoverElement(documentRef, tagName, { className, text, ariaLabel } = {}) {
  const element = documentRef.createElement(tagName);
  if (className) setDiagramElementClass(element, className);
  if (ariaLabel) element.setAttribute("aria-label", ariaLabel);
  if (text !== undefined) element.textContent = String(text ?? "");
  return element;
}

function appendDiagramText(documentRef, parent, text) {
  const value = String(text ?? "");
  if (!value) return;
  if (typeof documentRef.createTextNode === "function") {
    parent.append(documentRef.createTextNode(value));
    return;
  }
  const fallback = createDiagramPopoverElement(documentRef, "span", { text: value });
  parent.append(fallback);
}

function replaceDiagramPopoverContent(popover, node) {
  popover.textContent = "";
  if (!node) return;
  const documentRef = popover.ownerDocument ?? diagramDocumentFor(popover);
  if (!documentRef?.createElement) return;
  appendDiagramPopoverContent(documentRef, popover, node);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function classToken(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function metadataClassNames(node) {
  const metadata = node.metadata ?? {};
  return [
    ["node-category", metadata.nodeCategory],
    ["node-role", metadata.diagramNodeRole],
    ["node-diagram-type", metadata.diagramNodeType],
    ["node-visual-group", metadata.visualGroup]
  ]
    .filter(([, value]) => typeof value === "string" && value)
    .map(([prefix, value]) => `${prefix}-${classToken(value)}`)
    .join(" ");
}

function shortRef(value, maxLength = 22) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function compactText(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getElkLayoutEngine() {
  const browserWindow = globalThis.window;
  if (!browserWindow?.ELK) return undefined;
  elkLayoutEngine ??= new browserWindow.ELK();
  return elkLayoutEngine;
}

/** Fold for the hover-dwell option (mirrors normalizeScopeTransition): a finite value is clamped to
 *  >= 0; anything else (undefined/NaN/non-number) falls back to the 2000ms default. Exported so the
 *  default + clamping are unit-testable without reaching the private normalizeOptions. */
export function normalizePopoverHoverDelayMs(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 2000;
}

function normalizeOptions(options = {}) {
  return {
    direction: options.direction ?? "RIGHT",
    edgeRouting: options.edgeRouting ?? "ORTHOGONAL",
    hierarchy: options.hierarchy ?? false,
    hierarchyEdgeTypes: options.hierarchyEdgeTypes ?? ["contains"],
    compact: options.compact ?? false,
    showPopovers: options.showPopovers ?? true,
    // Hover-dwell (ms) before the informational popover appears on pointer hover; the pointer must
    // rest on the node this long continuously. Focus (keyboard) still shows immediately. 0 = no
    // debounce (legacy immediate-on-hover). Default 2000.
    popoverHoverDelayMs: normalizePopoverHoverDelayMs(options.popoverHoverDelayMs),
    visibleRows: options.visibleRows ?? 5,
    showEdgeLabels: options.showEdgeLabels ?? false,
    minWidth: options.minWidth ?? 680,
    minHeight: options.minHeight ?? 260,
    sourceLabel: options.sourceLabel ?? "ELK layered diagram layout",
    fallbackSourceLabel: options.fallbackSourceLabel ?? "fallback layered diagram layout",
    elkErrorSourceLabel: options.elkErrorSourceLabel ?? "fallback layered diagram layout — ELK error",
    elkUnavailableSourceLabel: options.elkUnavailableSourceLabel ?? "fallback layered diagram layout — ELK unavailable",
    ariaLabel: options.ariaLabel ?? `${options.title ?? "Diagram"} rendered as an accessible SVG graph`,
    caption: options.caption,
    markerId: classToken(options.markerId || `diagram-arrow-${classToken(options.diagramId ?? "default")}`),
    nodeWidth: options.nodeWidth,
    nodeHeight: options.nodeHeight,
    drawHierarchyEdgesWhenNested: options.drawHierarchyEdgesWhenNested ?? false,
    panZoom: options.panZoom ?? false,
    panZoomControls: options.panZoomControls ?? true,
    minScale: options.minScale ?? 0.2,
    maxScale: options.maxScale ?? 8,
    zoomStep: options.zoomStep ?? 1.2,
    // P0-B3 scope / drill-down. Default OFF → no affordance, no nav → byte-identical.
    drillDown: options.drillDown ?? false,
    resolveScope: typeof options.resolveScope === "function" ? options.resolveScope : null,
    hasScope: typeof options.hasScope === "function" ? options.hasScope : null,
    onScopeChange: typeof options.onScopeChange === "function" ? options.onScopeChange : null,
    // P1 scope-linking. `scopeExitOnBackground` (default true) gates BOTH the outer-boundary
    // render and the click-outside/Escape drill-UP gesture — but only when a level is actually a
    // scope child under drillDown, so root/non-drill renders stay byte-identical regardless.
    // `scopeBreadcrumb` (default true) gates the breadcrumb bar for boundary-only / host-driven UX.
    scopeExitOnBackground: options.scopeExitOnBackground ?? true,
    scopeBreadcrumb: options.scopeBreadcrumb ?? true,
    // Phase 2 (opt-in, default-off): the animated matched-frame scope transition. Normalized to
    // `{ mode, durationMs, maxAnimatedNodes }`; default mode "crisp" ⇒ behavior-identical to today.
    // Consumed ONLY in the enter/exit path (runScopeTransition) — renderDiagramSvg never reads it.
    scopeTransition: normalizeScopeTransition(options.scopeTransition),
    // Staged process diagrams. Stage machinery activates only when the MODEL declares ≥2
    // stages (diagramStages) — un-staged models render byte-identically regardless of these.
    stageControls: options.stageControls ?? true,
    initialStage: options.initialStage,
    onStageChange: typeof options.onStageChange === "function" ? options.onStageChange : null,
    nodeRenderers: { ...defaultNodeRenderers, ...(options.nodeRenderers ?? {}) }
  };
}

/** P0-B3: a node "has a scope" (a sub-diagram it can drill into) when it carries an inline
 *  `scope` model, declares a `metadata.scopeRef` id (resolved lazily by options.resolveScope),
 *  or the caller's `hasScope(node)` predicate returns true. Synchronous — safe at render time. */
export function nodeHasScope(node, options = {}) {
  if (!node) return false;
  if (node.scope != null) return true;
  if (node.metadata && node.metadata.scopeRef != null && `${node.metadata.scopeRef}`.trim() !== "") return true;
  return typeof options.hasScope === "function" ? options.hasScope(node) === true : false;
}

// ---- Phase 2: opt-in animated scope transition (matched-frame illusion) ------
// PURELY ADDITIVE + DEFAULT-OFF. The default `scopeTransition.mode === "crisp"` path is
// byte-/behavior-identical to the pre-Phase-2 renderer: no requestAnimationFrame, no document,
// no getBoundingClientRect. When opted into `"zoom"` (and reduced-motion is off + rAF exists),
// enter/exit run a compositor-only cross-fade that maps the whole incoming <svg> onto the
// entered node's on-screen box (an ILLUSION, not literal continuous zoom). It NEVER touches the
// viewBox (so panZoom stays untouched) — only CSS transform + opacity on two stacked layers.
// The helpers below are pure + unit-testable; the DOM orchestration lives in runScopeTransition.

const DEFAULT_SCOPE_TRANSITION_DURATION_MS = 260;
const DEFAULT_SCOPE_TRANSITION_MAX_NODES = 400;
const SCOPE_TRANSITION_SCALE_FLOOR = 0.35;

/** Ease-out-cubic: fast start, gentle settle. easeOutCubic(0)===0, easeOutCubic(1)===1, and it is
 *  monotonic non-decreasing on [0,1]. Pure; exported for tests. */
export function easeOutCubic(t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const inv = 1 - clamped;
  return 1 - inv * inv * inv;
}

/** Linear interpolation a→b by t. Pure; exported for tests. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Clamp a uniform scale to a floor so a tiny node opening a huge child does not start invisibly
 *  small (matched-frame illusion honesty). Pure; exported for tests. */
export function clampScale(scale, floor = SCOPE_TRANSITION_SCALE_FLOOR) {
  const safeFloor = Number.isFinite(floor) ? floor : SCOPE_TRANSITION_SCALE_FLOOR;
  if (!Number.isFinite(scale)) return safeFloor;
  return scale < safeFloor ? safeFloor : scale;
}

/** Compute the CSS transform (translate+uniform-scale) that maps `fromRect` onto `toRect`: the
 *  scale is `toRect.width / fromRect.width` and the translate lands `fromRect`'s top-left, scaled,
 *  on `toRect`'s top-left. Guards a zero/degenerate `fromRect.width` (returns scale 1, no
 *  translate). Pure; exported for tests. Rects use {left, top, width}. */
export function rectToRectTransform(fromRect, toRect) {
  const fromW = fromRect?.width;
  const scale = Number.isFinite(fromW) && fromW !== 0 && Number.isFinite(toRect?.width)
    ? toRect.width / fromW
    : 1;
  const fromLeft = Number.isFinite(fromRect?.left) ? fromRect.left : 0;
  const fromTop = Number.isFinite(fromRect?.top) ? fromRect.top : 0;
  const toLeft = Number.isFinite(toRect?.left) ? toRect.left : 0;
  const toTop = Number.isFinite(toRect?.top) ? toRect.top : 0;
  return {
    translateX: toLeft - fromLeft * scale,
    translateY: toTop - fromTop * scale,
    scale
  };
}

/** Serialize a {translateX, translateY, scale} into a CSS transform string. Pure; exported. */
export function scopeTransformToCss({ translateX = 0, translateY = 0, scale = 1 } = {}) {
  return `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

/** Normalize the `scopeTransition` option into `{ mode, durationMs, maxAnimatedNodes }`. Accepts
 *  undefined (→ crisp defaults), a bare string "crisp"|"zoom", or an object. Default mode is
 *  ALWAYS "crisp" (default-off). Pure; exported for tests. */
export function normalizeScopeTransition(input) {
  const defaults = {
    mode: "crisp",
    durationMs: DEFAULT_SCOPE_TRANSITION_DURATION_MS,
    maxAnimatedNodes: DEFAULT_SCOPE_TRANSITION_MAX_NODES
  };
  if (input == null) return defaults;
  if (typeof input === "string") {
    return { ...defaults, mode: input === "zoom" ? "zoom" : "crisp" };
  }
  if (typeof input !== "object") return defaults;
  const mode = input.mode === "zoom" ? "zoom" : "crisp";
  const durationMs = Number.isFinite(input.durationMs) && input.durationMs > 0
    ? input.durationMs
    : defaults.durationMs;
  const maxAnimatedNodes = Number.isFinite(input.maxAnimatedNodes) && input.maxAnimatedNodes >= 0
    ? input.maxAnimatedNodes
    : defaults.maxAnimatedNodes;
  return { mode, durationMs, maxAnimatedNodes };
}

/** True when the container's document prefers reduced motion. Fully optional-chained: safe with a
 *  null container or outside a browser. Exported for tests. */
export function prefersReducedMotion(container) {
  return container?.ownerDocument?.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

/** The single gate deciding whether a scope enter/exit should ANIMATE (else crisp-commit). True
 *  only when: mode is "zoom"; reduced-motion is off; the container's window has requestAnimationFrame;
 *  the outgoing <svg> exists and supports getBoundingClientRect; and the incoming diagram does not
 *  exceed maxAnimatedNodes. Any failure silently falls back to crisp. Exported for tests. */
export function shouldAnimateScopeTransition(options, container, incomingDiagram) {
  if (options?.scopeTransition?.mode !== "zoom") return false;
  if (prefersReducedMotion(container)) return false;
  if (typeof container?.ownerDocument?.defaultView?.requestAnimationFrame !== "function") return false;
  const svg = scopeTransitionOutgoingSvg(container);
  if (!svg || typeof svg.getBoundingClientRect !== "function") return false;
  const maxNodes = options?.scopeTransition?.maxAnimatedNodes ?? DEFAULT_SCOPE_TRANSITION_MAX_NODES;
  const nodeCount = incomingDiagram?.nodes?.length ?? 0;
  if (nodeCount > maxNodes) return false;
  return true;
}

/** Find the container's live diagram <svg> (the standard lookup used everywhere else). */
function scopeTransitionOutgoingSvg(container) {
  if (!container || typeof container.querySelector !== "function") return null;
  return container.querySelector("svg.diagram-svg") ?? container.querySelector("svg");
}

// ---- Lifecycle marking (deprecated / expired / …) ---------------------------
// A diagram can declare a LIFECYCLE state (`diagram.lifecycle` or `diagram.metadata.lifecycle`,
// either a bare string or `{ state, label?, note? }`). A lifecycled diagram renders with a
// caption badge, a diagonal watermark, and a `diagram-lifecycle-<state>` class that dims the
// graph — so a stale/deprecated diagram can never be mistaken for the current architecture.
// No lifecycle (every existing model) ⇒ byte-identical markup.

/** Normalize a diagram's lifecycle declaration. Returns `{ state, label, note }` or null.
 *  `state` is a lowercased class-safe token (e.g. "deprecated", "expired"); `label` defaults
 *  to the state upper-cased for display. PURE — safe anywhere, exported for hosts/tests. */
export function diagramLifecycle(diagram) {
  const raw = diagram?.lifecycle ?? diagram?.metadata?.lifecycle;
  if (raw == null) return null;
  if (typeof raw === "string") {
    const state = raw.trim();
    if (!state) return null;
    return { state: classToken(state.toLowerCase()), label: state.toUpperCase(), note: "" };
  }
  if (typeof raw !== "object") return null;
  const state = typeof raw.state === "string" ? raw.state.trim() : "";
  if (!state) return null;
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : state.toUpperCase();
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  return { state: classToken(state.toLowerCase()), label, note };
}

// ---- Staged process diagrams ------------------------------------------------
// A diagram can declare ordered STAGES (`diagram.stages`, or `diagram.metadata.stages`) that
// unfold a process: each node/edge declares when it participates (`stage: <ref>` = appears at
// that stage and stays; `stages: [<ref>…]` = explicit membership; nothing = every stage; the
// same fields are honored under `metadata` so stored models need no top-level schema change).
// A stage ref is a 1-based index number or a stage id string. The FULL union is laid out once
// (positions never shift between stages); hydrateDiagram binds prev/next controls that toggle
// per-element visibility classes. Models without stages (all existing ones) ⇒ byte-identical.

/** Normalize `diagram.stages` into `[{ id, title, caption }]` (id defaults to the 1-based
 *  index as a string). Returns [] unless there are ≥ 2 well-formed stages (a single stage is
 *  not a process). PURE, exported for hosts/tests. */
export function diagramStages(diagram) {
  const raw = diagram?.stages ?? diagram?.metadata?.stages;
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const stages = raw.map((entry, index) => {
    if (typeof entry === "string") {
      return { id: String(index + 1), title: entry.trim() || `Stage ${index + 1}`, caption: "" };
    }
    if (entry && typeof entry === "object") {
      const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : String(index + 1);
      const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Stage ${index + 1}`;
      const caption = typeof entry.caption === "string" ? entry.caption.trim() : "";
      return { id, title, caption };
    }
    return null;
  });
  if (!stages.every(Boolean)) {
    // Loud-over-silent: ONE malformed entry disables the whole staged feature — say so, or the
    // author sees "no stage bar" with zero explanation.
    if (typeof console !== "undefined") console.warn("graphpaper: diagram.stages contains a malformed entry (not a string/object) — staged rendering disabled for", diagram?.id);
    return [];
  }
  return stages;
}

/** Resolve one element's stage declaration to a Set of 0-based stage indices (or null when the
 *  element declares nothing → visible at every stage). An unknown stage ref is LOUD (console
 *  warn) and ignored — fail-open keeps the graph readable rather than vanishing elements. */
function elementStageIndices(element, stages) {
  const explicit = element?.stages ?? element?.metadata?.stages;
  const from = element?.stage ?? element?.metadata?.stage;
  if (explicit != null && !Array.isArray(explicit) && typeof console !== "undefined") {
    // Same loudness as an unknown ref: a non-array `stages` declaration is ignored (falls
    // through to `stage`/undeclared), but silently would be undiagnosable from the UI.
    console.warn("graphpaper: `stages` must be an array of stage refs — ignoring", explicit);
  }
  const refToIndex = (ref) => {
    if (typeof ref === "number" && Number.isFinite(ref)) {
      const index = Math.trunc(ref) - 1;
      if (index >= 0 && index < stages.length) return index;
    } else if (typeof ref === "string" && ref.trim()) {
      const index = stages.findIndex((stage) => stage.id === ref.trim());
      if (index !== -1) return index;
      const numeric = Number(ref.trim());
      if (Number.isFinite(numeric)) return refToIndex(numeric);
    }
    if (typeof console !== "undefined") console.warn("graphpaper: unknown stage ref ignored", ref);
    return null;
  };
  if (Array.isArray(explicit) && explicit.length > 0) {
    const indices = explicit.map(refToIndex).filter((index) => index != null);
    return indices.length > 0 ? new Set(indices) : null;
  }
  if (from != null) {
    const start = refToIndex(from);
    if (start == null) return null;
    const indices = new Set();
    for (let index = start; index < stages.length; index += 1) indices.add(index);
    return indices;
  }
  return null;
}

/** Compute the full stage-visibility map for a staged diagram: which 0-based stage indices
 *  each node and edge is visible at. An edge is visible only at stages where BOTH endpoints
 *  are (intersected with its own declaration, if any). Returns null for un-staged diagrams.
 *  PURE, exported for hosts/tests. */
export function stageVisibilityForDiagram(diagram) {
  const stages = diagramStages(diagram);
  if (stages.length === 0) return null;
  const everyStage = new Set(stages.map((_, index) => index));
  const declared = new Set();
  const nodeStages = new Map();
  for (const node of diagram.nodes ?? []) {
    const own = elementStageIndices(node, stages);
    if (own) declared.add(`node:${node.id}`);
    nodeStages.set(node.id, own ?? everyStage);
  }
  const edgeStages = new Map();
  // Iterate validEdges with ITS indexing — the exact list renderDiagramSvg walks — so the
  // edgeKey stamped as data-diagram-edge and the key here always agree (id-less edges key by
  // list index; a dropped invalid edge must not shift the correspondence).
  validEdges(diagram).forEach((edge, index) => {
    const own = elementStageIndices(edge, stages);
    const key = edgeKey(edge, index);
    if (own) declared.add(`edge:${key}`);
    const fromVisible = nodeStages.get(edge.from) ?? everyStage;
    const toVisible = nodeStages.get(edge.to) ?? everyStage;
    const visible = new Set([...(own ?? everyStage)].filter((stageIndex) => fromVisible.has(stageIndex) && toVisible.has(stageIndex)));
    if (visible.size === 0 && typeof console !== "undefined") {
      // An edge visible at NO stage is always an authoring smell (own declaration ∩ endpoint
      // visibility = ∅) — silently invisible everywhere is undiagnosable from the UI.
      console.warn("graphpaper: edge is visible at no stage (its declaration never overlaps both endpoints)", key);
    }
    edgeStages.set(key, visible);
  });
  return { stages, nodeStages, edgeStages, declared };
}

function layoutOptions(options) {
  return {
    "elk.algorithm": "layered",
    "elk.direction": options.direction,
    "elk.edgeRouting": options.edgeRouting,
    "elk.hierarchyHandling": options.hierarchy ? "INCLUDE_CHILDREN" : "SEPARATE_CHILDREN",
    "elk.spacing.nodeNode": options.compact ? "34" : "54",
    "elk.layered.spacing.nodeNodeBetweenLayers": options.compact ? "82" : "112",
    "elk.layered.spacing.edgeNodeBetweenLayers": options.compact ? "24" : "32",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "18",
    "elk.layered.cycleBreaking.strategy": "GREEDY",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP"
  };
}

function visibleRows(node, options) {
  return (node.rows ?? []).slice(0, Math.max(0, options.visibleRows));
}

function tableNodeSize(node, options) {
  const displayedRows = visibleRows(node, options).length;
  const moreRows = Math.max(0, (node.rows?.length ?? 0) - displayedRows) > 0 ? 1 : 0;
  return {
    width: options.nodeWidth ?? TABLE_NODE_WIDTH,
    height: Math.max(110, 62 + (displayedRows + moreRows) * TABLE_ROW_HEIGHT)
  };
}

function componentNodeSize(node, options) {
  const displayedRows = options.compact ? [] : visibleRows(node, { ...options, visibleRows: Math.min(options.visibleRows, 3) });
  const baseHeight = options.compact ? 72 : 86;
  return {
    width: options.nodeWidth ?? DEFAULT_NODE_WIDTH,
    height: Math.max(options.nodeHeight ?? DEFAULT_NODE_HEIGHT, baseHeight + displayedRows.length * COMPONENT_ROW_HEIGHT)
  };
}

function genericNodeSize(node, options) {
  if (node.type === "table") return tableNodeSize(node, options);
  return componentNodeSize(node, options);
}

const defaultNodeRenderers = {
  table: {
    measure: tableNodeSize,
    render: renderTableNode
  },
  service: {
    measure: componentNodeSize,
    render: renderComponentNode
  },
  database: {
    measure: componentNodeSize,
    render: renderComponentNode
  },
  queue: {
    measure: componentNodeSize,
    render: renderComponentNode
  },
  ui: {
    measure: componentNodeSize,
    render: renderComponentNode
  },
  external: {
    measure: componentNodeSize,
    render: renderComponentNode
  },
  gateway: {
    measure: componentNodeSize,
    render: renderComponentNode
  },
  custom: {
    measure: genericNodeSize,
    render: renderComponentNode
  }
};

function nodeRendererFor(node, options) {
  return options.nodeRenderers[node.type] ?? options.nodeRenderers.custom ?? { measure: genericNodeSize, render: renderComponentNode };
}

function measureNode(node, options) {
  return nodeRendererFor(node, options).measure(node, options);
}

function pointListToPath(points) {
  if (!points?.length) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${Number(point.x).toFixed(1)} ${Number(point.y).toFixed(1)}`).join(" ");
}

function positionedNode(x, y, width = DEFAULT_NODE_WIDTH, height = DEFAULT_NODE_HEIGHT) {
  return { x, y, width, height, centerX: x + width / 2, centerY: y + height / 2 };
}

// Anchor a center-line endpoint onto the node's bounding box so the orthogonal fallback
// router exits/enters at the box edge rather than the node center. `side` picks the edge
// that faces the layout flow. The arrowhead marker (refX=tip, markerUnits=userSpaceOnUse)
// extends back from the endpoint toward the edge line, so anchoring the endpoint exactly on
// the border makes the arrow tip touch the node cleanly — no inset is needed or wanted.
function nodeBoundaryAnchor(node, side) {
  switch (side) {
    case "right":
      return { x: node.x + node.width, y: node.centerY };
    case "left":
      return { x: node.x, y: node.centerY };
    case "bottom":
      return { x: node.centerX, y: node.y + node.height };
    case "top":
      return { x: node.centerX, y: node.y };
    default:
      return { x: node.centerX, y: node.centerY };
  }
}

function orthogonalEdgePath(from, to, direction = "RIGHT") {
  if (direction === "DOWN") {
    // Reverse the exit/entry sides when the target sits above the source so the arrow
    // still terminates on the facing border instead of crossing through the node.
    const forward = to.centerY >= from.centerY;
    const start = nodeBoundaryAnchor(from, forward ? "bottom" : "top");
    const end = nodeBoundaryAnchor(to, forward ? "top" : "bottom");
    const midY = (start.y + end.y) / 2;
    return pointListToPath([
      start,
      { x: start.x, y: midY },
      { x: end.x, y: midY },
      end
    ]);
  }
  const forward = to.centerX >= from.centerX;
  const start = nodeBoundaryAnchor(from, forward ? "right" : "left");
  const end = nodeBoundaryAnchor(to, forward ? "left" : "right");
  const midX = (start.x + end.x) / 2;
  return pointListToPath([
    start,
    { x: midX, y: start.y },
    { x: midX, y: end.y },
    end
  ]);
}

function edgeKey(edge, index) {
  return edge.id ?? `${edge.from}->${edge.to}:${edge.type}:${index}`;
}

// Information-flow flavors: directed movement of data/information between components.
// These reuse the existing free-text edge `flavor` field rather than a new schema column.
// An edge is treated as information flow when its flavor is in this set or when it carries
// an explicit `metadata.flow === true` opt-in, so authors can introduce new flow flavors
// without touching the renderer.
const INFORMATION_FLOW_FLAVORS = new Set([
  "flow",
  "data-flow",
  "dataflow",
  "information-flow",
  "reads",
  "writes",
  "publishes",
  "subscribes",
  "consumes",
  "produces",
  "emits",
  "streams",
  "sends",
  "receives",
  "ingests"
]);

export function isInformationFlowEdge(edge) {
  if (!edge) return false;
  if (edge.metadata?.flow === true) return true;
  const flavor = edge.metadata?.flavor ?? edge.flavor;
  return typeof flavor === "string" && INFORMATION_FLOW_FLAVORS.has(flavor.trim().toLowerCase());
}

function validEdges(diagram) {
  const nodeIds = new Set((diagram.nodes ?? []).map((node) => node.id));
  return (diagram.edges ?? []).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to);
}

function diagramContainment(diagram, options) {
  const hierarchyTypes = new Set(options.hierarchyEdgeTypes);
  const nodeIds = new Set((diagram.nodes ?? []).map((node) => node.id));
  const parentByChild = new Map();
  const childrenByParent = new Map();
  function wouldCycle(parentId, childId) {
    let cursor = parentId;
    while (cursor) {
      if (cursor === childId) return true;
      cursor = parentByChild.get(cursor);
    }
    return false;
  }
  for (const edge of diagram.edges ?? []) {
    if (!hierarchyTypes.has(edge.type)) continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    if (edge.from === edge.to || parentByChild.has(edge.to) || wouldCycle(edge.from, edge.to)) continue;
    parentByChild.set(edge.to, edge.from);
    const children = childrenByParent.get(edge.from) ?? [];
    children.push(edge.to);
    childrenByParent.set(edge.from, children);
  }
  return { parentByChild, childrenByParent };
}

function containmentDepths(diagram, parentByChild) {
  const depths = new Map();
  for (const node of diagram.nodes ?? []) {
    let depth = 0;
    let cursor = parentByChild.get(node.id);
    const seen = new Set([node.id]);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = parentByChild.get(cursor);
    }
    depths.set(node.id, depth);
  }
  return depths;
}

function edgesForLayout(diagram, options, hierarchyActive) {
  const hierarchyTypes = new Set(options.hierarchyEdgeTypes);
  return validEdges(diagram).filter((edge) => !(hierarchyActive && hierarchyTypes.has(edge.type)));
}

function fallbackLayeredLayout(diagram, options, sourceLabel) {
  const nodes = diagram.nodes ?? [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of validEdges(diagram)) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const queue = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  const layerByNode = new Map(nodes.map((node) => [node.id, 0]));
  const visited = new Set();
  while (queue.length > 0) {
    const nodeId = queue.shift();
    visited.add(nodeId);
    for (const targetId of outgoing.get(nodeId) ?? []) {
      layerByNode.set(targetId, Math.max(layerByNode.get(targetId) ?? 0, (layerByNode.get(nodeId) ?? 0) + 1));
      incoming.set(targetId, Math.max(0, (incoming.get(targetId) ?? 0) - 1));
      if ((incoming.get(targetId) ?? 0) === 0) queue.push(targetId);
    }
  }
  let cycleLayer = Math.max(0, ...Array.from(layerByNode.values()));
  for (const node of nodes) {
    if (!visited.has(node.id)) layerByNode.set(node.id, cycleLayer++);
  }

  const layers = [];
  for (const node of nodes) {
    const layer = layerByNode.get(node.id) ?? 0;
    layers[layer] ??= [];
    layers[layer].push(node);
  }
  const compactLayers = layers.filter(Boolean);
  const layerSpacing = options.compact ? 104 : 134;
  const rowSpacing = options.compact ? 28 : 36;
  const positions = new Map();
  compactLayers.forEach((layerNodes, layerIndex) => {
    let offset = DEFAULT_LAYOUT_PADDING;
    for (const node of layerNodes) {
      const size = measureNode(node, options);
      if (options.direction === "DOWN") {
        positions.set(node.id, positionedNode(offset, DEFAULT_LAYOUT_PADDING + layerIndex * (size.height + layerSpacing), size.width, size.height));
        offset += size.width + rowSpacing;
      } else {
        positions.set(node.id, positionedNode(DEFAULT_LAYOUT_PADDING + layerIndex * (size.width + layerSpacing), offset, size.width, size.height));
        offset += size.height + rowSpacing;
      }
    }
  });

  const bounds = Array.from(positions.values()).reduce((acc, position) => ({
    maxX: Math.max(acc.maxX, position.x + position.width),
    maxY: Math.max(acc.maxY, position.y + position.height)
  }), { maxX: 0, maxY: 0 });
  const containment = diagramContainment(diagram, options);
  return {
    width: Math.max(options.minWidth, Math.ceil(bounds.maxX + DEFAULT_LAYOUT_PADDING)),
    height: Math.max(options.minHeight, Math.ceil(bounds.maxY + DEFAULT_LAYOUT_PADDING)),
    positions,
    edgePaths: new Map(),
    containmentDepths: containmentDepths(diagram, containment.parentByChild),
    drawHierarchyEdges: true,
    sourceLabel
  };
}

function elkGraphForDiagram(diagram, options) {
  const nodes = diagram.nodes ?? [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const containment = diagramContainment(diagram, options);
  const hierarchyActive = options.hierarchy && containment.parentByChild.size > 0;
  const rootNodes = hierarchyActive ? nodes.filter((node) => !containment.parentByChild.has(node.id)) : nodes;

  function elkNode(node) {
    const size = measureNode(node, options);
    const children = hierarchyActive ? (containment.childrenByParent.get(node.id) ?? []).map((childId) => nodesById.get(childId)).filter(Boolean) : [];
    if (children.length === 0) {
      return { id: node.id, width: size.width, height: size.height };
    }
    return {
      id: node.id,
      width: size.width,
      height: size.height,
      layoutOptions: {
        ...layoutOptions({ ...options, direction: "DOWN" }),
        "elk.padding": "[top=76,left=24,bottom=24,right=24]",
        "elk.spacing.nodeNode": "28",
        "elk.nodeSize.constraints": "MINIMUM_SIZE"
      },
      children: children.map(elkNode)
    };
  }

  return {
    graph: {
      id: diagram.id,
      layoutOptions: layoutOptions(options),
      children: rootNodes.map(elkNode),
      edges: edgesForLayout(diagram, options, hierarchyActive).map((edge, index) => ({
        id: edgeKey(edge, index),
        sources: [edge.from],
        targets: [edge.to]
      }))
    },
    hierarchyActive,
    containmentDepths: containmentDepths(diagram, containment.parentByChild)
  };
}

function layoutFromElk(diagram, graph, options, sourceLabel, containmentDepthMap, hierarchyActive) {
  const positions = new Map();
  function collectNode(child, offsetX, offsetY) {
    const x = offsetX + (child.x ?? 0);
    const y = offsetY + (child.y ?? 0);
    positions.set(child.id, positionedNode(x, y, child.width ?? DEFAULT_NODE_WIDTH, child.height ?? DEFAULT_NODE_HEIGHT));
    for (const grandchild of child.children ?? []) collectNode(grandchild, x, y);
  }
  for (const child of graph.children ?? []) {
    collectNode(child, DEFAULT_LAYOUT_PADDING, DEFAULT_LAYOUT_PADDING);
  }

  const edgePaths = new Map();
  for (const edge of graph.edges ?? []) {
    const section = edge.sections?.[0];
    if (!section?.startPoint || !section?.endPoint) continue;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
      .map((point) => ({ x: point.x + DEFAULT_LAYOUT_PADDING, y: point.y + DEFAULT_LAYOUT_PADDING }));
    edgePaths.set(edge.id, pointListToPath(points));
  }

  const nodeBounds = Array.from(positions.values()).reduce((bounds, position) => ({
    maxX: Math.max(bounds.maxX, position.x + position.width),
    maxY: Math.max(bounds.maxY, position.y + position.height)
  }), { maxX: 0, maxY: 0 });
  return {
    width: Math.max(options.minWidth, Math.ceil(Math.max(graph.width ?? 0, nodeBounds.maxX) + DEFAULT_LAYOUT_PADDING)),
    height: Math.max(options.minHeight, Math.ceil(Math.max(graph.height ?? 0, nodeBounds.maxY) + DEFAULT_LAYOUT_PADDING)),
    positions,
    edgePaths,
    containmentDepths: containmentDepthMap,
    drawHierarchyEdges: !hierarchyActive || options.drawHierarchyEdgesWhenNested,
    sourceLabel
  };
}

export async function layoutDiagram(diagram, inputOptions = {}) {
  const options = normalizeOptions({ ...inputOptions, diagramId: diagram?.id });
  const elk = getElkLayoutEngine();
  if (!elk) return fallbackLayeredLayout(diagram, options, options.elkUnavailableSourceLabel);
  try {
    const { graph: elkGraph, containmentDepths: depthMap, hierarchyActive } = elkGraphForDiagram(diagram, options);
    const graph = await elk.layout(elkGraph);
    return layoutFromElk(diagram, graph, options, options.sourceLabel, depthMap, hierarchyActive);
  } catch (error) {
    console.warn("Mission Control DiagramRenderer ELK layout failed; using fallback layered layout", error);
    return fallbackLayeredLayout(diagram, options, options.elkErrorSourceLabel);
  }
}

function renderRowBadges(badges) {
  const values = Array.isArray(badges) ? badges.filter(Boolean) : [];
  return values.length ? ` <tspan class="diagram-row-badges">${esc(values.join(" "))}</tspan>` : "";
}

function renderTableNode(node, position, options) {
  const width = position.width;
  const height = position.height;
  const rows = visibleRows(node, options);
  const rowText = rows.map((row, index) => `<text class="schema-column-line diagram-node-row" x="14" y="${52 + index * TABLE_ROW_HEIGHT}">${esc(row.label)}${row.value ? ` <tspan class="diagram-row-value">${esc(row.value)}</tspan>` : ""}${renderRowBadges(row.badges)}</text>`).join("");
  const remainingRows = Math.max(0, (node.rows?.length ?? 0) - rows.length);
  const scoped = scopedNodeClass(node, options);
  const scopeAria = scoped ? " · contains a sub-diagram (activate to dig in)" : "";
  return `<g class="map-node schema-node diagram-node diagram-node-table node-type-${classToken(node.type)} ${metadataClassNames(node)}${scoped ? " " + scoped : ""}" data-diagram-node="${esc(node.id)}" data-node-id="${esc(node.id)}" data-schema-table="${esc(node.metadata?.tableName ?? node.title)}" tabindex="0" focusable="true" role="group" aria-label="${esc(`${node.title} table schema. Hover or focus to inspect rows and details.${scopeAria}`)}" transform="translate(${position.x.toFixed(1)} ${position.y.toFixed(1)})">
    <title>${esc(node.subtitle ?? `${node.title}: ${node.rows?.length ?? 0} rows`)}</title>
    <rect width="${width}" height="${height}" rx="10"></rect>
    <text class="map-node-stereotype" x="14" y="18">«${esc(node.type)}»</text>
    <line class="map-node-divider" x1="0" y1="30" x2="${width}" y2="30"></line>
    <text class="schema-table-name map-node-title" x="14" y="43">${esc(node.title)}</text>
    ${rowText}
    ${remainingRows > 0 ? `<text class="schema-column-more" x="14" y="${52 + rows.length * TABLE_ROW_HEIGHT}">+ ${esc(remainingRows)} more rows</text>` : ""}${scopeAffordanceMarkup(node, width, options)}
  </g>`;
}

/** P0-B3: the extra class marking a node as a drill-down scope portal (drillDown only).
 *  P1-B2: never mark the current level's own scope root (you are already inside it). */
function scopedNodeClass(node, options) {
  // `!= null` (not a truthy check) to match the boundary gate (renderDiagramSvg): a level with a
  // falsy-but-non-null scopeOf ("", 0, false) is still a scope child, so its own self-drill glyph
  // must be suppressed here consistently. Real models never hit this (root levels carry no scopeOf
  // → null; enterNodeScope stamps a truthy node.id); it only closes a degenerate-node-id gap.
  if (options.scopeRootId != null && node.id === options.scopeRootId) return "";
  return options.drillDown && nodeHasScope(node, options) ? "diagram-node-scoped" : "";
}

/** P0-B3: the "dig in" glyph rendered top-right of a scoped node (drillDown only). It is a
 *  focusable button carrying `data-diagram-scope-enter=<nodeId>` — the nav controller
 *  (bindDiagramScopeNavigation) delegates off that attribute. Empty string when not scoped,
 *  so non-scope nodes + the default (drillDown off) stay byte-identical. */
function scopeAffordanceMarkup(node, width, options) {
  if (!options.drillDown || !nodeHasScope(node, options)) return "";
  // P1-B2: no "dig in" glyph on the current level's scope root — re-entering its own scope is a
  // no-op self-drill. `scopeRootId` is set (in renderDiagramSvg) only for a scope sub-diagram.
  // `!= null` (not truthy) to stay consistent with the boundary gate / scopedNodeClass above so a
  // falsy-but-non-null scopeOf is treated as a scope child on all three sites.
  if (options.scopeRootId != null && node.id === options.scopeRootId) return "";
  const size = 18;
  const x = Math.max(0, width - size - 8);
  const y = 8;
  return `<g class="diagram-scope-affordance" data-diagram-scope-enter="${esc(node.id)}" role="button" tabindex="0" aria-label="${esc(`Dig into ${node.title}`)}">
    <rect class="diagram-scope-affordance-hit" x="${x.toFixed(1)}" y="${y}" width="${size}" height="${size}" rx="4"></rect>
    <text class="diagram-scope-affordance-glyph" x="${(x + size / 2).toFixed(1)}" y="${y + size - 5}" text-anchor="middle">⤢</text>
  </g>`;
}

/** P1 scope-linking: the outer boundary rendered on a nested scope child (drillDown +
 *  `options.scopeRootId` set + `scopeExitOnBackground !== false`). Three SVG elements in paint
 *  order (lowest first), rendered in diagram/layout coordinates so they track pan/zoom for free:
 *   (a) a full-viewBox TRANSPARENT exit backdrop — the only interactive element; a click on empty
 *       canvas hits it directly (nodes paint above as siblings) and the delegated scope listener
 *       reads `data-diagram-scope-exit` off it to pop one level;
 *   (b) an inset dashed visible frame (`pointer-events:none`) sitting inside the 32px layout
 *       padding so it never overlaps node geometry — a purely spatial cue;
 *   (c) a top-left decorative label chip (`aria-hidden`) naming the parent scope.
 *  Empty string on any root/non-drill level, so those renders stay byte-identical. */
function renderScopeBoundary(layout, diagram, options) {
  const width = layout.width;
  const height = layout.height;
  const inset = DEFAULT_LAYOUT_PADDING / 2; // 16 — inside the 32px layout padding
  const frameW = width - 2 * inset;
  const frameH = height - 2 * inset;
  const scopeOfTitle = diagram?.metadata?.scopeOfTitle ?? "parent scope";
  // Same escaping helper the rest of renderDiagramSvg uses for node text.
  const labelText = `‹ ${shortRef(scopeOfTitle, 32)} · click outside to zoom out`;
  const labelX = inset + 8;
  const labelY = inset + 8;
  const chipW = Math.min(Math.max(labelText.length * 6.6 + 16, 0), Math.max(frameW - 16, 0));
  const chipH = 22;
  return `<rect class="diagram-scope-exit-backdrop" aria-hidden="true" data-diagram-scope-exit="1" x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
      <rect class="diagram-scope-boundary" aria-hidden="true" pointer-events="none" x="${inset}" y="${inset}" width="${frameW}" height="${frameH}" rx="12"></rect>
      <g class="diagram-scope-boundary-label" pointer-events="none" aria-hidden="true">
        <rect class="diagram-scope-boundary-label-bg" x="${labelX}" y="${labelY}" width="${chipW.toFixed(1)}" height="${chipH}" rx="6"></rect>
        <text class="diagram-scope-boundary-label-text" x="${labelX + 8}" y="${labelY + chipH / 2}">${esc(labelText)}</text>
      </g>`;
}

function renderComponentNode(node, position, options) {
  const width = position.width;
  const height = position.height;
  const rows = options.compact ? [] : visibleRows(node, { ...options, visibleRows: Math.min(options.visibleRows, 3) });
  const rowText = rows.map((row, index) => `<text class="diagram-node-row component-node-row" x="12" y="${78 + index * COMPONENT_ROW_HEIGHT}">${esc(row.label)}${row.value ? `: ${esc(shortRef(row.value, 24))}` : ""}</text>`).join("");
  const statusClass = node.status ? `component-status-${classToken(node.status)}` : "";
  const subtitle = node.subtitle ?? node.status ?? "";
  const scoped = scopedNodeClass(node, options);
  const scopeAria = scoped ? " · contains a sub-diagram (activate to dig in)" : "";
  return `<g class="map-node diagram-node component-node ${statusClass} node-type-${classToken(node.type)} ${metadataClassNames(node)}${scoped ? " " + scoped : ""}" data-diagram-node="${esc(node.id)}" data-node-id="${esc(node.id)}" tabindex="0" focusable="true" role="group" aria-label="${esc(`${node.title} ${node.type}${node.status ? ` ${node.status}` : ""}. Hover or focus to inspect details.${scopeAria}`)}" transform="translate(${position.x.toFixed(1)} ${position.y.toFixed(1)})">
    <title>${esc([node.title, node.status, node.type].filter(Boolean).join(": "))}</title>
    <rect width="${width}" height="${height}" rx="10"></rect>
    <text class="map-node-stereotype" x="12" y="18">«${esc(node.type)}»</text>
    <line class="map-node-divider" x1="0" y1="30" x2="${width}" y2="30"></line>
    <text class="map-node-title" x="12" y="48">${esc(shortRef(node.title, 24))}</text>
    ${subtitle ? `<text class="map-node-meta" x="12" y="64">${esc(shortRef(subtitle, 28))}</text>` : ""}
    ${rowText}${scopeAffordanceMarkup(node, width, options)}
  </g>`;
}

function edgeLabel(edge, diagram) {
  const nodes = new Map((diagram.nodes ?? []).map((node) => [node.id, node]));
  const fromTitle = nodes.get(edge.from)?.title ?? edge.from;
  const toTitle = nodes.get(edge.to)?.title ?? edge.to;
  return [fromTitle, "→", toTitle, edge.label, edge.type, edge.description].filter(Boolean).join(" · ");
}

function renderEdgeLabel(edge, from, to, options, isFlow = false) {
  // Information-flow edges always surface their label on the diagram: the flow verb (reads,
  // publishes, …) is the payload, not decoration. Other edge types stay opt-in via showEdgeLabels.
  if ((!options.showEdgeLabels && !isFlow) || !edge.label) return "";
  const x = ((from.centerX + to.centerX) / 2).toFixed(1);
  const y = ((from.centerY + to.centerY) / 2 - 6).toFixed(1);
  const labelClass = isFlow ? "map-edge-label map-edge-flow-label" : "map-edge-label";
  return `<text class="${labelClass}" x="${x}" y="${y}">${esc(shortRef(edge.label, 34))}</text>`;
}

export function renderDiagramSvg(diagram, layout, inputOptions = {}) {
  const options = normalizeOptions({ ...inputOptions, diagramId: diagram?.id });
  // P1-B2: the node that IS the current level's scope root must not re-show a "dig in" glyph —
  // otherwise digging into a container re-enters its own identical scope (an endless self-drill).
  // A scope sub-diagram carries `metadata.scopeOf = <that node id>`; the top-level model has none
  // (→ null → every node keeps its normal affordance, byte-identical to a non-drill-down render).
  options.scopeRootId = diagram?.metadata?.scopeOf ?? null;
  const markerId = options.markerId;
  const hierarchyTypes = new Set(options.hierarchyEdgeTypes);
  const flowMarkerId = `${markerId}-flow`;
  // Lifecycle + stages are MODEL-declared; both absent (every pre-existing model) ⇒ the markup
  // below is byte-identical to before either feature existed.
  const lifecycle = diagramLifecycle(diagram);
  const staged = diagramStages(diagram).length > 0;
  const edges = validEdges(diagram).flatMap((edge, index) => {
    if (hierarchyTypes.has(edge.type) && layout.drawHierarchyEdges === false) return [];
    const from = layout.positions.get(edge.from);
    const to = layout.positions.get(edge.to);
    if (!from || !to) return [];
    const path = layout.edgePaths.get(edgeKey(edge, index)) || orthogonalEdgePath(from, to, options.direction);
    const kindToken = edge.metadata?.kind ?? edge.type;
    const flavorToken = edge.metadata?.flavor ?? edge.type;
    const isFlow = isInformationFlowEdge(edge);
    const groupClass = `map-edge-group edge-type-${classToken(edge.type)}${isFlow ? " map-edge-group-flow" : ""}`;
    const pathClass = `map-edge edge-kind-${classToken(kindToken)} edge-flavor-${classToken(flavorToken)}${isFlow ? " map-edge-flow" : ""}`;
    const flowAttr = isFlow ? ` data-edge-flow="${esc(classToken(flavorToken))}"` : "";
    // Every edge group carries its render key: the stage controller toggles visibility by it and
    // bindDiagramPopovers resolves hover/focus hits by it (nodes use data-diagram-node the same
    // way). The transparent map-edge-hit twin widens the pointer target so a 2px stroke is
    // actually hoverable; tabindex mirrors the nodes so keyboard focus reaches edge details too.
    const edgeMarkerId = isFlow ? flowMarkerId : markerId;
    return [`<g class="${groupClass}"${flowAttr} data-diagram-edge="${esc(edgeKey(edge, index))}" tabindex="0" focusable="true" role="group" aria-label="${esc(`${edgeLabel(edge, diagram)}. Hover or focus to inspect details.`)}">
      <title>${esc(edgeLabel(edge, diagram))}</title>
      <path class="map-edge-hit" d="${esc(path)}" pointer-events="stroke"></path>
      <path class="${pathClass}" d="${esc(path)}" marker-end="url(#${edgeMarkerId})"></path>
      ${renderEdgeLabel(edge, from, to, options, isFlow)}
    </g>`];
  }).join("");

  const nodeGroups = [...(diagram.nodes ?? [])].sort((left, right) => {
    const leftDepth = layout.containmentDepths?.get(left.id) ?? 0;
    const rightDepth = layout.containmentDepths?.get(right.id) ?? 0;
    return leftDepth - rightDepth || diagram.nodes.indexOf(left) - diagram.nodes.indexOf(right);
  }).flatMap((node) => {
    const position = layout.positions.get(node.id);
    if (!position) return [];
    const renderer = nodeRendererFor(node, options);
    return [renderer.render(node, position, options)];
  }).join("");

  // P1 scope-linking: the outer boundary + exit backdrop, only on a nested scope child under
  // drillDown (gated exactly like the "dig in" glyph so root/non-drill renders stay byte-identical).
  // Injected between the edge and node groups below so the backdrop is a SIBLING beneath the nodes
  // (never their ancestor) — that keeps hit-testing DOM-only in bindDiagramScopeNavigation.
  const scopeBoundary =
    (options.drillDown && options.scopeRootId != null && options.scopeExitOnBackground !== false)
      ? renderScopeBoundary(layout, diagram, options)
      : "";

  // The lifecycle badge rides the figcaption (crisp HTML, outside pan/zoom); the watermark
  // rides INSIDE the SVG so a standalone export still carries the marking unmistakably.
  const lifecycleBadge = lifecycle
    ? ` <span class="diagram-lifecycle-badge diagram-lifecycle-badge-${lifecycle.state}"${lifecycle.note ? ` title="${esc(lifecycle.note)}"` : ""}>${esc(lifecycle.label)}</span>`
    : "";
  const captionContent = options.caption
    ? options.caption(layout)
    : `${esc(diagram.title)} <span class="diagram-engine">${esc(layout.sourceLabel)}</span>`;
  const caption = `<figcaption>${captionContent}${lifecycleBadge}</figcaption>`;

  const watermark = lifecycle
    ? `<text class="diagram-lifecycle-watermark diagram-lifecycle-watermark-${lifecycle.state}" x="${(layout.width / 2).toFixed(1)}" y="${(layout.height / 2).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="${Math.max(28, Math.min(layout.width, layout.height) / 6).toFixed(0)}" transform="rotate(-18 ${(layout.width / 2).toFixed(1)} ${(layout.height / 2).toFixed(1)})" aria-hidden="true">${esc(lifecycle.label)}</text>`
    : "";

  const svgKindClass = diagram.kind === "schema" ? "schema-diagram" : "architecture-map";
  const lifecycleClass = lifecycle ? ` diagram-lifecycle diagram-lifecycle-${lifecycle.state}` : "";
  const stagedClass = staged ? " diagram-staged" : "";
  const ariaLabel = lifecycle ? `${options.ariaLabel} (${lifecycle.label})` : options.ariaLabel;
  return `${caption}
    <svg class="diagram-svg ${svgKindClass} diagram-kind-${classToken(diagram.kind)}${lifecycleClass}${stagedClass}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${esc(ariaLabel)}">
      <defs>
        <marker id="${markerId}" class="diagram-arrow-marker" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>
        <marker id="${flowMarkerId}" class="diagram-arrow-marker diagram-arrow-marker-flow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>
      </defs>
      <g class="map-edges">${edges}</g>${scopeBoundary ? `
      ${scopeBoundary}` : ""}
      <g class="map-nodes">${nodeGroups}</g>${watermark ? `
      ${watermark}` : ""}
    </svg>`;
}

function ensureDiagramPopover(target = activePopoverTarget) {
  const documentRef = diagramDocumentFor(target);
  if (!documentRef?.body) return null;
  let popover = diagramPopoverForDocument(documentRef);
  if (!popover) {
    popover = documentRef.createElement("div");
    popover.id = "diagram-node-popover";
    popover.className = "diagram-popover diagram-node-popover";
    popover.setAttribute("role", "tooltip");
    popover.hidden = true;
    documentRef.body.append(popover);
  }
  if (!popover.dataset.bound) {
    popover.dataset.bound = "true";
    popover.addEventListener("pointerenter", clearDiagramPopoverHideTimer);
    popover.addEventListener("pointerleave", () => scheduleHideDiagramPopover(activePopoverTarget, 80));
  }
  return popover;
}

function clearDiagramPopoverHideTimer() {
  if (!popoverHideTimer) return;
  if (popoverHideTimerWindow?.clearTimeout) popoverHideTimerWindow.clearTimeout(popoverHideTimer);
  else globalThis.clearTimeout(popoverHideTimer);
  popoverHideTimer = null;
  popoverHideTimerWindow = null;
}

function scheduleHideDiagramPopover(target = activePopoverTarget, delay = 140) {
  clearDiagramPopoverHideTimer();
  const browserWindow = diagramWindowFor(target);
  popoverHideTimerWindow = browserWindow;
  popoverHideTimer = browserWindow?.setTimeout ? browserWindow.setTimeout(() => hideDiagramPopover(target), delay) : globalThis.setTimeout(() => hideDiagramPopover(target), delay);
}

function clearDiagramPopoverShowTimer() {
  if (!popoverShowTimer) return;
  if (popoverShowTimerWindow?.clearTimeout) popoverShowTimerWindow.clearTimeout(popoverShowTimer);
  else globalThis.clearTimeout(popoverShowTimer);
  popoverShowTimer = null;
  popoverShowTimerWindow = null;
}

// Hover-dwell debounce for the informational popover: only reveal `target`'s popover once the
// pointer has stayed on it for `delay` ms. Any competing show/hide/leave clears the pending timer
// (see clearDiagramPopoverShowTimer callers), so moving away before the dwell elapses shows nothing
// and moving between nodes restarts the dwell. A non-positive delay shows immediately (keeps the
// focus / opt-out paths synchronous).
function scheduleShowDiagramNodePopover(target, node, delay) {
  clearDiagramPopoverShowTimer();
  // A new dwell supersedes any pending hide (e.g. a jittery leave-and-return on the same node):
  // otherwise the stale ~140ms hide would fire mid-dwell and cancel the fresh show timer.
  clearDiagramPopoverHideTimer();
  if (!(delay > 0)) { showDiagramNodePopover(target, node); return; }
  const browserWindow = diagramWindowFor(target);
  popoverShowTimerWindow = browserWindow;
  const fire = () => { popoverShowTimer = null; popoverShowTimerWindow = null; showDiagramNodePopover(target, node); };
  popoverShowTimer = browserWindow?.setTimeout ? browserWindow.setTimeout(fire, delay) : globalThis.setTimeout(fire, delay);
}

export function hideDiagramPopover(target = activePopoverTarget) {
  const documentRef = diagramDocumentFor(target);
  clearDiagramPopoverHideTimer();
  clearDiagramPopoverShowTimer();
  if (target) target.removeAttribute("aria-describedby");
  activePopoverTarget = null;
  const popover = diagramPopoverForDocument(documentRef);
  if (!popover) return;
  popover.hidden = true;
  replaceDiagramPopoverContent(popover, null);
}

export function hideDiagramPopoverForPageEvent(event) {
  const eventTarget = event?.target;
  const documentRef = diagramDocumentFor(eventTarget ?? activePopoverTarget);
  const popover = diagramPopoverForDocument(documentRef);
  if (isDiagramNode(eventTarget, popover ?? activePopoverTarget) && popover?.contains(eventTarget)) return;
  hideDiagramPopover(activePopoverTarget ?? eventTarget);
}

function normalizeDetails(node) {
  const sections = Array.isArray(node.details?.sections) ? node.details.sections : [];
  if (sections.length > 0) return node.details;
  const fallbackRows = [];
  if (node.type) fallbackRows.push({ label: "type", value: node.type });
  if (node.status) fallbackRows.push({ label: "status", value: node.status });
  if (node.description) fallbackRows.push({ label: "description", value: node.description });
  for (const row of node.rows ?? []) fallbackRows.push(row);
  return {
    title: node.title,
    kicker: node.type === "table" ? "Actual table schema" : `${node.type} details`,
    sections: fallbackRows.length ? [{ title: "Details", rows: fallbackRows }] : []
  };
}

function appendPopoverCount(documentRef, container, value, label) {
  const count = createDiagramPopoverElement(documentRef, "span", { className: "count-pill" });
  count.append(createDiagramPopoverElement(documentRef, "strong", { text: value }));
  appendDiagramText(documentRef, count, label);
  container.append(count);
}

function appendPopoverRow(documentRef, rowsElement, row) {
  const wrapper = createDiagramPopoverElement(documentRef, "div");
  const label = createDiagramPopoverElement(documentRef, "dt");
  appendDiagramText(documentRef, label, row.label ?? "");
  const badges = Array.isArray(row.badges) ? row.badges.filter(Boolean) : [];
  if (badges.length > 0) {
    appendDiagramText(documentRef, label, " ");
    const badgeList = createDiagramPopoverElement(documentRef, "span", { className: "diagram-popover-badges" });
    for (const badge of badges) {
      badgeList.append(createDiagramPopoverElement(documentRef, "span", { className: "chip blue", text: badge }));
    }
    label.append(badgeList);
  }
  wrapper.append(label);
  wrapper.append(createDiagramPopoverElement(documentRef, "dd", { text: compactText(row.value ?? row.description ?? "") }));
  rowsElement.append(wrapper);
}

function appendPopoverSection(documentRef, popover, section) {
  const rows = section.rows ?? [];
  const title = section.title ?? "Details";
  const sectionClass = /foreign key/i.test(title) ? "schema-popover-fks" : "diagram-popover-section";
  const sectionElement = createDiagramPopoverElement(documentRef, "div", { className: sectionClass, ariaLabel: title });
  sectionElement.append(createDiagramPopoverElement(documentRef, "strong", { text: title }));
  if (rows.length === 0) {
    sectionElement.append(createDiagramPopoverElement(documentRef, "p", { className: "schema-popover-empty", text: "No rows." }));
  } else {
    const rowsElement = createDiagramPopoverElement(documentRef, "dl", { className: "schema-popover-columns diagram-popover-rows" });
    for (const row of rows) appendPopoverRow(documentRef, rowsElement, row);
    sectionElement.append(rowsElement);
  }
  popover.append(sectionElement);
}

function appendDiagramPopoverContent(documentRef, popover, node) {
  const details = normalizeDetails(node);
  const sections = details.sections ?? [];
  popover.append(createDiagramPopoverElement(documentRef, "div", { className: "diagram-popover-kicker", text: details.kicker ?? `${node.type} details` }));
  popover.append(createDiagramPopoverElement(documentRef, "h4", { text: details.title ?? node.title }));
  if (node.rows?.length || node.status) {
    const counts = createDiagramPopoverElement(documentRef, "div", { className: "schema-popover-counts diagram-popover-counts" });
    if (node.rows?.length) appendPopoverCount(documentRef, counts, node.rows.length, " rows");
    if (node.status) appendPopoverCount(documentRef, counts, node.status, " status");
    popover.append(counts);
  }
  if (node.description) {
    popover.append(createDiagramPopoverElement(documentRef, "p", { className: "schema-popover-empty diagram-popover-description", text: node.description }));
  }
  if (sections.length === 0) {
    popover.append(createDiagramPopoverElement(documentRef, "p", { className: "schema-popover-empty", text: "No details available." }));
    return;
  }
  for (const section of sections) appendPopoverSection(documentRef, popover, section);
}

function positionDiagramPopover(target, popover) {
  const margin = 12;
  const browserWindow = diagramWindowFor(target);
  const viewportWidth = browserWindow?.innerWidth ?? 1024;
  const viewportHeight = browserWindow?.innerHeight ?? 768;
  const rect = target.getBoundingClientRect();
  popover.style.visibility = "hidden";
  popover.hidden = false;
  const width = popover.offsetWidth || 360;
  const height = popover.offsetHeight || 220;
  let left = rect.right + margin;
  if (left + width > viewportWidth - margin) left = rect.left - width - margin;
  left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
  let top = rect.top + Math.min(18, rect.height / 2);
  if (top + height > viewportHeight - margin) top = viewportHeight - height - margin;
  top = Math.max(margin, top);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.style.visibility = "";
}

function showDiagramNodePopover(target, node) {
  clearDiagramPopoverHideTimer();
  clearDiagramPopoverShowTimer();
  const popover = ensureDiagramPopover(target);
  if (!popover) return;
  activePopoverTarget?.removeAttribute("aria-describedby");
  activePopoverTarget = target;
  target.setAttribute("aria-describedby", popover.id);
  replaceDiagramPopoverContent(popover, node);
  positionDiagramPopover(target, popover);
}

function diagramNodeEventTarget(target, container) {
  if (!isDiagramNode(target, container)) return null;
  let cursor = target;
  while (cursor && cursor !== container) {
    if (cursor.getAttribute?.("data-diagram-node")) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}

function stayedInsideDiagramNode(element, relatedTarget) {
  return isDiagramNode(relatedTarget, element) && element.contains(relatedTarget);
}

function diagramEdgeEventTarget(target, container) {
  if (!isDiagramNode(target, container)) return null;
  let cursor = target;
  while (cursor && cursor !== container) {
    if (cursor.getAttribute?.("data-diagram-edge")) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}

// Synthesize the node-shaped popover payload for an EDGE: the kicker names the relationship's
// endpoints, the body carries the label, the colloquial description, and kind/flavor rows.
// Reusing the node popover renderer wholesale keeps edges and nodes visually identical.
function edgePopoverModel(edge, diagram) {
  const nodes = new Map((diagram.nodes ?? []).map((node) => [node.id, node]));
  const fromTitle = nodes.get(edge.from)?.title ?? edge.from;
  const toTitle = nodes.get(edge.to)?.title ?? edge.to;
  const rows = [{ label: "type", value: edge.type ?? "edge" }];
  const kind = edge.metadata?.kind;
  const flavor = edge.metadata?.flavor;
  if (typeof kind === "string" && kind && kind !== edge.type) rows.push({ label: "kind", value: kind });
  if (typeof flavor === "string" && flavor && flavor !== edge.type) rows.push({ label: "flavor", value: flavor });
  return {
    type: edge.type ?? "edge",
    title: edge.label ?? `${fromTitle} → ${toTitle}`,
    description: edge.description,
    details: {
      kicker: `${fromTitle} → ${toTitle}`,
      title: edge.label ?? `${fromTitle} → ${toTitle}`,
      sections: [{ title: "Relationship", rows }]
    }
  };
}

function unbindDelegatedDiagramPopovers(container) {
  const cleanup = delegatedDiagramPopoverBindings.get(container);
  if (!cleanup) return;
  cleanup();
  delegatedDiagramPopoverBindings.delete(container);
}

export function cleanupHydratedDiagram(container) {
  if (!container) return;
  hydrationTokens.delete(container);
  // Phase 2: cancel any in-flight animated scope transition (cancelAnimationFrame + remove the
  // clone overlay + restore the incoming svg). No-op when nothing is animating (the default).
  cancelScopeTransition(container);
  unbindDelegatedDiagramPopovers(container);
  disablePanZoom(container);
  // P0-B3: tear down the drill-down nav + stack + breadcrumb.
  unbindDiagramScopeNavigation(container);
  diagramScopeStacks.delete(container);
  container.querySelector?.(".diagram-scope-breadcrumb")?.remove();
  // Staged process controls: unbind removes the stage bar + per-container state.
  unbindDiagramStageControls(container);
  container.querySelector?.(".diagram-stage-bar")?.remove();
  if (activePopoverTarget && typeof container.contains === "function" && container.contains(activePopoverTarget)) {
    hideDiagramPopover(activePopoverTarget);
  }
}

// Exported for tests (drive hover/focus/leave against a fake DOM + fake timers). Consumers normally
// reach this via hydrateDiagram; direct use is fine for a host that lays out its own SVG.
export function bindDiagramPopovers(container, diagram, options) {
  unbindDelegatedDiagramPopovers(container);
  hideDiagramPopover();
  if (!options.showPopovers) return;
  const byId = new Map((diagram.nodes ?? []).map((node) => [node.id, node]));
  // Same keying as the renderer's data-diagram-edge stamp (edgeKey over validEdges order), so a
  // hovered edge group always resolves to its model. Payloads are synthesized once per bind.
  const edgeModels = new Map(validEdges(diagram).map((edge, index) => [edgeKey(edge, index), edgePopoverModel(edge, diagram)]));
  // Idempotent for the normal path (options are pre-normalized by hydrateDiagram); also gives a
  // direct external caller the documented 2000ms default instead of a silent 0.
  const hoverDelay = normalizePopoverHoverDelayMs(options.popoverHoverDelayMs);
  const nodeFromEvent = (event) => {
    const element = diagramNodeEventTarget(event.target, container);
    if (!element || stayedInsideDiagramNode(element, event.relatedTarget)) return null;
    const node = byId.get(element.getAttribute("data-diagram-node"));
    return node ? { element, node } : null;
  };
  // Edges resolve exactly like nodes, from their own stamp; a node hit wins (an edge group never
  // contains a node, so the order only matters for determinism).
  const edgeFromEvent = (event) => {
    const element = diagramEdgeEventTarget(event.target, container);
    if (!element || stayedInsideDiagramNode(element, event.relatedTarget)) return null;
    const model = edgeModels.get(element.getAttribute("data-diagram-edge"));
    return model ? { element, node: model } : null;
  };
  const hitFromEvent = (event) => nodeFromEvent(event) ?? edgeFromEvent(event);
  // Hover: debounced by `hoverDelay` — the pointer must dwell on the node before the popover shows.
  const showHover = (event) => {
    const hit = hitFromEvent(event);
    if (hit) scheduleShowDiagramNodePopover(hit.element, hit.node, hoverDelay);
  };
  // Focus (keyboard): deliberate navigation, so show immediately — never make a keyboard user wait.
  const showFocus = (event) => {
    const hit = hitFromEvent(event);
    if (hit) showDiagramNodePopover(hit.element, hit.node);
  };
  const scheduleHide = (event) => {
    const hit = hitFromEvent(event);
    if (!hit) return;
    // Leaving the node before its dwell elapsed cancels the pending show (so nothing ever appears).
    clearDiagramPopoverShowTimer();
    scheduleHideDiagramPopover(hit.element);
  };
  const hide = (event) => {
    const hit = hitFromEvent(event);
    if (hit) hideDiagramPopover(hit.element);
  };
  container.addEventListener("pointerover", showHover);
  container.addEventListener("pointerout", scheduleHide);
  container.addEventListener("focusin", showFocus);
  container.addEventListener("focusout", hide);
  delegatedDiagramPopoverBindings.set(container, () => {
    container.removeEventListener("pointerover", showHover);
    container.removeEventListener("pointerout", scheduleHide);
    container.removeEventListener("focusin", showFocus);
    container.removeEventListener("focusout", hide);
    // Drop any pending hover-dwell so a torn-down diagram can't pop a popover after unbind.
    clearDiagramPopoverShowTimer();
  });
}

// ---- Scope / drill-down navigation (P0-B3) --------------------------------
// Opt-in via `drillDown: true`. A node with a scope (inline `scope`, a `metadata.scopeRef`
// resolved by `resolveScope(node)`, or `hasScope(node)`) is a PORTAL: activating its "dig in"
// glyph navigates INTO its sub-diagram (not rendered inline), pushing a breadcrumb. The stack
// lives per-container in a WeakMap (mirrors panZoomBindings/hydrationTokens); each level is a
// full re-render via renderDiagramLevel, so nested scopes compose. Default OFF ⇒ byte-identical.

const diagramScopeStacks = new WeakMap();
const diagramScopeBindings = new WeakMap();

function diagramScopeStack(container) {
  return diagramScopeStacks.get(container) ?? [];
}

/** Resolve a scoped node's sub-diagram: inline `node.scope` wins, else `resolveScope(node)`. */
async function resolveNodeScope(node, options) {
  if (node?.scope != null) return node.scope;
  if (typeof options.resolveScope === "function") {
    try {
      return await options.resolveScope(node);
    } catch (error) {
      // Loud-over-silent: a resolver failure is surfaced, but never throws out of a click handler.
      if (typeof console !== "undefined") console.warn("graphpaper: resolveScope failed for node", node?.id, error);
      return null;
    }
  }
  return null;
}

function renderScopeBreadcrumb(container, options) {
  const doc = container.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  container.querySelector?.(".diagram-scope-breadcrumb")?.remove();
  const stack = diagramScopeStack(container);
  if (!doc || stack.length <= 1) return;
  const nav = doc.createElement("nav");
  nav.className = "diagram-scope-breadcrumb";
  nav.setAttribute("aria-label", "Diagram scope path");
  stack.forEach((entry, index) => {
    if (index > 0) {
      const sep = doc.createElement("span");
      sep.className = "diagram-scope-crumb-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "›";
      nav.appendChild(sep);
    }
    const isCurrent = index === stack.length - 1;
    const crumb = doc.createElement("button");
    crumb.type = "button";
    crumb.className = `diagram-scope-crumb${isCurrent ? " diagram-scope-crumb-current" : ""}`;
    crumb.textContent = entry.title ?? (index === 0 ? "root" : `scope ${index}`);
    if (isCurrent) crumb.setAttribute("aria-current", "true");
    else crumb.addEventListener("click", (event) => { event.preventDefault?.(); void exitToScopeDepth(container, index, options); });
    nav.appendChild(crumb);
  });
  // Prepend above the SVG so the path reads top-to-bottom.
  if (typeof container.prepend === "function") container.prepend(nav);
  else container.insertBefore?.(nav, container.firstChild ?? null);
}

async function enterNodeScope(container, node, options) {
  // Capture the hydration token BEFORE the (possibly async) resolve: if a newer hydrate/enter
  // supersedes this one during the await, bail — otherwise a stale resolve would push onto the
  // wrong stack + clobber the newer render (first-enter-wins; matters for an async resolveScope).
  const token = hydrationTokens.get(container);
  const sub = await resolveNodeScope(node, options);
  if (!sub) return;
  if (hydrationTokens.get(container) !== token) return;
  // P1-B2: stamp the entered node as THIS level's scope root (`metadata.scopeOf`) so its own
  // "dig in" glyph is suppressed at render — no endless self-drill re-entering an identical scope.
  // Done in the primitive so it holds for EVERY drill-down consumer (inline `node.scope`, a
  // `resolveScope`, MC's containment resolver alike), not only those that stamp it themselves. A
  // model that already carries `scopeOf` wins (idempotent). Shallow copy — never mutate the
  // consumer's own model object; the copy is what the stack re-renders + `onScopeChange` reports.
  // Alongside `scopeOf` (the back-pointer node id), stamp `scopeOfTitle` — the parent's display
  // title — so the pure renderer's outer-boundary label (renderScopeBoundary) can name the parent
  // scope without a stack. A host that pre-stamped either key wins (idempotent).
  const scopedModel = {
    ...sub,
    metadata: {
      ...(sub.metadata ?? {}),
      scopeOf: sub.metadata?.scopeOf ?? node.id,
      scopeOfTitle: sub.metadata?.scopeOfTitle ?? (node.title ?? node.id)
    }
  };
  const stack = diagramScopeStack(container).slice();
  stack.push({ title: node.title ?? node.id, model: scopedModel });
  diagramScopeStacks.set(container, stack);
  emitScopeChange(container, options);
  // Phase 2: the crisp commit is the EXISTING renderDiagramLevel promise; runScopeTransition either
  // just awaits it (crisp default — behaviorally identical to before) or wraps it in the animated
  // matched-frame cross-fade. `nodeId` is the ENTERING node — its box lives in the outgoing level.
  await runScopeTransition(container, options, {
    direction: "enter",
    nodeId: node.id,
    incomingDiagram: scopedModel,
    commit: () => renderDiagramLevel(container, scopedModel, options, { restoreFocus: true })
  });
}

async function exitToScopeDepth(container, depth, options) {
  const stack = diagramScopeStack(container).slice(0, depth + 1);
  if (stack.length === 0) return;
  const outgoingModel = diagramScopeStack(container)[diagramScopeStack(container).length - 1]?.model ?? null;
  diagramScopeStacks.set(container, stack);
  emitScopeChange(container, options);
  const targetModel = stack[stack.length - 1].model;
  // Phase 2: for EXIT the matched box is the node in the PARENT (incoming) we return to — the child's
  // `metadata.scopeOf`. Its on-screen box must be read on the incoming parent svg AFTER commit.
  await runScopeTransition(container, options, {
    direction: "exit",
    nodeId: outgoingModel?.metadata?.scopeOf ?? null,
    incomingDiagram: targetModel,
    commit: () => renderDiagramLevel(container, targetModel, options, { restoreFocus: true })
  });
}

function emitScopeChange(container, options) {
  if (typeof options.onScopeChange !== "function") return;
  const stack = diagramScopeStack(container);
  try {
    options.onScopeChange({
      depth: Math.max(0, stack.length - 1),
      path: stack.map((entry) => entry.title ?? ""),
      model: stack[stack.length - 1]?.model ?? null
    });
  } catch { /* a host callback must never break navigation */ }
}

// ---- Phase 2: DOM orchestration of the animated scope transition ------------
// Per-container cancel handle (mirrors panZoomBindings/diagramScopeBindings). Stores a fn that
// cancelAnimationFrame(id) + removes the clone overlay + restores the incoming svg's inline styles.
// Called+deleted at the START of every runScopeTransition (supersede a prior tween) and from
// cleanupHydratedDiagram (tear-down self-cancel).
const diagramTransitionBindings = new WeakMap();

function cancelScopeTransition(container) {
  const cancel = diagramTransitionBindings.get(container);
  if (cancel) cancel();
  diagramTransitionBindings.delete(container);
}

/** Query the on-screen box of a rendered node group `[data-diagram-node="<id>"]` inside `svg`.
 *  Returns null when the group or getBoundingClientRect is missing. */
function scopeNodeScreenRect(svg, nodeId) {
  if (!svg || nodeId == null || typeof svg.querySelector !== "function") return null;
  const escaped = String(nodeId).replace(/"/g, '\\"');
  const group = svg.querySelector(`[data-diagram-node="${escaped}"]`);
  if (!group || typeof group.getBoundingClientRect !== "function") return null;
  const rect = group.getBoundingClientRect();
  return rect && Number.isFinite(rect.width) && rect.width > 0 ? rect : null;
}

/** Clear the inline styles the tween sets on the incoming svg, returning it to the crisp state. */
function clearScopeTransitionStyle(svg) {
  if (!svg || !svg.style) return;
  svg.style.transform = "";
  svg.style.opacity = "";
  svg.style.willChange = "";
  svg.style.transformOrigin = "";
  svg.style.pointerEvents = "";
}

/**
 * Phase 2: run a scope enter/exit either crisply (default) or as an opt-in animated matched-frame
 * cross-fade. `commit` is a thunk returning the EXISTING renderDiagramLevel(...) promise — the
 * authoritative single-layout swap+hydrate of the incoming level. Behavior:
 *   - Not animating → `return await commit()` (BEHAVIORALLY IDENTICAL to pre-Phase-2).
 *   - Animating → snapshot the outgoing svg into a dead overlay clone, await commit(), then rAF-lerp
 *     BOTH layers via CSS transform+opacity only (never the viewBox). Aborts (leaving the committed
 *     crisp DOM) if a newer transition or hydrate supersedes mid-flight. Always cleans up.
 * `_hooks` is a test seam (frame/schedule injection); production passes nothing.
 */
async function runScopeTransition(container, options, { direction, nodeId, incomingDiagram, commit } = {}, _hooks = {}) {
  // Supersede any prior in-flight tween immediately (a newer enter/exit wins).
  cancelScopeTransition(container);

  if (!shouldAnimateScopeTransition(options, container, incomingDiagram)) {
    // DEFAULT / crisp / reduced-motion / too-big path — no rAF, no clone, no measurement, no
    // getBoundingClientRect. BEHAVIORALLY IDENTICAL to the pre-Phase-2 direct `await commit()`.
    return await commit();
  }

  const outgoingSvg = scopeTransitionOutgoingSvg(container);
  const win = container?.ownerDocument?.defaultView;
  const durationMs = options?.scopeTransition?.durationMs ?? DEFAULT_SCOPE_TRANSITION_DURATION_MS;

  // Measure the OUTGOING geometry ONCE, before commit swaps the svg's contents.
  const outgoingSvgRect = outgoingSvg && typeof outgoingSvg.getBoundingClientRect === "function"
    ? outgoingSvg.getBoundingClientRect()
    : null;
  // For ENTER the matched box is read on the OUTGOING svg (the entering node lives there).
  const enterNodeRect = direction === "enter" ? scopeNodeScreenRect(outgoingSvg, nodeId) : null;

  // Build the dead snapshot overlay (a clone of the outgoing svg) stacked over the container.
  const doc = container.ownerDocument;
  const layer = typeof doc?.createElement === "function" ? doc.createElement("div") : null;
  let cloneSvg = null;
  if (layer && typeof outgoingSvg?.cloneNode === "function" && typeof container.appendChild === "function") {
    layer.className = "diagram-scope-transition-layer";
    if (layer.style) {
      layer.style.position = "absolute";
      layer.style.inset = "0";
      layer.style.pointerEvents = "none";
      layer.style.willChange = "transform,opacity";
    }
    cloneSvg = outgoingSvg.cloneNode(true);
    if (cloneSvg?.style) {
      cloneSvg.style.transformOrigin = "0 0";
      cloneSvg.style.willChange = "transform,opacity";
    }
    if (typeof layer.appendChild === "function") layer.appendChild(cloneSvg);
    container.appendChild(layer);
  }

  // ---- Cancellation state, registered BEFORE `await commit()` --------------------------------
  // `commit()` (renderDiagramLevel) genuinely suspends on `await layoutDiagram` (async ELK). A rapid
  // double interaction (double-click, enter-then-background-exit) can start tween B while tween A is
  // still suspended here. If A's cancel handle is only registered AFTER the await, B's
  // `cancelScopeTransition(container)` at the top of runScopeTransition is a NO-OP against A — A's
  // clone + rAF leak past the supersede. So register a canceller NOW: it tears down the
  // already-appended clone overlay, marks the tween aborted, cancels any scheduled rAF, and settles
  // the caller. The SAME `cancelBinding` serves both the mid-commit window and the animating phase
  // (rafId is null until the rAF loop starts; incomingSvg is filled in after commit).
  let rafId = null;
  let resolveTween = null; // set once the animation Promise is created; lets an external cancel settle it
  let finished = false;
  let aborted = false; // set by an external cancel firing DURING `await commit()` (before we animate)
  let incomingSvg = null; // resolved after commit; finish() clears its inline tween styles
  const finish = () => {
    if (finished) return;
    finished = true;
    if (layer && typeof layer.remove === "function") layer.remove();
    else if (layer?.parentNode && typeof layer.parentNode.removeChild === "function") layer.parentNode.removeChild(layer);
    clearScopeTransitionStyle(incomingSvg);
    if (diagramTransitionBindings.get(container) === cancelBinding) diagramTransitionBindings.delete(container);
    // Settle the awaiting enter/exit — a superseded/canceled tween must never hang its caller.
    if (typeof resolveTween === "function") resolveTween();
  };

  const cancelBinding = () => {
    aborted = true;
    if (rafId != null && typeof win?.cancelAnimationFrame === "function") win.cancelAnimationFrame(rafId);
    rafId = null;
    finish();
  };
  diagramTransitionBindings.set(container, cancelBinding);

  // The authoritative crisp commit (single ELK layout + swap + hydrate of the incoming level).
  // renderDiagramLevel bumps `nextHydrationToken` FIRST and RETURNS the token IT installed. We
  // capture THAT (our OWN commit's token) rather than the global-current token: if a newer render
  // (tween B) superseded during our commit's own await, renderDiagramLevel bailed WITHOUT swapping
  // and the global token is now B's — reading the global here would make `superseded()` compare a
  // value against itself and wrongly conclude we were NOT superseded, animating a stale svg. Reading
  // our OWN installed token makes the comparison honest.
  const committedToken = await commit();

  incomingSvg = scopeTransitionOutgoingSvg(container);

  // A tween is superseded when: an external cancel fired during our commit's await (`aborted`); the
  // container left the DOM; a NEWER renderDiagramLevel bumped the hydration token past the one OUR
  // commit installed; or there is no incoming svg to animate.
  const superseded = () =>
    aborted ||
    container.isConnected === false ||
    hydrationTokens.get(container) !== committedToken ||
    !incomingSvg;

  // If commit already bailed (token superseded during its own await) OR another transition raced in
  // (aborted our binding), leave the DOM in the committed crisp state and stop.
  if (superseded() || !outgoingSvgRect || !incomingSvg?.style) { finish(); return; }

  // For EXIT the matched box is on the INCOMING (parent) svg, read AFTER commit.
  const matchedRect = direction === "enter" ? enterNodeRect : scopeNodeScreenRect(incomingSvg, nodeId);
  // The whole incoming svg maps onto the node box (matched-frame). Fall back to the svg's own rect
  // (identity — a plain cross-fade) when the node box is unavailable.
  const targetBox = matchedRect ?? outgoingSvgRect;

  // Center-based translate + clamped uniform scale so the box centers stay coincident even when the
  // scale floor kicks in (a tiny node opening a huge child).
  const startScale = clampScale(rectToRectTransform(outgoingSvgRect, targetBox).scale);
  const fromCx = outgoingSvgRect.left + outgoingSvgRect.width / 2;
  const fromCy = outgoingSvgRect.top + outgoingSvgRect.height / 2;
  const toCx = targetBox.left + targetBox.width / 2;
  const toCy = targetBox.top + (targetBox.height ?? targetBox.width) / 2;
  const startTransform = {
    translateX: toCx - fromCx * startScale,
    translateY: toCy - fromCy * startScale,
    scale: startScale
  };
  const identity = { translateX: 0, translateY: 0, scale: 1 };

  // ENTER: incoming starts small-inside-the-node (opacity 0) → identity + opacity 1; the clone stays
  //        at identity → zooms into the node + opacity 1 → 0.
  // EXIT:  incoming (parent) starts zoomed-INTO the node → pulls out to identity + fades in; the clone
  //        (child) shrinks into the node + fades out. Same math; which layer is "incoming" flips.
  incomingSvg.style.transformOrigin = "0 0";
  incomingSvg.style.willChange = "transform,opacity";
  incomingSvg.style.pointerEvents = "none";

  const applyFrame = (t) => {
    const e = easeOutCubic(t);
    const mix = (a, b) => ({
      translateX: lerp(a.translateX, b.translateX, e),
      translateY: lerp(a.translateY, b.translateY, e),
      scale: lerp(a.scale, b.scale, e)
    });
    incomingSvg.style.transform = scopeTransformToCss(mix(startTransform, identity));
    incomingSvg.style.opacity = String(lerp(0, 1, e));
    if (cloneSvg?.style) {
      cloneSvg.style.transform = scopeTransformToCss(mix(identity, startTransform));
      cloneSvg.style.opacity = String(lerp(1, 0, e));
    }
  };

  // Paint the first frame synchronously so the incoming svg never flashes at identity/full-opacity.
  applyFrame(0);

  const now = typeof _hooks.now === "function"
    ? _hooks.now
    : (typeof win.performance?.now === "function" ? () => win.performance.now() : () => Date.now());
  const raf = typeof _hooks.requestAnimationFrame === "function"
    ? _hooks.requestAnimationFrame
    : win.requestAnimationFrame.bind(win);

  await new Promise((resolve) => {
    resolveTween = resolve;
    const start = now();
    const step = () => {
      rafId = null;
      if (superseded()) { finish(); return; }
      const t = durationMs > 0 ? Math.min(1, (now() - start) / durationMs) : 1;
      applyFrame(t);
      if (t >= 1) { finish(); return; }
      rafId = raf(step);
    };
    rafId = raf(step);
  });
}

/** Test seam: drive `runScopeTransition` directly with an injectable frame clock (`_hooks` =
 *  `{ requestAnimationFrame, now }`) so the animation can be flushed frame-by-frame with zero real
 *  DOM/rAF. Not part of the public API surface — exported only for the Phase-2 test harness. */
export function __runScopeTransitionForTest(container, options, spec, hooks) {
  return runScopeTransition(container, normalizeOptions(options), spec, hooks);
}

function scopeEnterTargetFor(target, container) {
  let cursor = target;
  while (cursor && cursor !== container) {
    if (cursor.getAttribute?.("data-diagram-scope-enter")) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}

/** P1 scope-linking: the drill-UP mirror of `scopeEnterTargetFor`. Ancestor-walks from a clicked
 *  target up to (not including) the container. A `data-diagram-node` or `data-diagram-scope-enter`
 *  ancestor short-circuits to null (a node click, or the dig-in glyph, is NOT an exit); the exit
 *  backdrop's `data-diagram-scope-exit` matches. Because the backdrop is a leaf sibling of the node
 *  groups (never their ancestor), paint-order alone discriminates — no geometry math. Exported for
 *  tests; usable with plain objects exposing getAttribute(name) + parentNode (no real DOM needed). */
export function scopeExitTargetFor(target, container) {
  let cursor = target;
  while (cursor && cursor !== container) {
    if (cursor.getAttribute?.("data-diagram-node")) return null;        // a node click ≠ exit
    if (cursor.getAttribute?.("data-diagram-scope-enter")) return null; // the dig-in glyph is enter
    if (cursor.getAttribute?.("data-diagram-scope-exit")) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}

// P1 scope-linking: below this client-space travel, a pointerdown→up is a click (exit); above it
// the gesture was a drag/pan and must NOT trigger a background exit.
const EXIT_MOVE_THRESHOLD = 6;

/** P1 scope-linking: the target stack depth for a ONE-LEVEL drill-UP (background click / Escape).
 *  `exitToScopeDepth(container, depth)` slices the stack to `depth+1`, so popping exactly one frame
 *  off a stack of length N means depth = N-2 (N-1 keeps the current level; N-2 lands on its parent).
 *  Single source of truth for the "zoom out exactly one step" contract, shared by the click + Escape
 *  handlers. Exported (pure, tiny) so the depth math is unit-testable without the DOM/stack WeakMap. */
export function scopeExitOneLevelDepth(stackLength) {
  return stackLength - 2;
}

function bindDiagramScopeNavigation(container, diagram, options) {
  unbindDiagramScopeNavigation(container);
  const byId = new Map((diagram.nodes ?? []).map((node) => [node.id, node]));
  // Pan-vs-click disambiguation: with panZoom on, a drag-to-pan release also fires `click`. Track
  // pointer travel from the pointerdown origin and set `moved` past EXIT_MOVE_THRESHOLD so a pan
  // release never pops a scope level. Reset on every pointerdown.
  let moved = false;
  let downX = 0;
  let downY = 0;
  const onDown = (event) => {
    moved = false;
    downX = event.clientX ?? 0;
    downY = event.clientY ?? 0;
  };
  const onMove = (event) => {
    if (moved) return;
    const dx = (event.clientX ?? 0) - downX;
    const dy = (event.clientY ?? 0) - downY;
    if (Math.abs(dx) > EXIT_MOVE_THRESHOLD || Math.abs(dy) > EXIT_MOVE_THRESHOLD) moved = true;
  };
  const exitOneLevel = (event) => {
    const stack = diagramScopeStack(container);
    if (stack.length <= 1) return; // already at root
    event.preventDefault?.();
    hideDiagramPopover();
    void exitToScopeDepth(container, scopeExitOneLevelDepth(stack.length), options); // pop exactly ONE level
  };
  const activate = (event) => {
    const trigger = scopeEnterTargetFor(event.target, container);
    if (trigger) {
      const node = byId.get(trigger.getAttribute("data-diagram-scope-enter"));
      if (!node) return;
      event.preventDefault?.();
      hideDiagramPopover();
      void enterNodeScope(container, node, options);
      return;
    }
    // P1 background-click drill-UP: only on a real empty-canvas click (backdrop match), never a pan.
    if (options.scopeExitOnBackground === false) return;
    if (moved) return;
    if (!scopeExitTargetFor(event.target, container)) return;
    exitOneLevel(event);
  };
  const onKey = (event) => {
    // P1 keyboard drill-UP: Escape pops one level (the keyboard-reachable mirror of background click).
    if (event.key === "Escape") {
      if (options.scopeExitOnBackground === false) return;
      exitOneLevel(event);
      return;
    }
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    if (!scopeEnterTargetFor(event.target, container)) return;
    activate(event);
  };
  container.addEventListener("pointerdown", onDown);
  container.addEventListener("pointermove", onMove);
  container.addEventListener("click", activate);
  container.addEventListener("keydown", onKey);
  diagramScopeBindings.set(container, () => {
    container.removeEventListener("pointerdown", onDown);
    container.removeEventListener("pointermove", onMove);
    container.removeEventListener("click", activate);
    container.removeEventListener("keydown", onKey);
  });
}

function unbindDiagramScopeNavigation(container) {
  const cleanup = diagramScopeBindings.get(container);
  if (cleanup) cleanup();
  diagramScopeBindings.delete(container);
}

// ---- Staged process controls ------------------------------------------------
// Activates only when the MODEL declares stages (diagramStages ≥ 2) and `stageControls` is not
// disabled. The whole union is already laid out + rendered (positions stable, panZoom intact);
// flipping a stage only toggles per-element visibility classes and updates the stage bar. State
// lives per-container in WeakMaps (the panZoom/scope-stack pattern).

const diagramStageStates = new WeakMap();
const diagramStageBindings = new WeakMap();

function clampStageIndex(index, count) {
  return Math.max(0, Math.min(count - 1, Math.trunc(Number.isFinite(index) ? index : 0)));
}

function toggleDiagramClass(element, className, on) {
  if (element.classList?.toggle) {
    element.classList.toggle(className, Boolean(on));
    return;
  }
  const current = (element.getAttribute?.("class") ?? "").split(/\s+/).filter(Boolean);
  const has = current.includes(className);
  if (on && !has) current.push(className);
  if (!on && has) current.splice(current.indexOf(className), 1);
  element.setAttribute?.("class", current.join(" "));
}

function applyDiagramStage(container, stageIndex, options) {
  const state = diagramStageStates.get(container);
  if (!state) return;
  const { stages, nodeStages, edgeStages, declared } = state.visibility;
  const index = clampStageIndex(stageIndex, stages.length);
  state.index = index;
  // A popover pinned to a node that this flip hides would linger over nothing.
  if (activePopoverTarget && typeof container.contains === "function" && container.contains(activePopoverTarget)) {
    hideDiagramPopover(activePopoverTarget);
  }
  // "New at this stage" = visible now but not at the previous stage; at stage 1 only elements
  // that DECLARED a stage glow (highlighting everything would highlight nothing).
  const isNew = (key, visibleSet) => visibleSet.has(index) && (index === 0 ? declared.has(key) : !visibleSet.has(index - 1));
  for (const element of container.querySelectorAll?.("[data-diagram-node]") ?? []) {
    const visibleSet = nodeStages.get(element.getAttribute("data-diagram-node"));
    if (!visibleSet) continue;
    toggleDiagramClass(element, "diagram-stage-hidden", !visibleSet.has(index));
    toggleDiagramClass(element, "diagram-stage-new", isNew(`node:${element.getAttribute("data-diagram-node")}`, visibleSet));
  }
  for (const element of container.querySelectorAll?.("[data-diagram-edge]") ?? []) {
    const visibleSet = edgeStages.get(element.getAttribute("data-diagram-edge"));
    if (!visibleSet) continue;
    toggleDiagramClass(element, "diagram-stage-hidden", !visibleSet.has(index));
    toggleDiagramClass(element, "diagram-stage-new", isNew(`edge:${element.getAttribute("data-diagram-edge")}`, visibleSet));
  }
  const stage = stages[index];
  if (state.label) state.label.textContent = `Stage ${index + 1}/${stages.length} · ${stage.title}`;
  if (state.captionEl) {
    state.captionEl.textContent = stage.caption ?? "";
    state.captionEl.hidden = !stage.caption;
  }
  if (state.prevButton) state.prevButton.disabled = index === 0;
  if (state.nextButton) state.nextButton.disabled = index === stages.length - 1;
  // Reaching either end disables the button the user is on — hand keyboard focus to its
  // counterpart instead of dropping it to <body>.
  const activeElement = container.ownerDocument?.activeElement;
  if (state.prevButton?.disabled && activeElement === state.prevButton) state.nextButton?.focus?.();
  else if (state.nextButton?.disabled && activeElement === state.nextButton) state.prevButton?.focus?.();
  if (typeof options.onStageChange === "function") {
    try {
      options.onStageChange({ index, count: stages.length, stage });
    } catch { /* a host callback must never break stage navigation */ }
  }
}

function buildDiagramStageBar(doc, state, step) {
  const wrapper = doc.createElement("div");
  wrapper.className = "diagram-stage-bar";
  const controls = doc.createElement("div");
  controls.className = "diagram-stage-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Process stages");
  const makeButton = (label, title, delta) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "diagram-stage-btn";
    button.textContent = label;
    button.setAttribute("aria-label", title);
    button.title = title;
    button.addEventListener("click", (event) => { event.preventDefault?.(); step(delta); });
    return button;
  };
  state.prevButton = makeButton("‹ Prev", "Previous stage", -1);
  state.nextButton = makeButton("Next ›", "Next stage", 1);
  state.label = doc.createElement("span");
  state.label.className = "diagram-stage-label";
  state.label.setAttribute("aria-live", "polite");
  controls.append(state.prevButton, state.label, state.nextButton);
  state.captionEl = doc.createElement("p");
  state.captionEl.className = "diagram-stage-caption";
  // The caption is the narrative payload of a flip — announce it, not just the stage label.
  state.captionEl.setAttribute("aria-live", "polite");
  wrapper.append(controls, state.captionEl);
  return wrapper;
}

function unbindDiagramStageControls(container) {
  const cleanup = diagramStageBindings.get(container);
  if (cleanup) cleanup();
  diagramStageBindings.delete(container);
  diagramStageStates.delete(container);
}

function bindDiagramStageControls(container, diagram, options) {
  unbindDiagramStageControls(container);
  if (options.stageControls === false) return;
  const visibility = stageVisibilityForDiagram(diagram);
  if (!visibility) return;
  const doc = container.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  if (!doc || typeof container.querySelectorAll !== "function") return;
  const state = { visibility, index: 0 };
  diagramStageStates.set(container, state);
  const step = (delta) => applyDiagramStage(container, (diagramStageStates.get(container)?.index ?? 0) + delta, options);
  const bar = buildDiagramStageBar(doc, state, step);
  if (typeof container.prepend === "function") container.prepend(bar);
  else container.insertBefore?.(bar, container.firstChild ?? null);
  diagramStageBindings.set(container, () => { bar.remove?.(); });
  const initial = options.initialStage == null ? 0 : Number(options.initialStage) - 1;
  applyDiagramStage(container, initial, options);
}

// The factored per-scope render (layout → SVG → popovers → panZoom → scope nav + breadcrumb).
// Both the public hydrateDiagram and the drill-down enter/exit transitions call this; only the
// stack management differs (hydrateDiagram resets it, enter/exit mutate it first).
// P1 scope-linking: after a scope transition (drill-in glyph, background click, Escape, or a
// breadcrumb jump) the whole SVG subtree is swapped, so a previously-focused node/glyph is gone
// and focus would silently fall to <body>. Move focus to a stable landmark so keyboard users are
// not stranded: the current breadcrumb crumb (a real <button>) when present, else the container
// itself if it can hold focus. Fully optional-chained + try/guarded so it no-ops outside a DOM
// (the pure-render tests never reach here) and never breaks navigation. Only a scope TRANSITION
// restores focus — the initial hydrate leaves focus untouched (byte-identical, no surprise grab).
function restoreScopeFocus(container) {
  try {
    const crumb = container?.querySelector?.(".diagram-scope-crumb-current");
    if (typeof crumb?.focus === "function") {
      crumb.focus();
      return;
    }
    // No breadcrumb (suppressed / at root): fall back to the container if it can take focus.
    if (typeof container?.focus === "function" && container.getAttribute?.("tabindex") != null) {
      container.focus();
    }
  } catch { /* focus management must never break a scope transition */ }
}

// Returns the hydration token this render installed. Phase 2's runScopeTransition captures it (via
// the `commit()` thunk) so a tween whose OWN render bailed — because a newer enter/exit/hydrate
// bumped the global token past this one during the `await layoutDiagram` window — is correctly
// detected as superseded (`hydrationTokens.get(container) !== <this token>`) and does NOT animate a
// stale/absent svg. A bailed render still returns its own token so the comparison stays honest.
async function renderDiagramLevel(container, diagram, options, { restoreFocus = false } = {}) {
  const token = ++nextHydrationToken;
  hydrationTokens.set(container, token);
  const layout = await layoutDiagram(diagram, options);
  if (hydrationTokens.get(container) !== token || !container.isConnected) return token;
  disablePanZoom(container);
  replaceDiagramSvgNodes(container, diagram, layout, options);
  bindDiagramPopovers(container, diagram, options);
  if (options.panZoom) enablePanZoom(container, options);
  // Staged process controls (no-op for un-staged models). Bound BEFORE the drill-down
  // breadcrumb so a breadcrumb, when present, prepends above the stage bar.
  bindDiagramStageControls(container, diagram, options);
  if (options.drillDown) {
    bindDiagramScopeNavigation(container, diagram, options);
    // P1: `scopeBreadcrumb:false` suppresses the bar (boundary-only or host-driven chrome).
    if (options.scopeBreadcrumb !== false) renderScopeBreadcrumb(container, options);
  }
  // Only enter/exit transitions ask for focus restoration; the initial hydrate does not.
  if (restoreFocus) restoreScopeFocus(container);
  return token;
}

// ---- Pan / zoom / fit-to-view ---------------------------------------------
// Opt-in via the `panZoom` option (or call enablePanZoom() directly). Drives the
// SVG viewBox: drag (or two-finger scroll) to pan, pinch / ctrl+wheel to zoom
// toward the cursor, plus a fit/zoom control overlay. Uniform zoom preserves the
// viewBox aspect ratio, so the SVG remains its own clipping viewport — no fixed
// container height required. All DOM access is optional-chained so it no-ops
// safely outside a browser.

const panZoomBindings = new WeakMap();

function parsePanZoomViewBox(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function buildPanZoomControls(doc, actions) {
  const wrap = doc.createElement("div");
  wrap.className = "diagram-panzoom-controls";
  const make = (label, title, handler) => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "diagram-panzoom-btn";
    btn.textContent = label;
    btn.setAttribute("aria-label", title);
    btn.title = title;
    btn.addEventListener("click", (event) => { event.preventDefault?.(); handler(); });
    return btn;
  };
  wrap.appendChild(make("+", "Zoom in", actions.zoomIn));
  wrap.appendChild(make("−", "Zoom out", actions.zoomOut));
  wrap.appendChild(make("⤢", "Fit to view", actions.fit));
  return wrap;
}

export function disablePanZoom(container) {
  if (!container) return;
  const cleanup = panZoomBindings.get(container);
  if (cleanup) cleanup();
  panZoomBindings.delete(container);
}

export function enablePanZoom(container, inputOptions = {}) {
  const noop = () => {};
  if (!container || typeof container.querySelector !== "function") return noop;
  disablePanZoom(container);
  const svg = container.querySelector("svg.diagram-svg") ?? container.querySelector("svg");
  if (!svg) return noop;
  const doc = container.ownerDocument ?? globalThis.document ?? null;
  const win = doc?.defaultView ?? (typeof globalThis.window !== "undefined" ? globalThis.window : globalThis);
  if (!doc || !win) return noop;

  const minScale = inputOptions.minScale ?? 0.2;
  const maxScale = inputOptions.maxScale ?? 8;
  const zoomStep = inputOptions.zoomStep ?? 1.2;
  const showControls = inputOptions.panZoomControls ?? true;

  const base = parsePanZoomViewBox(svg.getAttribute?.("viewBox")) ?? { x: 0, y: 0, w: 1000, h: 1000 };
  const view = { ...base };

  const apply = () => svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  const fit = () => { view.x = base.x; view.y = base.y; view.w = base.w; view.h = base.h; apply(); };
  const clampZoom = () => {
    const scale = base.w / view.w;
    if (scale < minScale) { view.w = base.w / minScale; view.h = base.h / minScale; }
    else if (scale > maxScale) { view.w = base.w / maxScale; view.h = base.h / maxScale; }
  };
  const rectOf = () => (typeof svg.getBoundingClientRect === "function" ? svg.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 });
  const zoomAt = (clientX, clientY, factor) => {
    const rect = rectOf();
    if (!rect.width || !rect.height) return;
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const sx = view.x + px * view.w;
    const sy = view.y + py * view.h;
    view.w /= factor; view.h /= factor;
    clampZoom();
    view.x = sx - px * view.w;
    view.y = sy - py * view.h;
    apply();
  };
  const panScreen = (dx, dy) => {
    const rect = rectOf();
    if (!rect.width || !rect.height) return;
    view.x -= dx * (view.w / rect.width);
    view.y -= dy * (view.h / rect.height);
    apply();
  };
  const zoomCenter = (factor) => { const r = rectOf(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor); };

  const onWheel = (event) => {
    event.preventDefault?.();
    if (event.ctrlKey || event.metaKey) zoomAt(event.clientX, event.clientY, Math.exp(-(event.deltaY ?? 0) * 0.01));
    else panScreen(-(event.deltaX ?? 0), -(event.deltaY ?? 0));
  };
  let dragging = false, lastX = 0, lastY = 0;
  const onPointerDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    dragging = true; lastX = event.clientX; lastY = event.clientY;
    if (svg.style) svg.style.cursor = "grabbing";
    svg.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!dragging) return;
    panScreen(event.clientX - lastX, event.clientY - lastY);
    lastX = event.clientX; lastY = event.clientY;
  };
  const onPointerUp = (event) => {
    if (!dragging) return;
    dragging = false;
    if (svg.style) svg.style.cursor = "grab";
    svg.releasePointerCapture?.(event.pointerId);
  };

  const prevPosition = container.style?.position ?? "";
  const computed = typeof win.getComputedStyle === "function" ? win.getComputedStyle(container) : null;
  if (container.style && (!computed || computed.position === "static" || computed.position === "")) container.style.position = "relative";
  if (svg.style) {
    svg.style.cursor = "grab";
    svg.style.touchAction = "none";
    svg.style.width = "100%";
    svg.style.minWidth = "0";
    svg.style.maxWidth = "none";
  }

  svg.addEventListener?.("wheel", onWheel, { passive: false });
  svg.addEventListener?.("pointerdown", onPointerDown);
  win.addEventListener?.("pointermove", onPointerMove);
  win.addEventListener?.("pointerup", onPointerUp);

  let controlsEl = null;
  if (showControls && typeof container.appendChild === "function") {
    controlsEl = buildPanZoomControls(doc, { zoomIn: () => zoomCenter(zoomStep), zoomOut: () => zoomCenter(1 / zoomStep), fit });
    container.appendChild(controlsEl);
  }

  const cleanup = () => {
    svg.removeEventListener?.("wheel", onWheel);
    svg.removeEventListener?.("pointerdown", onPointerDown);
    win.removeEventListener?.("pointermove", onPointerMove);
    win.removeEventListener?.("pointerup", onPointerUp);
    controlsEl?.remove?.();
    if (svg.style) { svg.style.cursor = ""; svg.style.touchAction = ""; }
    if (container.style) container.style.position = prevPosition;
  };
  panZoomBindings.set(container, cleanup);
  apply();
  return cleanup;
}

export async function hydrateDiagram(container, diagram, inputOptions = {}) {
  if (!container || !diagram) return;
  const options = normalizeOptions({ ...inputOptions, diagramId: diagram.id });
  // A fresh external hydrate is the ROOT scope: reset the drill-down stack (a re-entrant
  // enter/exit transition goes through renderDiagramLevel directly + keeps the stack).
  if (options.drillDown) {
    diagramScopeStacks.set(container, [{ title: diagram.title ?? "root", model: diagram }]);
    container.querySelector?.(".diagram-scope-breadcrumb")?.remove();
  }
  await renderDiagramLevel(container, diagram, options);
}
