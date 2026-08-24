/**
 * Arena tracks — pure data, no Three.js.
 *
 * This module is imported by the browser AND by the relay server, which is why
 * it must not touch the DOM or import three: the server draws the track for
 * each round, so both ends have to agree on what the pool is.
 *
 * A track is a theme plus a list of rings. The scenery for the theme lives in
 * arenas.js; the ring positions here are authored to sit in the gaps that
 * scenery leaves, so the two files have to be edited together.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Fills in the gate yaw of any ring that did not specify one, from the line. */
function squareUp(rings) {
  return rings.map((t, i) => {
    const tube = t.tube ?? Math.max(0.13, t.radius * 0.11);
    if (t.yaw != null) return { ...t, tube };
    const a = rings[Math.max(0, i - 1)].pos;
    const b = rings[Math.min(rings.length - 1, i + 1)].pos;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const yaw = dx === 0 && dz === 0 ? Math.PI : Math.atan2(dx, dz);
    return { ...t, yaw, tube };
  });
}

/** `r(x, y, z, radius)` — one ring, in metres. */
const r = (x, y, z, radius = 1.8) => ({ pos: { x, y, z }, radius });

/* ------------------------------------------------------------------ */
/* themes                                                              */
/* ------------------------------------------------------------------ */

export const THEMES = {
  junkyard: {
    name: 'Junkyard',
    blurb: 'Stacked wrecks, tyre piles and a crane. Low, tight and unforgiving.',
    profile: 'cruise',
  },
  city: {
    name: 'City block',
    blurb: 'Six towers, four alleys. The course goes through the gaps, not over them.',
    profile: 'sport',
  },
  warehouse: {
    name: 'Warehouse',
    blurb: 'Indoors between the racking. No wind at all, and no room either.',
    profile: 'cruise',
  },
  forest: {
    name: 'Forest trail',
    blurb: 'Trunks close enough that the line matters more than the speed.',
    profile: 'realistic',
  },
  harbour: {
    name: 'Harbour',
    blurb: 'Container stacks and a gantry crane, with the strongest wind of the five.',
    profile: 'realistic',
  },
};

/* ------------------------------------------------------------------ */
/* the pool                                                            */
/* ------------------------------------------------------------------ */

