/**
 * Training missions.
 *
 * A mission is a list of objectives. An objective owns a marker to render and
 * a test() that runs every frame and returns progress 0..1. When progress hits
 * 1 the mission moves on. Order is the lesson: each one adds exactly one new
 * skill to the last.
 */

const DEG = Math.PI / 180;
const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/* ---------- objective builders ---------- */

function hold({ label, hint, pos, radius = 1.6, alt = [0.8, 2.0], seconds = 8, marker = true }) {
  return {
    label,
    hint,
    marker: marker ? { type: 'ring', pos, radius, alt: (alt[0] + alt[1]) / 2 } : null,
    init: (m) => (m.held = 0),
    test(ctx, dt, m) {
      const d = ctx.drone;
      const inside = dist2D(d.pos, pos) < radius && d.altitude > alt[0] && d.altitude < alt[1];
      m.held = inside ? m.held + dt : Math.max(0, m.held - dt * 1.6);
      m.detail = `${Math.min(seconds, m.held).toFixed(1)}s / ${seconds}s`;
      return m.held / seconds;
    },
  };
}

function reach({ label, hint, pos, radius = 1.4, alt = null, dwell = 0.6 }) {
  return {
    label,
    hint,
    marker: { type: 'ring', pos, radius, alt: alt ? (alt[0] + alt[1]) / 2 : 1.5 },
    init: (m) => (m.held = 0),
    test(ctx, dt, m) {
      const d = ctx.drone;
      const okAlt = !alt || (d.altitude > alt[0] && d.altitude < alt[1]);
      const inside = dist2D(d.pos, pos) < radius && okAlt;
      m.held = inside ? m.held + dt : 0;
      return Math.min(1, m.held / dwell);
    },
  };
}

function climbAbove({ label, hint, alt }) {
  return {
    label,
    hint,
    marker: { type: 'band', alt },
    test(ctx) {
      const a = ctx.drone.altitude;
      return Math.min(1, a / alt) === 1 ? 1 : a / alt;
    },
  };
}

function descendBelow({ label, hint, alt, from = 4 }) {
  return {
    label,
    hint,
    marker: { type: 'band', alt },
    test(ctx) {
      const a = ctx.drone.altitude;
      if (a <= alt) return 1;
      return Math.max(0, Math.min(0.99, (from - a) / (from - alt)));
    },
  };
}

function landOn({ label, hint, pos, radius = 0.9, gentle = 1.4 }) {
  return {
    label,
    hint,
    marker: { type: 'pad', pos, radius },
    test(ctx, dt, m) {
      const d = ctx.drone;
      if (d.airborne || d.altitude > 0.08) {
        m.detail = '';
        return 0;
      }
      const off = dist2D(d.pos, pos);
      if (off > radius) {
        m.detail = `${off.toFixed(2)} m off the pad — take off and try again`;
        return 0;
      }
      m.detail = `touchdown ${(off * 100).toFixed(0)} cm from centre`;
      ctx.score.landingOffset = off;
      return 1;
    },
  };
}

function faceThePilot({ label, hint, tolerance = 25, seconds = 2 }) {
  return {
    label,
    hint,
    marker: null,
    init: (m) => (m.held = 0),
    test(ctx, dt, m) {
      const d = ctx.drone;
      const toPilot = Math.atan2(ctx.pilot.x - d.pos.x, ctx.pilot.z - d.pos.z);
      const nose = Math.atan2(-Math.sin(d.yaw), -Math.cos(d.yaw));
      let err = Math.atan2(Math.sin(toPilot - nose), Math.cos(toPilot - nose)) / DEG;
      m.detail = `${Math.abs(err).toFixed(0)}° off`;
      m.held = Math.abs(err) < tolerance && d.airborne ? m.held + dt : 0;
      return Math.min(1, m.held / seconds);
    },
  };
}

