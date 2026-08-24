/**
 * Task mode — five tyre courses.
 *
 * Every task is the same shape: fly through the tyres in order, then put the
 * drone back on the pad. What changes is the PATTERN, and each pattern isolates
 * a different skill:
 *
 *   1 Straight line  — hold a heading and a height          (guided)
 *   2 Slalom         — coordinated roll, stop the swing
 *   3 Staircase      — climb and descend onto a number
 *   4 Circle         — continuous turn, nose follows the line
 *   5 Figure eight   — both turn directions plus height changes
 *
 * Task 1 walks the pilot through every control first. Tasks 2-5 just run.
 */

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export const PAD = { x: 0, y: 0, z: 0 };

/* ------------------------------------------------------------------ */
/* course geometry                                                     */
/* ------------------------------------------------------------------ */

/** Fills in the gate yaw of any tyre that did not specify one, from the line. */
function squareUp(tyres) {
  return tyres.map((t, i) => {
    if (t.yaw != null) return { ...t, tube: t.tube ?? Math.max(0.13, t.radius * 0.11) };
    const a = tyres[Math.max(0, i - 1)].pos;
    const b = tyres[Math.min(tyres.length - 1, i + 1)].pos;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const yaw = dx === 0 && dz === 0 ? Math.PI : Math.atan2(dx, dz);
    return { ...t, yaw, tube: t.tube ?? Math.max(0.13, t.radius * 0.11) };
  });
}

function straightLine() {
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push({ pos: { x: 0, y: 2.0, z: -8 - i * 6 }, radius: 1.8 });
  }
  return squareUp(out);
}

function slalom() {
  const out = [];
  const xs = [-4.5, 4.5, -4.5, 4.5, 0];
  for (let i = 0; i < 5; i++) {
    out.push({ pos: { x: xs[i], y: 2.2, z: -8 - i * 6 }, radius: 1.6 });
  }
  return squareUp(out);
}

function staircase() {
  const ys = [1.6, 3.2, 5.2, 3.2, 1.6];
  const out = [];
  for (let i = 0; i < 5; i++) {
    out.push({ pos: { x: 0, y: ys[i], z: -8 - i * 6 }, radius: 1.6 });
  }
  return squareUp(out);
}

function circle() {
  const R = 12;
  const cz = -16;
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = (90 + i * 60) * DEG; // starts on the pilot's side, turns left
    out.push({
      pos: { x: Math.cos(a) * R, y: 2.4, z: cz + Math.sin(a) * R },
      radius: 1.6,
      yaw: -a, // gate normal is the tangent, so the plane squares to the turn
    });
  }
  return squareUp(out);
}

function figureEight() {
  // Gerono lemniscate: x = A cos t, z = z0 + B sin t cos t. Crosses itself
  // once, so the pilot flies one left-hand loop and one right-hand loop.
  const A = 14;
  const B = 20;
  const z0 = -18;
  const out = [];
  for (let k = 0; k < 8; k++) {
    const t = Math.PI / 8 + (k * Math.PI) / 4;
    const x = A * Math.cos(t);
    const z = z0 + (B / 2) * Math.sin(2 * t);
    const dx = -A * Math.sin(t);
    const dz = B * Math.cos(2 * t);
    out.push({
      pos: { x, y: k % 2 ? 3.4 : 1.9, z },
      radius: 1.6,
      yaw: Math.atan2(dx, dz),
    });
  }
  return squareUp(out);
}

/* ------------------------------------------------------------------ */
/* the guided walk-through (task 1 only)                               */
/* ------------------------------------------------------------------ */

/**
 * Each step is a small contract: say what the control does, then wait until the
 * pilot has actually done it. Nothing advances on a timer alone except the two
 * "look at this" steps.
 */
