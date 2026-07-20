# graphpaper — scope linking (drill-in button + outer-boundary exit + future zoom)

**Status:** design (2026-07-20). Extends P0-B3 scope drill-down ([[DESIGN-SCOPE-DRILLDOWN.md]])
with the drill-**UP** half: an outer boundary on a nested scope and a click-outside / Escape
gesture that pops one level. Phase 1 (boundary + gesture) ships now; Phase 2 (animated
semantic-zoom transition) is deferred, sketched here for continuity.

## TL;DR

The network→process example — a node linking to a deeper diagram shows a button to dig in; a
child diagram shows an outer boundary and clicking outside zooms back out — is **~70% already
shipped** by P0-B3. Existing today: the dig-in glyph, cross-*diagram* linking to a separately
stored child, the crisp per-level re-render, the per-container scope stack, the child→parent
back-link, and a breadcrumb exit. The genuinely-new work is exactly two things, only the first
ships now:

1. **Phase 1 (now):** the **outer-boundary render** + **click-outside / Escape drill-UP**
   gesture. The renderer already knows it is inside a nested scope
   (`options.scopeRootId`, `src/index.js:899`); we add a boundary keyed off that flag and a
   background-click handler that reuses the existing one-level pop (`exitToScopeDepth`).
2. **Phase 2 (later):** an **animated viewBox zoom** on enter/exit, slotting onto the existing
   pan/zoom viewBox substrate. Strictly additive, default-off, reduced-motion → crisp.

The **data model needs nothing new** — the forest is authored today with `metadata.scopeRef` +
a host `resolveScope`. Two optional cosmetic metadata keys (`scopeOfTitle`, `scopeLabel`) are
nice-to-haves, both back-compat.

Everything inherits the established **default-OFF / byte-identical** contract
(`normalizeOptions`, `src/index.js:259-263`): with `drillDown` off, or at the root level (no
`metadata.scopeOf`), every existing model renders identical markup and behaves identically.

## Decisions locked in (2026-07-20)

- **Exit hit-region:** a full-viewBox transparent backdrop — **any empty-canvas click exits**
  (the frame is a spatial cue, not a wall). A strict "margin outside the frame only" geometry
  gate is a fast-follow if surprise-exits prove annoying.
- **Pop depth on background click:** **exactly one level** (matches "zoom out one step"; the
  breadcrumb still covers arbitrary multi-level jumps).

---

## 1. What already exists, and how the example maps onto it TODAY

Request: (a) a node linking to a deeper diagram shows a button that changes scope down into the
child; (b) a child diagram shows an outer boundary and clicking outside changes scope up.

### 1a. The drill-IN button — DONE, untouched

- **Detection:** `nodeHasScope(node, options)` (`src:276-281`) returns true synchronously when
  the node carries an inline `node.scope` OR a non-empty `node.metadata.scopeRef` OR
  `options.hasScope(node)`. So a process node that *points at a separate stored child by id*
  still gets its button without the child in memory.
- **Button markup:** `scopeAffordanceMarkup` (`src:842-854`), gated on
  `options.drillDown && nodeHasScope`, emits the button top-right of the node:
  `<g class="diagram-scope-affordance" data-diagram-scope-enter="<nodeId>" role="button" tabindex="0">`
  with a ⤢ glyph, plus `diagram-node-scoped` on the node `<g>` (`scopedNodeClass`, `src:833-836`).
- **Activation → enter:** `bindDiagramScopeNavigation` (`src:1316-1339`) delegates
  `click`/`keydown(Enter|Space)`; `scopeEnterTargetFor` (`src:1307-1314`) ancestor-walks to the
  button; `activate` calls `enterNodeScope(container, node, options)` (`src:1265-1285`).

### 1b. Cross-DIAGRAM linking to a SEPARATE stored child — DONE

This is the crux of the "two separate linked diagrams" requirement, and it already works:

- `resolveNodeScope(node, options)` (`src:1220-1233`) prefers inline `node.scope`, else
  `await options.resolveScope(node)` — **async-capable** (`src:1225`), so it can load a
  separately stored/versioned/large child diagram lazily on click. A null return is a safe
  no-op (`src:1271`); a thrown loader error is caught and warned, never crashing the handler
  (`src:1226-1229`).
