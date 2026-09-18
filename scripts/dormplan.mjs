#!/usr/bin/env node
// Build data/dorms/index.html — every residential room on campus, drawn as the
// building it sits in.
//
//   node scripts/dormplan.mjs && open data/dorms/index.html
//
// 3,666 people live in 1,903 rooms across 35 halls, and the room label is the
// only floor plan we have. It is not one scheme but four:
//
//   floors     18 halls   "317"      three digits, the first is the storey
//   suites      5 halls   "02A"      a suite number and a room letter, no storey
//   apartment   4 halls   "101-2"    unit and bed, the unit's first digit is the storey
//   mixed       8 halls   small buildings that do as they please
//
// So the drawing follows each hall's own numbering rather than forcing a storey
// on to labels that never carried one. A band is a storey where the label says
// so and the whole building otherwise; inside a band, rooms that share a suite
// are drawn touching.
//
// Colour is the one real measurement: class year, which is what the halls
// actually sort people by. This page carries names on hover. data/ is
// gitignored.

import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { genderOf } from "./dorm-gender.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const DB_PATH = flag("db", "data/directory.db");
const OUT = flag("out", "data/dorms/index.html");

// ─── residents ─────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const residents = db
  .prepare(
    `SELECT DormName dorm, DormRoom room, FirstName first, LastName last,
            COALESCE(NULLIF(StudentClass, ''), '?') cls
     FROM people WHERE COALESCE(DormRoom, '') <> ''
     ORDER BY DormName, DormRoom, LastName`,
  )
  .all();
db.close();

if (!residents.length) {
  console.error("nobody has a room — run scripts/enumerate.mjs first");
  process.exit(1);
}

// ─── reading the room labels ───────────────────────────────────────────────

const halls = new Map();
for (const r of residents) {
  if (!halls.has(r.dorm)) halls.set(r.dorm, new Map());
  const rooms = halls.get(r.dorm);
  if (!rooms.has(r.room)) rooms.set(r.room, []);
  rooms.get(r.room).push(r);
}

// Which of the four schemes is this hall using?
function schemeOf(labels) {
  if (labels.every((l) => /^\d+-\d+$/.test(l))) return "apartment";
  const digits = labels.map((l) => (l.match(/\d+/) ?? [""])[0]);
  if (digits.filter((d) => d.length >= 3).length / labels.length > 0.8) return "floors";
  if (labels.filter((l) => /[A-Za-z]$/.test(l)).length / labels.length > 0.8) return "suites";
  return "mixed";
}

// A room's band (which stripe of the building it belongs to) and its unit (the
// suite or apartment it shares a wall with). Returning null for the band means
// the label carries no storey and the hall is drawn as one piece.
function place(label, scheme) {
  if (scheme === "apartment") {
    const [unit, bed] = label.split("-");
    return { band: unit.length >= 3 ? unit[0] : null, unit, bed };
  }
  const m = label.match(/^([A-Za-z]*)(\d+)([A-Za-z]*)$/);
  if (!m) return { band: null, unit: label, bed: "" };
  const [, , num, suffix] = m;
  if (scheme === "floors") return { band: num.length >= 3 ? num[0] : null, unit: label, bed: "" };
  if (scheme === "suites") return { band: null, unit: num, bed: suffix };
  return { band: null, unit: label, bed: "" };
}

const SCHEME_NOTE = {
  floors: "numbered by storey",
  suites: "suites, no storey in the label",
  apartment: "apartments, numbered by storey",
  mixed: "no consistent numbering",
};

