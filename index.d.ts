/**
 * graphpaper — framework-agnostic diagram renderer.
 *
 * Lays out a neutral node/edge {@link DiagramModel} with ELK (provided as
 * `window.ELK`, e.g. from `elkjs`) and renders interactive SVG. Falls back to a
 * built-in layered layout when no ELK engine is present.
 *
 * Types promoted from the JSDoc typedefs in `src/index.js`.
 */

export interface DiagramRow {
  label: string;
  value?: string;
  description?: string;
  badges?: string[];
}

export interface DiagramDetailsSection {
  title?: string;
  rows?: DiagramRow[];
}

export interface DiagramDetails {
  title?: string;
  kicker?: string;
  sections?: DiagramDetailsSection[];
}

/** A stage reference: a 1-based stage index, or a stage id string. */
export type DiagramStageRef = number | string;

/** A pill hung off a node's top-right corner: a count, a state, a warning. */
export interface DiagramNodeBadge {
  label: string;
  /** Class-safe tone token → `map-node-badge-<tone>` (the stylesheet ships danger, warning, info, muted). */
  tone?: string;
}

export interface DiagramNode {
  id: string;
  title: string;
  type?: string;
  subtitle?: string;
  status?: string;
  description?: string;
  rows?: DiagramRow[];
  /** Badges drawn outside the node's rect at its top-right, right-aligned in author order; a
   *  string is a badge with no tone. Listed in the popover as chips. Absent ⇒ byte-identical markup. */
  badges?: Array<string | DiagramNodeBadge>;
  /**
   * How many of `rows` this node shows on the diagram (component nodes cap at 3); default: the
   * `visibleRows` render option. Honoured under `compact` too, where nodes otherwise show no rows —
   * the way to give one node a line of its own without loosening the whole layout.
   */
  visibleRows?: number;
  details?: DiagramDetails;
  metadata?: Record<string, unknown>;
  /** P0-B3: an inline sub-diagram this node contains (a "scope"). When present (or when
   *  `metadata.scopeRef` / a `hasScope` predicate applies) and `drillDown` is on, the node
   *  renders a "dig in" affordance; activating it navigates INTO this sub-diagram. Not
   *  rendered inline in the outer scope. */
  scope?: DiagramModelInput;
  /** Staged diagrams: the stage this element APPEARS at (visible from there on). Also honored
   *  under `metadata.stage`. */
  stage?: DiagramStageRef;
  /** Staged diagrams: EXPLICIT stage membership (wins over `stage`; allows disappearing
   *  elements). Also honored under `metadata.stages`. */
  stages?: DiagramStageRef[];
}

export interface DiagramEdge {
  from: string;
  to: string;
  id?: string;
  type?: string;
  label?: string;
  description?: string;
  /** Semantic edge flavor (e.g. "reads"/"writes"); may also live under `metadata.flavor`. */
  flavor?: string;
  metadata?: Record<string, unknown>;
  /** Staged diagrams: as on nodes. An edge is additionally hidden at any stage where either
   *  endpoint is hidden. */
  stage?: DiagramStageRef;
  stages?: DiagramStageRef[];
}

/** One stage of a staged process diagram. */
export interface DiagramStage {
  /** Stable id other elements may reference (defaults to the 1-based index as a string). */
  id?: string;
  title?: string;
  /** Shown under the stage controls while this stage is active. */
  caption?: string;
}

/** A diagram-level lifecycle marking (e.g. deprecated / expired). */
export interface DiagramLifecycle {
  /** Free-form state token, e.g. "deprecated", "expired" (class-safe, lowercased for CSS). */
  state: string;
  /** Display label (defaults to the state upper-cased). */
  label?: string;
  /** Optional note shown as the badge tooltip. */
  note?: string;
}

/** The canonical, fully-typed diagram shape. Use this when authoring your own data. */
export interface DiagramModel {
  id: string;
  title: string;
  kind?: string;
  description?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  metadata?: Record<string, unknown>;
  /** Lifecycle marking: renders a caption badge + diagonal watermark + dims the graph. Also
   *  honored under `metadata.lifecycle`. Absent ⇒ byte-identical markup. */
  lifecycle?: string | DiagramLifecycle;
  /** Ordered process stages (≥ 2 activate staged rendering: prev/next controls flip element
   *  visibility over ONE stable union layout). Also honored under `metadata.stages`. */
  stages?: Array<string | DiagramStage>;
}

