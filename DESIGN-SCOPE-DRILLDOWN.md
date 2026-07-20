# graphpaper — scope / nested diagrams + drill-down (P0-B3)

**Status:** design (2026-07-02). Roadmap P0-B3 (PLAN-MC-ROADMAP.md); graphpaper's roadmap
**centerpiece #3** (composable diagrams w/ semantic-zoom drill-down). Build follows in the
same commit (a library feature, not a cross-package chain).

## Goal

A graphpaper node can **contain a sub-diagram** (a sense of "scope"). The sub-diagram is
**NOT rendered inline** in the outer scope (avoid clutter); instead the node shows a small
**"dig in" affordance**, and activating it **navigates into** the sub-diagram (drill-down),
with a **breadcrumb** to climb back out. "Zoom enters a new diagram scope."

This is distinct from graphpaper's existing **inline hierarchy** (`hierarchy: true` → ELK
`INCLUDE_CHILDREN`, compound nodes rendered nested). Inline hierarchy shows children *within*
the parent; scope drill-down shows one scope at a time and *navigates* between them. Both can
coexist; drill-down is a **navigation layer** on top (per the flesh-out note).

## Data model (framework-agnostic — the caller supplies the sub-diagrams)

A node signals it has a scope in either of two ways (a node is "scoped" if either holds):

1. **Inline** — `node.scope: DiagramModelInput` — the sub-diagram travels with the node
   (self-describing; simplest for in-memory callers like the future Agents tab).
2. **By reference** — `node.metadata.scopeRef: string` (an id/slug) + a render option
   `resolveScope(node) => DiagramModelInput | null | Promise<…>` — the caller lazily resolves
   the referenced sub-diagram (fits MC's storage: each architecture graph is a separate stored
   diagram; a node points at another by slug, OR the resolver derives a focused subtree from
   the existing `contains` hierarchy — **no migration**).

Detection is synchronous at render time via `nodeHasScope(node, options)`:
`node.scope != null || node.metadata?.scopeRef != null || options.hasScope?.(node) === true`.
The heavy resolve (option 2) runs only on activation.

New `DiagramRenderOptions`:
- `drillDown?: boolean` (default **false** → byte-identical; no affordance, no nav).
- `resolveScope?: (node) => DiagramModelInput | null | Promise<…>`.
- `hasScope?: (node) => boolean` (optional synchronous predicate for render-time detection when
  using `scopeRef`-free by-reference resolution).
- `onScopeChange?: (info: { depth, path: string[], model }) => void` (optional; lets a host
  surface the breadcrumb in its own chrome instead of graphpaper's built-in bar).

## Render (the "dig in" affordance)

`renderDiagramSvg` marks a scoped node:
- adds the class `diagram-node-scoped` to the node `<g>` (themeable outline);
- appends a small **scope glyph** in the node's top-right — an SVG `<g class="diagram-scope-affordance" data-diagram-scope-enter="<nodeId>" role="button" tabindex="0" aria-label="Dig into <title>">` containing a "⤢" mark;
- appends "· contains a sub-diagram (activate to dig in)" to the node's aria-label.

Sub-diagrams are **never** laid out/rendered in the outer scope — only the glyph. This keeps
the outer diagram uncluttered regardless of sub-diagram size.

Gated on `options.drillDown` (off → no class, no glyph → byte-identical markup).

## Navigation (opt-in, layered on hydrateDiagram)

`hydrateDiagram(container, diagram, { drillDown: true, resolveScope })` binds a **scope
navigation controller** after popovers/panZoom:

- **Enter**: a delegated `click`/`keydown(Enter|Space)` on the scope glyph → `enterScope(node)`
  (the shipped trigger; a `dblclick`-on-body alternate is a deferred nicety):
  - resolve `sub = node.scope ?? await resolveScope(node)`; if null, no-op (loud console warn).
  - push `{ title: node.title, model: currentModel, options }` onto the container's **scope
    stack** (a module `WeakMap<container, StackEntry[]>`);
  - re-`hydrateDiagram(container, sub, options)` (same options → nested scopes compose).
- **Breadcrumb**: a `<nav class="diagram-scope-breadcrumb">` prepended into the container shows
  `root › … › current`; each crumb is a button → `exitToDepth(i)` pops the stack + re-hydrates
  the model at that depth. Rendered only when depth ≥ 1 (root scope shows none).
- **State**: per-container stack in a `WeakMap` (mirrors `panZoomBindings`/`hydrationTokens`);
  pan/zoom resets per scope (each hydrate re-fits). `onScopeChange` fires on every transition.
  `enterScope` captures the hydration token BEFORE the async resolve and bails if a newer
  hydrate/enter superseded it (first-enter-wins — no stale resolve clobbers a newer render).
- **Cleanup**: `cleanupHydratedDiagram` tears down the nav listeners + stack + breadcrumb
  (extend the existing teardown WeakMap set).

The controller reuses the existing delegated-listener + `diagramNodeEventTarget` + WeakMap-
binding patterns (same shape as `bindDiagramPopovers` / `enablePanZoom`).

## MC consumption (minimal for B3 — the deep Architecture-tab adoption is P1-B2)

B3 makes the feature **available + proven in MC**, without rebuilding the Architecture tab:
- Forward `drillDown` + `resolveScope` through MC's shared hydrate path (they already flow via
  the options object — `hydrateDiagram` options are pass-through). No lifecycle change needed.
- **Derived-scope resolver (no migration):** a small MC helper `architectureContainmentScope`
  builds a node's focused sub-diagram from its `contains`-subtree in the SAME architecture graph
  (reuse the hierarchy data). This is the resolver P1-B2 will wire into the Architecture tab.
- For B3, exercise it in a **test** (graphpaper renders the glyph for a scoped node; the resolver
  derives a subtree; enter/exit updates the stack) — MC's bundle includes + can drive the
  feature. The Architecture tab's live adoption (drop node cards, graphpaper fills the pane,
  scope replaces inline hierarchy) is **P1-B2**; the Agents-tab hierarchy is **P1-B4** — both
  consume this same `scope`/`resolveScope` API (inline for Agents, derived/by-ref for Architecture).

## Consumer API summary (design for P1-B2 + P1-B4)

- **P1-B4 Agents tab** (in-memory hierarchy): build one `DiagramModel` where each agent node
  carries an inline `node.scope` = its team's sub-diagram. `drillDown: true`, no resolver needed.
- **P1-B2 Architecture tab** (stored graphs): either `node.metadata.scopeRef = "<slug>"` +
  `resolveScope` that loads the referenced stored diagram, OR the derived-containment resolver
  above. `drillDown: true`; drop the inline `hierarchy` in favor of scope navigation.

## Non-goals (later flesh-out)

- **Reusable component *instancing*** (one component definition instanced across N nodes) —
  roadmap #3's second half; scope-by-reference (`scopeRef` → a shared definition) is the hook,
  but the instancing/dedup model is a later pass.
- Cross-scope edges / minimap / animated zoom transitions — future polish.

## Verify

- graphpaper: `npm run build --prefix packages/graphpaper` (tsc over index.d.ts) — the src is
  JS, so a Node test drives `renderDiagramSvg` (scope glyph present/absent by `drillDown`) +
  `nodeHasScope` + the derived resolver. A jsdom-free nav-logic test asserts the stack
  transitions (enter/exit) via the exported controller where DOM-free; a light DOM test if the
  suite has a document.
- MC: `typecheck:web` + `build:web` (the bundle picks up the new graphpaper) + full suite green.
- Byte-identical: every existing diagram (all `drillDown` absent) renders identical markup + nav.
