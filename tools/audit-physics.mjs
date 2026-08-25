/**
 * Flight model audit.
 *
 * Runs the real Drone against every profile and every autopilot, looking for
 * the things that make a trainer lie to you: NaN, drift on a centred stick,
 * a geofence that leaks, a battery that never runs out, an autopilot that
 * cannot be overridden.
 *
 *   node tools/audit-physics.mjs
 */
import { Drone, PROFILES, GEOFENCE } from '../public/js/physics.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const world = { obstacles: [], rings: [] };
const NEUTRAL = { roll: 0, pitch: 0, yaw: 0, thr: 0 };
const HZ = 120;

function fly(d, seconds, input = NEUTRAL, p = PROFILES.cruise) {
  for (let i = 0; i < seconds * HZ; i++) d.update(1 / HZ, input, p, world);
}

const finite = (d) =>
  [d.pos.x, d.pos.y, d.pos.z, d.vel.x, d.vel.y, d.vel.z, d.roll, d.pitch, d.yaw, d.throttle, d.battery]
    .every(Number.isFinite);

console.log('\n── Every profile ─────────────────────────────────');

for (const [key, p] of Object.entries(PROFILES)) {
  const d = new Drone();
  d.takeoff();
  fly(d, 6, NEUTRAL, p);
  check(`${key}: numbers stay finite`, finite(d), JSON.stringify({ y: d.pos.y, thr: d.throttle }));
  check(`${key}: leaves the ground`, d.altitude > 0.5, `alt ${d.altitude.toFixed(2)}`);

  // Full stick in every direction, then hands off — nothing should blow up.
  const d2 = new Drone();
  d2.takeoff();
  fly(d2, 2, NEUTRAL, p);
  for (const axis of ['roll', 'pitch', 'yaw']) {
    fly(d2, 1.5, { ...NEUTRAL, [axis]: 1, thr: 0.3 }, p);
    fly(d2, 1.5, { ...NEUTRAL, [axis]: -1, thr: 0.3 }, p);
  }
  check(`${key}: survives full-stick abuse`, finite(d2) && !Number.isNaN(d2.speed), 'went non-finite');
}

console.log('\n── Hold and drift ────────────────────────────────');

for (const key of ['beginner', 'sport', 'cruise']) {
  const p = PROFILES[key];
  const d = new Drone();
  d.takeoff();
  fly(d, 4, NEUTRAL, p);
  const a0 = d.altitude;
  fly(d, 20, NEUTRAL, p);          // hands off for 20 s
  const drop = Math.abs(d.altitude - a0);
  check(`${key}: altitude hold keeps height hands-off`, drop < 0.6, `drifted ${drop.toFixed(2)} m in 20 s`);
}

{
  const p = PROFILES.realistic;
  const d = new Drone();
  d.takeoff();
  fly(d, 4, NEUTRAL, p);
  check('realistic: has no altitude hold (raw throttle)', p.altHold === false, 'altHold is on');
}

console.log('\n── Geofence and ground ───────────────────────────');

{
  const d = new Drone();
  d.takeoff();
  fly(d, 3);
  fly(d, 60, { roll: 0, pitch: 1, yaw: 0, thr: 0.2 });   // run at the wall
  const dist = Math.hypot(d.pos.x, d.pos.z);
  check('geofence holds', dist <= GEOFENCE.radius + 1.5, `reached ${dist.toFixed(1)} m of ${GEOFENCE.radius}`);
  check('geofence: still finite', finite(d));
}

{
  const d = new Drone();
  d.takeoff();
  fly(d, 3);
  fly(d, 40, { ...NEUTRAL, thr: 1 });                     // straight up
  check('ceiling holds', d.pos.y <= GEOFENCE.ceiling + 2, `reached ${d.pos.y.toFixed(1)} m`);
}

{
  const d = new Drone();
  d.arm(true);
  fly(d, 5, { ...NEUTRAL, thr: -1 });                      // press down on the ground
  check('never falls through the floor', d.pos.y >= 0, `y = ${d.pos.y}`);
}

console.log('\n── Battery ───────────────────────────────────────');

{
  const d = new Drone();
  d.takeoff();
  let landed = false;
  for (let i = 0; i < 40 * 60 * HZ && !landed; i++) {
    d.update(1 / HZ, NEUTRAL, PROFILES.cruise, world);
    if (d.battery <= 0) landed = true;
  }
  check('battery runs down in a sane time', landed, 'still flying after 40 simulated minutes');
  check('battery never goes negative', d.battery >= 0, `${d.battery}`);
}

console.log('\n── Flips ─────────────────────────────────────────');

