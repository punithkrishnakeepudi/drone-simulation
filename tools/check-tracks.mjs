/**
 * Track geometry check.
 *
 * Builds every arena's obstacle set headlessly and asks two questions of every
 * track:
 *
 *   1. is the opening of each ring clear?
 *   2. is the straight line between consecutive rings clear?
 *
 * A blocked line is not automatically a bug — a pilot may be meant to go round
 * something — but it is always worth looking at, so it is reported as a warning
 * while a blocked ring is an error.
 *
 * The scenery helpers are re-implemented here rather than imported, because
 * world.js pulls in three. They must match the AABBs world.js pushes; if the
 * collision volumes there change, change them here too.
 *
 * Run:  node tools/check-tracks.mjs
 */

import { buildScenery } from '../public/js/arenas.js';
import { TRACKS, THEMES, trackProfile } from '../public/js/tracks.js';

const DRONE_R = 0.22;      // physics.js collision radius
const GEOFENCE = 58;
const CEILING = 40;

/* --- the helpers arenas.js expects, reduced to their collision volumes --- */

const noop = () => ({});
function fakeMesh() {
  return {
    position: { set() {}, copy() { return this; }, multiplyScalar() { return this; }, x: 0, y: 0, z: 0 },
    rotation: { set() {}, x: 0, y: 0, z: 0 },
    scale: { set() {}, x: 1, y: 1, z: 1 },
    castShadow: false,
    receiveShadow: false,
    add() {},
    traverse() {},
  };
}
const THREE = new Proxy(
  {},
  {
    get(_, key) {
      if (key === 'Group') return function () { return { add() {}, position: { set() {} }, rotation: { y: 0 } }; };
      return function () { return fakeMesh(); };
    },
  }
);

function box(scene, obstacles, { x, y, z, w, h, d }) {
  obstacles.push({
    min: { x: x - w / 2, y, z: z - d / 2 },
    max: { x: x + w / 2, y: y + h, z: z + d / 2 },
    tag: 'box',
  });
  return fakeMesh();
}

function hangar(scene, obstacles, x, z, yaw = 0) {
  const W = 14, D = 9, H = 4.2;
  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  const ex = (W * cos + D * sin) / 2;
  const ez = (W * sin + D * cos) / 2;
  obstacles.push({ min: { x: x - ex, y: 0, z: z - ez }, max: { x: x + ex, y: H + W / 2, z: z + ez }, tag: 'hangar' });
  return fakeMesh();
}

function container(scene, obstacles, x, z, color, yaw = 0) {
  const W = 6, H = 2.6, D = 2.4;
  const cos = Math.abs(Math.cos(yaw)), sin = Math.abs(Math.sin(yaw));
  obstacles.push({
    min: { x: x - (W * cos + D * sin) / 2, y: 0, z: z - (W * sin + D * cos) / 2 },
    max: { x: x + (W * cos + D * sin) / 2, y: H, z: z + (W * sin + D * cos) / 2 },
    tag: 'container',
  });
  return fakeMesh();
}

function tree(scene, obstacles, x, z, h = 5) {
  obstacles.push({
    min: { x: x - h * 0.28, y: h * 0.3, z: z - h * 0.28 },
    max: { x: x + h * 0.28, y: h * 0.92, z: z + h * 0.28 },
    tag: 'tree',
  });
  return fakeMesh();
}

function obstaclesFor(theme) {
  const obstacles = [];
  buildScenery(theme, { scene: { add: noop }, obstacles, THREE, box, hangar, container, tree });
  return obstacles;
}

/* --- tests -------------------------------------------------------------- */

const inside = (p, b, pad = DRONE_R) =>
  p.x > b.min.x - pad && p.x < b.max.x + pad &&
  p.y > b.min.y - pad && p.y < b.max.y + pad &&
  p.z > b.min.z - pad && p.z < b.max.z + pad;

function hit(p, obstacles) {
  return obstacles.find((b) => inside(p, b));
}

/** "tree at x −3.8…−2.1, y 1.9…5.7, z −44.2…−40.8" */
function describe(b) {
  const f = (n) => n.toFixed(1);
  return `${b.tag || 'prop'} at x ${f(b.min.x)}…${f(b.max.x)}, y ${f(b.min.y)}…${f(b.max.y)}, z ${f(b.min.z)}…${f(b.max.z)}`;
}

/** Points around the rim and across the opening of a gate. */
function ringSamples(ring) {
  const { pos, radius, yaw } = ring;
  const ux = Math.cos(yaw), uz = -Math.sin(yaw);   // across the gate
  const out = [];
  for (const f of [0, 0.5, 0.9]) {
    const n = f === 0 ? 1 : 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push({
        x: pos.x + ux * Math.cos(a) * radius * f,
        y: pos.y + Math.sin(a) * radius * f,
        z: pos.z + uz * Math.cos(a) * radius * f,
      });
    }
  }
  return out;
}

function segment(a, b, step = 0.5) {
  const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step));
  const out = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

const PAD = { x: 0, y: 1.2, z: 0 };

let errors = 0;
let warnings = 0;
const cache = new Map();

for (const track of TRACKS) {
  if (!cache.has(track.theme)) cache.set(track.theme, obstaclesFor(track.theme));
  const obs = cache.get(track.theme);
  const notes = [];

  track.rings.forEach((ring, i) => {
    // 1. the opening itself
    const blocked = ringSamples(ring).map((p) => hit(p, obs)).find(Boolean);
    if (blocked) {
      notes.push(`  ERROR  ring ${i + 1} at (${ring.pos.x}, ${ring.pos.y}, ${ring.pos.z}) is blocked by ${describe(blocked)}`);
      errors++;
    }
    // 2. inside the flying area
    const d = Math.hypot(ring.pos.x, ring.pos.z) + ring.radius;
    if (d > GEOFENCE - 1) {
      notes.push(`  ERROR  ring ${i + 1} is ${d.toFixed(1)} m out — the geofence is at ${GEOFENCE}`);
      errors++;
    }
    if (ring.pos.y + ring.radius > CEILING - 1) {
      notes.push(`  ERROR  ring ${i + 1} tops out at ${(ring.pos.y + ring.radius).toFixed(1)} m — the ceiling is ${CEILING}`);
      errors++;
    }
    // 3. the leg into it
    const from = i === 0 ? PAD : track.rings[i - 1].pos;
    const b = segment(from, ring.pos).map((p) => hit(p, obs)).find(Boolean);
    if (b) {
      notes.push(`  warn   the straight line into ring ${i + 1} passes through a ${b.tag || 'prop'} — pilots must go round`);
      warnings++;
    }
  });

  // 4. the way home
  const last = track.rings[track.rings.length - 1].pos;
  const home = segment(last, PAD).map((p) => hit(p, obs)).find(Boolean);
  if (home) {
    notes.push(`  warn   the straight line home passes through a ${home.tag || 'prop'}`);
    warnings++;
  }

  const head = `${track.id.padEnd(16)} ${String(track.rings.length).padStart(2)} rings  ${THEMES[track.theme].name} · ${trackProfile(track)}`;
  console.log(notes.length ? `${head}\n${notes.join('\n')}` : `${head}   ok`);
}

console.log(`\n${TRACKS.length} tracks · ${errors} errors · ${warnings} warnings`);
process.exit(errors ? 1 : 0);