export const GUIDE = [
  {
    id: 'welcome',
    key: 'Look around',
    title: 'This is your field',
    body:
      'Orange nose, green tail — that is how you tell which way the drone is facing. ' +
      'You are the figure on the pad; everything is judged from where you stand.',
    seconds: 5,
    test: (ctx, dt, m) => ((m.t = (m.t || 0) + dt) / 5),
  },
  {
    id: 'motors',
    key: 'MOTORS',
    title: 'Start the motors',
    body: 'Tap MOTORS on the phone (Space on the keyboard). The props spin, the drone stays put.',
    test: (ctx) => (ctx.drone.armed ? 1 : 0),
  },
  {
    id: 'throttle',
    key: 'LEFT STICK ↑↓',
    title: 'Throttle — left stick up and down',
    body: 'Push the left stick UP to climb. Get above 1.5 m. Up is always up, whichever way the nose points.',
    test: (ctx) => clamp(ctx.drone.altitude / 1.5, 0, 1),
  },
  {
    id: 'hover',
    key: 'CENTRE IT',
    title: 'Now let go',
    body: 'Centre the left stick and it holds height. Keep it hovering for three seconds.',
    test: (ctx, dt, m) => {
      const ok = ctx.drone.altitude > 0.9 && Math.abs(ctx.input.thr) < 0.12;
      m.t = ok ? (m.t || 0) + dt : 0;
      m.detail = `${Math.min(3, m.t || 0).toFixed(1)}s / 3.0s`;
      return clamp((m.t || 0) / 3, 0, 1);
    },
  },
  {
    id: 'yaw',
    key: 'LEFT STICK ←→',
    title: 'Yaw — left stick left and right',
    body: 'This spins the drone on the spot without moving it. Turn it a good way round and back.',
    test: (ctx, dt, m) => {
      if (m.last == null) m.last = ctx.drone.yaw;
      let d = ctx.drone.yaw - m.last;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      m.turned = (m.turned || 0) + Math.abs(d);
      m.last = ctx.drone.yaw;
      m.detail = `${Math.round(Math.min(180, (m.turned / DEG)))}° of 180°`;
      return clamp(m.turned / (180 * DEG), 0, 1);
    },
  },
  {
    id: 'pitch',
    key: 'RIGHT STICK ↑↓',
    title: 'Pitch — right stick up and down',
    body: 'Forward and back. The drone tilts, so it keeps sliding after you centre the stick — push the other way to stop it.',
    test: (ctx, dt, m) => {
      m.used = (m.used || 0) + Math.abs(ctx.input.pitch) * dt;
      return clamp(m.used / 1.6, 0, 1);
    },
  },
  {
    id: 'roll',
    key: 'RIGHT STICK ←→',
    title: 'Roll — right stick left and right',
    body: 'Slides sideways without turning. Careful: when the nose points back at YOU, left and right swap over.',
    test: (ctx, dt, m) => {
      m.used = (m.used || 0) + Math.abs(ctx.input.roll) * dt;
      return clamp(m.used / 1.6, 0, 1);
    },
  },
  {
    id: 'view',
    key: 'VIEW',
    title: 'Change the camera',
    body: 'Tap VIEW (or C). Pilot view is what you would really see. Chase and nose camera are for learning the line.',
    test: (ctx) => (ctx.ui.camChanges > 0 ? 1 : 0),
  },
  {
    id: 'path',
    key: 'PATH BOX',
    title: 'The black box, bottom right',
    body:
      'That is your path from above. The dotted green line is the course, the orange line is where you actually flew. ' +
      'Keep the orange on the green.',
    seconds: 6,
    test: (ctx, dt, m) => ((m.t = (m.t || 0) + dt) / 6),
  },
  {
    id: 'aim',
    key: 'LINE UP',
    title: 'Point the nose at tyre 1',
    body: 'Yaw until the nose lines up with the first tyre, then hold it steady for two seconds.',
    test: (ctx, dt, m) => {
      const t = ctx.tyres[0];
      if (!t) return 1;
      const bearing = Math.atan2(t.pos.x - ctx.drone.pos.x, t.pos.z - ctx.drone.pos.z);
      const n = ctx.drone.nose();
      const noseA = Math.atan2(n.x, n.z);
      const err = Math.abs(Math.atan2(Math.sin(bearing - noseA), Math.cos(bearing - noseA))) / DEG;
      m.detail = `${err.toFixed(0)}° off`;
      m.t = err < 20 && ctx.drone.airborne ? (m.t || 0) + dt : 0;
      return clamp((m.t || 0) / 2, 0, 1);
    },
  },
  {
    id: 'go',
    key: 'FLY IT',
    title: 'Fly the course',
    body: 'Four tyres, straight ahead, all at 2 m. Small inputs. Arrive slow, not fast.',
    seconds: 3,
    test: (ctx, dt, m) => ((m.t = (m.t || 0) + dt) / 3),
  },
];

/* ------------------------------------------------------------------ */
/* the five tasks                                                      */
/* ------------------------------------------------------------------ */