export const TRACKS = [
  /* ---- junkyard ---- */
  {
    id: 'junk-run',
    name: 'Scrap run',
    theme: 'junkyard',
    brief: 'Six rings weaving between the wreck stacks. Stay under the crane jib.',
    rings: squareUp([
      r(0, 2.0, -8, 2.0),
      r(-4, 2.2, -15, 1.9),
      r(5, 2.4, -20, 1.9),
      r(-3, 2.0, -29, 1.8),
      r(3, 2.2, -35, 1.9),
      r(0, 2.6, -43, 2.2),
    ]),
  },
  {
    id: 'junk-climb',
    name: 'Over the heap',
    theme: 'junkyard',
    brief: 'Up over the scrap pile at 7 m, then straight back down to a low gate.',
    rings: squareUp([
      r(0, 1.8, -9, 2.0),
      r(-5, 4.0, -17, 1.9),
      r(0, 7.0, -24, 2.0),
      r(5, 4.5, -31, 1.9),
      r(0, 1.7, -38, 1.8),
      r(-6, 2.4, -44, 1.9),
      r(0, 3.0, -50, 2.1),
    ]),
  },
  {
    id: 'junk-tight',
    name: 'Tight lines',
    theme: 'junkyard',
    brief: 'Eight small rings, none of them where you want them. Slow is fast here.',
    rings: squareUp([
      r(0, 1.7, -7, 1.6),
      r(-4, 1.7, -12, 1.5),
      r(4, 2.0, -17, 1.5),
      r(-5, 2.3, -23, 1.5),
      r(4, 1.8, -29, 1.5),
      r(-3, 1.7, -35, 1.5),
      r(3, 2.2, -40, 1.6),
      r(0, 2.6, -46, 1.8),
    ]),
  },

  /* ---- city ---- */
  {
    id: 'city-alley',
    name: 'Alley cat',
    theme: 'city',
    brief: 'Up the right alley, across the gap between the rows, back down the left.',
    // The gate at x=0 squares itself across the row gap: its neighbours are at
    // +8 and −8, so the normal comes out pointing the way the pilot is going.
    rings: squareUp([
      r(8, 2.4, -9, 2.0),
      r(8, 2.2, -18, 1.8),
      r(8, 2.4, -26, 1.8),
      r(0, 2.6, -25, 1.9),
      r(-8, 2.4, -26, 1.8),
      r(-8, 2.2, -16, 1.9),
      r(-8, 2.6, -8, 2.0),
    ]),
  },
  {
    id: 'city-rooftop',
    name: 'Rooftop',
    theme: 'city',
    brief: 'Climb to 17 m, cross the roofs, and drop back into the alley on the far side.',
    rings: squareUp([
      r(8, 2.4, -9, 2.0),
      r(8, 9.0, -16, 2.0),
      r(0, 19.0, -20, 2.4),
      r(-8, 19.0, -30, 2.2),
      r(-8, 8.0, -34, 2.0),
      r(-8, 2.4, -40, 1.9),
      r(0, 2.6, -46, 2.1),
    ]),
  },
  {
    id: 'city-loop',
    name: 'Block circuit',
    theme: 'city',
    brief: 'One lap of the middle block at rooftop height, then down and home.',
    rings: squareUp([
      r(8, 3.0, -10, 2.0),
      r(8, 3.0, -20, 1.9),
      r(0, 3.2, -25, 1.9),
      r(-8, 3.0, -20, 1.9),
      r(-8, 3.0, -12, 1.9),
      r(0, 3.4, -7, 2.0),
      r(8, 2.6, -12, 1.9),
      r(0, 2.4, -4, 2.2),
    ]),
  },

  /* ---- warehouse ---- */
  {
    id: 'ware-aisle',
    name: 'Centre aisle',
    theme: 'warehouse',
    // The racking runs from z = −12 to z = −40, so the only ways across are in
    // front of it or behind it. Both crossings here are behind.
    brief: 'Straight down the middle aisle, round the back of the racking and up the outside.',
    rings: squareUp([
      r(0, 1.8, -11, 1.8),
      r(0, 1.8, -20, 1.7),
      r(0, 2.2, -29, 1.7),
      r(0, 1.8, -42, 1.8),
      r(13, 2.0, -42, 1.7),
      r(13, 2.0, -24, 1.7),
    ]),
  },
  {
    id: 'ware-figure',
    name: 'Racking eight',
    theme: 'warehouse',
    brief: 'Down one outside aisle, round the back, up the other. The doorway is the only way home.',
    rings: squareUp([
      r(0, 1.8, -9, 1.8),
      r(13, 2.0, -10, 1.7),
      r(13, 2.0, -26, 1.7),
      r(13, 2.0, -42, 1.7),
      r(0, 2.2, -43, 1.8),
      r(-13, 2.0, -42, 1.7),
      r(-13, 2.0, -26, 1.7),
      r(-13, 2.2, -10, 1.8),
    ]),
  },

  /* ---- forest ---- */
  {
    id: 'forest-slalom',
    name: 'Trail slalom',
    theme: 'forest',
    brief: 'Seven rings between the trunks. The trees are solid and they do not move.',
    rings: squareUp([
      r(0, 2.0, -8, 1.9),
      r(-5, 2.0, -14, 1.8),
      r(5, 2.2, -20, 1.8),
      r(-5, 2.0, -26, 1.8),
      r(5, 2.2, -32, 1.8),
      r(-4, 2.4, -39, 1.8),
      r(0, 2.8, -45, 2.0),
    ]),
  },
  {
    id: 'forest-canopy',
    name: 'Through the canopy',
    theme: 'forest',
    brief: 'Over the treeline at 12 m, then back under it. The gap is where the ring is.',
    rings: squareUp([
      r(0, 2.0, -9, 1.9),
      r(0, 12.0, -18, 2.2),
      r(-6, 12.0, -28, 2.0),
      r(-6, 2.2, -36, 1.8),
      r(4, 2.2, -42, 1.8),
      r(0, 2.6, -48, 2.0),
    ]),
  },

  /* ---- harbour ---- */
  {
    id: 'harbour-stack',
    name: 'Between the stacks',
    theme: 'harbour',
    brief: 'Six rings down the container lanes, crosswind the whole way.',
    rings: squareUp([
      r(0, 2.2, -9, 2.0),
      r(-8, 2.4, -16, 1.9),
      r(8, 2.4, -24, 1.9),
      r(-8, 2.6, -32, 1.9),
      r(8, 2.6, -40, 1.9),
      r(0, 3.0, -52, 2.2),
    ]),
  },
  {
    id: 'harbour-gantry',
    name: 'Under the gantry',
    theme: 'harbour',
    brief: 'Under the crane beam, up and over it, and under it again on the way home.',
    rings: squareUp([
      r(0, 2.2, -12, 2.0),
      r(0, 4.0, -30, 2.2),
      r(-9, 9.0, -38, 2.0),
      r(0, 16.0, -30, 2.4),
      r(9, 9.0, -22, 2.0),
      r(0, 4.0, -15, 2.2),
      r(0, 2.6, -8, 2.2),
    ]),
  },
];

export const TRACK_IDS = TRACKS.map((t) => t.id);

export function trackById(id) {
  return TRACKS.find((t) => t.id === id) || null;
}

/**
 * The flight model a track is flown in. Everyone in a round gets the same one,
 * so nobody wins by picking a softer model.
 */
export function trackProfile(track) {
  return track.profile || THEMES[track.theme]?.profile || 'cruise';
}

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */

export const SCORING = {
  base: 1000,
  perSecond: 4,
  perMiss: 50,
  perHit: 25,
  perCrash: 150,
  cleanBonus: 100,
  landingBonus: 60,      // at a perfect landing, falling off over 0.6 m
  landingFalloff: 100,
};

/**
 * Points for one round. Shared by the pilot's screen and the results table so
 * the two can never disagree about the arithmetic.
 *
 * @param {{time:number, missed:number, hits:number, crashes:number, landing:number|null, dnf:boolean}} run
 */
export function scoreRound(run) {
  if (run.dnf) return 0;
  const s = SCORING;
  let pts = s.base;
  pts -= Math.round(run.time * s.perSecond);
  pts -= run.missed * s.perMiss;
  pts -= run.hits * s.perHit;
  pts -= run.crashes * s.perCrash;
  if (!run.missed && !run.hits && !run.crashes) pts += s.cleanBonus;
  if (run.landing != null) pts += Math.max(0, Math.round(s.landingBonus - s.landingFalloff * run.landing));
  return clamp(Math.round(pts), 0, 99999);
}
