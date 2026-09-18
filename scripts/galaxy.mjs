#!/usr/bin/env node
// Build data/galaxy/index.html — every surname in the directory as a point,
// linked to the names it is spelled like.
//
//   node scripts/galaxy.mjs && open data/galaxy/index.html
//
// Each name becomes a vector of its letter triples, weighted so that a shared
// rare run ("zyl") counts for far more than a shared common one ("son"). Every
// name is then linked to its eight nearest, which finds real families without
// being told any: Anderson sits with Sanderson, Henderson and Gunderson; Zhang
// with Zhao, Zheng and Zhong; Rodriguez with all its hyphenated relatives.
//
// The drawing is the graph, not an embedding. Three dimensions cannot hold
// this structure faithfully — a name has neighbours in several independent
// directions at once (its prefix family, its suffix family, its length), and
// measured against the eight-nearest objective the best 3D layout still leaves
// neighbours at 0.36 of a random pair's distance where the packing floor is
// 0.12. So the edges are drawn rather than implied, and position is only a
// device for keeping linked names near each other.
//
// This page carries real names, unlike the lookup tree. data/ is gitignored.

import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const DB_PATH = flag("db", "data/directory.db");
const OUT = flag("out", "data/galaxy/index.html");
const FIELD = flag("field", "LastName");
const K = Number(flag("k", 8));

// ─── names ─────────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const names = db
  .prepare(
    `SELECT ${FIELD} v, COUNT(*) n FROM people
     WHERE COALESCE(${FIELD}, '') <> '' GROUP BY ${FIELD} ORDER BY ${FIELD}`,
  )
  .all();
db.close();

const N = names.length;
if (!N) {
  console.error("no names in the db — run scripts/enumerate.mjs first");
  process.exit(1);
}

// ─── letter triples ────────────────────────────────────────────────────────

// The ^ and $ make a name's opening and closing runs their own features, so
// "Smith" and "Goldsmith" are related without being treated as the same word.
const df = new Map();
const grams = names.map(({ v }) => {
  const s = `^${v.toLowerCase().replace(/[^a-z]/g, "")}$`;
  const g = new Set();
  for (let i = 0; i + 3 <= s.length; i++) g.add(s.slice(i, i + 3));
  for (const t of g) df.set(t, (df.get(t) ?? 0) + 1);
  return [...g];
});

// Inverse document frequency, then unit length, so similarity is a cosine and
// a long name is not automatically more similar to everything.
const vecs = grams.map((g) => {
  const m = new Map();
  let norm = 0;
  for (const t of g) {
    const w = Math.log(N / df.get(t));
    m.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of m) m.set(t, w / norm);
  return m;
});

// ─── nearest names ─────────────────────────────────────────────────────────

// Only names sharing at least one triple can be neighbours, so the inverted
// index turns 17 million pairs into roughly 290 candidates each.
const posting = new Map();
grams.forEach((g, i) => {
  for (const t of g) {
    let list = posting.get(t);
    if (!list) posting.set(t, (list = []));
    list.push(i);
  }
});

const neighbours = [];
const edges = [];
const edgeWeight = [];
const seenEdge = new Set();
for (let i = 0; i < N; i++) {
  const acc = new Map();
  for (const t of grams[i]) {
    const wi = vecs[i].get(t);
    for (const j of posting.get(t)) {
      if (j !== i) acc.set(j, (acc.get(j) ?? 0) + wi * vecs[j].get(t));
    }
  }
  const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, K);
  neighbours.push(top.map(([j]) => j));
  for (const [j, sim] of top) {
    const key = i < j ? i * N + j : j * N + i;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push(i, j);
    edgeWeight.push(sim);
  }
}

// ─── layout ────────────────────────────────────────────────────────────────

// Linked names pull together in proportion to how alike they are; every name
// pushes off a handful of random others each pass, which is enough to keep the
// whole cloud from collapsing without computing all 17 million repulsions.
const ATT = 1.0;
const REP = 0.002;
const EPOCHS = 800;
const NEG = 3;