- On enter, `enterNodeScope` **shallow-copies** the resolved child and stamps
  `metadata.scopeOf = node.id` (`src:1279`) — never mutating your stored model. So a separate
  diagram *becomes* a scope child identically to an inline one, and the rendered child now
  carries a back-pointer to the parent node.

### 1c. The crisp re-render + the stack — DONE

- Enter pushes `{ title, model }` onto the per-container stack (`diagramScopeStacks` WeakMap,
  `src:1213/1280-1282`) and calls `renderDiagramLevel` (`src:1476-1492`): layout →
  `replaceDiagramSvgNodes` → popovers → panZoom → scope-nav → breadcrumb. This **is** the
  "total crisp re-render." Nested scopes compose because the same options object is reused
  (`src:1284`).
- `onScopeChange({depth,path,model})` fires on every transition via `emitScopeChange`
  (`src:1295-1305`).

### 1d. The child→parent link + the renderer already knows it is nested — DONE (the exit hook)

`renderDiagramSvg` sets `options.scopeRootId = diagram?.metadata?.scopeOf ?? null` (`src:899`).
Today it is only used to suppress the self-drill glyph (`src:834, 846`). **This flag is exactly
"this level IS a scope child, and here is the parent node id"** — the detection hook for the
outer boundary needs no new plumbing.

### 1e. Exit TODAY — breadcrumb only

`renderScopeBreadcrumb` (`src:1235-1263`) prepends `<nav class="diagram-scope-breadcrumb">`
(root › … › current); each crumb calls `exitToScopeDepth(container, index, options)`
(`src:1287-1293`), which slices the stack, fires `emitScopeChange`, and re-renders. **This is
the only exit path today** — there is no spatial "click outside to zoom out."

### 1f. The viewBox pan/zoom substrate — the future-animation hook

`enablePanZoom` (`src:1537-1643`) holds a mutable `view={x,y,w,h}`, `apply()` does
`svg.setAttribute("viewBox", …)` (`src:1555`), `fit()` resets to the base viewBox
`0 0 layout.width layout.height` (`src:960/1556`). `parsePanZoomViewBox` (`src:1504`) reads the
live view; `zoomAt`'s `px/py` math (`src:1566-1573`) maps screen↔viewBox. Animating a viewBox is
just rAF-lerping four numbers through this same `setAttribute`.

**Net: for the network→process example, the drill-in button and crisp re-render are free.** You
author the network diagram, give each drillable process node `metadata.scopeRef`, pass
`{ drillDown:true, resolveScope }`, and drill-in works end to end today. The missing half is the
spatial drill-**up**.

---

## 2. The genuinely-new work (phased)

### PHASE 1 — Outer-boundary render + click-outside / Escape drill-UP

Two pieces: a render addition in the pure `renderDiagramSvg`, and a gesture addition in the
scope controller. Both gated so they are inert unless the level is a scope child under
`drillDown`.

#### 2.1 Rendering the outer boundary (in `renderDiagramSvg`, `src:893-969`)

