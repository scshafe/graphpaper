# @scshafe/graphpaper

A small, framework-agnostic diagram renderer. Give it a neutral node/edge
**`DiagramModel`** and it lays the graph out with [ELK](https://github.com/kieler/elkjs)
and renders interactive SVG (status-colored nodes, orthogonal edge routing,
hierarchy nesting, and hover popovers). No React required.

Popovers cover **edges** as well as nodes: hovering or keyboard-focusing an edge
shows its endpoints, label, `description` (the colloquial explanation of the
relationship), and kind/flavor rows. Each edge renders a wide transparent hit
path so the 2px stroke is comfortably hoverable.

## Install

The package is published privately to GitHub Packages as `@scshafe/graphpaper`
(the unscoped `graphpaper` on registry.npmjs.org is an unrelated package). Map
only the scope in the consuming project's committed `.npmrc`; everything else,
including the optional `elkjs` peer, still resolves from registry.npmjs.org:

```ini
@scshafe:registry=https://npm.pkg.github.com
```

Credentials for `npm.pkg.github.com` (a `read:packages` token) belong in the
user-level `~/.npmrc` or the installing process's environment, never in a
project file. Consumers pin an exact version:

```bash
pnpm add --save-exact @scshafe/graphpaper
```

## Usage

```js
import { hydrateDiagram } from "@scshafe/graphpaper";

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

With an engine present, the edge labels a diagram shows (`showEdgeLabels`, or
information-flow edges) are placed by ELK with room reserved, instead of at
the path midpoint where they collide with neighbours. `edgeLabelPlacement`
picks where: `"center"` (default) inline on the edge, a relationship label,
which costs a taller layout; `"tail"` or `"head"` beside the edge at its
source or target, the flowchart convention for decisions, at no extra height.
Theme the label backdrop with `--gp-halo`.

Where there is no `window` — a server rendering SVG in Node, a test — hand the
engine in as `layoutEngine`; it takes precedence over the global. Do not fake a
`window` for elkjs instead: its bundle reads `window.Error` and throws.

```js
import { createRequire } from "node:module";
import { layoutDiagram, renderDiagramSvg } from "@scshafe/graphpaper";

const ELK = createRequire(import.meta.url)("elkjs/lib/elk.bundled.js");
const options = { direction: "DOWN", layoutEngine: new ELK() };
const layout = await layoutDiagram(model, options);
const svg = renderDiagramSvg(model, layout, options); // no DOM needed
```

## Node headers and the colour key

Every node opens with a «type» line and a divider. `stereotypes: false` drops
them — the colour carries the kind and each node shrinks by that band — and a
`legend` says what the colours mean:

```js
hydrateDiagram(el, model, {
  stereotypes: false,
  legend: [
    { type: "service", label: "Service" },
    { type: "store", status: "degraded", label: "Degraded" },
    { edge: { kind: "flow", flow: true }, label: "Data flow" }
  ]
});
```

Node entries render as chips — the label inside a box wearing the node's own
classes (`map-node node-type-service`) — and edge entries as a line swatch
(`map-edge edge-kind-flow`), so whatever your stylesheet gives the diagram,
the key shows the same. The legend renders after
the SVG as `.diagram-legend` (positioned in the container; pan/zoom positions
it), starts shown unless `legendVisible: false`, and with `panZoom` on gets a
Key button beside the zoom controls that toggles it and remembers the choice
per diagram id in localStorage.

A node can also set its own `visibleRows` to show some of its `rows` on the
diagram — honoured under `compact`, where nodes otherwise show none — so one
agent can carry a line such as `marks: ok | hostile` without loosening the
whole layout.

A node can carry `badges` — `["59 dead", { label: "31 waiting", tone: "warning" }]` —
drawn as pills hung off its top-right corner, right-aligned in author order,
outside the rect so they cost no height. The tone becomes a
`map-node-badge-<tone>` class (the stylesheet ships `danger`, `warning`, `info`,
`muted`); the popover lists them as chips. Edge labels wear their edge's
`edge-kind-<kind>` and `edge-flavor-<flavor>` classes as well, so a stylesheet
that mutes an arrow can mute its word.

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

## Node selection (click a node, host decides what it means)

Pass `onNodeSelect` and nodes become pickable. Exactly one node is selected at a time; it wears
`diagram-node-selected` and `aria-current="true"`, and the host is told which one. graphpaper
marks the node and nothing else — opening a panel, routing, fetching detail is the host's job.

```js
await hydrateDiagram(el, model, {
  panZoom: true,
  onNodeSelect: ({ nodeId, node, previousNodeId, source }) => {
    if (nodeId == null) closePanel();       // Escape, a click on empty canvas, or the node went away
    else openPanel(nodeId, node);
  }
});

selectDiagramNode(el, "action-recall");     // deep link / restore — returns false if not drawn
selectedDiagramNodeId(el);                  // "action-recall"
clearDiagramNodeSelection(el);              // the host closed the panel
```

Gestures: click, or **Enter / Space** on a focused node (nodes already carry `tabindex="0"`, so
the pick is Tab-reachable with no new markup). **Escape** or a click on empty canvas clears. A
drag-to-pan that ends over a node does **not** select. Re-picking the node already selected is a
no-op and does not call back, so a second click can never make a host re-fetch.

Under `drillDown`, selection is the **inner** gesture: Escape and a background click drop a
selection before they pop a scope level (one gesture undoes one thing), and the "dig in" glyph
still drills. A re-render (a scope transition) keeps the selection if that level still draws the
node, and otherwise clears it and calls back with `source: "render"` — a mark is never left on
nothing. Omit `onNodeSelect` and none of this binds: byte-identical markup, no listeners.

## API

- `hydrateDiagram(container, model, options?)` — lay out + render into a DOM element, bind popovers + (opt-in) drill-down nav.
- `layoutDiagram(model, options?)` → `DiagramLayout` — positions + edge paths only.
- `renderDiagramSvg(model, layout, options?)` → SVG markup string (plus the legend when `legend` is set).
- `renderDiagramLegend(options?)` → the colour-key markup on its own.
- `cleanupHydratedDiagram(container)` — tear down listeners/popovers/scope-nav.
- `hideDiagramPopover()` / `hideDiagramPopoverForPageEvent(event)` — popover control.
- `isInformationFlowEdge(edge)` — predicate for flow edges.
- `nodeHasScope(node, options?)` — predicate: does the node have a drill-down scope?
- `enablePanZoom(container, options?)` / `disablePanZoom(container)` — pan/zoom control.
- `selectDiagramNode(container, nodeId, options?)` / `clearDiagramNodeSelection(container, options?)` / `selectedDiagramNodeId(container)` — node-selection control.
- `bindDiagramInteractions(container, model, options)` — click/keyboard binding for a host-rendered SVG.
- `diagramLifecycle(model)` — normalize the lifecycle declaration (or null).
- `diagramStages(model)` / `stageVisibilityForDiagram(model)` — staged-diagram helpers.

See `index.d.ts` for the full `DiagramModel` / `DiagramRenderOptions` types.

## Development

Use Node.js 22.22.0 and npm 10.9.4:

```bash
npm ci
npm run verify
```

The release gate runs the complete test suite, audits the npm payload, packs
the package, installs that tarball into a fresh temporary consumer, and imports
the public API.

## Styling

Import the shipped stylesheet so the visuals travel with the package:

```js
import "@scshafe/graphpaper/diagram.css";
```

It's self-contained (sensible dark defaults) and themeable via CSS custom
properties — `--gp-blue`, `--gp-muted`, `--gp-text`, `--gp-line`, `--gp-radius`,
`--gp-halo` (edge-label backdrop) and `--gp-panel` (pan/zoom buttons and legend
backdrop); legacy `--blue`/`--muted`/`--text`/`--line`/`--radius` are also honored.