export interface DiagramNodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface DiagramLayout {
  width: number;
  height: number;
  positions: Map<string, DiagramNodePosition>;
  edgePaths: Map<string, string>;
  /** Edge-label boxes placed by the layout engine (ELK inline labels), keyed like `edgePaths`; absent → labels sit at the path midpoint. */
  edgeLabelBoxes?: Map<string, { x: number; y: number; width: number; height: number }>;
  containmentDepths?: Map<string, number>;
  drawHierarchyEdges?: boolean;
  sourceLabel: string;
}

export type DiagramDirection = "RIGHT" | "DOWN" | "LEFT" | "UP";
export type DiagramEdgeRouting = "ORTHOGONAL" | "POLYLINE" | "SPLINES";

/** Renders a single node type to SVG inner markup, given the node and its geometry. */
export type DiagramNodeRenderer = (...args: any[]) => string;

/**
 * One row of the colour key: a node kind (`type`, optionally with a `status`) or an edge kind. The
 * swatch wears the same classes as the nodes/edges it stands for, so the stylesheet colours both.
 */
export interface DiagramLegendEntry {
  label: string;
  type?: string;
  status?: string;
  edge?: { kind?: string; flavor?: string; flow?: boolean };
}

/**
 * An ELK-compatible layout engine: `layout(graph)` resolves the same graph with positions and edge
 * sections filled in — what `new ELK()` from `elkjs` provides.
 */
export interface DiagramLayoutEngine {
  layout(graph: any): Promise<any>;
}