**Coordinate-space decision: render it INSIDE the `<svg>`, in diagram/layout coordinates — NOT
an HTML chrome overlay.** The boundary is a spatial statement ("the parent is out beyond this
frame"), so it must stay glued to content under pan/zoom. Anything inside the `<svg>` transforms
for free with the viewBox — exactly like nodes, edges, and the existing lifecycle `watermark`
(`src:951-953`, injected at `src:966`). An HTML overlay (like `.diagram-panzoom-controls` or the
breadcrumb) is fixed chrome and would NOT track zoom. It also reuses the existing string→DOM
path: the backdrop rect parses into the same `<svg>` child, so its clicks bubble to the
container where the delegated scope listener already lives (`src:1333`) — **no new listener
target**.

**New pure function `renderScopeBoundary(layout, diagram, options)`** returns three elements, in
paint order (backdrop lowest):

- **Exit backdrop** — full-viewBox transparent hit-target, the ONLY interactive element:
  `<rect class="diagram-scope-exit-backdrop" data-diagram-scope-exit="1" x="0" y="0" width="${layout.width}" height="${layout.height}" fill="transparent">`
- **Visible frame** — inset dashed rect, `pointer-events:none` (never intercepts):
  `<rect class="diagram-scope-boundary" x="${INSET}" y="${INSET}" width="${W-2*INSET}" height="${H-2*INSET}" rx="12" pointer-events="none">`,
  with `INSET = DEFAULT_LAYOUT_PADDING/2 = 16` (`src:14` = 32) so the frame sits *inside* the
  32px layout padding and never overlaps node geometry.
- **Label chip** — top-left, `pointer-events:none`, `<g class="diagram-scope-boundary-label">`
  with a bg rect + `<text>` reading `‹ ${shortRef(scopeOfTitle, 32)} · click outside to zoom out`.
  Use the existing `shortRef` truncation (`src:209`) so a long parent title cannot overflow a
  narrow child viewBox. Whole group `aria-hidden="true"` — decorative; keyboard exit is Escape +
  breadcrumb.

**Wiring** — compute after `nodeGroups` (`src:939`), inject between `map-edges` and `map-nodes`
(`src:965`):

```js
const scopeBoundary =
  (options.drillDown && options.scopeRootId != null && options.scopeExitOnBackground !== false)
    ? renderScopeBoundary(layout, diagram, options) : "";
```

```
<g class="map-edges">${edges}</g>
${scopeBoundary}
<g class="map-nodes">${nodeGroups}</g>${watermark ? …}
```

Placing it between edges and nodes means the backdrop paints **below every node `<g>`** (nodes
stay clickable/hoverable — popovers unaffected) and the visible frame draws over edges but under
nodes. Crucially the backdrop is a **sibling** of `<g class="map-nodes">`, not an ancestor of
any node — this is what makes hit-testing DOM-only (see 2.2).

**Parent title into the pure renderer.** `renderDiagramSvg` has no stack, so stamp the title
where the child model is created. Extend `enterNodeScope` (`src:1279`):

```js
metadata: {
  ...(sub.metadata ?? {}),
  scopeOf: sub.metadata?.scopeOf ?? node.id,
  scopeOfTitle: sub.metadata?.scopeOfTitle ?? (node.title ?? node.id)   // NEW
}
```

`renderScopeBoundary` reads `metadata.scopeOfTitle`, falling back to `"parent scope"` when a
host pre-stamped only `scopeOf`. Document `scopeOfTitle` next to `scopeOf` in
`index.d.ts:199-203`.

**Byte-identical guarantee.** `scopeBoundary` is `""` unless `drillDown && scopeRootId != null`.
Root/top-level models carry no `metadata.scopeOf` (`src:897-899`) → `scopeRootId` null → no
boundary. `drillDown` off → no boundary. Every pre-existing model renders identical markup. The
new markup is only `<g>/<rect>/<text>` with class/data/geometry attrs (no `on*`, no `href`), so
it passes the existing SVG-safety scanner (`assertDiagramSvgMarkupSafeForDomReplacement`,
`src:92-108`) unchanged.

#### 2.2 The click-outside / Escape gesture (in `bindDiagramScopeNavigation`, `src:1316-1339`)

**New matcher `scopeExitTargetFor(target, container)`** mirroring `scopeEnterTargetFor`
(`src:1307`):

```js
function scopeExitTargetFor(target, container) {
  let cursor = target;
  while (cursor && cursor !== container) {
    if (cursor.getAttribute?.("data-diagram-node")) return null;        // node click ≠ exit
    if (cursor.getAttribute?.("data-diagram-scope-enter")) return null; // dig-in glyph is enter
    if (cursor.getAttribute?.("data-diagram-scope-exit")) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}
```

**Why DOM-ancestry alone suffices (no geometry math).** The backdrop is a leaf `<rect>` sibling
of the node groups, not their ancestor. A click on a node hits the node's `<rect>`/`<text>`,
whose ancestor chain contains `data-diagram-node` and NOT `data-diagram-scope-exit` → returns
null. A click on empty canvas hits the backdrop directly → matches → exit. The visible frame +
label are `pointer-events:none`, so clicks fall through them to the backdrop. Paint order does
the discrimination.

**Pan-vs-click disambiguation.** With `panZoom:true`, a drag-to-pan ends in a `pointerup` the
browser also reports as `click` — we must NOT exit on every pan release. Track pointer travel via
delegated `pointerdown`/`pointermove` on the container (same shape as the popover listeners),
with `EXIT_MOVE_THRESHOLD ≈ 6px` client-space; set a `moved` flag; only exit when `!moved`.

**Extend `activate` + `onKey`** (`src:1319-1332`):

```js
const activate = (event) => {
  const trigger = scopeEnterTargetFor(event.target, container);
  if (trigger) { /* existing ENTER path, unchanged */ return; }
  if (options.scopeExitOnBackground === false) return;   // NEW exit path
  if (moved) return;                                     // it was a pan
  if (!scopeExitTargetFor(event.target, container)) return;
  const stack = diagramScopeStack(container);
  if (stack.length <= 1) return;                         // already at root
  event.preventDefault?.(); hideDiagramPopover();
  void exitToScopeDepth(container, stack.length - 2, options);  // pop exactly ONE level
};
const onKey = (event) => {
  if (event.key === "Escape") {                          // NEW keyboard exit
    if (options.scopeExitOnBackground === false) return;
    const stack = diagramScopeStack(container);
    if (stack.length <= 1) return;
    event.preventDefault?.(); hideDiagramPopover();
    void exitToScopeDepth(container, stack.length - 2, options);
    return;
  }
  /* existing Enter/Space enter-by-keyboard */
};
```

Bind `onDown`/`onMove` alongside the existing `click`/`keydown`; extend the teardown closure
(`src:1335-1338`) to remove them. `unbindDiagramScopeNavigation` (`src:1341-1345`) and
`cleanupHydratedDiagram` (`src:1155-1170`) need no other change — same single WeakMap binding.

**Reuse of the pop machinery.** `exitToScopeDepth(container, depth, options)` (`src:1287-1293`)
already slices the stack to `depth+1`, fires `emitScopeChange` (→ host `onScopeChange` for free),
and re-renders. Drill-UP one level = `exitToScopeDepth(container, len-2, options)`. Nesting
composes: from depth 3 a background click → depth 2, identical to a breadcrumb click. Nothing new
is built for the pop itself.

**a11y.** The backdrop is `aria-hidden` decoration; Escape gives the keyboard-reachable drill-UP
(background click alone is not keyboard-reachable). The breadcrumb's focusable crumb buttons
(`src:1252`) remain the assistive-tech / arbitrary-jump path. `hideDiagramPopover()` runs before
every exit so no popover lingers over a removed child node (same as the enter path, `src:1325`).

#### 2.3 Coexistence with the breadcrumb

**Keep both.** Boundary/background-click = the primary *spatial* "zoom out one step". Breadcrumb =
arbitrary multi-level jumps + keyboard focus. Two new flags in `normalizeOptions` (`src:259-263`),
both defaulting to preserve today:

- `scopeExitOnBackground?: boolean` (default **true**) — gates BOTH the boundary render (2.1)
  and the click/Escape gesture (2.2). Set false for a read-only child that should show no exit
  affordance and not intercept background clicks.
- `scopeBreadcrumb?: boolean` (default **true**) — gates `renderScopeBreadcrumb` at `src:1490`
  (`if (options.scopeBreadcrumb !== false) renderScopeBreadcrumb(...)`), letting a host that
  prefers boundary-only UX, or drives its own chrome via `onScopeChange`, suppress the bar.

Default (both true): once you drill in, breadcrumb AND boundary both appear — additive, and root
level shows neither, exactly as today.

#### 2.4 New CSS (append to the `/* Scope / drill-down */` block, `diagram.css` ~:169)

```css
.diagram-scope-boundary { fill: none; stroke: var(--gp-line, var(--line, rgba(183,203,231,0.28))); stroke-width: 1.5; stroke-dasharray: 6 4; }
.diagram-scope-exit-backdrop { cursor: zoom-out; }
.diagram-scope-boundary-label-bg { fill: rgba(8,17,31,0.86); stroke: var(--gp-line, var(--line, rgba(183,203,231,0.18))); stroke-width: 1; }
.diagram-scope-boundary-label-text { fill: var(--gp-muted, var(--muted, #9fb0c8)); font-size: 12px; dominant-baseline: middle; }
```

Reuses the existing theme tokens (`--gp-line/--gp-muted/--gp-blue`, `diagram.css:145-169`).
`cursor:zoom-out` on the backdrop signals the gesture and previews Phase 2.

---

### PHASE 2 (LATER) — Animated semantic-zoom transition

Purely additive, default-off, ships after Phase 1. It swaps only the *moment* of the crisp
`renderDiagramLevel` swap for a two-phase illusion driven by the same viewBox substrate. Nothing
in Phase 1 blocks it — the boundary rect rides inside the SVG so it animates with any viewBox
change for free.

**The approach (matched-frame illusion).** Parent and child are *separate models with
independent layouts*, so a literal continuous magnification is impossible. Instead, make both
endpoints share ONE rectangle: the entered node's box `n = layout.positions.get(node.id)`
(`src:510-511` → `{x,y,width,height,centerX,centerY}`) == the child's outer-boundary frame
(Phase 1's inset frame). The eye reads "the node became the child" because the frames coincide at
the seam and a cross-fade hides the swap.

- **Two stacked `<svg>`s** (`position:absolute; inset:0` in the already-relative container,
  `src:1611`), cross-fading. Chosen over one transformed container because the two documents have
  different viewBoxes/layouts and each must keep its own crisp vector rendering.
- **ENTER (drill down):** parent svg's viewBox lerps (rAF, ease-out-cubic, ~260ms) from its live
  view `v0` (via `parsePanZoomViewBox`, `src:1504`) down into `n` (aspect-corrected/letterboxed
  to `v0`'s ratio), fading out over the second half; child svg is staged on top, transformed so
  its frame maps onto `n` on-screen (inverting the `zoomAt` px/py map, `src:1566-1573`), then
  lerps to identity + fades in. **EXIT (drill up)** reverses: parent looked up from the child's
  `metadata.scopeOf` (`src:899/1279`) → `parentLayout.positions.get(scopeOf)` gives the
  destination rect; child shrinks into it while the parent viewBox pulls out to `fit()` and fades
  in (~240ms).
- **60fps discipline:** the *surviving* svg animates via transform/opacity (compositor-only) and
  ends on the channel that lands crisp/fitted; the *discarded* svg animates via viewBox
  `setAttribute` (heavier, but it is about to be deleted). `will-change` set at stage, cleared at
  commit; one rAF loop; client rect measured once. For large diagrams (over `maxAnimatedNodes`),
  degrade the discarded svg to transform-scale too.

**Option flag** (`index.d.ts`, `DiagramRenderOptions`, consumed only in the enter/exit path —
`renderDiagramSvg` never reads it, renderer stays pure):

```ts
scopeTransition?: "crisp" | "zoom" | { mode: "crisp" | "zoom"; durationMs?: number; maxAnimatedNodes?: number }
```

Default `"crisp"` in `normalizeOptions`. `renderDiagramLevel` gains an optional `preRendered`
handle so the level-bind reuses the svg the animation already built (avoid a second
layout+parse); absent → today's crisp path.

**Reduced-motion + guards.** `prefersReducedMotion(container)` =
`container.ownerDocument?.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches`;
when true, or no document, or no `requestAnimationFrame`, or `scopeTransition:"crisp"` →
immediate crisp commit (identical to today). Mirrors the existing motion opt-out for flow edges
(`diagram.css:66`). **Abort-on-supersede for free:** capture `hydrationTokens.get(container)` at
animation start (`src:22-23`); each frame aborts if it changed — and `renderDiagramLevel` bumps
the token first thing (`src:1477-1478`), so any newer enter/exit/hydrate auto-invalidates an
in-flight tween. `cleanupHydratedDiagram` (deletes the token, `src:1157`) self-cancels the loop;
add a `diagramTransitionBindings` WeakMap (mirroring `panZoomBindings`) to also cancel the rAF id
+ remove the transient svg.

**Honest limits (call these out, don't hide them):** it is a matched-frame cross-fade, not
literal continuous zoom — interiors don't correspond pixel-for-pixel. It gets visibly "called
out" when: the child's aspect is far from the node box (letterbox with transient bars — accept
over distortion); a tiny node opens a huge child (child starts extremely scaled-down and only
resolves late — clamp the start scale, floor ~0.35); a slow async `resolveScope` (v1: wait for
resolve, token-guarded, before any visual). Multi-level dives are a *sequence* of these
illusions, relying on abort-on-supersede to avoid stutter.

---

## 3. Data model / authoring for the example — and the forest/DAG edge cases

**The data model needs nothing new for correctness.** The forest is authored today as
independent stored `DiagramModel`s linked by-reference.

### 3a. Why by-reference (`scopeRef` + `resolveScope`), not inline `node.scope`

The process-internals diagram is a *separate, independently authored/stored/versioned* document.
Inline `node.scope` would fuse two documents into one blob, force the (possibly large) internals
to travel with every load of the network diagram even when nobody drills in, and prevent two
network nodes (same daemon on two hosts) from sharing one internals definition.
`metadata.scopeRef` + a resolver avoids all three, and `resolveScope` is async so it loads from
DB/file/fetch lazily on click (`src:1225`). (Inline `node.scope` remains right for a *different*
consumer — an in-memory, generated-on-the-fly child — but not this forest.)

### 3b. Two orthogonal relationships in the network diagram

- **device *contains* process** → *inline containment* via `hierarchy:true` + `contains` edges
  (`hierarchyEdgeTypes` default `["contains"]`, `src:237`). ELK nests processes inside their
  device box, so the network level shows devices AND their processes together.
- **process *drills into* its internals** → *by-reference scope* via `metadata.scopeRef` on the
  process node. This is a **navigation** link, not containment — the internals are NOT drawn at
  the network level. Both coexist cleanly: containment is an edge, scope is node metadata.

### 3c. Concrete forest (three independent diagrams)

**(A) network diagram** — devices contain processes; two processes drill into separate internals:

```json
{
  "id": "net-1", "title": "Prod network",
  "nodes": [
    { "id": "host-a", "title": "host-a", "type": "device" },
    { "id": "host-b", "title": "host-b", "type": "device" },
    { "id": "p-auth",  "title": "auth-daemon", "type": "process",
      "metadata": { "scopeRef": "auth-daemon-internals", "scopeLabel": "auth-daemon seams" } },
    { "id": "p-nginx", "title": "nginx", "type": "process",
      "metadata": { "scopeRef": "nginx-internals" } },
    { "id": "p-cron",  "title": "cron", "type": "process" }
  ],
  "edges": [
    { "from": "host-a", "to": "p-auth",  "type": "contains" },
    { "from": "host-a", "to": "p-nginx", "type": "contains" },
    { "from": "host-b", "to": "p-cron",  "type": "contains" },
    { "from": "p-nginx", "to": "p-auth", "type": "calls", "flavor": "reads", "label": "verifies token" }
  ]
}
```

`p-auth`/`p-nginx` carry `scopeRef` → they get the dig-in glyph under `drillDown:true`; `p-cron`
(no scopeRef) does not. The `calls` edge is normal information flow, not a scope link.

**(B) resolver + hydrate** (host code — a registry keyed by diagram id):

```js
const DIAGRAMS = new Map([["net-1", networkDiagram], ["auth-daemon-internals", authDaemonInternals] /* … */]);
async function resolveScope(node) {
  const ref = node?.metadata?.scopeRef;
  if (ref == null) return null;
  return DIAGRAMS.get(ref) ?? (await loadDiagramById(ref)) ?? null;   // async ok (src:1225)
}
await hydrateDiagram(el, networkDiagram, {
  hierarchy: true,   // device>process containment
  drillDown: true,   // scope glyph + nav (and Phase-1 boundary/exit)
  resolveScope,
  onScopeChange: ({ path }) => setBreadcrumb(path),
});
```

**(C) a process-internals child** — a completely standalone diagram, carrying NO parent
back-pointer:

```json
{
  "id": "auth-daemon-internals", "title": "auth-daemon internals",
  "nodes": [
    { "id": "listener", "title": "TCP listener", "type": "seam" },
    { "id": "verifier", "title": "token verifier", "type": "seam",
      "metadata": { "scopeRef": "token-verifier-internals" } },
    { "id": "store", "title": "session store", "type": "seam" }
  ],
  "edges": [
    { "from": "listener", "to": "verifier", "type": "calls" },
    { "from": "verifier", "to": "store", "type": "reads" }
  ]
}
```

`verifier` itself carries a `scopeRef` — that is how the forest goes deeper. The child→parent
link is *not authored*; it is auto-stamped at drill time (`scopeOf`, `src:1279`). Rendered
standalone (opened directly), the child carries no `scopeOf` → no boundary, no back gesture —
correct: it is a valid top-level diagram on its own.

### 3d. Forest/DAG edge cases

- **Nested (deeper) scopes:** a child node's own `scopeRef` drills further with the *same*
  options object (`src:1284`); unbounded depth on the stack (`src:1280-1282`); the breadcrumb
  grows `root › auth-daemon › token verifier`. Nesting is emergent — no "this is nested" flag.
- **Multi-parent / DAG (shared child):** because the link is a shared `scopeRef` id, one stored
  child can be referenced from many parents. **The stack tracks the PATH, not identity** — each
  frame is a shallow *copy* stamped with the *entering* node's id (`src:1277-1279`), so
  click-outside returns to the *right* parent per traversal, with no aliasing across references.
  (Limit: both instances render identical content; true per-instance *instancing* is explicit
  future work — the shared `scopeRef` is the hook, no data change now.)
- **Cycles:** (i) containment cycles inside one diagram are guarded — `diagramContainment`'s
  `wouldCycle` + single-parent enforcement drop offending `contains` edges. (ii) Scope cycles
  across the forest (A→B→A) are *navigationally benign*: the stack is a path, re-entering A just
  pushes another A frame, bounded by clicks, exited by boundary/breadcrumb. The trivial 1-cycle
  (re-entering your own scope) is already pre-empted by suppressing the glyph on `scopeRootId`
  (`src:834/846`). To forbid A→B→A, do it in the host loader — optional, no graphpaper change.

### 3e. Optional cosmetic metadata (both back-compat, both just reserved keys on `metadata`)

- **`node.metadata.scopeLabel?: string`** — an author caption for the drill button
  aria-label/tooltip (today hardcoded `Dig into ${node.title}`, `src:850`). Purely additive.
- **`metadata.scopeOfTitle?: string`** — mostly auto-stamped (Phase 1, §2.1) for the boundary
  label; the authoring relevance is only the escape hatch for a host that pre-stamps `scopeOf` on
  a stored child itself.

**Not worth adding:** a separate `childDiagramId` (redundant with `scopeRef`); an authored
child→parent back-pointer (actively *wrong* — breaks the shared-child/DAG case; keep it
auto-stamped); a dedicated scope edge type (scope is deliberately node metadata, not an edge, so
it never pollutes real edges or layout).

**Label sources:** the drill *button* prefers `scopeLabel` → node title; the *boundary* prefers
the parent node's title (`scopeOfTitle`).

---

## 4. Build order + what to verify

**Recommended order:**

1. **Phase 1 render, gated & inert.** Add `renderScopeBoundary` + the `scopeBoundary` injection +
   the two option flags in `normalizeOptions`. Add CSS. Add the `scopeOfTitle` stamp in
   `enterNodeScope`. The boundary *renders* on child levels but nothing new is interactive.
2. **Phase 1 gesture.** Add `scopeExitTargetFor`, the pointerdown/pointermove threshold, and the
   exit branches in `activate`/`onKey`; extend the teardown. Now click-outside + Escape drill up
   one level.
3. **Docs/types.** `index.d.ts`: document `metadata.scopeOfTitle` (and optional `scopeLabel`)
   next to `scopeOf` (`:199-203`); add `scopeExitOnBackground?` + `scopeBreadcrumb?` to
   `DiagramRenderOptions` (`:132/167`). Extend README's "Scope / drill-down" section with the
   boundary/click-outside/Escape drill-up and the multi-diagram forest example.
4. **Phase 2 (separate, later PR).** `animateScopeTransition` + `scopeTransition` option +
   `prefersReducedMotion` + `diagramTransitionBindings` + `preRendered` hook.

**What to verify:**

- **Byte-identical when off** (the load-bearing test, matching the existing contract at
  `DESIGN-SCOPE-DRILLDOWN.md`): every model with `drillDown` absent, and every root-level render
  (no `metadata.scopeOf`), produces identical `renderDiagramSvg` output. Assert
  `scopeBoundary === ""` when `!drillDown` or `scopeRootId == null` or
  `scopeExitOnBackground === false`.
- **Render tests (DOM-free, drive `renderDiagramSvg`):** a model stamped `metadata.scopeOf` under
  `drillDown:true` emits exactly one `data-diagram-scope-exit` backdrop + the
  `.diagram-scope-boundary` frame + the label with `scopeOfTitle`; a root model emits none;
  `drillDown:false` emits none. Confirm the new markup passes
  `assertDiagramSvgMarkupSafeForDomReplacement` (`src:92-108`).
- **Nav-logic tests:** `scopeExitTargetFor` returns the backdrop for a backdrop target, null when
  a `data-diagram-node` or `data-diagram-scope-enter` ancestor is hit first.
- **Forest/DAG tests:** deeper `scopeRef` composes; shared child from two parents returns to the
  correct parent per path; dangling `scopeRef` → glyph shows but enter is a safe no-op.
- **Build gate:** `node --check src/index.js` + the `node:test` suite green.

---

## Files touched (all under this repo)

- `src/index.js` — `renderScopeBoundary` (new); `scopeBoundary` injection in `renderDiagramSvg`
  (~`src:939/965`); `scopeExitTargetFor` (new, mirrors `src:1307`); `activate`/`onKey` +
  pointer-threshold in `bindDiagramScopeNavigation` (`src:1316-1339`); `scopeOfTitle` stamp in
  `enterNodeScope` (`src:1279`); two new flags in `normalizeOptions` (`src:259-263`) +
  `scopeBreadcrumb` gate at `src:1490`. Phase 2: `animateScopeTransition`, `prefersReducedMotion`,
  `diagramTransitionBindings`, `preRendered` on `renderDiagramLevel` (`src:1476`).
- `diagram.css` — append `.diagram-scope-boundary` / `.diagram-scope-exit-backdrop` /
  `.diagram-scope-boundary-label-*` after the scope block (~:169). Phase 2: transient-svg +
  reduced-motion rules.
- `index.d.ts` — doc `metadata.scopeOfTitle` (+ optional `scopeLabel`) at `:199-203`; add
  `scopeExitOnBackground?` / `scopeBreadcrumb?` (+ Phase 2 `scopeTransition?`) to
  `DiagramRenderOptions` (`:132/167`).
- `README.md` — extend the "Scope / drill-down" section (boundary + click-outside/Escape
  drill-up; the forest example; Phase 2 `scopeTransition:"zoom"` note).
- `test/` — new `node:test` suite (zero deps) covering byte-identical-when-off, the boundary
  render, and `scopeExitTargetFor`.

## Non-goals (Phase 1)

- Animated zoom transitions (Phase 2, above).
- Strict "margin-outside-the-frame-only" exit geometry (fast-follow if any-empty-canvas exit
  proves annoying).
- Reusable component *instancing* across N nodes (roadmap #3's second half; shared `scopeRef`
  is the hook).
- Cross-scope edges / minimap.