function gateRun({ label, hint, gates }) {
  return {
    label,
    hint,
    marker: { type: 'gates', gates },
    init: (m) => {
      m.index = 0;
      m.side = null;
      m.t = 0;
    },
    test(ctx, dt, m) {
      const d = ctx.drone;
      m.t += dt;
      const g = gates[m.index];
      if (!g) return 1;
      // Signed distance to the gate plane, along the gate's facing axis.
      const nx = Math.sin(g.yaw), nz = Math.cos(g.yaw);
      const s = (d.pos.x - g.pos.x) * nx + (d.pos.z - g.pos.z) * nz;
      const side = s >= 0 ? 1 : -1;
      if (m.side === null) m.side = side;
      if (side !== m.side) {
        const perp = Math.hypot(
          d.pos.x - g.pos.x - s * nx,
          d.pos.z - g.pos.z - s * nz
        );
        const dy = Math.abs(d.pos.y - g.pos.y);
        if (Math.hypot(perp, dy) < g.radius) {
          m.index++;
          m.side = null;
          ctx.emit('gate');
        } else {
          m.side = side;
        }
      }
      m.detail = `gate ${Math.min(m.index + 1, gates.length)} of ${gates.length} · ${m.t.toFixed(1)}s`;
      ctx.score.courseTime = m.t;
      return m.index / gates.length;
    },
  };
}

/* ---------- the syllabus ---------- */

const PAD = { x: 0, y: 0, z: 0 };

export const MISSIONS = [
  {
    id: 'free',
    name: 'Free flight',
    profile: 'beginner',
    brief: 'No objectives. Get a feel for the sticks, then pick a lesson.',
    objectives: [],
  },
  {
    id: 'hover',
    name: '1 · Hover',
    profile: 'beginner',
    brief:
      'The whole skill of flying is holding one spot. Take off, park the drone in the ring at head height, and keep it there.',
    objectives: [
      climbAbove({ label: 'Take off', hint: 'Left stick up. It stops climbing when you centre it.', alt: 1.0 }),
      hold({
        label: 'Hold the ring for 8 seconds',
        hint: 'Tiny nudges on the right stick. Push, then centre — never hold the stick over.',
        pos: { x: 0, z: -4 },
        radius: 1.6,
        alt: [0.9, 2.2],
        seconds: 8,
      }),
      landOn({ label: 'Land on the pad', hint: 'Left stick gently down until it settles.', pos: PAD }),
    ],
  },
  {
    id: 'altitude',
    name: '2 · Altitude',
    profile: 'beginner',
    brief: 'Left stick only. Climb, descend, and stop where you mean to stop.',
    objectives: [
      climbAbove({ label: 'Climb above 5 m', hint: 'Watch the altitude tape on the left.', alt: 5 }),
      descendBelow({ label: 'Come back down to 1 m', hint: 'Ease off before you arrive, not after.', alt: 1.2, from: 5 }),
      climbAbove({ label: 'Climb to 3 m', hint: 'Stop on the number this time.', alt: 3 }),
      landOn({ label: 'Land on the pad', hint: 'Slow all the way to the ground.', pos: PAD }),
    ],
  },
  {
    id: 'sidestep',
    name: '3 · Left and right',
    profile: 'beginner',
    brief:
      'Roll only — right stick left and right. The nose stays pointed away from you the whole time, so left is left.',
    objectives: [
      reach({ label: 'Fly to the left marker', hint: 'A small push, then centre and let it drift in.', pos: { x: -5, z: -5 }, alt: [0.8, 3] }),
      reach({ label: 'Now the right marker', hint: 'Counter-push to stop. Drag alone will not stop it.', pos: { x: 5, z: -5 }, alt: [0.8, 3] }),
      reach({ label: 'Back to the middle', hint: 'Aim to arrive slow, not to arrive fast.', pos: { x: 0, z: -5 }, alt: [0.8, 3] }),
      landOn({ label: 'Land on the pad', hint: '', pos: PAD }),
    ],
  },
  {
    id: 'box',
    name: '4 · The box',
    profile: 'beginner',
    brief: 'Four corners at 2 m, nose fixed forward. Roll for the sides, pitch for the ends.',
    objectives: [
      reach({ label: 'Corner 1', hint: 'Forward is right stick up.', pos: { x: -5, z: -9 }, alt: [1.2, 3.2] }),
      reach({ label: 'Corner 2', hint: '', pos: { x: 5, z: -9 }, alt: [1.2, 3.2] }),
      reach({ label: 'Corner 3', hint: '', pos: { x: 5, z: -3 }, alt: [1.2, 3.2] }),
      reach({ label: 'Corner 4', hint: 'Square corners: stop, then turn the movement.', pos: { x: -5, z: -3 }, alt: [1.2, 3.2] }),
      landOn({ label: 'Land on the pad', hint: '', pos: PAD }),
    ],
  },
  {
    id: 'nosein',
    name: '5 · Nose-in',
    profile: 'beginner',
    brief:
      'The one that catches everyone. Turn the drone to face you and your left/right inputs mirror. Fly it anyway.',
    objectives: [
      climbAbove({ label: 'Take off to 2 m', hint: '', alt: 2 }),
      faceThePilot({ label: 'Turn the nose to face you', hint: 'Left stick sideways is yaw — it spins, it does not move.' }),
      reach({ label: 'Nose-in, fly to the left marker', hint: 'Nose-in: push the stick the way the drone should go from ITS point of view — mirrored from yours.', pos: { x: -5, z: -6 }, alt: [0.8, 4] }),
      reach({ label: 'Nose-in, fly to the right marker', hint: 'Slow. Correct in small taps.', pos: { x: 5, z: -6 }, alt: [0.8, 4] }),
      landOn({ label: 'Land on the pad', hint: 'You may turn the nose away again first.', pos: PAD }),
    ],
  },
  {
    id: 'gates',
    name: '6 · Gate run',
    profile: 'sport',
    brief: 'Sport mode: more tilt, a little wind. Five gates in order, cleanest line wins.',
    objectives: [
      gateRun({
        label: 'Fly the course',
        hint: 'Look ahead one gate. Yaw to point the nose along the line you want.',
        gates: [
          { pos: { x: 0, y: 2.0, z: -8 }, yaw: 0, radius: 1.5 },
          { pos: { x: -7, y: 2.4, z: -14 }, yaw: Math.PI / 4, radius: 1.5 },
          { pos: { x: 4, y: 3.0, z: -19 }, yaw: -Math.PI / 5, radius: 1.5 },
          { pos: { x: 9, y: 2.2, z: -11 }, yaw: Math.PI / 2, radius: 1.5 },
          { pos: { x: 0, y: 2.0, z: -5 }, yaw: Math.PI, radius: 1.7 },
        ],
      }),
      landOn({ label: 'Land on the pad', hint: 'Stop the clock on the ground.', pos: PAD }),
    ],
  },
  {
    id: 'spot',
    name: '7 · Spot landing',
    profile: 'sport',
    brief: 'Up to 8 m, then put it back on the pad inside 30 cm without a thump.',
    objectives: [
      climbAbove({ label: 'Climb to 8 m', hint: '', alt: 8 }),
      landOn({ label: 'Land within 30 cm of centre', hint: 'Line up high, then descend straight. Fix drift early.', pos: PAD, radius: 0.3 }),
    ],
  },
];