const buildings = [...halls]
  .map(([name, rooms]) => {
    const labels = [...rooms.keys()];
    const scheme = schemeOf(labels);

    // band -> unit -> rooms, each in label order
    const bands = new Map();
    for (const label of labels.sort(compareLabel)) {
      const { band, unit } = place(label, scheme);
      const key = band ?? "";
      if (!bands.has(key)) bands.set(key, new Map());
      const units = bands.get(key);
      if (!units.has(unit)) units.set(unit, []);
      units.get(unit).push({ label, people: rooms.get(label) });
    }

    const people = [...rooms.values()].reduce((a, p) => a + p.length, 0);
    // Roommate pairs that share a class year, the number worth arguing about.
    let pairs = 0;
    let matched = 0;
    for (const p of rooms.values()) {
      if (p.length !== 2) continue;
      pairs++;
      if (p[0].cls === p[1].cls && p[0].cls !== "?") matched++;
    }

    return {
      name,
      gender: genderOf(name) ?? "mixed",
      scheme,
      people,
      rooms: rooms.size,
      pairs,
      matched,
      bands: [...bands].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([label, units]) => ({
        label,
        units: [...units.values()].map((rs) =>
          rs.map((r) => ({
            label: r.label,
            beds: r.people.map((p) => ({
              cls: p.cls,
              who: `${p.first} ${p.last}`.trim(),
            })),
          })),
        ),
      })),
    };
  })
  .sort((a, b) => b.people - a.people);

// "010" before "101" before "02A"; numbers compare as numbers so 9 precedes 10.
function compareLabel(a, b) {
  const na = (a.match(/\d+/) ?? ["0"])[0];
  const nb = (b.match(/\d+/) ?? ["0"])[0];
  if (na.length !== nb.length) return na.length - nb.length;
  if (+na !== +nb) return +na - +nb;
  return a < b ? -1 : 1;
}

// ─── totals ────────────────────────────────────────────────────────────────

const people = residents.length;
const roomCount = buildings.reduce((a, b) => a + b.rooms, 0);
const allPairs = buildings.reduce((a, b) => a + b.pairs, 0);
const allMatched = buildings.reduce((a, b) => a + b.matched, 0);

const CLASS_ORDER = ["FR", "SO", "JR", "SR"];
const tally = new Map();
for (const r of residents) tally.set(r.cls, (tally.get(r.cls) ?? 0) + 1);