const P = new Float32Array(N * 3);
// A small starting cloud lets the pulling organise things before the pushing
// spreads them out; from a wide one the graph never gets a chance to fold up.
for (let i = 0; i < N * 3; i++) P[i] = (Math.random() - 0.5) * 0.2;

const started = Date.now();
for (let e = 0; e < EPOCHS; e++) {
  const alpha = 1 - e / EPOCHS;
  for (let k = 0; k < edgeWeight.length; k++) {
    const a = edges[k * 2] * 3;
    const b = edges[k * 2 + 1] * 3;
    const dx = P[b] - P[a];
    const dy = P[b + 1] - P[a + 1];
    const dz = P[b + 2] - P[a + 2];
    const c = alpha * ATT * edgeWeight[k] * 0.5;
    P[a] += c * dx;
    P[a + 1] += c * dy;
    P[a + 2] += c * dz;
    P[b] -= c * dx;
    P[b + 1] -= c * dy;
    P[b + 2] -= c * dz;
  }
  for (let i = 0; i < N; i++) {
    const a = i * 3;
    for (let s = 0; s < NEG; s++) {
      const b = ((Math.random() * N) | 0) * 3;
      const dx = P[b] - P[a];
      const dy = P[b + 1] - P[a + 1];
      const dz = P[b + 2] - P[a + 2];
      const d2 = dx * dx + dy * dy + dz * dz + 0.001;
      // Clamped so a pair that lands almost on top of each other cannot fling
      // itself across the scene in one step.
      const c = Math.min((alpha * REP) / d2, 0.5);
      P[a] -= c * dx;
      P[a + 1] -= c * dy;
      P[a + 2] -= c * dz;
    }
  }
}
const layoutMs = Date.now() - started;

// Centre and scale to a unit-ish ball so the camera needs no tuning.
const centre = [0, 1, 2].map((d) => {
  let s = 0;
  for (let i = 0; i < N; i++) s += P[i * 3 + d];
  return s / N;
});
const radii = new Float64Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let d = 0; d < 3; d++) {
    P[i * 3 + d] -= centre[d];
    r += P[i * 3 + d] ** 2;
  }
  radii[i] = Math.sqrt(r);
}

// A name with no neighbour at all has nothing pulling it in, so repulsion
// alone throws it to the far edge. Scaling by the furthest point would then
// squash everyone else into a speck — here the two strays sit at radius 1.0
// while 99% of names are inside 0.08. So scale by the 99th percentile and reel
// the strays back to the rim instead.
const sorted = Float64Array.from(radii).sort();
const scale = sorted[Math.floor(0.99 * (N - 1))] || 1;
const RIM = 1.3;
for (let i = 0; i < N; i++) {
  const r = radii[i] / scale;
  const k = (r > RIM ? RIM / r : 1) / scale;
  for (let d = 0; d < 3; d++) P[i * 3 + d] *= k;
}
const strays = radii.filter((r) => r / scale > RIM).length;

// ─── quality, measured ─────────────────────────────────────────────────────

const dist = (i, j) =>
  Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]);
let near = 0;
let far = 0;
let pairs = 0;
for (let i = 0; i < N; i++) {
  for (const j of neighbours[i]) {
    near += dist(i, j);
    pairs++;
  }
  for (let s = 0; s < K; s++) far += dist(i, (Math.random() * N) | 0);
}
const ratio = near / far;

// ─── page ──────────────────────────────────────────────────────────────────

const round = (x) => Math.round(x * 1000) / 1000;
const bearers = names.map((r) => r.n);
const maxBearers = Math.max(...bearers);

const DATA = {
  names: names.map((r) => r.v),
  bearers,
  pos: Array.from(P, round),
  edges: Array.from(edges),
  nbr: neighbours,
};

