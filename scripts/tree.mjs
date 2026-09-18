#!/usr/bin/env node
// Build data/tree/index.html — the shape of the sweep that emptied the
// directory, drawn as a zoomable sunburst.
//
//   node scripts/tree.mjs && open data/tree/index.html
//
// enumerate.mjs could only ask the directory for names, and the server only
// ever answered with the first hundred matches. So it asked for `a`, got a
// hundred rows back, knew that meant "there are more", and asked again for
// `aa`, `ab`, `ac` … until every branch came back short enough to be complete.
// The queries table is the record of that: one row per question asked, keyed by
// the letters and holding how many rows came back.
//
// That table is a tree. A query is a node, its children are the same letters
// plus one more, and a node has children exactly when it came back pegged at
// the cap. Drawing it shows the thing the numbers alone do not: the search
// spent most of its life proving that nothing was there.
//
// Everything is inlined, so the built folder drops onto any static host. It
// carries no names — only letters, counts, and the shape they made.

import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const DB_PATH = flag("db", "data/directory.db");
const OUT = flag("out", "data/tree/index.html");

// ─── read the crawl ────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const queries = db.prepare("SELECT last, first, count FROM queries").all();
const people = db.prepare("SELECT COUNT(*) n FROM people").get().n;

// The crawl's own answers stop at the cap, so a busy branch only ever said
// "100". The sweep finished, though, which means the people table holds
// everyone, and an exact count is a matter of asking it instead. Tally every
// distinct substring of every name once per person and the whole tree's worth
// of counts falls out in one pass.
const DEPTH_LIMIT = 8;

function tally(column) {
  const counts = new Map();
  const rows = db
    .prepare(`SELECT ${column} v FROM people WHERE COALESCE(${column}, '') <> ''`)
    .all();
  for (const { v } of rows) {
    const name = String(v).toLowerCase();
    // A name carrying the same run twice is still just one person.
    const seen = new Set();
    for (let i = 0; i < name.length; i++) {
      for (let len = 1; len <= DEPTH_LIMIT && i + len <= name.length; len++) {
        seen.add(name.slice(i, i + len));
      }
    }
    for (const sub of seen) counts.set(sub, (counts.get(sub) ?? 0) + 1);
  }
  return counts;
}

const EXACT = { last: tally("LastName"), first: tally("FirstName") };
db.close();

if (!queries.length) {
  console.error("no queries in the db — run scripts/enumerate.mjs first");
  process.exit(1);
}

const cap = Math.max(...queries.map((q) => q.count));
// The sweep ran each axis on its own: one pass constraining the last name, one
// constraining the first. They are separate trees over the same population, so
// they get separate drawings rather than a fused one that implies a join that
// never happened.
const axis = (rows, keyOf, exact) => {
  // `prefix:rows:people`, one per line. Shorter than JSON by enough to matter
  // at seventeen thousand nodes, and the browser splits it back apart in one
  // pass. `rows` is what the crawl saw, capped at the cap; `people` is true.
  return rows
    .filter((r) => keyOf(r) !== "")
    .map((r) => `${keyOf(r)}:${r.count}:${exact.get(keyOf(r)) ?? 0}`)
    .sort()
    .join("\n");
};

const DATA = {
  last: axis(queries.filter((r) => r.first === ""), (r) => r.last, EXACT.last),
  first: axis(queries.filter((r) => r.last === ""), (r) => r.first, EXACT.first),
};

// ─── page ──────────────────────────────────────────────────────────────────

