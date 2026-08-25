/**
 * Flight model.
 *
 * A real multirotor, modelled the way one actually behaves:
 *
 *   - thrust acts along the BODY up axis, never straight up. Tilt the craft and
 *     you trade lift for horizontal acceleration, so you sink unless you add
 *     throttle. This single fact is what makes real drones hard.
 *   - attitude is a second-order system (angular acceleration -> rate -> angle),
 *     so the craft overshoots, has momentum, and cannot stop instantly.
 *   - motors spool up with a lag, the pack sags under load, and the airframe
 *     sees quadratic drag against a moving air mass, not against the ground.
 *   - ground effect adds lift in the last rotor-span above the surface.
 *
 * Everything is metres, seconds, radians.
 */

const G = 9.81;
const DEG = Math.PI / 180;

export const PROFILES = {
  beginner: {
    label: 'Beginner',
    blurb: 'Altitude hold, gentle tilt, still air. The flight controller holds the hover for you.',
    maxTilt: 16 * DEG,
    maxRate: 180 * DEG,
    yawRate: 80 * DEG,
    climbRate: 1.8,
    attP: 130,
    attD: 19,
    motorTau: 0.10,
    twr: 2.0,
    drag: 1.05,
    dragQ: 0.02,
    dragV: 0.9,
    expo: 0.45,
    altHold: true,
    wind: 0,
    forgiving: true,
  },
  sport: {
    label: 'Sport',
    blurb: 'More tilt, quicker yaw, a real breeze. Altitude hold is still watching your back.',
    maxTilt: 28 * DEG,
    maxRate: 260 * DEG,
    yawRate: 150 * DEG,
    climbRate: 3.2,
    attP: 200,
    attD: 24,
    motorTau: 0.08,
    twr: 2.3,
    drag: 0.78,
    dragQ: 0.035,
    dragV: 0.7,
    expo: 0.3,
    altHold: true,
    wind: 0.7,
    forgiving: false,
  },
  cruise: {
    label: 'Cruise',
    blurb:
      'Realistic tilt, momentum and wind, but the flight controller holds height for you. ' +
      'The throttle stick springs back to centre and the drone stays at the altitude you left it.',
    maxTilt: 32 * DEG,
    maxRate: 300 * DEG,
    yawRate: 180 * DEG,
    climbRate: 2.6,
    attP: 220,
    attD: 25,
    motorTau: 0.07,
    twr: 2.4,
    drag: 0.55,
    dragQ: 0.05,
    dragV: 0.6,
    expo: 0.28,
    altHold: true,
    wind: 1.2,
    forgiving: false,
  },
  realistic: {
    label: 'Realistic',
    blurb: 'No altitude hold. Raw throttle, real momentum, gusting wind, battery sag. Nothing helps you.',
    maxTilt: 35 * DEG,
    maxRate: 320 * DEG,
    yawRate: 200 * DEG,
    climbRate: 0,
    attP: 240,
    attD: 26,
    motorTau: 0.065,
    twr: 2.5,
    drag: 0.50,
    dragQ: 0.055,
    dragV: 0.55,
    expo: 0.25,
    altHold: false,
    wind: 1.5,
    forgiving: false,
  },
  acro: {
    label: 'Acro',
    blurb: 'Rate mode. The sticks command rotation speed, not angle — let go and it stays where you left it.',
    acro: true,
    maxTilt: 90 * DEG,
    maxRate: 420 * DEG,
    rateTau: 0.045,
    yawRate: 280 * DEG,
    climbRate: 0,
    attP: 0,
    attD: 0,
    motorTau: 0.055,
    twr: 2.8,
    drag: 0.45,
    dragQ: 0.06,
    dragV: 0.5,
    expo: 0.3,
    altHold: false,
    wind: 1.5,
    forgiving: false,
  },
};

export const GEOFENCE = { radius: 58, ceiling: 40 };

