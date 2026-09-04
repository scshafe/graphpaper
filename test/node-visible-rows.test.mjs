// Per-node visible rows.
//
// Contract under test:
//   - `compact` nodes show no rows by default; a node with its own `visibleRows` shows that many
//     (capped at 3 for component nodes) and grows by the row height, others stay as they were.
//   - Outside compact, a node's `visibleRows` overrides the render option both ways (more or fewer).
//   - Table nodes honour the per-node limit too.

import test from "node:test";
import assert from "node:assert/strict";
import { layoutDiagram, renderDiagramSvg } from "../src/index.js";

const rows = [{ label: "marks", value: "ok | hostile" }, { label: "step", value: "2" }, { label: "ref", value: "security.scan@2" }, { label: "extra", value: "4" }];
const model = {
  id: "rows-test",
  title: "Rows",
  nodes: [
    { id: "quiet", title: "Quiet", type: "code", rows },
    { id: "one", title: "One line", type: "code", rows, visibleRows: 1 },
    { id: "many", title: "Many", type: "code", rows, visibleRows: 9 },
    { id: "table", title: "T", type: "table", rows, visibleRows: 1 }
  ],
  edges: []
};

test("a compact node shows only the rows it asks for", async () => {
  const layout = await layoutDiagram(model, { compact: true, stereotypes: false });
  assert.equal(layout.positions.get("quiet").height, 60, "compact + no band: the floor");
  assert.equal(layout.positions.get("one").height, 61, "one row: base 46 + 15");
  assert.equal(layout.positions.get("many").height, 91, "component nodes cap at 3 rows: 46 + 45");
  const svg = renderDiagramSvg(model, layout, { compact: true, stereotypes: false });
  const rowsOf = (id) => (svg.match(new RegExp(`data-diagram-node="${id}"[\\s\\S]*?</g>`, "u"))?.[0] ?? "").match(/component-node-row/g) ?? [];
  assert.equal(rowsOf("quiet").length, 0);
  assert.equal(rowsOf("one").length, 1);
  assert.equal(rowsOf("many").length, 3);
  assert.match(svg, /<text class="diagram-node-row component-node-row" x="12" y="52">marks: ok \| hostile<\/text>/, "the row sits under the subtitle with the band off");
});

test("outside compact a node's visibleRows overrides the render option, and tables honour it", async () => {
  const fewer = await layoutDiagram({ ...model, nodes: [{ id: "none", title: "None", type: "code", rows, visibleRows: 0 }] }, { visibleRows: 3 });
  assert.equal(fewer.positions.get("none").height, 86, "no rows → the floor");
  const layout = await layoutDiagram(model, { visibleRows: 0 });
  assert.equal(layout.positions.get("quiet").height, 86);
  assert.equal(layout.positions.get("one").height, 86 + 15);
  const svg = renderDiagramSvg(model, layout, { visibleRows: 0 });
  assert.equal((svg.match(/schema-column-line/g) ?? []).length, 1, "the table shows one row");
  assert.match(svg, /\+ 3 more rows/);
});