const n = (x) => x.toLocaleString("en-US");
const people = bearers.reduce((a, b) => a + b, 0);

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Name galaxy</title>
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
  html, body { height: 100%; }
  body {
    margin: 0; overflow: hidden;
    background: var(--bg); color: var(--ink);
    font: 400 16px/1.5 "Iowan Old Style", "Charter", "Hoefler Text", Georgia, serif;
  }
  /* The scene is the page. Everything else floats over it. */
  #scene, #labels { position: fixed; inset: 0; width: 100vw; height: 100vh; margin: 0; }
  #scene { cursor: grab; touch-action: none; }
  #scene.dragging { cursor: grabbing; }
  #labels { pointer-events: none; }

  /* Scrims rather than bars: the cloud runs under the text and fades out, so
     the chrome reads without cutting the picture into boxes. */
  .chrome {
    position: fixed; left: 0; right: 0; z-index: 2;
    display: flex; flex-wrap: wrap; align-items: baseline; gap: .6rem 1.1rem;
    padding: 1.4rem 1.8rem;
    font-family: "SF Mono", Menlo, monospace; font-size: .75rem; color: var(--faint);
  }
  .chrome > * { pointer-events: auto; }
  .top {
    top: 0;
    background: linear-gradient(#14110f 12%, rgba(20,17,15,0.72) 55%, rgba(20,17,15,0));
  }
  .bottom {
    bottom: 0;
    background: linear-gradient(to top, #14110f 12%, rgba(20,17,15,0.72) 55%, rgba(20,17,15,0));
  }
  h1 {
    margin: 0; font-size: 1.4rem; font-weight: 400; letter-spacing: -0.01em;
    color: var(--ink); font-family: "Iowan Old Style", "Charter", Georgia, serif;
  }
  #status { color: var(--dim); }
  .chrome button {
    background: none; border: 1px solid var(--line); border-radius: 3px;
    padding: .25rem .55rem; color: var(--dim); cursor: pointer; font: inherit;
  }
  .chrome button:hover { color: var(--ink); }
  .chrome button[aria-pressed="true"] { color: var(--ink); border-color: var(--accent); }
  #find {
    margin-left: auto; width: 11rem;
    background: rgba(20,17,15,0.6); border: 1px solid var(--line); border-radius: 3px;
    color: var(--ink); padding: .25rem .5rem; font: inherit;
  }
  #find::placeholder { color: var(--faint); }
  #find:focus { outline: none; border-color: var(--accent); }
  #tally { margin-left: auto; color: var(--dim); }

  .tip {
    position: fixed; z-index: 3; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: #0d0b0a; border: 1px solid var(--line); border-radius: 3px;
    padding: .45rem .6rem; white-space: nowrap;
    font-family: "SF Mono", Menlo, monospace; font-size: .74rem; line-height: 1.5;
  }
  .tip.on { opacity: 1; }
  .tip h3 { margin: 0; font: inherit; font-size: .8rem; color: var(--ink); }
  .tip div { color: var(--dim); }
  .tip p { margin: .2rem 0 0; color: var(--faint); }
</style>

<canvas id="scene"></canvas>
<canvas id="labels"></canvas>

<header class="chrome top">
  <h1>Name galaxy</h1>
  <span id="status">drag to turn &middot; scroll to zoom</span>
  <button id="toggle-edges" aria-pressed="true">links</button>
  <input id="find" placeholder="find a name" autocomplete="off" spellcheck="false">
</header>

<footer class="chrome bottom">
  <span>dot size = people sharing the name</span>
  <span>colour = where it sits</span>
  <span id="tally">${n(N)} names &middot; ${n(people)} people &middot; ${n(
    edges.length / 2,
  )} links &middot; ${K} nearest each</span>
</footer>

<div class="tip" id="tip"></div>

<script>
const DATA = ${JSON.stringify(DATA)};
const MAX_BEARERS = ${maxBearers};
const NAMES = DATA.names;
const POS = new Float32Array(DATA.pos);
const EDGES = new Uint16Array(DATA.edges);
const BEARERS = DATA.bearers;
const NBR = DATA.nbr;
const N = NAMES.length;

const scene = document.getElementById("scene");
const labels = document.getElementById("labels");
const lctx = labels.getContext("2d");
const tip = document.getElementById("tip");
const status = document.getElementById("status");
const gl = scene.getContext("webgl", { antialias: true, alpha: false });

// ─── colour ────────────────────────────────────────────────────────────────

// Position is the only thing colour encodes, which is the honest choice: the
// layout already groups a family together, so letting the family pick up its
// own hue makes it legible without claiming a second measurement.
const COL = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  const x = POS[i * 3], y = POS[i * 3 + 1], z = POS[i * 3 + 2];
  // A full spectrum turns the cloud into a generic rainbow and fights the
  // lookup tree's palette, so the wheel is folded into the same plum-to-amber
  // arc: enough range to tell one region from another, none of the cyan.
  const around = (Math.atan2(y, x) / Math.PI + 1) / 2;
  const hue = (((285 + 140 * around) % 360) / 360);
  const lift = (z + 1) / 2;
  const [r, g, b] = hsl(hue, 0.38 + 0.14 * lift, 0.42 + 0.26 * lift);
  COL[i * 3] = r; COL[i * 3 + 1] = g; COL[i * 3 + 2] = b;
}
function hsl(h, s, l) {
  const f = (k) => {
    const a = (k + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(a - 3, 9 - a, 1));
  };
  return [f(0), f(8), f(4)];
}