for (const dir of ['fwd', 'back', 'left', 'right']) {
  const d = new Drone();
  d.takeoff();
  fly(d, 3);
  fly(d, 4, { ...NEUTRAL, thr: 1 });
  const before = d.altitude;
  const ok = d.flip(dir);
  let peak = 0;
  for (let i = 0; i < 1.2 * HZ; i++) {
    d.update(1 / HZ, NEUTRAL, PROFILES.cruise, world);
    peak = Math.max(peak, Math.abs(d.flipAxis === 'pitch' ? d.pitch : d.roll));
  }
  const deg = (peak * 180) / Math.PI;
  check(`flip ${dir}: accepted`, ok, d.flipRefused);
  check(`flip ${dir}: rotates a full turn`, deg > 300, `peak ${deg.toFixed(0)}°`);
  check(`flip ${dir}: levels out afterwards`, Math.abs(d.roll) < 0.02 && Math.abs(d.pitch) < 0.02, `roll ${d.roll.toFixed(3)} pitch ${d.pitch.toFixed(3)}`);
  check(`flip ${dir}: autopilot releases`, d.autopilot === null, String(d.autopilot));
  check(`flip ${dir}: does not fall far`, before - d.altitude < 2.5, `lost ${(before - d.altitude).toFixed(2)} m`);
  check(`flip ${dir}: no crash`, !d.crashed, d.crashReason);
}

{
  const d = new Drone();
  check('flip refused on the ground', d.flip('fwd') === false && /take off/i.test(d.flipRefused), d.flipRefused);

  const d2 = new Drone();
  d2.takeoff(); fly(d2, 3); fly(d2, 4, { ...NEUTRAL, thr: 1 });
  d2.battery = 20;
  check('flip refused on low battery', d2.flip('fwd') === false && /battery/i.test(d2.flipRefused), d2.flipRefused);

  const d3 = new Drone();
  d3.takeoff(); fly(d3, 2.2);
  check('flip refused too low', d3.flip('fwd') === false && /climb/i.test(d3.flipRefused), `alt ${d3.altitude.toFixed(2)} — ${d3.flipRefused}`);

  const d4 = new Drone();
  d4.takeoff(); fly(d4, 3); fly(d4, 4, { ...NEUTRAL, thr: 1 });
  d4.flip('fwd');
  check('a second flip is refused mid-flip', d4.flip('back') === false);
  check('bogus direction is refused', d4.flip('sideways') === false);
}

console.log('\n── Return to home ────────────────────────────────');

for (const key of ['beginner', 'sport', 'cruise', 'realistic']) {
  const p = PROFILES[key];
  const d = new Drone();
  d.takeoff();
  fly(d, 3, NEUTRAL, p);
  fly(d, 8, { roll: 0, pitch: 1, yaw: 0, thr: 0.3 }, p);
  const out = d.homeDist;
  d.returnHome();
  let t = 0;
  while (d.autopilot === 'rth' && t < 120 * HZ) { d.update(1 / HZ, NEUTRAL, p, world); t++; }
  check(`rth ${key}: gets home from ${out.toFixed(0)} m`, d.homeDist < 1.5, `stopped ${d.homeDist.toFixed(2)} m out`);
  check(`rth ${key}: lands`, d.altitude < 0.2, `alt ${d.altitude.toFixed(2)}`);
  check(`rth ${key}: does not crash`, !d.crashed, d.crashReason);
  check(`rth ${key}: finishes in reasonable time`, t / HZ < 90, `${(t / HZ).toFixed(0)} s`);
}

{
  const d = new Drone();
  d.takeoff(); fly(d, 3); fly(d, 6, { roll: 0, pitch: 1, yaw: 0, thr: 0.3 });
  d.returnHome();
  check('rth engages', d.autopilot === 'rth');
  // The sim cancels on stick input; the model must at least allow it.
  d.autopilot = null;
  fly(d, 0.5);
  check('rth can be cancelled', d.autopilot === null && !d.crashed);

  const g = new Drone();
  check('rth refused on the ground', (g.returnHome(), g.autopilot !== 'rth'));
}

console.log('\n── Reset ─────────────────────────────────────────');

{
  const d = new Drone();
  d.takeoff();
  fly(d, 5, { roll: 1, pitch: 1, yaw: 1, thr: 1 });
  d.reset();
  check('reset clears attitude', d.roll === 0 && d.pitch === 0 && d.yaw === 0);
  check('reset refills the battery', d.battery === 100);
  check('reset clears the autopilot', d.autopilot === null && d.rthStage === '');
  check('reset puts it back on the pad', Math.hypot(d.pos.x, d.pos.z) < 0.01);
  check('reset clears crashed', d.crashed === false);
}

console.log('\n── Timestep independence ─────────────────────────');

{
  // The same flight at two rates should land in roughly the same place, or the
  // model is frame-rate dependent and a slow laptop flies a different drone.
  //
  // Beginner is the profile to test it with: every other one has randomised
  // gusting wind, so two runs would diverge on the weather rather than on the
  // integrator and the test would measure nothing.
  const run = (hz) => {
    const d = new Drone();
    d.takeoff();
    for (let i = 0; i < 6 * hz; i++) d.update(1 / hz, NEUTRAL, PROFILES.beginner, world);
    for (let i = 0; i < 4 * hz; i++) d.update(1 / hz, { roll: 0.5, pitch: 1, yaw: 0, thr: 0.4 }, PROFILES.beginner, world);
    return d;
  };
  const a = run(120);
  const b = run(60);
  const gap = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
  check('120 Hz and 60 Hz agree', gap < 2.0, `${gap.toFixed(2)} m apart after 10 s`);
}

console.log('\n── Result ────────────────────────────────────────');
console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\n  Failures:');
  for (const f of failures) console.log(`   - ${f}`);
}
process.exit(fail ? 1 : 0);
