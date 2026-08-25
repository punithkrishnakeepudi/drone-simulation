/**
 * Audio — the noise a small quad actually makes.
 *
 * Everything here is synthesised. No sample files: the whole point of this
 * project is that it runs off a laptop hotspot with no internet, and a
 * synthesised motor can follow throttle, stick input and distance continuously
 * in a way a looping sample never can.
 *
 * What makes a quad sound like a quad rather than like a wasp:
 *
 *   1. Blade-pass tone. Each prop makes a tone at RPM/60 × blades, so the pitch
 *      rides the throttle. That is the buzz.
 *   2. Four of them, slightly apart. The motors never run at the same speed, so
 *      the four tones beat against each other and the buzz warbles. This is the
 *      single most recognisable part of the sound.
 *   3. The four speeds are not random — they are how the thing steers. Rolling
 *      right means the left pair speeds up and the right pair slows down, so
 *      the warble follows the sticks. You can hear a quad bite into a turn.
 *   4. Broadband prop wash on top, opening up with throttle.
 *   5. It is a long way away. Distance, stereo position and Doppler are all
 *      doing real work when the drone is 40 m out.
 */

const SPEED_OF_SOUND = 343;

/* A prop is closer to a sawtooth than a sine, but a raw sawtooth is far too
   harsh. These harmonic weights keep the fundamental and the first few
   partials and roll the rest away. */
const HARMONICS = [0, 1, 0.55, 0.32, 0.16, 0.09, 0.05, 0.03];

/* Front-left, front-right, rear-left, rear-right.
   Each row is how that motor responds to [pitch, roll, yaw] — the standard
   X-quad mix. Yaw signs alternate because diagonal pairs spin opposite ways. */
const MIX = [
  { pitch: +1, roll: -1, yaw: +1 },
  { pitch: +1, roll: +1, yaw: -1 },
  { pitch: -1, roll: -1, yaw: -1 },
  { pitch: -1, roll: +1, yaw: +1 },
];