export interface DiagramRenderOptions {
  direction?: DiagramDirection;
  edgeRouting?: DiagramEdgeRouting;
  hierarchy?: boolean;
  hierarchyEdgeTypes?: string[];
  compact?: boolean;
  showPopovers?: boolean;
  /**
   * Hover-dwell (ms) before the informational popover appears on pointer hover: the pointer must
   * rest on a node continuously for this long. Focus (keyboard) navigation still shows the popover
   * immediately. `0` disables the debounce (legacy immediate-on-hover). Default `2000`.
   */
  popoverHoverDelayMs?: number;
  visibleRows?: number;
  showEdgeLabels?: boolean;
  /**
   * Where ELK puts a shown edge label (ignored by the built-in fallback layout). `"center"`
   * (default): inline on a straight run of the edge — a relationship label — at the cost of a
   * taller layout. `"tail"` / `"head"`: beside the edge where it leaves its source / reaches its
   * target — the flowchart convention for decisions — adding no layers.
   */
  edgeLabelPlacement?: "center" | "tail" | "head";
  /** Draw the «type» line and divider at the top of each node (default true). Off: the colour carries the kind and every node shrinks by the band. */
  stereotypes?: boolean;
  /** Colour-key entries, rendered after the SVG as `.diagram-legend` (absent → no legend). The container must be positioned; pan/zoom makes it so. */
  legend?: readonly DiagramLegendEntry[];
  /** Heading of the key (default "Key"). */
  legendTitle?: string;
  /** Start with the key shown (default true). enablePanZoom adds a Key button that toggles it and remembers the choice per `diagramId`. */
  legendVisible?: boolean;
  minWidth?: number;
  minHeight?: number;
  title?: string;
  sourceLabel?: string;
  fallbackSourceLabel?: string;
  elkErrorSourceLabel?: string;
  elkUnavailableSourceLabel?: string;
  ariaLabel?: string;
  caption?: string | ((layout: DiagramLayout) => string);
  markerId?: string;
  diagramId?: string;
  nodeWidth?: number;
  nodeHeight?: number;
  /**
   * Layout engine to use instead of `window.ELK` — e.g. `new ELK()` from `elkjs/lib/elk.bundled.js`
   * on a server, where no `window` exists (and where handing elkjs a fake one breaks it: the bundle
   * reads `window.Error`). Takes precedence over the global; absent, the renderer looks for
   * `window.ELK`, then falls back to the built-in layered layout.
   */
  layoutEngine?: DiagramLayoutEngine;
  drawHierarchyEdgesWhenNested?: boolean;
  /** Enable pan/zoom/fit interaction on hydrate (default false). */
  panZoom?: boolean;
  /** Show the zoom in/out/fit control overlay (default true when panZoom is on). */
  panZoomControls?: boolean;
  /** Minimum zoom-out scale relative to fit (default 0.2). */
  minScale?: number;
  /** Maximum zoom-in scale relative to fit (default 8). */
  maxScale?: number;
  /** Zoom multiplier per control-button step (default 1.2). */
  zoomStep?: number;
  /** P0-B3: enable scope / nested-diagram drill-down (default false → byte-identical). When on,
   *  scoped nodes render a "dig in" glyph and hydrateDiagram binds breadcrumb navigation. */
  drillDown?: boolean;
  /** P0-B3: lazily resolve a node's sub-diagram (for `metadata.scopeRef`-style by-reference
   *  scopes). Inline `node.scope` takes precedence. */
  resolveScope?: (node: DiagramNode) => DiagramModelInput | null | Promise<DiagramModelInput | null>;
  /** P0-B3: synchronous render-time predicate for whether a node has a scope (when neither an
   *  inline `node.scope` nor `metadata.scopeRef` is used). */
  hasScope?: (node: DiagramNode) => boolean;
  /** P0-B3: notified on every scope transition (enter/exit) with the current depth + title path. */
  onScopeChange?: (info: { depth: number; path: string[]; model: DiagramModelInput | null }) => void;
  /** P1 scope-linking: on a nested scope child (drillDown), render an outer boundary + a full-canvas
   *  transparent exit backdrop, and enable the click-outside / Escape "zoom out one level" gesture
   *  (default true). `false` renders a read-only child with no exit affordance that never intercepts
   *  background clicks. Inert at the root level and when `drillDown` is off → byte-identical. */
  scopeExitOnBackground?: boolean;
  /** P1 scope-linking: render the scope breadcrumb bar (default true). `false` suppresses it for a
   *  boundary-only UX or a host driving its own chrome via `onScopeChange`. */
  scopeBreadcrumb?: boolean;
  /** Phase 2 scope-linking (OPT-IN, default `"crisp"`): an animated matched-frame transition on
   *  drill enter/exit. `"zoom"` cross-fades the outgoing snapshot and the incoming level so the eye
   *  reads "the node became the child" — an ILLUSION (the whole incoming diagram is scaled onto the
   *  entered node's on-screen box), NOT a literal continuous magnification (the two levels have
   *  independent layouts). Compositor-only (CSS transform + opacity; the viewBox / panZoom is never
   *  touched). Falls back to the crisp swap under `prefers-reduced-motion`, without
   *  requestAnimationFrame, or for a level exceeding `maxAnimatedNodes`. The default `"crisp"` is
   *  behavior-identical to omitting the option. `durationMs` defaults to 260, `maxAnimatedNodes` to
   *  400. Consumed only by the enter/exit controller — `renderDiagramSvg` never reads it. */
  scopeTransition?:
    | "crisp"
    | "zoom"
    | { mode?: "crisp" | "zoom"; durationMs?: number; maxAnimatedNodes?: number };
  /** Staged diagrams: render the prev/next stage controls (default true; only relevant when the
   *  model declares ≥ 2 stages). `false` renders the full union with no controls. */
  stageControls?: boolean;
  /** Staged diagrams: the 1-based stage to show first (default 1). */
  initialStage?: number;
  /** Staged diagrams: notified on every stage change. */
  onStageChange?: (info: { index: number; count: number; stage: Required<DiagramStage> }) => void;
  nodeRenderers?: Record<string, DiagramNodeRenderer>;
  [key: string]: unknown;
}

/**
 * What the renderer functions accept. The renderer tolerates partial /
 * loosely-typed models, so node/edge arrays are intentionally permissive here.
 * The canonical {@link DiagramModel} is assignable to this.
 */