// ─── gl ────────────────────────────────────────────────────────────────────

const program = (vs, fs) => {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
};

const dotProg = program(
  \`attribute vec3 aPos; attribute vec3 aCol; attribute float aSize;
   uniform mat4 uMVP; uniform float uScale; varying vec3 vCol; varying float vDepth;
   void main() {
     vec4 p = uMVP * vec4(aPos, 1.0);
     gl_Position = p;
     gl_PointSize = aSize * uScale / max(p.w, 0.1);
     vCol = aCol; vDepth = p.w;
   }\`,
  \`precision mediump float; varying vec3 vCol; varying float vDepth;
   void main() {
     vec2 d = gl_PointCoord - vec2(0.5);
     float r = dot(d, d);
     if (r > 0.25) discard;
     // soft edge, and the far side of the cloud sits back a little
     float a = smoothstep(0.25, 0.08, r) * clamp(2.2 - vDepth * 0.45, 0.25, 1.0);
     gl_FragColor = vec4(vCol, a);
   }\`,
);

const lineProg = program(
  \`attribute vec3 aPos; attribute vec3 aCol; uniform mat4 uMVP;
   varying vec3 vCol; void main() { gl_Position = uMVP * vec4(aPos, 1.0); vCol = aCol; }\`,
  \`precision mediump float; varying vec3 vCol;
   void main() { gl_FragColor = vec4(vCol, 0.11); }\`,
);

const buffer = (data) => {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return b;
};
const SIZES = new Float32Array(N);
for (let i = 0; i < N; i++) SIZES[i] = 2.2 + 9 * Math.sqrt(BEARERS[i] / MAX_BEARERS);

const posBuf = buffer(POS);
const colBuf = buffer(COL);
const sizeBuf = buffer(SIZES);
const idxBuf = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, EDGES, gl.STATIC_DRAW);

// ─── camera ────────────────────────────────────────────────────────────────

// Far enough back that the whole cloud is framed with air around it. The
// vertical half-angle is 0.5rad, so the visible half-height is zoom*tan(0.5);
// at 3.6 that is 1.97 against a cloud reaching 1.3.
let yaw = 0.6, pitch = 0.3, zoom = 3.6;
let W = 0, H = 0;
let showEdges = true;
let hot = -1;
let pinned = -1;

// Column-major throughout, because that is what WebGL wants handed to it and
// what the projection below is written in. Multiplying these row-major puts
// every point behind the camera.
const mul = (a, b) => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
};
function mvp() {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const rotY = new Float32Array([cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1]);
  const rotX = new Float32Array([1,0,0,0, 0,cp,sp,0, 0,-sp,cp,0, 0,0,0,1]);
  const view = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-zoom,1]);
  const f = 1 / Math.tan(0.5);
  const near = 0.1, far = 50;
  // Vertical field of view is fixed and the horizontal one widens with the
  // window, so the cloud keeps its shape instead of stretching.
  const proj = new Float32Array([
    f / (W / H),0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),-1, 0,0,(2*far*near)/(near-far),0,
  ]);
  return mul(mul(proj, view), mul(rotX, rotY));
}

function fit() {
  W = window.innerWidth;
  H = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of [scene, labels]) {
    c.width = W * dpr;
    c.height = H * dpr;
  }
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gl.viewport(0, 0, scene.width, scene.height);
  draw();
}

function bind(prog, name, buf, n) {
  const loc = gl.getAttribLocation(prog, name);
  if (loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
}

let M = mvp();
function draw() {
  M = mvp();
  gl.clearColor(0.078, 0.067, 0.059, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  if (showEdges) {
    gl.useProgram(lineProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, "uMVP"), false, M);
    bind(lineProg, "aPos", posBuf, 3);
    bind(lineProg, "aCol", colBuf, 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.drawElements(gl.LINES, EDGES.length, gl.UNSIGNED_SHORT, 0);
  }

  gl.useProgram(dotProg);
  gl.uniformMatrix4fv(gl.getUniformLocation(dotProg, "uMVP"), false, M);
  gl.uniform1f(gl.getUniformLocation(dotProg, "uScale"), (H / 700) * 2.2);
  bind(dotProg, "aPos", posBuf, 3);
  bind(dotProg, "aCol", colBuf, 3);
  bind(dotProg, "aSize", sizeBuf, 1);
  gl.drawArrays(gl.POINTS, 0, N);

  paintLabels();
}

// ─── projection, shared by labels and picking ──────────────────────────────

function project(i) {
  const x = POS[i*3], y = POS[i*3+1], z = POS[i*3+2];
  const w = M[3]*x + M[7]*y + M[11]*z + M[15];
  if (w <= 0.01) return null;
  return [
    ((M[0]*x + M[4]*y + M[8]*z + M[12]) / w * 0.5 + 0.5) * W,
    (0.5 - (M[1]*x + M[5]*y + M[9]*z + M[13]) / w * 0.5) * H,
    w,
  ];
}

// The biggest names are always labelled, plus whatever is under the cursor and
// its neighbours. Any more than that and the cloud disappears under text.
const ALWAYS = [...Array(N).keys()].sort((a, b) => BEARERS[b] - BEARERS[a]).slice(0, 26);

function paintLabels() {
  lctx.clearRect(0, 0, W, H);
  lctx.font = '400 11px "SF Mono", Menlo, monospace';
  lctx.textAlign = "center";

  const focus = pinned >= 0 ? pinned : hot;
  const near = new Set(focus >= 0 ? [focus, ...NBR[focus]] : []);

  for (const i of ALWAYS) {
    if (near.has(i)) continue;
    const p = project(i);
    if (!p) continue;
    lctx.fillStyle = "rgba(236,228,220,0.35)";
    lctx.fillText(NAMES[i], p[0], p[1] - 7);
  }
  for (const i of near) {
    const p = project(i);
    if (!p) continue;
    lctx.fillStyle = i === focus ? "#ece4dc" : "rgba(236,228,220,0.75)";
    lctx.font = i === focus
      ? '400 13px "SF Mono", Menlo, monospace'
      : '400 11px "SF Mono", Menlo, monospace';
    lctx.fillText(NAMES[i], p[0], p[1] - 8);
  }
}

function pick(mx, my) {
  let best = -1, bestD = 18 * 18;
  for (let i = 0; i < N; i++) {
    const p = project(i);
    if (!p) continue;
    const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ─── interaction ───────────────────────────────────────────────────────────

let dragging = false, lastX = 0, lastY = 0, moved = 0;

scene.addEventListener("pointerdown", (e) => {
  dragging = true; moved = 0;
  lastX = e.clientX; lastY = e.clientY;
  scene.classList.add("dragging");
  scene.setPointerCapture(e.pointerId);
});

scene.addEventListener("pointermove", (e) => {
  const box = scene.getBoundingClientRect();
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    yaw += dx * 0.006;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * 0.006));
    lastX = e.clientX; lastY = e.clientY;
    draw();
    return;
  }
  const i = pick(e.clientX - box.left, e.clientY - box.top);
  if (i !== hot) { hot = i; draw(); }
  if (i >= 0) showTip(i, e.clientX - box.left, e.clientY - box.top);
  else tip.classList.remove("on");
});

scene.addEventListener("pointerup", (e) => {
  dragging = false;
  scene.classList.remove("dragging");
  // A click that did not really move the camera is a click on a name.
  if (moved < 4) {
    const box = scene.getBoundingClientRect();
    const i = pick(e.clientX - box.left, e.clientY - box.top);
    pinned = i >= 0 && i !== pinned ? i : -1;
    draw();
  }
});

scene.addEventListener("pointerleave", () => {
  hot = -1;
  tip.classList.remove("on");
  draw();
});

scene.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoom = Math.max(0.6, Math.min(12, zoom * (1 + Math.sign(e.deltaY) * 0.12)));
  draw();
}, { passive: false });

function showTip(i, x, y) {
  const kin = NBR[i].slice(0, 4).map((j) => NAMES[j]).join(", ");
  tip.innerHTML =
    \`<h3>\${NAMES[i]}</h3>\` +
    \`<div>\${BEARERS[i]} \${BEARERS[i] === 1 ? "person" : "people"}</div>\` +
    (kin ? \`<p>like \${kin}</p>\` : "");
  tip.classList.add("on");
  tip.style.left = Math.max(8, Math.min(x + 16, W - tip.offsetWidth - 8)) + "px";
  tip.style.top = Math.max(8, y - tip.offsetHeight - 12) + "px";
}

document.getElementById("toggle-edges").addEventListener("click", (e) => {
  showEdges = !showEdges;
  e.currentTarget.setAttribute("aria-pressed", String(showEdges));
  draw();
});

// Typing a name pins it and swings the camera round until it faces you.
const lower = NAMES.map((s) => s.toLowerCase());
document.getElementById("find").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { pinned = -1; status.textContent = "drag to turn · scroll to zoom"; draw(); return; }
  let i = lower.indexOf(q);
  if (i < 0) i = lower.findIndex((s) => s.startsWith(q));
  if (i < 0) i = lower.findIndex((s) => s.includes(q));
  if (i < 0) { status.textContent = "no name like that"; return; }
  pinned = i;
  status.textContent = NAMES[i] + " · " + BEARERS[i] + (BEARERS[i] === 1 ? " person" : " people");
  yaw = -Math.atan2(POS[i*3+2], POS[i*3]) + Math.PI / 2;
  pitch = Math.max(-1.5, Math.min(1.5, Math.asin(Math.max(-1, Math.min(1, POS[i*3+1])))));
  draw();
});

fit();
addEventListener("resize", fit);
</script>
`;

mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
writeFileSync(OUT, html);

const say = (l, v) => console.error(`  \x1b[2m${l.padEnd(16)}\x1b[0m \x1b[1m${v}\x1b[0m`);
console.error("");
say("wrote", OUT);
say("names", n(N));
say("links", n(edges.length / 2));
say("layout", `${layoutMs} ms`);
say("neighbour dist", `${ratio.toFixed(3)} of random`);
say("strays reeled in", String(strays));
say("size", `${Math.round(html.length / 1024)} KB`);
console.error("");