/* Small fixed detunes so the four never phase-lock into one flat tone. */
const DETUNE = [0, 7, -5, 11];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class DroneAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.motors = [];
    this.prevDist = null;
  }

  /**
   * Must be called from inside a real click or key press — every browser
   * refuses to start an AudioContext otherwise. Safe to call repeatedly.
   */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    // --- master ---
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);

    // --- the airframe, out there in the world ---
    // Everything the drone itself makes goes through one panner, so distance,
    // stereo position and occlusion are handled in one place.
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 2.5;
    this.panner.maxDistance = 400;
    this.panner.rolloffFactor = 1.1;
    this.panner.connect(this.master);

    // A little air absorption: the far side of the field eats the top end.
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'lowpass';
    this.airFilter.frequency.value = 18000;
    this.airFilter.connect(this.panner);

    this.motorBus = ctx.createGain();
    this.motorBus.gain.value = 0;
    this.motorBus.connect(this.airFilter);

    // --- four motors ---
    const wave = ctx.createPeriodicWave(
      new Float32Array(HARMONICS.length),
      Float32Array.from(HARMONICS),
      { disableNormalization: false }
    );

    for (let i = 0; i < 4; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = 120;
      osc.detune.value = DETUNE[i];

      const gain = ctx.createGain();
      gain.gain.value = 0.25;
      osc.connect(gain).connect(this.motorBus);
      osc.start();
      this.motors.push({ osc, gain, mix: MIX[i] });
    }

    // --- prop wash: broadband, opens with throttle ---
    this.noiseBuf = whiteNoise(ctx, 2);

    this.wash = ctx.createBufferSource();
    this.wash.buffer = this.noiseBuf;
    this.wash.loop = true;
    this.washFilter = ctx.createBiquadFilter();
    this.washFilter.type = 'bandpass';
    this.washFilter.frequency.value = 900;
    this.washFilter.Q.value = 0.7;
    this.washGain = ctx.createGain();
    this.washGain.gain.value = 0;
    this.wash.connect(this.washFilter).connect(this.washGain).connect(this.motorBus);
    this.wash.start();

    // --- wind, at the pilot's ear rather than out at the drone ---
    this.gust = ctx.createBufferSource();
    this.gust.buffer = this.noiseBuf;
    this.gust.loop = true;
    this.gustFilter = ctx.createBiquadFilter();
    this.gustFilter.type = 'bandpass';
    this.gustFilter.frequency.value = 420;
    this.gustFilter.Q.value = 0.5;
    this.gustGain = ctx.createGain();
    this.gustGain.gain.value = 0;
    this.gust.connect(this.gustFilter).connect(this.gustGain).connect(this.master);
    this.gust.start();
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setMuted(on) {
    this.muted = on;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(on ? 0 : 1, t, 0.05);
  }

  /** Park the context when the tab is hidden — it is pure battery otherwise. */
  setAwake(on) {
    if (!this.ctx) return;
    if (on) this.ctx.resume();
    else this.ctx.suspend();
  }

  /**
   * Per frame. `listener` is the camera — the drone is heard from wherever the
   * view is, so the nose camera puts you right on top of the motors and the
   * pilot view leaves them 30 m away.
   */
  update(dt, drone, profile, input, listener) {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const smooth = Math.max(0.012, dt * 0.9);

    // --- where everyone is standing ---
    const lp = listener.position;
    place(ctx.listener, lp, listener);
    this.panner.positionX ? setParam3(this.panner, drone.pos, t, smooth) : this.panner.setPosition(drone.pos.x, drone.pos.y, drone.pos.z);

    // --- Doppler ---
    // The spec dropped automatic Doppler years ago, so it is done by hand:
    // only the closing speed along the line of sight shifts the pitch.
    const dx = drone.pos.x - lp.x;
    const dy = drone.pos.y - lp.y;
    const dz = drone.pos.z - lp.z;
    const dist = Math.max(0.4, Math.hypot(dx, dy, dz));
    let doppler = 1;
    if (this.prevDist !== null && dt > 0) {
      const closing = (this.prevDist - dist) / dt;          // + = coming at you
      doppler = clamp(SPEED_OF_SOUND / (SPEED_OF_SOUND - closing), 0.88, 1.16);
    }
    this.prevDist = dist;

    // --- blade-pass frequency ---
    // Idle is the armed-but-sitting-there hum; the top end is a hard climb.
    // Working against gravity in a turn loads the motors, so gLoad pushes it up.
    const thr = drone.armed ? clamp(drone.throttle, 0, 1) : 0;
    const load = clamp(drone.gLoad, 0.4, 2.2);
    const base = (96 + 330 * Math.pow(thr, 0.82)) * (0.93 + 0.07 * load) * doppler;

    // The four motors split around that base exactly the way they steer.
    const cmdP = clamp(input.pitch, -1, 1);
    const cmdR = clamp(input.roll, -1, 1);
    const cmdY = clamp(input.yaw, -1, 1);
    for (const m of this.motors) {
      const diff = m.mix.pitch * cmdP + m.mix.roll * cmdR + m.mix.yaw * cmdY;
      const f = clamp(base * (1 + 0.085 * diff), 20, 6000);
      m.osc.frequency.setTargetAtTime(f, t, smooth);
    }

    // --- levels ---
    // Motors idle audibly and get loud fast; the wash follows throttle harder
    // than the tone does, which is what makes a hard climb sound like effort.
    const motorLevel = drone.armed ? 0.10 + 0.52 * Math.pow(thr, 1.15) : 0;
    this.motorBus.gain.setTargetAtTime(motorLevel, t, smooth);

    const washLevel = drone.armed ? 0.05 + 0.30 * Math.pow(thr, 1.5) : 0;
    this.washGain.gain.setTargetAtTime(washLevel, t, smooth);
    this.washFilter.frequency.setTargetAtTime(700 + 2300 * thr, t, smooth);

    // Air absorption over distance — a drone at the fence is all bottom end.
    this.airFilter.frequency.setTargetAtTime(clamp(19000 - dist * 260, 1400, 19000), t, smooth);

    // --- wind at the pilot, plus the rush of the drone's own airspeed ---
    const airspeed = drone.speed;
    const windLevel = clamp(drone.windSpeed * 0.012 + airspeed * 0.004, 0, 0.16);
    this.gustGain.gain.setTargetAtTime(windLevel, t, smooth);
    this.gustFilter.frequency.setTargetAtTime(360 + airspeed * 42 + drone.windSpeed * 30, t, smooth);
  }

  /**
   * One-shots. These are deliberately short and dry — anything longer stacks up
   * during a bad landing and turns to mud.
   */
  event(name) {
    if (!this.running) return;
    switch (name) {
      case 'crash':        this.thud(0.55, 90, 0.9); this.burst(0.45, 2600, 0.5); break;
      case 'hard-landing': this.thud(0.30, 120, 0.6); this.burst(0.16, 1500, 0.22); break;
      case 'landed':       this.thud(0.16, 150, 0.28); break;
      case 'bump':         this.burst(0.10, 1900, 0.20); break;
      case 'tyre':         this.whoosh(); break;
      case 'flip':         this.whoosh(); break;
      case 'flip-refused': this.beep(200, 0.12, 0.10); break;
      case 'rth':          this.beep(560, 0.08, 0.09); this.beep(760, 0.12, 0.09, 0.10); break;
      case 'rth-cancel':   this.beep(400, 0.10, 0.08); break;
      case 'armed':        this.beep(660, 0.07, 0.10); break;
      case 'disarmed':     this.beep(420, 0.09, 0.09); break;
      case 'fence':
      case 'ceiling':      this.beep(300, 0.13, 0.11); break;
      case 'battery-empty':this.beep(240, 0.30, 0.13); break;
      case 'task-complete':this.beep(720, 0.10, 0.11); this.beep(960, 0.16, 0.10, 0.11); break;
      case 'course-done':  this.beep(640, 0.10, 0.10); break;
      case 'guide-step':   this.beep(880, 0.05, 0.06); break;
      default: break;
    }
  }

  /** Low filtered noise — the airframe hitting the ground. */
  thud(dur, freq, level) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq * 4, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(f).connect(g).connect(this.panner);
    src.start(t);
    src.stop(t + dur);
  }

  /** Bright filtered noise — plastic on plastic. */
  burst(dur, freq, level) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.1;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 0.35), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(f).connect(g).connect(this.panner);
    src.start(t);
    src.stop(t + dur);
  }

  /** Passing through a tyre: a band of noise sweeping past your ear. */
  whoosh() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.34;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 3.2;
    f.frequency.setValueAtTime(420, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + dur * 0.45);
    f.frequency.exponentialRampToValueAtTime(520, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(f).connect(g).connect(this.panner);
    src.start(t);
    src.stop(t + dur);
  }

  /** Flight-controller tones. Not spatial — these are the pilot's own kit. */
  beep(freq, dur, level, delay = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

/* ---------------- helpers ---------------- */

function whiteNoise(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function setParam3(node, p, t, smooth) {
  node.positionX.setTargetAtTime(p.x, t, smooth);
  node.positionY.setTargetAtTime(p.y, t, smooth);
  node.positionZ.setTargetAtTime(p.z, t, smooth);
}

/**
 * Point the listener at whatever the camera is looking at. The modern
 * AudioParam form is preferred; the old setPosition/setOrientation pair is
 * still what some browsers ship, so both paths are kept.
 */
const fwd = { x: 0, y: 0, z: -1 };
function place(listener, pos, camera) {
  // -Z of the camera's world matrix is the direction it faces.
  const e = camera.matrixWorld.elements;
  fwd.x = -e[8];
  fwd.y = -e[9];
  fwd.z = -e[10];
  const upX = e[4];
  const upY = e[5];
  const upZ = e[6];

  if (listener.positionX) {
    listener.positionX.value = pos.x;
    listener.positionY.value = pos.y;
    listener.positionZ.value = pos.z;
    listener.forwardX.value = fwd.x;
    listener.forwardY.value = fwd.y;
    listener.forwardZ.value = fwd.z;
    listener.upX.value = upX;
    listener.upY.value = upY;
    listener.upZ.value = upZ;
  } else {
    listener.setPosition(pos.x, pos.y, pos.z);
    listener.setOrientation(fwd.x, fwd.y, fwd.z, upX, upY, upZ);
  }
}