const n = (x) => x.toLocaleString("en-US");
const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Name lookup tree</title>
<style>
  :root {
    --bg: #14110f;
    --line: #2e2724;
    --ink: #ece4dc;
    --dim: #8b7f76;
    --faint: #5c534d;
    --accent: oklch(0.78 0.13 3);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.25rem 2rem 3rem;
    background: var(--bg); color: var(--ink);
    font: 400 16px/1.5 "Iowan Old Style", "Charter", "Hoefler Text", Georgia, serif;
  }
  /* One column, one picture. Everything else is a caption for it. */
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { margin: 0 0 .9rem; font-size: 1.55rem; font-weight: 400; letter-spacing: -0.01em; }

  /* The one row of chrome above the chart: where you are, and which tree. */
  .bar {
    display: flex; align-items: center; gap: .6rem; min-height: 1.9rem;
    padding-bottom: .7rem; border-bottom: 1px solid var(--line);
    font-family: "SF Mono", Menlo, monospace; font-size: .78rem;
  }
  .bar button {
    background: none; border: 0; padding: .15rem .2rem; cursor: pointer;
    color: var(--dim); font: inherit;
  }
  .bar button:hover { color: var(--accent); }
  #crumbs button:last-child { color: var(--ink); cursor: default; }
  #crumbs { display: flex; align-items: center; gap: .3rem; }
  #crumbs s { color: var(--faint); text-decoration: none; }
  .toggle { margin-left: auto; display: flex; gap: .35rem; }
  .toggle button {
    border: 1px solid var(--line); border-radius: 3px; padding: .25rem .55rem;
    font-size: .72rem; transition: color .12s, border-color .12s;
  }
  .toggle button[aria-pressed="true"] { color: var(--ink); border-color: var(--accent); }

  .stage { position: relative; }
  /* Sized in script so the backing store and the box always agree; a canvas
     stretched by CSS draws the circle as an ellipse. */
  canvas { display: block; margin: .6rem auto 0; cursor: default; }
  canvas.zoomable { cursor: pointer; }

  /* Rides with the cursor, so it never covers the arc you are pointing at. */
  .tip {
    position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: #0d0b0a; border: 1px solid var(--line); border-radius: 3px;
    padding: .45rem .6rem; white-space: nowrap;
    font-family: "SF Mono", Menlo, monospace; font-size: .74rem; line-height: 1.5;
  }
  .tip.on { opacity: 1; }
  .tip h3 { margin: 0; font: inherit; font-size: .8rem; color: var(--ink); }
  .tip div { color: var(--dim); }
  .tip p { margin: 0; color: var(--accent); }

  /* The legend and the tally share one line under the chart, because they are
     both answering "what am I looking at" and two rows would make that a
     search. */
  .foot {
    display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.1rem;
    margin-top: .8rem; padding-top: .8rem; border-top: 1px solid var(--line);
    font-family: "SF Mono", Menlo, monospace; font-size: .72rem; color: var(--faint);
  }
  .foot .k { display: flex; align-items: center; gap: .4rem; }
  .foot i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .foot #ramp { width: 34px; }
  #tally { margin-left: auto; color: var(--dim); }
</style>

<div class="wrap">
  <h1>Name lookup tree</h1>

  <div class="bar">
    <div id="crumbs"></div>
    <div class="toggle">
      <button id="ax-last" aria-pressed="true">last name</button>
      <button id="ax-first" aria-pressed="false">first name</button>
    </div>
  </div>

  <div class="stage">
    <canvas id="chart"></canvas>
    <div class="tip" id="tip"></div>
  </div>

  <div class="foot">
    <span class="k"><i id="ramp"></i>1&ndash;${cap - 1} rows</span>
    <span class="k"><i id="pegged-swatch"></i>pegged, split again</span>
    <span id="tally"></span>
  </div>
</div>

<script>
const DATA = ${JSON.stringify(DATA)};
const CAP = ${cap};
const PEOPLE = ${people};
const RINGS = 5; // levels drawn below whatever you have zoomed to

// ─── tree ──────────────────────────────────────────────────────────────────