export const TASKS = [
  {
    id: 'line',
    n: 1,
    name: 'Straight line',
    pattern: 'Four tyres in a row',
    profile: 'beginner',
    guided: true,
    brief: 'Hold one heading and one height. The whole course is a single straight line at 2 m.',
    tip: 'Nose stays pointed down the line. Correct drift with tiny taps, not with big pushes.',
    tyres: straightLine(),
  },
  {
    id: 'slalom',
    n: 2,
    name: 'Slalom',
    pattern: 'Five tyres, alternating left and right',
    profile: 'beginner',
    guided: false,
    brief: 'Weave through five tyres. Roll in, then roll out to kill the swing before the next one.',
    tip: 'Start the turn early. The drone keeps sliding after you centre the stick.',
    tyres: slalom(),
  },
  {
    id: 'stair',
    n: 3,
    name: 'Staircase',
    pattern: 'Five tyres, up to 5 m and back down',
    profile: 'sport',
    guided: false,
    brief: 'Same line, different heights: 1.6, 3.2, 5.2, 3.2, 1.6 m. Climb and settle on each number.',
    tip: 'Lead the climb. Ease off before you arrive or you will float straight over the tyre.',
    tyres: staircase(),
  },
  {
    id: 'circle',
    n: 4,
    name: 'Circle',
    pattern: 'Six tyres around a 12 m ring',
    profile: 'sport',
    guided: false,
    brief: 'One continuous left-hand turn. Hold the radius and the height the whole way round.',
    tip: 'Roll a little and hold it, then feed in yaw so the nose keeps following the circle.',
    tyres: circle(),
  },
  {
    id: 'eight',
    n: 5,
    name: 'Figure eight',
    pattern: 'Eight tyres, two loops, two heights',
    profile: 'realistic',
    guided: false,
    brief: 'Realistic mode: no altitude hold, real wind. One loop each way, alternating 1.9 and 3.4 m.',
    tip: 'The cross-over is the hard part. Set the height before the turn, not during it.',
    tyres: figureEight(),
  },
];

export const FREE = {
  id: 'free',
  n: 0,
  name: 'Free flight',
  pattern: 'No course, no objectives',
  profile: 'cruise',
  guided: false,
  brief: 'Open field. Nothing is scored and nothing is explained.',
  tip: '',
  tyres: [],
};

/* ------------------------------------------------------------------ */
/* the ideal line, sampled for the path box                            */
/* ------------------------------------------------------------------ */

/** Catmull-Rom through the tyre centres, so the path box can draw the target. */
export function idealPath(tyres, perSpan = 16) {
  if (!tyres.length) return [];
  const p = tyres.map((t) => t.pos);
  const pts = [];
  const at = (i) => p[clamp(i, 0, p.length - 1)];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < perSpan; s++) {
      const t = s / perSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      pts.push({
        x: f(p0.x, p1.x, p2.x, p3.x),
        y: f(p0.y, p1.y, p2.y, p3.y),
        z: f(p0.z, p1.z, p2.z, p3.z),
      });
    }
  }
  pts.push({ ...p[p.length - 1] });
  return pts;
}

/* ------------------------------------------------------------------ */
/* runner                                                              */
/* ------------------------------------------------------------------ */

export class TaskRunner {
  constructor(emit) {
    this.emit = emit || (() => {});
    this.load(FREE);
  }

  load(task) {
    this.task = task;
    this.tyres = task.tyres;
    this.path = idealPath(task.tyres);
    this.at = 0;
    this.prev = null;
    this.guideIndex = task.guided ? 0 : -1;
    this.guideMem = {};
    this.guideProgress = 0;
    this.phase = task.tyres.length === 0 ? 'free' : task.guided ? 'guide' : 'fly';
    this.clock = 0;
    this.running = false;
    this.complete = false;
    this.mem = {};
    this.detail = '';
    this.score = { time: 0, tyres: 0, total: task.tyres.length, misses: 0, bumps: 0, landing: null };
  }

  restart() {
    this.load(this.task);
  }

  get guide() {
    return this.guideIndex >= 0 ? GUIDE[this.guideIndex] || null : null;
  }

  get guideCount() {
    return GUIDE.length;
  }

  /** 0..1 across the whole task, for the progress bar. */
  get progress() {
    if (this.phase === 'free') return 0;
    if (this.complete) return 1;
    if (this.phase === 'guide') return 0;
    return clamp(this.at / (this.tyres.length + 1), 0, 1); // tyres plus the landing
  }

