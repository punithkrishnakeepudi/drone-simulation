/**
 * Pairing audit — the solo path, end to end, against a running relay.
 *
 * The screen fetches a code and joins; a phone presents the same code, is
 * seated automatically because it is the only one waiting, and then control
 * packets flow both ways. This is the path every single user takes, so it is
 * worth checking on its own rather than only as part of the arena.
 *
 *   node tools/audit-pairing.mjs [port]
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = Number(process.argv[2] || 8793);
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n}${d ? ` — ${d}` : ''}`); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function peer(role, pin, opts = {}) {
  const p = { inbox: [], role };
  p.ws = new WebSocket(WSURL);
  p.ready = new Promise((res) => {
    p.ws.on('open', () => p.ws.send(JSON.stringify({ t: 'hello', role, pin, ...opts })));
    p.ws.on('message', (r) => {
      const m = JSON.parse(r);
      p.inbox.push(m);
      if (m.t === 'welcome') { p.welcome = m; res(m); }
      if (m.t === 'denied') { p.denied = m; res(m); }
    });
    p.ws.on('error', () => res(null));
    setTimeout(() => res(null), 2500);
  });
  p.send = (o) => p.ws.readyState === 1 && p.ws.send(JSON.stringify(o));
  p.last = (t) => [...p.inbox].reverse().find((m) => m.t === t);
  p.close = () => { try { p.ws.close(); } catch { /* gone */ } };
  return p;
}

async function main() {
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), PIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let dead = false;
  child.on('exit', () => (dead = true));
  await sleep(1400);

  console.log('\n── Solo pairing ──────────────────────────────────');

  // 1. the screen loads and takes a code
  const s = await (await fetch(`${BASE}/api/session`)).json();
  check('screen is issued a code', /^\d{4}$/.test(s.pin), String(s.pin));

  const screen = peer('sim', s.pin);
  await screen.ready;
  check('screen joins with that code', !!screen.welcome, JSON.stringify(screen.denied));
  check('screen is given a seat', screen.welcome?.seat != null, String(screen.welcome?.seat));

  // 2. while the screen is on, the code must not move under the phone's feet
  const s2 = await (await fetch(`${BASE}/api/session`)).json();
  check('code is stable while a screen is connected', s2.pin === s.pin, `${s.pin} then ${s2.pin}`);

  // 3. the phone joins with the same code
  const phone = peer('ctrl', s.pin, { callsign: 'SOLO' });
  await phone.ready;
  check('phone joins with the same code', !!phone.welcome, JSON.stringify(phone.denied));
  await sleep(300);
  check('lone phone is seated automatically', phone.welcome?.seat != null || !!phone.last('seat/assigned'), 'phone had to pick a seat by hand');

  // 4. a phone with the wrong code gets nowhere
  const wrong = peer('ctrl', s.pin === '1234' ? '4321' : '1234');
  await wrong.ready;
  check('wrong code cannot join', !!wrong.denied, 'a bad code was let in');
  wrong.close();

  console.log('\n── Control loop ──────────────────────────────────');

  screen.inbox.length = 0;
  phone.inbox.length = 0;

  // sticks up
  for (let i = 0; i < 10; i++) {
    phone.send({ t: 'input', a: { r: 0.2, p: -0.1, y: 0, t: 0.6 }, ts: 1000 + i });
    await sleep(20);
  }
  await sleep(300);
  const inputs = screen.inbox.filter((m) => m.t === 'input');
  check('stick packets reach the screen', inputs.length >= 8, `${inputs.length} of 10`);
  check('stick values survive the trip', inputs.at(-1)?.a?.t === 0.6, JSON.stringify(inputs.at(-1)?.a));

  // commands
  phone.send({ t: 'cmd', name: 'takeoff' });
  phone.send({ t: 'cmd', name: 'flip', value: 'fwd' });
  phone.send({ t: 'cmd', name: 'rth' });
  await sleep(300);
  const cmds = screen.inbox.filter((m) => m.t === 'cmd').map((m) => m.name);
  check('takeoff reaches the screen', cmds.includes('takeoff'));
  check('flip reaches the screen', cmds.includes('flip'));
  check('return-to-home reaches the screen', cmds.includes('rth'));

  // telemetry back
  screen.send({ t: 'state', alt: 4.2, batt: 88, thr: 0.55, ev: 'tyre', evn: 3, rth: false, echo: 1009 });
  await sleep(300);
  const st = phone.last('state');
  check('telemetry reaches the phone', !!st, 'nothing came back');
  check('telemetry carries throttle for the rumble', st?.thr === 0.55, String(st?.thr));
  check('telemetry carries the event name', st?.ev === 'tyre' && st?.evn === 3, JSON.stringify({ ev: st?.ev, evn: st?.evn }));
  check('telemetry carries the rth flag', st?.rth === false, String(st?.rth));

  console.log('\n── Recovery ──────────────────────────────────────');

  phone.close();
  await sleep(400);
  check('relay survives the phone leaving', !dead);

  const phone2 = peer('ctrl', s.pin, { callsign: 'SOLO2' });
  await phone2.ready;
  await sleep(300);
  check('a phone can rejoin the same screen', !!phone2.welcome, JSON.stringify(phone2.denied));

  screen.inbox.length = 0;
  phone2.send({ t: 'input', a: { r: 0, p: 0, y: 0, t: 0.4 } });
  await sleep(300);
  check('control resumes after a reconnect', screen.inbox.some((m) => m.t === 'input'), 'sticks went nowhere');

  console.log('\n── Result ────────────────────────────────────────');
  console.log(`  ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\n  Failures:'); for (const f of failures) console.log(`   - ${f}`); }

  screen.close(); phone2.close();
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  process.exit(fail ? 1 : 0);
}

main();