export class MissionRunner {
  constructor(emit) {
    this.emit = emit || (() => {});
    this.load(MISSIONS[0]);
  }

  load(mission) {
    this.mission = mission;
    this.index = 0;
    this.mem = {};
    this.progress = 0;
    this.complete = mission.objectives.length === 0;
    this.startedAt = null;
    this.elapsed = 0;
    this.score = { bumps: 0, courseTime: 0, landingOffset: null };
    this.initObjective();
  }

  get objective() {
    return this.mission.objectives[this.index] || null;
  }

  initObjective() {
    const o = this.objective;
    this.mem = {};
    if (o && o.init) o.init(this.mem);
  }

  restart() {
    this.load(this.mission);
  }

  update(dt, drone, pilot) {
    if (this.complete || !this.objective) return;
    if (this.startedAt === null && drone.armed) this.startedAt = 0;
    if (this.startedAt !== null) this.elapsed += dt;

    const ctx = { drone, pilot, score: this.score, emit: this.emit };
    this.progress = Math.max(0, Math.min(1, this.objective.test(ctx, dt, this.mem) || 0));

    if (this.progress >= 1) {
      this.emit('objective');
      this.index++;
      if (this.index >= this.mission.objectives.length) {
        this.complete = true;
        this.score.bumps = drone.bumps;
        this.emit('mission-complete');
      } else {
        this.initObjective();
        this.progress = 0;
      }
    }
  }

  /** Markers the renderer should show: current objective plus the next one, dimmed. */
  markers() {
    const out = [];
    const cur = this.objective;
    if (cur && cur.marker) out.push({ ...cur.marker, active: true });
    const next = this.mission.objectives[this.index + 1];
    if (next && next.marker) out.push({ ...next.marker, active: false });
    return out;
  }
}
