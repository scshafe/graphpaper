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

function assertDiagramSvgMarkupSafeForDomReplacement(markup) {
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

function normalizeOptions(options = {}) {
  return {
    direction: options.direction ?? "RIGHT",
    edgeRouting: options.edgeRouting ?? "ORTHOGONAL",
    hierarchy: options.hierarchy ?? false,
    hierarchyEdgeTypes: options.hierarchyEdgeTypes ?? ["contains"],
    compact: options.compact ?? false,
    showPopovers: options.showPopovers ?? true,
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
  if (options.scopeRootId && node.id === options.scopeRootId) return "";
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
  if (options.scopeRootId && node.id === options.scopeRootId) return "";
  const size = 18;
  const x = Math.max(0, width - size - 8);
  const y = 8;
  return `<g class="diagram-scope-affordance" data-diagram-scope-enter="${esc(node.id)}" role="button" tabindex="0" aria-label="${esc(`Dig into ${node.title}`)}">
    <rect class="diagram-scope-affordance-hit" x="${x.toFixed(1)}" y="${y}" width="${size}" height="${size}" rx="4"></rect>
    <text class="diagram-scope-affordance-glyph" x="${(x + size / 2).toFixed(1)}" y="${y + size - 5}" text-anchor="middle">⤢</text>
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
    // Staged diagrams stamp each edge group with its render key so the stage controller can
    // toggle visibility per edge (nodes already carry data-diagram-node for popovers).
    const stageAttr = staged ? ` data-diagram-edge="${esc(edgeKey(edge, index))}"` : "";
    const edgeMarkerId = isFlow ? flowMarkerId : markerId;
    return [`<g class="${groupClass}"${flowAttr}${stageAttr}>
      <title>${esc(edgeLabel(edge, diagram))}</title>
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
      <g class="map-edges">${edges}</g>
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

export function hideDiagramPopover(target = activePopoverTarget) {
  const documentRef = diagramDocumentFor(target);
  clearDiagramPopoverHideTimer();
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

function unbindDelegatedDiagramPopovers(container) {
  const cleanup = delegatedDiagramPopoverBindings.get(container);
  if (!cleanup) return;
  cleanup();
  delegatedDiagramPopoverBindings.delete(container);
}

export function cleanupHydratedDiagram(container) {
  if (!container) return;
  hydrationTokens.delete(container);
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

function bindDiagramPopovers(container, diagram, options) {
  unbindDelegatedDiagramPopovers(container);
  hideDiagramPopover();
  if (!options.showPopovers) return;
  const byId = new Map((diagram.nodes ?? []).map((node) => [node.id, node]));
  const show = (event) => {
    const element = diagramNodeEventTarget(event.target, container);
    if (!element || stayedInsideDiagramNode(element, event.relatedTarget)) return;
    const node = byId.get(element.getAttribute("data-diagram-node"));
    if (!node) return;
    showDiagramNodePopover(element, node);
  };
  const scheduleHide = (event) => {
    const element = diagramNodeEventTarget(event.target, container);
    if (!element || stayedInsideDiagramNode(element, event.relatedTarget)) return;
    scheduleHideDiagramPopover(element);
  };
  const hide = (event) => {
    const element = diagramNodeEventTarget(event.target, container);
    if (!element || stayedInsideDiagramNode(element, event.relatedTarget)) return;
    hideDiagramPopover(element);
  };
  container.addEventListener("pointerover", show);
  container.addEventListener("pointerout", scheduleHide);
  container.addEventListener("focusin", show);
  container.addEventListener("focusout", hide);
  delegatedDiagramPopoverBindings.set(container, () => {
    container.removeEventListener("pointerover", show);
    container.removeEventListener("pointerout", scheduleHide);
    container.removeEventListener("focusin", show);
    container.removeEventListener("focusout", hide);
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
  const scopedModel = { ...sub, metadata: { ...(sub.metadata ?? {}), scopeOf: sub.metadata?.scopeOf ?? node.id } };
  const stack = diagramScopeStack(container).slice();
  stack.push({ title: node.title ?? node.id, model: scopedModel });
  diagramScopeStacks.set(container, stack);
  emitScopeChange(container, options);
  await renderDiagramLevel(container, scopedModel, options);
}

async function exitToScopeDepth(container, depth, options) {
  const stack = diagramScopeStack(container).slice(0, depth + 1);
  if (stack.length === 0) return;
  diagramScopeStacks.set(container, stack);
  emitScopeChange(container, options);
  await renderDiagramLevel(container, stack[stack.length - 1].model, options);
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

function scopeEnterTargetFor(target, container) {
  let cursor = target;
  while (cursor && cursor !== container) {
    if (cursor.getAttribute?.("data-diagram-scope-enter")) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}

function bindDiagramScopeNavigation(container, diagram, options) {
  unbindDiagramScopeNavigation(container);
  const byId = new Map((diagram.nodes ?? []).map((node) => [node.id, node]));
  const activate = (event) => {
    const trigger = scopeEnterTargetFor(event.target, container);
    if (!trigger) return;
    const node = byId.get(trigger.getAttribute("data-diagram-scope-enter"));
    if (!node) return;
    event.preventDefault?.();
    hideDiagramPopover();
    void enterNodeScope(container, node, options);
  };
  const onKey = (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    if (!scopeEnterTargetFor(event.target, container)) return;
    activate(event);
  };
  container.addEventListener("click", activate);
  container.addEventListener("keydown", onKey);
  diagramScopeBindings.set(container, () => {
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
async function renderDiagramLevel(container, diagram, options) {
  const token = ++nextHydrationToken;
  hydrationTokens.set(container, token);
  const layout = await layoutDiagram(diagram, options);
  if (hydrationTokens.get(container) !== token || !container.isConnected) return;
  disablePanZoom(container);
  replaceDiagramSvgNodes(container, diagram, layout, options);
  bindDiagramPopovers(container, diagram, options);
  if (options.panZoom) enablePanZoom(container, options);
  // Staged process controls (no-op for un-staged models). Bound BEFORE the drill-down
  // breadcrumb so a breadcrumb, when present, prepends above the stage bar.
  bindDiagramStageControls(container, diagram, options);
  if (options.drillDown) {
    bindDiagramScopeNavigation(container, diagram, options);
    renderScopeBreadcrumb(container, options);
  }
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