// Rebuild the tree from the prefix:count lines. Sorting by length first means a
// node's parent is always already in the map by the time we need it.
function build(text) {
  const root = { p: "", c: -1, kids: [], depth: 0, parent: null, empty: 0 };
  const map = new Map([["", root]]);
  const rows = text.split("\\n").map((line) => {
    const [p, c, exact] = line.split(":");
    return [p, +c, +exact];
  });
  rows.sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1));

  for (const [p, c, exact] of rows) {
    const parent = map.get(p.slice(0, -1));
    if (!parent) continue;
    // An empty answer is a fact about its parent, not a branch of its own: it
    // was asked, it found nobody, and nothing was ever asked below it. Ten
    // thousand of them drawn as hairlines bury the seven thousand that found
    // someone, so they are tallied on the parent and left off the chart.
    if (c === 0) {
      parent.empty++;
      continue;
    }
    const node = { p, c, people: exact, kids: [], depth: p.length, parent, empty: 0 };
    parent.kids.push(node);
    map.set(p, node);
  }
  measure(root);
  return root;
}

// Leaves carry the weight, so a node's slice of the circle is the number of
// questions that ended underneath it. People are counted at leaves only: a
// pegged parent's rows are all re-found by its children, so adding both would
// count them twice.
function measure(node) {
  const leaf = node.kids.length === 0;
  node.leaves = leaf ? 1 : 0;
  // Counts stay true to the crawl even though the empties are off the chart.
  node.asked = (node.c >= 0 ? 1 : 0) + node.empty;
  node.dead = node.empty;
  // node.people is counted straight off the finished people table, so nothing
  // needs rolling up. Summing the children would be wrong anyway: the search
  // matches anywhere in a name, so anyone whose name simply ends here is
  // counted here and by none of them — 98 of the 99 people containing "erson"
  // end there, and the leaves below it add to one.
  node.deepest = node.depth;
  for (const k of node.kids) {
    measure(k);
    node.leaves += k.leaves;
    node.asked += k.asked;
    node.dead += k.dead;
    node.deepest = Math.max(node.deepest, k.deepest);
  }
}

function layout(node, a0, a1) {
  node.a0 = a0;
  node.a1 = a1;
  let a = a0;
  for (const k of node.kids) {
    const w = ((a1 - a0) * k.leaves) / node.leaves;
    layout(k, a, a + w);
    a += w;
  }
}

const TREES = { last: build(DATA.last), first: build(DATA.first) };
for (const t of Object.values(TREES)) layout(t, -Math.PI / 2, Math.PI * 1.5);

// ─── colour ────────────────────────────────────────────────────────────────

// Three states, because the crawl only ever cared about three. Nothing found
// stays near the page background, so dead ends read as absence rather than as
// data. A harvest climbs plum to coral, square-rooted: two thirds of the
// non-empty queries came back in single digits, and on a linear ramp that whole
// crowd collapses into the same near-black and the picture claims the search
// found less than it did. Pegged gets its own pale cream rather than the top of
// the ramp, because it does not mean "the most rows" — it means the answer was
// cut off and nobody knows what was behind it.
const PEGGED_INK = "oklch(0.91 0.075 45)";