export interface DiagramModelInput {
  id: string;
  title?: string;
  kind?: string;
  description?: string;
  nodes?: readonly any[];
  edges?: readonly any[];
  /** Free-form model metadata. RESERVED keys:
   *   - `scopeOf` — a drill-down sub-diagram's own scope-root node id. Set automatically by
   *     `enterNodeScope` on the model it renders (P1-B2); at render the matching node's "dig in"
   *     glyph is suppressed so it can't re-enter its own scope. A resolver may pre-set it, but need
   *     not. Top-level models carry no `scopeOf`.
   *   - `scopeOfTitle` — the parent scope's display title, shown in the P1 outer-boundary label
   *     ("‹ <parent> · click outside to zoom out"). Auto-stamped by `enterNodeScope` from the
   *     entering node's title (falls back to "parent scope"); a host that pre-stamps `scopeOf` on a
   *     stored child may pre-set it too.
   *   - `scopeLabel` — an optional author caption for a node's drill-in button (nice-to-have). */
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** True if the edge represents information flow (drawn as a directional arrow), via `metadata.flow` or a known flavor. */
export function isInformationFlowEdge(
  edge: { flavor?: string; metadata?: Record<string, unknown> } | null | undefined
): boolean;

/** P0-B3: true if the node is a drill-down scope portal — an inline `scope`, a
 *  `metadata.scopeRef`, or `options.hasScope(node)`. Synchronous; safe at render time. */
export function nodeHasScope(
  node: DiagramNode | null | undefined,
  options?: { hasScope?: (node: DiagramNode) => boolean }
): boolean;

/** Normalize a diagram's lifecycle declaration (`lifecycle` or `metadata.lifecycle`; a bare
 *  string or `{ state, label?, note? }`). Returns null when the diagram declares none. PURE. */
export function diagramLifecycle(
  diagram: DiagramModelInput | null | undefined
): { state: string; label: string; note: string } | null;

/** Normalize `diagram.stages` / `diagram.metadata.stages` into `[{ id, title, caption }]`.
 *  Returns [] unless ≥ 2 well-formed stages are declared. PURE. */
export function diagramStages(
  diagram: DiagramModelInput | null | undefined
): Array<{ id: string; title: string; caption: string }>;

/** Compute the stage-visibility map for a staged diagram: the 0-based stage indices each node
 *  (by id) and edge (by its render key) is visible at; `declared` holds `node:<id>` /
 *  `edge:<key>` entries for elements that declared explicit staging. Null when un-staged. PURE. */
export function stageVisibilityForDiagram(diagram: DiagramModelInput | null | undefined): {
  stages: Array<{ id: string; title: string; caption: string }>;
  nodeStages: Map<string, Set<number>>;
  edgeStages: Map<string, Set<number>>;
  declared: Set<string>;
} | null;

/** Compute node positions + edge paths using ELK (`window.ELK`) with a built-in layered fallback. */
export function layoutDiagram(diagram: DiagramModelInput, options?: DiagramRenderOptions): Promise<DiagramLayout>;

/** Render a laid-out diagram to an SVG markup string. */
export function renderDiagramSvg(diagram: DiagramModelInput, layout: DiagramLayout, options?: DiagramRenderOptions): string;

/** The colour key on its own — what renderDiagramSvg appends after the SVG when `legend` is set; "" without entries. */
export function renderDiagramLegend(options?: DiagramRenderOptions): string;

/** Hide the active node popover (or the one for `target`). */
export function hideDiagramPopover(target?: EventTarget | null): void;

/** Hide the popover in response to a page-level event (scroll/resize/click-away). */
export function hideDiagramPopoverForPageEvent(event: Event): void;

/** Tear down a hydrated diagram's listeners/popovers for `container`. */
export function cleanupHydratedDiagram(container: Element): void;

/** Lay out + render `diagram` into `container` (replacing its content with SVG) and bind popovers. */
export function hydrateDiagram(container: Element, diagram: DiagramModelInput, options?: DiagramRenderOptions): Promise<void>;

export interface PanZoomOptions {
  minScale?: number;
  maxScale?: number;
  zoomStep?: number;
  panZoomControls?: boolean;
  /** Keys the remembered legend visibility (`graphpaper.legend.<diagramId>` in localStorage). */
  diagramId?: string;
}

/** Enable viewBox-based pan / zoom / fit-to-view on an already-hydrated diagram container. Returns a cleanup function. */
export function enablePanZoom(container: Element, options?: PanZoomOptions): () => void;

/** Tear down pan/zoom on a container (also performed by cleanupHydratedDiagram). */
export function disablePanZoom(container: Element): void;