const n = (x) => x.toLocaleString("en-US");

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Where everybody lives</title>
<style>
  :root {
    --bg: #14110f;
    --card: #1b1716;
    --line: #2e2724;
    --ink: #ece4dc;
    --dim: #8b7f76;
    --faint: #5c534d;
    --accent: oklch(0.78 0.13 3);
    /* Class year as one continuous climb, so seniority reads as warmth rather
       than as four unrelated colours. */
    --fr: oklch(0.52 0.13 325);
    --so: oklch(0.62 0.15 5);
    --jr: oklch(0.71 0.15 38);
    --sr: oklch(0.82 0.13 74);
    --other: oklch(0.44 0.02 60);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 2rem 3rem;
    background: var(--bg); color: var(--ink);
    font: 400 16px/1.5 "Iowan Old Style", "Charter", "Hoefler Text", Georgia, serif;
  }
  .wrap { max-width: 1400px; margin: 0 auto; }
  h1 { margin: 0 0 .9rem; font-size: 1.55rem; font-weight: 400; letter-spacing: -0.01em; }
  .bar {
    display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.1rem;
    padding-bottom: .7rem; margin-bottom: 1.4rem; border-bottom: 1px solid var(--line);
    font-family: "SF Mono", Menlo, monospace; font-size: .74rem; color: var(--faint);
  }
  .key { display: flex; align-items: center; gap: .4rem; }
  .key i { width: 10px; height: 10px; border-radius: 2px; }
  .bar button {
    background: none; border: 1px solid var(--line); border-radius: 3px;
    padding: .22rem .5rem; color: var(--dim); cursor: pointer; font: inherit;
  }
  .bar button:hover { color: var(--ink); }
  .bar button[aria-pressed="true"] { color: var(--ink); border-color: var(--accent); }
  #sorters { margin-left: auto; display: flex; gap: .35rem; }

  .halls { display: grid; gap: 1.1rem; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); }
  .hall {
    background: var(--card); border: 1px solid var(--line); border-radius: 4px;
    padding: .8rem .9rem 1rem;
  }
  .hall header { display: flex; align-items: baseline; gap: .5rem; margin-bottom: .1rem; }
  .hall h2 { margin: 0; font-size: 1rem; font-weight: 400; }
  .hall .who {
    font-family: "SF Mono", Menlo, monospace; font-size: .62rem;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .who.male { color: oklch(0.7 0.1 250); }
  .who.female { color: oklch(0.75 0.11 350); }
  .who.mixed { color: oklch(0.72 0.1 80); }
  .hall .count {
    margin-left: auto; font-family: "SF Mono", Menlo, monospace;
    font-size: .68rem; color: var(--dim);
  }
  .hall .note {
    font-family: "SF Mono", Menlo, monospace; font-size: .62rem; color: var(--faint);
    margin-bottom: .6rem;
  }

  .band { display: flex; align-items: flex-start; gap: .5rem; margin-top: .35rem; }
  .band > b {
    flex: none; width: .7rem; padding-top: .1rem; font-weight: 400;
    font-family: "SF Mono", Menlo, monospace; font-size: .62rem; color: var(--faint);
    text-align: right;
  }
  /* Rooms in a suite touch; separate rooms get air. So the grouping is legible
     without drawing a single line around it. */
  .units { display: flex; flex-wrap: wrap; gap: 3px; }
  .unit { display: flex; gap: 1px; }
  .room { display: flex; gap: 1px; border-radius: 2px; overflow: hidden; cursor: default; }
  .bed { width: 7px; height: 13px; }
  .bed.FR { background: var(--fr); }
  .bed.SO { background: var(--so); }
  .bed.JR { background: var(--jr); }
  .bed.SR { background: var(--sr); }
  .bed.other { background: var(--other); }
  .room:hover { outline: 1px solid var(--ink); outline-offset: 1px; }
  /* Dimming everyone else makes one year's spread through a building obvious. */
  body.filtering .bed { opacity: .12; }
  body.filtering .bed.lit { opacity: 1; }

  .tip {
    position: fixed; z-index: 5; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: #0d0b0a; border: 1px solid var(--line); border-radius: 3px;
    padding: .45rem .6rem; white-space: nowrap;
    font-family: "SF Mono", Menlo, monospace; font-size: .72rem; line-height: 1.5;
  }
  .tip.on { opacity: 1; }
  .tip h3 { margin: 0 0 .15rem; font: inherit; font-size: .78rem; color: var(--ink); }
  .tip div { color: var(--dim); }
  .tip em { font-style: normal; color: var(--faint); }
</style>

<div class="wrap">
  <h1>Where everybody lives</h1>
  <div class="bar">
    <span>${n(people)} people &middot; ${n(roomCount)} rooms &middot; ${
      buildings.length
    } halls</span>
    <span>${Math.round((allMatched / allPairs) * 100)}% of ${n(
      allPairs,
    )} roommate pairs share a year</span>
    <span id="sorters">
      <button data-sort="people" aria-pressed="true">by size</button>
      <button data-sort="matched" aria-pressed="false">by year mixing</button>
    </span>
  </div>
  <div class="bar" style="border:0;margin-bottom:.8rem;padding:0">
    ${CLASS_ORDER.map(
      (c) =>
        `<button class="key" data-cls="${c}" aria-pressed="false"><i style="background:var(--${c.toLowerCase()})"></i>${c} ${n(
          tally.get(c) ?? 0,
        )}</button>`,
    ).join("\n    ")}
    <button class="key" data-cls="other" aria-pressed="false"><i style="background:var(--other)"></i>grad &amp; other ${n(
      [...tally].filter(([k]) => !CLASS_ORDER.includes(k)).reduce((a, [, v]) => a + v, 0),
    )}</button>
  </div>
  <div class="halls" id="halls"></div>
</div>

<div class="tip" id="tip"></div>

<script>
const HALLS = ${JSON.stringify(buildings)};
const NOTE = ${JSON.stringify(SCHEME_NOTE)};
const KNOWN = ${JSON.stringify(CLASS_ORDER)};
const grid = document.getElementById("halls");
const tip = document.getElementById("tip");

const cls = (c) => (KNOWN.includes(c) ? c : "other");

function render(order) {
  const halls = [...HALLS].sort((a, b) => {
    if (order !== "matched") return b.people - a.people;
    // A hall of singles has no pairs to agree or disagree, so it belongs at the
    // bottom of this ranking rather than at the top of it with a share of zero.
    if (!a.pairs !== !b.pairs) return a.pairs ? -1 : 1;
    if (!a.pairs) return b.people - a.people;
    return a.matched / a.pairs - b.matched / b.pairs;
  });
  grid.innerHTML = halls
    .map((h) => {
      const share = h.pairs
        ? \` &middot; \${Math.round((h.matched / h.pairs) * 100)}% same year\`
        : "";
      const bands = h.bands
        .map(
          (b) => \`<div class="band"><b>\${b.label}</b><div class="units">\` +
            b.units
              .map(
                (u) =>
                  '<div class="unit">' +
                  u
                    .map(
                      (r) =>
                        \`<div class="room" data-room="\${r.label}" data-hall="\${h.name}">\` +
                        r.beds
                          .map((bed) => \`<i class="bed \${cls(bed.cls)}"></i>\`)
                          .join("") +
                        "</div>",
                    )
                    .join("") +
                  "</div>",
              )
              .join("") +
            "</div></div>",
        )
        .join("");
      return \`<section class="hall">
        <header>
          <h2>\${h.name.replace(/ Hall$/, "")}</h2>
          <span class="who \${h.gender}">\${h.gender}</span>
          <span class="count">\${h.people}</span>
        </header>
        <div class="note">\${NOTE[h.scheme]}\${share}</div>
        \${bands}
      </section>\`;
    })
    .join("");
}

// Rooms are looked up by hall and label on demand rather than stamped into the
// markup, which keeps 3,800 beds from carrying a name each.
const index = new Map();
for (const h of HALLS)
  for (const b of h.bands)
    for (const u of b.units)
      for (const r of u) index.set(h.name + "\\u0000" + r.label, r);

grid.addEventListener("pointerover", (e) => {
  const room = e.target.closest(".room");
  if (!room) return;
  const r = index.get(room.dataset.hall + "\\u0000" + room.dataset.room);
  if (!r) return;
  tip.innerHTML =
    \`<h3>\${room.dataset.hall.replace(/ Hall$/, "")} \${r.label}</h3>\` +
    r.beds.map((b) => \`<div>\${b.who} <em>\${b.cls}</em></div>\`).join("");
  tip.classList.add("on");
});

grid.addEventListener("pointermove", (e) => {
  if (!tip.classList.contains("on")) return;
  tip.style.left = Math.max(8, Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8)) + "px";
  tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 12) + "px";
});

grid.addEventListener("pointerout", (e) => {
  if (!e.relatedTarget || !e.relatedTarget.closest(".room")) tip.classList.remove("on");
});

for (const b of document.querySelectorAll("#sorters button")) {
  b.addEventListener("click", () => {
    for (const o of document.querySelectorAll("#sorters button"))
      o.setAttribute("aria-pressed", String(o === b));
    render(b.dataset.sort);
    applyFilter();
  });
}

let lit = null;
for (const b of document.querySelectorAll("[data-cls]")) {
  b.addEventListener("click", () => {
    lit = lit === b.dataset.cls ? null : b.dataset.cls;
    for (const o of document.querySelectorAll("[data-cls]"))
      o.setAttribute("aria-pressed", String(o.dataset.cls === lit));
    applyFilter();
  });
}

function applyFilter() {
  document.body.classList.toggle("filtering", !!lit);
  for (const bed of document.querySelectorAll(".bed"))
    bed.classList.toggle("lit", !!lit && bed.classList.contains(lit));
}

render("people");
</script>
`;

mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
writeFileSync(OUT, html);

const schemes = buildings.reduce((a, b) => ((a[b.scheme] = (a[b.scheme] ?? 0) + 1), a), {});
const say = (l, v) => console.error(`  \x1b[2m${l.padEnd(18)}\x1b[0m \x1b[1m${v}\x1b[0m`);
console.error("");
say("wrote", OUT);
say("people", n(people));
say("rooms", n(roomCount));
say("halls", `${buildings.length} — ${Object.entries(schemes).map(([k, v]) => `${v} ${k}`).join(", ")}`);
say("roommate pairs", `${n(allPairs)}, ${Math.round((allMatched / allPairs) * 100)}% same year`);
say("size", `${Math.round(html.length / 1024)} KB`);
console.error("");