function ink(c) {
  if (c <= 0) return "#241f1d";
  if (c >= CAP) return PEGGED_INK;
  const t = Math.sqrt(c / CAP);
  const l = 0.36 + 0.42 * t;
  const ch = 0.06 + 0.10 * t;
  const h = (330 + 55 * t) % 360;
  return \`oklch(\${l.toFixed(3)} \${ch.toFixed(3)} \${h.toFixed(1)})\`;
}

document.getElementById("ramp").style.background =
  "linear-gradient(90deg," +
  Array.from({ length: 24 }, (_, i) => ink(Math.round((i / 23) * (CAP - 1)))).join(",") +
  ")";
document.getElementById("pegged-swatch").style.background = PEGGED_INK;

// ─── drawing ───────────────────────────────────────────────────────────────

const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const tip = document.getElementById("tip");
const crumbs = document.getElementById("crumbs");

let axis = "last";
let focus = TREES.last;
let size = 0;
let hot = null; // node under the cursor
let bands = []; // per drawn ring, arcs sorted by angle, for hit testing

function fit() {
  // Bounded by the window as well as the column, with room left for the line
  // of chrome above and the legend below: a mandala you have to scroll to see
  // the other half of is not a mandala, and a colour you have to scroll to
  // look up is not a legend.
  const w = canvas.parentElement.clientWidth;
  size = Math.max(320, Math.min(w, 1000, window.innerHeight - 200));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + "px";
  canvas.style.height = size + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function draw() {
  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2 - 4;
  const hub = Math.max(26, outer * 0.13);
  const band = (outer - hub) / RINGS;
  const base = focus.depth;

  ctx.clearRect(0, 0, size, size);
  bands = [];

  // The focused node always spans the full circle, so zooming is just a
  // rescale of angles rather than a different layout.
  const scale = (Math.PI * 2) / (focus.a1 - focus.a0);
  const at = (a) => (a - focus.a0) * scale - Math.PI / 2;

  (function walk(node) {
    const ring = node.depth - base;
    if (ring > RINGS) return;
    if (ring > 0) {
      const r0 = hub + (ring - 1) * band;
      const r1 = r0 + band;
      const a0 = at(node.a0);
      const a1 = at(node.a1);
      const wedge = a1 - a0;

      ctx.beginPath();
      ctx.arc(cx, cy, r1, a0, a1);
      ctx.arc(cx, cy, r0, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = node === hot ? "#fff" : ink(node.c);
      ctx.fill();
      // Below about half a degree the gap costs more than the arc it separates,
      // so thin rings are left to merge into a band of texture.
      if (wedge > 0.009) {
        ctx.strokeStyle = "#14110f";
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }

      (bands[ring] ??= []).push({ node, a0, a1, r0, r1 });

      if (wedge > 0.12) label(node, cx, cy, (r0 + r1) / 2, (a0 + a1) / 2, wedge, band);
    }
    for (const k of node.kids) walk(k);
  })(focus);

  // The hub names what you are looking at and doubles as the way back up.
  ctx.beginPath();
  ctx.arc(cx, cy, hub - 3, 0, Math.PI * 2);
  ctx.fillStyle = "#1d1917";
  ctx.fill();
  ctx.strokeStyle = focus.parent ? "oklch(0.78 0.13 3)" : "#2e2724";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#ece4dc";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = '400 15px "SF Mono", Menlo, monospace';
  ctx.fillText(focus.p || "∅", cx, cy - 6);
  ctx.fillStyle = "#5c534d";
  ctx.font = '400 10px "SF Mono", Menlo, monospace';
  ctx.fillText(focus.parent ? "↑ back" : "all", cx, cy + 9);
}

// Letters read along the arc when there is room to turn them, and flip on the
// bottom half so none of them end up upside down.
function label(node, cx, cy, r, a, wedge, band) {
  const ch = node.p.slice(-1);
  const flip = a > 0 && a < Math.PI;
  ctx.save();
  ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  ctx.rotate(a + (flip ? -Math.PI / 2 : Math.PI / 2));
  ctx.fillStyle = node.c > CAP * 0.3 ? "#14110f" : "#8b7f76";
  ctx.font = \`400 \${Math.min(13, band * 0.45).toFixed(0)}px "SF Mono", Menlo, monospace\`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(ch, 0, 0);
  ctx.restore();
}

// ─── pointer ───────────────────────────────────────────────────────────────

function hit(x, y) {
  const cx = size / 2;
  const cy = size / 2;
  const r = Math.hypot(x - cx, y - cy);
  let a = Math.atan2(y - cy, x - cx);
  if (a < -Math.PI / 2) a += Math.PI * 2; // the seam sits at twelve o'clock
  for (const ring of bands) {
    if (!ring || r < ring[0].r0 || r > ring[0].r1) continue;
    let lo = 0;
    let hi = ring.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a < ring[mid].a0) hi = mid - 1;
      else if (a > ring[mid].a1) lo = mid + 1;
      else return ring[mid].node;
    }
  }
  return null;
}

const nfmt = (x) => x.toLocaleString("en-US");

// Two facts: how many people are down this branch, and whether the crawl was
// able to finish counting them.
function show(node, x, y) {
  tip.innerHTML =
    \`<h3>\${node.p}</h3>\` +
    \`<div>\${nfmt(node.people)} people</div>\` +
    (node.c >= CAP && !node.kids.length ? "<p>names end here</p>" : "");
  tip.classList.add("on");

  // Coordinates arrive relative to the canvas, which is centred inside the
  // stage the tip is positioned against.
  const stage = canvas.parentElement.clientWidth;
  const left = canvas.offsetLeft + x + 16;
  tip.style.left = Math.max(0, Math.min(left, stage - tip.offsetWidth)) + "px";
  tip.style.top = Math.max(canvas.offsetTop + y - tip.offsetHeight - 12, 0) + "px";
}

canvas.addEventListener("pointermove", (e) => {
  const box = canvas.getBoundingClientRect();
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  const node = hit(x, y);
  if (node !== hot) {
    hot = node;
    draw();
  }
  canvas.classList.toggle("zoomable", !!(node && node.kids.length));
  if (node) show(node, x, y);
  else tip.classList.remove("on");
});

canvas.addEventListener("pointerleave", () => {
  hot = null;
  tip.classList.remove("on");
  draw();
});

// Clicking the hub goes back up; clicking anything with a subtree goes down.
canvas.addEventListener("click", (e) => {
  const box = canvas.getBoundingClientRect();
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  const hub = Math.max(26, (size / 2 - 4) * 0.13);
  if (Math.hypot(x - size / 2, y - size / 2) < hub) {
    if (focus.parent) go(focus.parent);
    return;
  }
  const node = hit(x, y);
  if (node && node.kids.length) go(node);
});

function go(node) {
  focus = node;
  hot = null;
  tip.classList.remove("on");
  paintCrumbs();
  draw();
}

// ─── chrome ────────────────────────────────────────────────────────────────

function paintCrumbs() {
  const trail = [];
  for (let n = focus; n; n = n.parent) trail.unshift(n);
  crumbs.innerHTML = "";
  trail.forEach((node, i) => {
    if (i) crumbs.insertAdjacentHTML("beforeend", "<s>›</s>");
    const b = document.createElement("button");
    b.textContent = node.p || (axis === "last" ? "last name" : "first name");
    if (i < trail.length - 1) b.addEventListener("click", () => go(node));
    crumbs.append(b);
  });
}

// The whole sidebar boiled down to the four numbers that actually differ
// between the two trees.
function paintAxis() {
  const root = TREES[axis];
  let splits = 0;
  (function walk(n) {
    if (n.c >= CAP && (n.kids.length || n.empty)) splits++;
    n.kids.forEach(walk);
  })(root);

  document.getElementById("tally").textContent = [
    \`\${nfmt(PEOPLE)} people\`,
    \`\${nfmt(root.asked)} questions\`,
    \`\${splits} splits\`,
    \`\${Math.round((root.dead / root.asked) * 100)}% empty\`,
    \`\${root.deepest} letters\`,
  ].join("  ·  ");
}

for (const which of ["last", "first"]) {
  document.getElementById("ax-" + which).addEventListener("click", () => {
    axis = which;
    for (const other of ["last", "first"]) {
      document
        .getElementById("ax-" + other)
        .setAttribute("aria-pressed", String(other === which));
    }
    focus = TREES[which];
    paintAxis();
    paintCrumbs();
    draw();
  });
}

paintAxis();
paintCrumbs();
fit();
addEventListener("resize", fit);
</script>
`;

mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
writeFileSync(OUT, html);

const dead = queries.filter((q) => q.count === 0).length;
const say = (l, v) => console.error(`  \x1b[2m${l.padEnd(16)}\x1b[0m \x1b[1m${v}\x1b[0m`);
console.error("");
say("wrote", OUT);
say("nodes", n(queries.length));
say("dead ends", `${n(dead)} · ${Math.round((dead / queries.length) * 100)}%`);
say("cap", String(cap));
say("size", `${Math.round(html.length / 1024)} KB`);
console.error("");