const ROTOR_SPAN = 0.32; // used for ground effect and the collision radius

/* Return-to-home. The cruise height clears the tallest tyre on any course and
   the scenery around the field, so the way back is never through something. */
const RTH_ALT = 8;
const RTH_REF_SPEED = 12; // speed at which the approach brake is fully applied

/* Flips, the way a Tello does them: a hop to buy room, a fast ballistic roll
   through 360°, then catch it. The Tello refuses below 50% battery; so do we,
   and it also wants height, because a flip costs about a metre. */
const FLIP = { boost: 0.14, spin: 0.42, recover: 0.18 };
const FLIP_MIN_BATTERY = 50;
const FLIP_MIN_ALT = 1.5;

/** Which angle a flip drives, and which way round. */
const FLIP_DIRS = {
  fwd:   { axis: 'pitch', sign: +1 },
  back:  { axis: 'pitch', sign: -1 },
  right: { axis: 'roll',  sign: +1 },
  left:  { axis: 'roll',  sign: -1 },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Softens the middle of the stick so small corrections stay small. */
function expo(x, e) {
  return (1 - e) * x + e * x * x * x;
}

export class Drone {
  constructor() {
    this.reset();
  }

  reset(pad = { x: 0, z: 0 }) {
    this.pos = { x: pad.x, y: 0.06, z: pad.z };
    /** Where "home" is for return-to-home: the pad it was last placed on. */
    this.home = { x: pad.x, z: pad.z };
    this.vel = { x: 0, y: 0, z: 0 };
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.rollRate = 0;
    this.pitchRate = 0;
    this.yawRateV = 0;
    this.throttle = 0; // actual motor output 0..1, after spool-up lag
    this.armed = false;
    this.airborne = false;
    this.crashed = false;
    this.crashReason = '';
    this.battery = 100;
    this.holdAlt = 0;
    this.flightTime = 0;
    this.bumps = 0;
    this.bumpCooldown = 0;
    this.autopilot = null; // 'takeoff' | 'land' | 'rth' | 'flip' | null
    this.rthStage = '';    // 'climb' | 'cruise' | 'descend', while autopilot is 'rth'
    this.flipT = 0;        // seconds into the current flip
    this.flipAxis = '';
    this.flipSign = 1;
    this.flipRefused = '';  // why the last flip request was turned down
    this.wind = { x: 0, y: 0, z: 0 };
    this.windDir = Math.random() * Math.PI * 2;
    this.gLoad = 1;
    this.events = [];
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  get altitude() {
    return Math.max(0, this.pos.y - 0.06);
  }

  /** Wind strength the pilot can actually feel, m/s. */
  get windSpeed() {
    return Math.hypot(this.wind.x, this.wind.z);
  }

  /** Unit vector the nose points along (model faces -Z at yaw 0). */
  nose() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  right() {
    return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) };
  }

  /** Body up axis in world space — the direction thrust actually points. */
  bodyUp() {
    const sr = Math.sin(this.roll);
    const cr = Math.cos(this.roll);
    const sp = Math.sin(this.pitch);
    const cp = Math.cos(this.pitch);
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);

    // Exact up vector for YXZ order (Roll around Z, Pitch around X, Yaw around Y)
    const ux = sr * cy - sp * cr * sy;
    const uy = cp * cr;
    const uz = -sr * sy - sp * cr * cy;

    const l = Math.hypot(ux, uy, uz) || 1;
    return { x: ux / l, y: uy / l, z: uz / l };
  }

  arm(on) {
    if (this.crashed) return;
    if (on === this.armed) return;
    this.armed = on;
    if (!on) {
      this.autopilot = null;
      this.throttle = 0;
    }
    this.events.push(on ? 'armed' : 'disarmed');
  }

  takeoff() {
    if (this.crashed) return;
    this.armed = true;
    this.autopilot = 'takeoff';
    this.holdAlt = 1.2;
  }

  land() {
    if (this.crashed || !this.airborne) return;
    this.autopilot = 'land';
  }

  /**
   * Return to home — the one button every real drone has and every beginner
   * needs, because the usual way a first flight ends is the drone somewhere
   * out over the fence and the pilot with no idea which way is back.
   *
   * Three stages, the same order a real flight controller uses:
   *   climb   — get above the tyres and the scenery before going anywhere
   *   cruise  — fly home, nose pointed the way it is travelling
   *   descend — once over the pad, put it down
   */
  returnHome() {
    if (this.crashed || !this.airborne) return;
    this.autopilot = 'rth';
    this.rthStage = this.altitude < RTH_ALT - 0.4 ? 'climb' : 'cruise';
    this.events.push('rth');
  }

  /** Distance from the home pad on the flat, metres. */
  get homeDist() {
    return Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.z);
  }

  /**
   * A Tello-style flip. `dir` is 'fwd' | 'back' | 'left' | 'right'.
   *
   * Returns true if it is going to happen. The refusals are the interesting
   * part: a flip is ballistic, so it costs about a metre of height and a good
   * bite of battery, and a quad that tries one too low or too flat just breaks
   * itself. `flipRefused` carries the reason so the UI can say it out loud.
   */
  flip(dir) {
    const d = FLIP_DIRS[dir];
    this.flipRefused = '';
    if (!d || this.crashed) return false;
    if (this.autopilot === 'flip') return false;           // one at a time
    if (!this.airborne || !this.armed) {
      this.flipRefused = 'Take off first';
    } else if (this.battery < FLIP_MIN_BATTERY) {
      this.flipRefused = `Needs ${FLIP_MIN_BATTERY}% battery`;
    } else if (this.altitude < FLIP_MIN_ALT) {
      this.flipRefused = `Climb to ${FLIP_MIN_ALT} m first`;
    }
    if (this.flipRefused) {
      this.events.push('flip-refused');
      return false;
    }

    this.autopilot = 'flip';
    this.flipAxis = d.axis;
    this.flipSign = d.sign;
    this.flipT = 0;
    this.events.push('flip');
    return true;
  }

  /**
   * One step of a flip. This bypasses the attitude PD loop entirely and drives
   * the angle straight through 360°, because the loop has a tilt limit and the
   * whole point of a flip is to go past it.
   */
  updateFlip(dt, p) {
    const total = FLIP.boost + FLIP.spin + FLIP.recover;
    this.flipT += dt;
    const t = this.flipT;
    let thr;

    if (t < FLIP.boost) {
      // Hop, to buy the height the inverted half is about to cost.
      thr = 1;
    } else if (t < FLIP.boost + FLIP.spin) {
      // Through the roll. Thrust is near zero because for half of this the
      // motors are pointing at the sky — this is the part that makes it drop.
      thr = 0.1;
      const u = (t - FLIP.boost) / FLIP.spin;
      const a = 2 * Math.PI * u * this.flipSign;
      if (this.flipAxis === 'pitch') { this.pitch = a; this.roll = 0; }
      else { this.roll = a; this.pitch = 0; }
    } else {
      // Upright again: catch it before it hits anything.
      this.roll = 0;
      this.pitch = 0;
      this.rollRate = 0;
      this.pitchRate = 0;
      thr = 1;
    }

    this.yawRateV = 0;
    this.updateForces(dt, p, thr * 2 - 1, true);

    if (t >= total) {
      this.roll = 0;
      this.pitch = 0;
      this.rollRate = 0;
      this.pitchRate = 0;
      this.autopilot = null;
      this.flipT = 0;
      this.holdAlt = null;   // let altitude hold re-latch wherever it ended up
      this.events.push('flip-done');
    }
  }

  /**
   * @param {number} dt      seconds
   * @param {object} input   {roll,pitch,yaw,thr} each -1..1
   * @param {object} p       one of PROFILES
   * @param {object} world   {obstacles:[{min,max}]}
   */
  update(dt, input, p, world) {
    dt = Math.min(dt, 1 / 30);
    if (this.crashed) {
      this.settle(dt);
      return;
    }

    let sRoll = expo(clamp(input.roll || 0, -1, 1), p.expo);
    let sPitch = expo(clamp(input.pitch || 0, -1, 1), p.expo);
    let sYaw = expo(clamp(input.yaw || 0, -1, 1), p.expo);
    let sThr = clamp(input.thr || 0, -1, 1);

    // Autopilot overrides the sticks for takeoff and landing. In manual
    // profiles it flies a real altitude loop rather than teleporting.
    if (this.autopilot === 'takeoff') {
      sRoll = sPitch = sYaw = 0;
      sThr = p.altHold ? (this.altitude < 1.15 ? 1 : 0) : this.autoThrottle(1.2, p);
      if (this.altitude >= 1.1 && Math.abs(this.vel.y) < 0.5) {
        this.autopilot = null;
        this.events.push('hover');
      }
    } else if (this.autopilot === 'land') {
      sRoll = sPitch = sYaw = 0;
      const target = this.altitude > 0.35 ? -0.55 : -0.3;
      sThr = p.altHold ? target : this.autoDescend(p);
    } else if (this.autopilot === 'rth') {
      const cmd = this.flyHome(p);
      sRoll = cmd.roll;
      sPitch = cmd.pitch;
      sYaw = cmd.yaw;
      sThr = cmd.thr;
    }

    if (!this.armed) {
      this.throttle = 0;
      this.vel.y -= G * dt;
      this.integrate(dt);
      this.groundContact(p, true);
      return;
    }

    this.flightTime += dt;
    this.updateWind(dt, p);

    // A flip drives the attitude itself and past the tilt limit, so it replaces
    // the attitude loop rather than feeding it.
    if (this.autopilot === 'flip') {
      this.updateFlip(dt, p);
    } else {
      this.updateAttitude(dt, p, sRoll, sPitch, sYaw);
      this.updateForces(dt, p, sThr);
    }
    this.integrate(dt);

    this.fence();
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);
    this.collide(world, p);
    this.ringCollide(world, p);
    this.groundContact(p, false);
    this.updateBattery(dt);
  }

  /* ---------------- attitude ---------------- */

  updateAttitude(dt, p, sRoll, sPitch, sYaw) {
    if (p.acro) {
      // Rate mode: the stick is an angular velocity demand.
      const k = 1 - Math.exp(-dt / p.rateTau);
      this.rollRate += (sRoll * p.maxRate - this.rollRate) * k;
      this.pitchRate += (sPitch * p.maxRate - this.pitchRate) * k;
    } else {
      // Angle mode: a PD loop chases the commanded tilt, so the airframe has
      // real inertia — it leans in, overshoots slightly, and settles.
      const cmdRoll = sRoll * p.maxTilt;
      const cmdPitch = sPitch * p.maxTilt;
      this.rollRate += (p.attP * (cmdRoll - this.roll) - p.attD * this.rollRate) * dt;
      this.pitchRate += (p.attP * (cmdPitch - this.pitch) - p.attD * this.pitchRate) * dt;
      this.rollRate = clamp(this.rollRate, -p.maxRate, p.maxRate);
      this.pitchRate = clamp(this.pitchRate, -p.maxRate, p.maxRate);
    }

    this.roll += this.rollRate * dt;
    this.pitch += this.pitchRate * dt;

    const lim = p.acro ? 179 * DEG : p.maxTilt * 1.3;
    if (this.roll > lim) { this.roll = lim; this.rollRate = Math.min(0, this.rollRate); }
    if (this.roll < -lim) { this.roll = -lim; this.rollRate = Math.max(0, this.rollRate); }
    if (this.pitch > lim) { this.pitch = lim; this.pitchRate = Math.min(0, this.pitchRate); }
    if (this.pitch < -lim) { this.pitch = -lim; this.pitchRate = Math.max(0, this.pitchRate); }

    const kY = 1 - Math.exp(-dt / 0.09);
    this.yawRateV += (sYaw * p.yawRate - this.yawRateV) * kY;
    this.yaw += this.yawRateV * dt;
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
  }

  /* ---------------- wind ---------------- */

  updateWind(dt, p) {
    const w = p.wind || 0;
    if (w <= 0) {
      this.wind.x = this.wind.y = this.wind.z = 0;
      return;
    }
    const t = this.flightTime;
    const bx = Math.cos(this.windDir);
    const bz = Math.sin(this.windDir);
    // Slow gust envelope plus three-octave turbulence.
    const gust = 0.62 + 0.38 * Math.sin(t * 0.17) * Math.sin(t * 0.41 + 1.3);
    const turb = (a, b, c, ph) =>
      Math.sin(t * a + ph) * 0.5 + Math.sin(t * b + ph * 1.7) * 0.3 + Math.sin(t * c + ph * 3.1) * 0.2;
    // The boundary layer: still near the grass, stronger with height.
    const grad = 0.5 + 0.5 * Math.min(1, this.altitude / 9);
    this.wind.x = w * grad * (bx * gust + 0.38 * turb(0.73, 1.9, 3.7, 0.2));
    this.wind.z = w * grad * (bz * gust + 0.38 * turb(0.61, 2.3, 3.1, 1.4));
    this.wind.y = w * 0.2 * turb(0.9, 2.1, 4.3, 2.6);
  }

  /* ---------------- thrust, drag, gravity ---------------- */

  updateForces(dt, p, sThr, raw = false) {
    const up = this.bodyUp();
    let thrCmd;

    if (p.altHold && !raw) {
      // The flight controller works out the throttle for you — including the
      // extra it needs to stay level while the craft is tilted over.
      let targetVy;
      if (Math.abs(sThr) < 0.06 && this.airborne) {
        if (this.holdAlt == null) this.holdAlt = this.pos.y;
        targetVy = clamp((this.holdAlt - this.pos.y) * 1.8, -1.4, 1.4);
      } else {
        this.holdAlt = null;
        targetVy = sThr * p.climbRate;
      }
      const want = (targetVy - this.vel.y) * 4.2 + G;
      thrCmd = clamp(want / (p.twr * G * Math.max(0.35, up.y)), 0, 1);
      // Sitting on the ground with the stick centred means idle, not hover —
      // otherwise ground effect alone would float the drone off the pad.
      if (!this.airborne && sThr <= 0.06) thrCmd = 0.18;
    } else {
      thrCmd = (sThr + 1) / 2; // raw stick, hover sits near 1/TWR
    }

    // Motors cannot change speed instantly.
    const kM = 1 - Math.exp(-dt / p.motorTau);
    this.throttle += (thrCmd - this.throttle) * kM;

    const charge = this.battery / 100;
    const sag = 1 - 0.10 * (1 - charge) - 0.07 * this.throttle * (1 - charge);
    const T = p.twr * G * this.throttle * sag * this.groundEffect();
    this.gLoad = T / G;

    let ax = T * up.x;
    let ay = T * up.y - G;
    let az = T * up.z;

    // Drag acts against the air mass, so a headwind pushes you even at a hover.
    const rx = this.vel.x - this.wind.x;
    const ry = this.vel.y - this.wind.y;
    const rz = this.vel.z - this.wind.z;
    const rs = Math.hypot(rx, ry, rz);
    ax -= p.drag * rx + p.dragQ * rs * rx;
    az -= p.drag * rz + p.dragQ * rs * rz;
    ay -= p.dragV * ry + p.dragQ * 0.8 * rs * ry;

    this.vel.x += ax * dt;
    this.vel.y += ay * dt;
    this.vel.z += az * dt;
  }

  /** Extra lift in the last rotor-span above the surface. */
  groundEffect() {
    const h = this.altitude;
    const reach = ROTOR_SPAN * 3;
    if (h > reach) return 1;
    const k = 1 - h / reach;
    return 1 + 0.14 * k * k;
  }

  /** Throttle stick value that would hold `alt`, for autopilot in manual modes. */
  autoThrottle(alt, p) {
    const err = alt - this.altitude;
    const targetVy = clamp(err * 1.6, -1.2, 1.6);
    const want = (targetVy - this.vel.y) * 3.4 + G;
    const t = clamp(want / (p.twr * G * Math.max(0.4, this.bodyUp().y)), 0, 1);
    return t * 2 - 1;
  }

  /**
   * One step of return-to-home. Returns stick commands in the same -1..1 shape
   * the pilot's sticks use, so the rest of the flight model is untouched — RTH
   * flies the drone exactly the way a person would, it just holds the sticks
   * itself. That also means wind still pushes it around on the way back, which
   * is the honest behaviour.
   */
  flyHome(p) {
    const dx = this.home.x - this.pos.x;
    const dz = this.home.z - this.pos.z;
    const dist = Math.hypot(dx, dz);

    // --- stage machine ---
    if (this.rthStage === 'climb' && this.altitude >= RTH_ALT - 0.3) this.rthStage = 'cruise';
    if (this.rthStage === 'cruise' && dist < 0.6) this.rthStage = 'descend';
    // Blown off the pad on the way down — go back and try again.
    if (this.rthStage === 'descend' && dist > 2.2 && this.altitude > 1.2) this.rthStage = 'cruise';

    if (this.rthStage === 'descend') {
      const done = !this.airborne;
      if (done) {
        this.autopilot = null;
        this.rthStage = '';
      }
      // Keep nudging back over the pad while it sinks.
      const hold = this.holdToward(dx, dz, p, 0.35);
      return {
        roll: hold.roll,
        pitch: hold.pitch,
        yaw: 0,
        thr: p.altHold ? (this.altitude > 0.35 ? -0.55 : -0.3) : this.autoDescend(p),
      };
    }

    // --- climb and cruise ---
    // Ease off as it arrives so it settles over the pad instead of sailing past.
    const gain = this.rthStage === 'climb' ? 0 : Math.min(1, dist / 6);
    const hold = this.holdToward(dx, dz, p, gain);

    // Point the nose the way it is going. Not required, but it is what a real
    // RTH does and it makes the last stretch readable from the ground.
    let yaw = 0;
    if (dist > 2) {
      // Model faces -Z at yaw 0, so this is the heading that puts home ahead.
      const want = Math.atan2(-dx, -dz);
      let err = want - this.yaw;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      yaw = clamp(err * 1.1, -0.7, 0.7);
    }

    const thr = p.altHold ? clamp((RTH_ALT - this.altitude) * 0.9, -0.6, 1) : this.autoThrottle(RTH_ALT, p);
    return { roll: hold.roll, pitch: hold.pitch, yaw, thr };
  }

  /**
   * Stick deflection that flies toward a world-frame offset. The sticks are
   * relative to the nose, so the offset is rotated into the body frame first —
   * the same mental step the pilot has to make, done properly.
   */
  holdToward(dx, dz, p, gain) {
    if (gain <= 0) return { roll: 0, pitch: 0 };
    const dist = Math.hypot(dx, dz) || 1;
    // Unit vector to home, in the world.
    const wx = dx / dist;
    const wz = dz / dist;

    // Project onto the body axes. Positive pitch accelerates along the nose and
    // positive roll to the right, so these components are the sticks directly.
    const n = this.nose();
    const r = this.right();
    const fwd = wx * n.x + wz * n.z;
    const right = wx * r.x + wz * r.z;

    // Bleed off speed as it closes so it does not overshoot the pad.
    const brake = clamp(1 - this.speed / RTH_REF_SPEED, 0.15, 1);
    const g = gain * brake;
    return { roll: clamp(right * g, -1, 1), pitch: clamp(fwd * g, -1, 1) };
  }

  autoDescend(p) {
    const targetVy = this.altitude > 0.4 ? -0.9 : -0.35;
    const want = (targetVy - this.vel.y) * 3.4 + G;
    const t = clamp(want / (p.twr * G * Math.max(0.4, this.bodyUp().y)), 0, 1);
    return t * 2 - 1;
  }

  updateBattery(dt) {
    // Hovering is most of the drain; hard throttle and high speed cost more.
    const load = 0.5 + this.throttle * this.throttle * 1.1 + this.speed * 0.035;
    this.battery = Math.max(0, this.battery - (load * 100 * dt) / 430);
    if (this.battery <= 0 && this.airborne && this.autopilot !== 'land') {
      this.autopilot = 'land';
      this.events.push('battery-empty');
    }
  }

  integrate(dt) {
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
  }

  fence() {
    const d = Math.hypot(this.pos.x, this.pos.z);
    if (d > GEOFENCE.radius) {
      const k = GEOFENCE.radius / d;
      this.pos.x *= k;
      this.pos.z *= k;
      this.vel.x *= 0.2;
      this.vel.z *= 0.2;
      this.events.push('fence');
    }
    if (this.pos.y > GEOFENCE.ceiling) {
      this.pos.y = GEOFENCE.ceiling;
      this.vel.y = Math.min(0, this.vel.y);
      this.events.push('ceiling');
    }
  }

  collide(world, p) {
    const R = 0.22;
    for (const b of world.obstacles || []) {
      const cx = clamp(this.pos.x, b.min.x, b.max.x);
      const cy = clamp(this.pos.y, b.min.y, b.max.y);
      const cz = clamp(this.pos.z, b.min.z, b.max.z);
      const dx = this.pos.x - cx;
      const dy = this.pos.y - cy;
      const dz = this.pos.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R * R) continue;

      const impact = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
      const d = Math.sqrt(d2);

      if (d < 1e-4) {
        // Centre is inside the box: leave by the nearest face.
        const out = [
          [b.min.x - this.pos.x - R, -1, 0, 0],
          [this.pos.x - b.max.x - R, 1, 0, 0],
          [b.min.y - this.pos.y - R, 0, -1, 0],
          [this.pos.y - b.max.y - R, 0, 1, 0],
          [b.min.z - this.pos.z - R, 0, 0, -1],
          [this.pos.z - b.max.z - R, 0, 0, 1],
        ].sort((a, c) => Math.abs(a[0]) - Math.abs(c[0]))[0];
        this.pos.x += out[1] * (Math.abs(out[0]) + 0.01);
        this.pos.y += out[2] * (Math.abs(out[0]) + 0.01);
        this.pos.z += out[3] * (Math.abs(out[0]) + 0.01);
        this.vel.x *= -0.15;
        this.vel.y *= -0.15;
        this.vel.z *= -0.15;
        this.registerBump();
        continue;
      }

      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      this.pos.x = cx + nx * (R + 0.01);
      this.pos.y = cy + ny * (R + 0.01);
      this.pos.z = cz + nz * (R + 0.01);
      this.vel.x *= -0.15;
      this.vel.y *= -0.15;
      this.vel.z *= -0.15;

      if (!p.forgiving && impact > 3.5) this.crash('Hit an obstacle');
      else this.registerBump();
    }
  }

  /**
   * Tyre rims are solid rubber. A torus is cheap to test exactly, so clipping
   * the rim bounces you off it the way it would in the field.
   * @param {{rings?:Array}} world
   */
  ringCollide(world, p) {
    const R = 0.22;
    for (const t of world.rings || []) {
      // Into the tyre's own frame: u across the gate, v up, w through it.
      const dx = this.pos.x - t.pos.x;
      const dy = this.pos.y - t.pos.y;
      const dz = this.pos.z - t.pos.z;
      const sy = Math.sin(t.yaw);
      const cy = Math.cos(t.yaw);
      const lu = dx * cy - dz * sy;   // u = (cos yaw, 0, -sin yaw)
      const lv = dy;
      const lw = dx * sy + dz * cy;   // w = (sin yaw, 0,  cos yaw)

      const radial = Math.hypot(lu, lv);
      if (radial < 1e-5) continue;
      const qx = radial - t.radius;
      const qy = lw;
      const ql = Math.hypot(qx, qy);
      const gap = ql - t.tube - R;
      if (gap >= 0) continue;

      // Surface normal of the torus, pushed back into world space.
      const gx = (qx / (ql || 1)) * (lu / radial);
      const gy = (qx / (ql || 1)) * (lv / radial);
      const gw = qy / (ql || 1);
      const nx = gx * cy + gw * sy;
      const ny = gy;
      const nz = -gx * sy + gw * cy;
      const nl = Math.hypot(nx, ny, nz) || 1;

      const impact = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
      const push = -gap + 0.005;
      this.pos.x += (nx / nl) * push;
      this.pos.y += (ny / nl) * push;
      this.pos.z += (nz / nl) * push;

      // Kill the velocity into the rim, keep a little of the slide along it.
      const vn = (this.vel.x * nx + this.vel.y * ny + this.vel.z * nz) / nl;
      if (vn < 0) {
        this.vel.x -= (1.25 * vn * nx) / nl;
        this.vel.y -= (1.25 * vn * ny) / nl;
        this.vel.z -= (1.25 * vn * nz) / nl;
        this.vel.x *= 0.7;
        this.vel.y *= 0.7;
        this.vel.z *= 0.7;
      }

      if (!p.forgiving && impact > 4.5) this.crash('Clipped a tyre');
      else this.registerBump();
    }
  }

  registerBump() {
    if (this.bumpCooldown > 0) return;
    this.bumps++;
    this.bumpCooldown = 0.6;
    this.events.push('bump');
  }

  groundContact(p, motorsOff) {
    const floor = 0.06;
    if (this.pos.y > floor) {
      if (this.pos.y > floor + 0.06) this.airborne = true;
      return;
    }

    const vy = this.vel.y;
    const wasAirborne = this.airborne;
    const wasLanding = this.autopilot === 'land';
    this.pos.y = floor;

    const tilt = Math.max(Math.abs(this.roll), Math.abs(this.pitch));
    const harsh = -vy > 2.6 || (tilt > 32 * DEG && -vy > 1.2);

    if (wasAirborne && harsh && !p.forgiving && !motorsOff) {
      this.crash(tilt > 32 * DEG ? 'Tipped over on touchdown' : 'Landed too hard');
      return;
    }

    if (wasAirborne && -vy > 1.4) {
      this.events.push('hard-landing');
      this.bumps++;
    } else if (wasAirborne) {
      this.events.push('landed');
    }

    this.vel.y = 0;
    this.vel.x *= 0.7;
    this.vel.z *= 0.7;
    this.rollRate = this.pitchRate = 0;
    this.airborne = false;
    // A takeoff survives contact with the ground — it starts there, and the
    // motors need a tenth of a second to spool up before the craft can lift.
    // Clearing it here would cancel every takeoff on its first frame.
    if (this.autopilot !== 'takeoff') this.autopilot = null;
    this.holdAlt = null;
    if (wasLanding || motorsOff) this.armed = false;
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.armed = false;
    this.airborne = false;
    this.throttle = 0;
    this.crashReason = reason;
    this.events.push('crash');
  }

  settle(dt) {
    this.vel.y -= G * dt;
    this.integrate(dt);
    if (this.pos.y < 0.06) {
      this.pos.y = 0.06;
      this.vel = { x: 0, y: 0, z: 0 };
      this.roll = lerp(this.roll, 0.5, 0.05);
    }
  }
}