  /** One line telling the pilot what to do right now. */
  get objective() {
    if (this.phase === 'free') return 'Free flight — nothing is scored';
    if (this.complete) return 'Course complete';
    if (this.phase === 'guide') return this.guide ? this.guide.title : '';
    if (this.phase === 'land') return 'Land back on the pad';
    return `Fly through tyre ${this.at + 1} of ${this.tyres.length}`;
  }

  get hint() {
    if (this.phase === 'guide' && this.guide) return this.guide.body;
    if (this.phase === 'free') return '';
    return this.task.tip;
  }

  /**
   * @param {number} dt
   * @param {object} drone
   * @param {object} input  {roll,pitch,yaw,thr}
   * @param {object} ui     {camChanges}
   */
  update(dt, drone, input, ui) {
    if (this.phase === 'free' || this.complete) {
      this.prev = { x: drone.pos.x, y: drone.pos.y, z: drone.pos.z };
      return;
    }

    const ctx = { drone, input, ui, tyres: this.tyres, score: this.score, emit: this.emit };

    if (this.phase === 'guide') {
      this.stepGuide(dt, ctx);
      // Guidance does not lock the drone out — a pilot who is already flying the
      // course gets the steps ticked off behind them.
    }

    if (this.running) this.clock += dt;
    this.score.bumps = drone.bumps;

    if (this.phase !== 'land') this.checkTyre(drone);
    else this.checkLanding(drone);

    this.prev = { x: drone.pos.x, y: drone.pos.y, z: drone.pos.z };
  }

  stepGuide(dt, ctx) {
    const step = this.guide;
    if (!step) {
      this.phase = 'fly';
      this.guideIndex = -1;
      return;
    }
    const p = clamp(step.test(ctx, dt, this.guideMem) || 0, 0, 1);
    this.guideProgress = p;
    this.detail = this.guideMem.detail || '';
    if (p >= 1) {
      this.guideIndex++;
      this.guideMem = {};
      this.guideProgress = 0;
      if (this.guideIndex >= GUIDE.length) {
        this.guideIndex = -1;
        this.phase = 'fly';
        this.emit('guide-done');
      } else {
        this.emit('guide-step');
      }
    }
  }

  /** Plane-crossing test against the tyre we are currently chasing. */
  checkTyre(drone) {
    const t = this.tyres[this.at];
    if (!t) return;
    const cur = drone.pos;
    if (!this.prev) return;

    const nx = Math.sin(t.yaw);
    const nz = Math.cos(t.yaw);
    const s0 = (this.prev.x - t.pos.x) * nx + (this.prev.z - t.pos.z) * nz;
    const s1 = (cur.x - t.pos.x) * nx + (cur.z - t.pos.z) * nz;

    if (!this.running && drone.airborne) this.running = true;
    this.detail = `tyre ${this.at + 1}/${this.tyres.length} · ${this.clock.toFixed(1)}s`;

    // Only a crossing from behind the gate to in front of it counts.
    if (!(s0 < 0 && s1 >= 0)) return;
    const f = s0 / (s0 - s1 || 1e-6);
    const px = this.prev.x + (cur.x - this.prev.x) * f;
    const py = this.prev.y + (cur.y - this.prev.y) * f;
    const pz = this.prev.z + (cur.z - this.prev.z) * f;

    // Offset inside the ring plane.
    const ux = Math.cos(t.yaw);
    const uz = -Math.sin(t.yaw);
    const du = (px - t.pos.x) * ux + (pz - t.pos.z) * uz;
    const dv = py - t.pos.y;
    const off = Math.hypot(du, dv);

    if (off <= t.radius) {
      this.at++;
      this.score.tyres++;
      this.score.time = this.clock;
      this.emit('tyre');
      if (this.at >= this.tyres.length) {
        this.phase = 'land';
        this.emit('course-done');
      }
    } else if (off < t.radius * 2.4) {
      this.score.misses++;
      this.emit('miss');
    }
  }

  checkLanding(drone) {
    this.detail = `course ${this.score.time.toFixed(1)}s · ${this.score.misses} missed · ${this.score.bumps} hits`;
    if (drone.airborne || drone.altitude > 0.08) return;
    const off = dist2D(drone.pos, PAD);
    if (off > 1.4) {
      this.detail = `${off.toFixed(1)} m off the pad — take off and put it down on the H`;
      return;
    }
    this.score.landing = off;
    this.running = false;
    this.complete = true;
    this.emit('task-complete');
  }
}
