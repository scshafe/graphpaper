// Packed-install TypeScript smoke: typechecked in the consumer against the
// shipped index.d.ts (scripts/check-pack-install.mjs).
import {
  hydrateDiagram,
  layoutDiagram,
  renderDiagramSvg,
  selectDiagramNode,
  type DiagramLayout,
  type DiagramModel,
  type DiagramModelInput,
  type DiagramRenderOptions,
  type PanZoomOptions
} from "@scshafe/graphpaper";

const model: DiagramModel = {
  id: "types",
  title: "Types",
  nodes: [{ id: "a", title: "A" }],
  edges: []
};
// 0.5.x: an interface-typed DiagramModel lacks DiagramModelInput's index
// signature (a known index.d.ts gap), so the smoke passes a literal.
const input: DiagramModelInput = { id: model.id, title: model.title, nodes: model.nodes, edges: model.edges };
const options: DiagramRenderOptions = { direction: "DOWN" };
const layout: Promise<DiagramLayout> = layoutDiagram(input, options);
const render: (m: DiagramModelInput, l: DiagramLayout) => string = renderDiagramSvg;
const hydrate: (c: Element, m: DiagramModelInput) => Promise<void> = hydrateDiagram;
const panZoom = undefined as unknown as PanZoomOptions;
// @ts-expect-error renderDiagramSvg needs a layout
renderDiagramSvg(model);
// @ts-expect-error a node id is a string
selectDiagramNode(null, 1);
void layout;
void render;
void hydrate;
void panZoom;
