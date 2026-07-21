# graphpaper

A small, framework-agnostic diagram renderer. Give it a neutral node/edge
**`DiagramModel`** and it lays the graph out with [ELK](https://github.com/kieler/elkjs)
and renders interactive SVG (status-colored nodes, orthogonal edge routing,
hierarchy nesting, and hover popovers). No React required.

## Usage

```js
import { hydrateDiagram } from "graphpaper";

await hydrateDiagram(containerEl, {
  id: "demo",
  title: "Services",
  nodes: [
    { id: "api", title: "API", type: "service", status: "active" },
    { id: "db", title: "Postgres", type: "database" }
  ],
  edges: [{ from: "api", to: "db", label: "reads/writes" }]
}, { direction: "RIGHT" });
```

## ELK layout

The renderer uses an ELK engine exposed as `window.ELK` (the same global
`elkjs`'s `lib/elk.bundled.js` installs). When no engine is present it falls
back to a built-in layered layout, so it degrades gracefully. `elkjs` is an
optional peer dependency.

## Scope / drill-down (nested diagrams)

A node can **contain a sub-diagram** — a sense of "scope". The sub-diagram is **not** rendered
inline (avoiding clutter); instead the node shows a small "dig in" glyph, and activating it
**navigates into** the sub-diagram, with a breadcrumb to climb back out. Opt-in via
`drillDown: true` (default off → byte-identical: no glyph, no nav).

A node declares a scope in either of two ways:

```js
// (1) inline — the sub-diagram travels with the node
{ id: "server-a", title: "Server A", type: "service",
  scope: { id: "server-a-internals", title: "Server A", nodes: [...], edges: [...] } }

// (2) by reference — a lazy resolver loads it on activation
{ id: "server-b", title: "Server B", type: "service", metadata: { scopeRef: "server-b-internals" } }

await hydrateDiagram(el, topology, {
  drillDown: true,
  resolveScope: (node) => loadDiagramFor(node.metadata.scopeRef), // async ok
  onScopeChange: ({ depth, path }) => console.log("at", path.join(" › ")),
});
```

`nodeHasScope(node, options?)` is the synchronous render-time predicate (inline `scope`,
`metadata.scopeRef`, or an `options.hasScope(node)` callback).

### Drilling back up — outer boundary + click-outside / Escape

Once you've drilled into a sub-diagram, that nested level draws an **outer boundary**: an inset
dashed frame with a top-left label (`‹ <parent> · click outside to zoom out`) and a full-canvas
transparent exit backdrop. **Clicking any empty canvas** — or pressing **Escape** — pops exactly
one level (the spatial "zoom out one step"); the breadcrumb still covers arbitrary multi-level
jumps and stays the keyboard/assistive-tech path. Nodes and the dig-in glyph paint above the
backdrop, so clicking them never exits. On, both boundary and breadcrumb appear once nested; the
root level shows neither.

```js
await hydrateDiagram(el, topology, {
  drillDown: true,
  resolveScope,
  scopeExitOnBackground: true, // default — boundary + click-outside/Escape drill-up
  scopeBreadcrumb: true,       // default — set false for a boundary-only UX
});
```

- `scopeExitOnBackground` (default `true`) gates both the boundary render and the click/Escape
  gesture. Set `false` for a read-only child that shows no exit affordance and never intercepts
  background clicks.
- `scopeBreadcrumb` (default `true`) gates the breadcrumb bar — set `false` for boundary-only, or
  when a host drives its own chrome via `onScopeChange`.

The parent's title flows into the boundary label automatically via a reserved
`metadata.scopeOfTitle` key (auto-stamped on drill-in beside `metadata.scopeOf`); a host that
stores children with a pre-set `scopeOf` may pre-set `scopeOfTitle` too.

### Multi-diagram forest

Because a scope is linked by-reference (`metadata.scopeRef` + an async `resolveScope`), a whole
**forest** of independently authored/stored diagrams composes: each `resolveScope` returns a
standalone `DiagramModel`, whose own nodes may carry further `scopeRef`s to go deeper, unbounded.
The stack tracks the **path**, not identity — the same stored child referenced from two parents
returns to the correct parent per traversal, and a rendered-standalone child (no `scopeOf`) shows
no boundary, since it is a valid top-level diagram on its own.

### Animated transition (opt-in, default off)

`scopeTransition: "zoom"` enables an **opt-in animated matched-frame transition** on drill
enter/exit: the outgoing level is snapshotted and cross-fades with the incoming level, which is
scaled onto the entered node's on-screen box so the eye reads "the node became the child".

```js
await hydrateDiagram(el, topology, {
  drillDown: true,
  resolveScope,
  scopeTransition: "zoom", // or { mode: "zoom", durationMs: 260, maxAnimatedNodes: 400 }
});
```

It is an **illusion**, not a literal continuous zoom — the parent and child are separate diagrams
with independent layouts, so their interiors don't correspond pixel-for-pixel; the two frames only
coincide at the seam. It is **compositor-only** (CSS transform + opacity — the pan/zoom viewBox is
never touched) and strictly additive: the default `"crisp"` is behavior-identical to omitting the
option, and it **falls back to the crisp swap** under `prefers-reduced-motion`, when
`requestAnimationFrame` is unavailable, or for a level exceeding `maxAnimatedNodes` (default 400).
`durationMs` defaults to 260.

## Lifecycle marking (deprecated / expired / …)

A diagram can declare a lifecycle state so a stale graph can never be mistaken for the current
one — it renders with a caption badge, a diagonal in-SVG watermark (survives standalone export),
a dimmed graph, and an aria-label suffix. Declare it on the model (or under `metadata.lifecycle`):

```js
{ id: "old-topology", title: "Network topology", lifecycle: "deprecated", nodes, edges }
{ id: "v1", title: "V1 dataflow", lifecycle: { state: "expired", label: "Expired 2026-07", note: "superseded by v2" }, nodes, edges }
```

`state` is a free token; `deprecated` and `expired`/`out-of-date` ship tinted styles, anything
else gets the neutral treatment. `diagramLifecycle(model)` is the exported normalizer. No
declaration (every pre-existing model) ⇒ byte-identical markup.

## Staged process diagrams (step-through)

A diagram can declare ordered **stages** that unfold a process; hydration then renders a
prev/next stage bar (`Stage k/N · title` + per-stage caption) and flips per-element visibility.
The **whole union is laid out once** — positions never shift between stages, and pan/zoom
survives flips. Elements new at the current stage are highlighted.

```js
{
  id: "consult-flow",
  title: "Consult flow",
  stages: [
    { id: "ask", title: "Agent asks", caption: "The caller consults the authority." },
    "Decider dispatched",                       // string shorthand
    { id: "wake", title: "Caller wakes" }
  ],
  nodes: [
    { id: "caller", title: "Caller", type: "agent" },              // no declaration → every stage
    { id: "decider", title: "Decider", type: "agent", stage: 2 },  // appears at stage 2, stays
    { id: "note", title: "Transient", type: "custom", stages: ["ask"] } // explicit membership
  ],
  edges: [ /* same stage/stages fields; an edge also hides whenever either endpoint is hidden */ ]
}
```

A stage ref is a 1-based index or a stage id. The same fields are honored under `metadata`
(`metadata.stage` / `metadata.stages` / model-level `metadata.stages`), so stored models need no
top-level schema change. Options: `stageControls: false` (render the full union, no bar),
`initialStage` (1-based), `onStageChange({ index, count, stage })`. Pure helpers exported for
hosts/tests: `diagramStages(model)`, `stageVisibilityForDiagram(model)`. Models without stages
(all existing ones) ⇒ byte-identical markup.

## API

- `hydrateDiagram(container, model, options?)` — lay out + render into a DOM element, bind popovers + (opt-in) drill-down nav.
- `layoutDiagram(model, options?)` → `DiagramLayout` — positions + edge paths only.
- `renderDiagramSvg(model, layout, options?)` → SVG markup string.
- `cleanupHydratedDiagram(container)` — tear down listeners/popovers/scope-nav.
- `hideDiagramPopover()` / `hideDiagramPopoverForPageEvent(event)` — popover control.
- `isInformationFlowEdge(edge)` — predicate for flow edges.
- `nodeHasScope(node, options?)` — predicate: does the node have a drill-down scope?
- `enablePanZoom(container, options?)` / `disablePanZoom(container)` — pan/zoom control.
- `diagramLifecycle(model)` — normalize the lifecycle declaration (or null).
- `diagramStages(model)` / `stageVisibilityForDiagram(model)` — staged-diagram helpers.

See `index.d.ts` for the full `DiagramModel` / `DiagramRenderOptions` types.

## Styling

Import the shipped stylesheet so the visuals travel with the package:

```js
import "graphpaper/diagram.css";
```

It's self-contained (sensible dark defaults) and themeable via CSS custom
properties — `--gp-blue`, `--gp-muted`, `--gp-text`, `--gp-line`, `--gp-radius`
(legacy `--blue`/`--muted`/`--text`/`--line`/`--radius` are also honored).
