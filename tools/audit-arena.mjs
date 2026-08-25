/**
 * Arena audit — teams, seats, and a whole match end to end.
 *
 * Drives the real relay with real sockets: a host, several screens and their
 * phones. Checks the things that only break with more than one person in the
 * room — seat collisions, traffic crossing between seats, a pilot dropping out
 * mid-round, and whether a match actually finishes.
 *
 *   node tools/audit-arena.mjs
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A client that remembers everything it was sent. */
class Peer {
  constructor(role, pin, opts = {}) {
    this.role = role;
    this.inbox = [];
    this.ws = new WebSocket(WSURL);
    this.ready = new Promise((resolve) => {
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', role, pin, ...opts })));
      this.ws.on('message', (r) => {
        const m = JSON.parse(r);
        this.inbox.push(m);
        if (m.t === 'welcome') { this.welcome = m; resolve(m); }
        if (m.t === 'denied') { this.denied = m; resolve(m); }
      });
      this.ws.on('error', () => resolve(null));
      setTimeout(() => resolve(null), 2500);
    });
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  last(type) { return [...this.inbox].reverse().find((m) => m.t === type); }
  all(type) { return this.inbox.filter((m) => m.t === type); }
  clear() { this.inbox.length = 0; }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function main() {
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PIN: '4242',                 // fixed, so the whole run shares one code
      BRIEFING_SECONDS: '1',
      ROUND_SECONDS: '3',
      RESULTS_SECONDS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let dead = false;
  child.on('exit', () => (dead = true));
  await sleep(1400);

  const PIN = '4242';

  console.log('\n── Teams ─────────────────────────────────────────');

  const host = new Peer('host', PIN);
  await host.ready;
  check('host connects', !!host.welcome, JSON.stringify(host.denied));
  check('host is told the code', host.welcome?.pin === PIN, String(host.welcome?.pin));

  host.send({ t: 'team/create' });
  await sleep(300);
  const joined = host.last('team/joined');
  const TEAM = joined?.code;
  check('host can open a team', !!TEAM && TEAM !== 'HOME', String(TEAM));
  check('team code is 4 readable characters', /^[A-HJ-NP-Z2-9]{4}$/.test(TEAM || ''), String(TEAM));

  const stray = new Peer('ctrl', PIN, { team: 'ZZZZ' });
  await stray.ready;
  check('unknown team falls back to the shared room', stray.welcome?.isDefault === true, String(stray.welcome?.team));
  stray.close();

  console.log('\n── Seats ─────────────────────────────────────────');

  // Two screens and two phones, all in the host's team.
  const s1 = new Peer('sim', PIN, { team: TEAM });
  const s2 = new Peer('sim', PIN, { team: TEAM });
  await Promise.all([s1.ready, s2.ready]);
  check('screen 1 gets a seat', s1.welcome?.seat != null, String(s1.welcome?.seat));
  check('screen 2 gets a seat', s2.welcome?.seat != null, String(s2.welcome?.seat));
  check('two screens get different seats', s1.welcome?.seat !== s2.welcome?.seat, `${s1.welcome?.seat} vs ${s2.welcome?.seat}`);

  const p1 = new Peer('ctrl', PIN, { team: TEAM, callsign: 'ALPHA' });
  await p1.ready;
  p1.send({ t: 'seat/claim', seat: s1.welcome.seat, callsign: 'ALPHA' });
  await sleep(300);
  check('phone 1 claims seat 1', !p1.last('seat/error'), p1.last('seat/error')?.reason);

  const p2 = new Peer('ctrl', PIN, { team: TEAM, callsign: 'BRAVO' });
  await p2.ready;
  p2.send({ t: 'seat/claim', seat: s1.welcome.seat, callsign: 'BRAVO' });
  await sleep(300);
  check('a taken seat is refused', !!p2.last('seat/error'), 'second phone took an occupied seat');

  p2.send({ t: 'seat/claim', seat: s2.welcome.seat, callsign: 'BRAVO' });
  await sleep(300);
  check('phone 2 claims seat 2', !!p2.last('lobby') || !p2.last('seat/error'), p2.last('seat/error')?.reason);

  p2.send({ t: 'seat/claim', seat: 99, callsign: 'BRAVO' });
  await sleep(200);
  check('a seat that does not exist is refused', !!p2.last('seat/error'));
  check('relay still alive after bad seat', !dead);

  console.log('\n── Traffic isolation ─────────────────────────────');

  s1.clear(); s2.clear(); p1.clear(); p2.clear();
  p1.send({ t: 'input', a: { r: 0.5, p: 0, y: 0, t: 0.3 }, tag: 'FROM_P1' });
  await sleep(300);
  const s1Got = s1.inbox.some((m) => m.tag === 'FROM_P1');
  const s2Got = s2.inbox.some((m) => m.tag === 'FROM_P1');
  check('phone 1 input reaches its own screen', s1Got);
  check('phone 1 input does NOT reach the other screen', !s2Got, 'input crossed between seats');

  s1.clear(); p1.clear(); p2.clear();
  s1.send({ t: 'state', alt: 3, tag: 'FROM_S1' });
  await sleep(300);
  check('screen 1 telemetry reaches its own phone', p1.inbox.some((m) => m.tag === 'FROM_S1'));
  check('screen 1 telemetry does NOT reach the other phone', !p2.inbox.some((m) => m.tag === 'FROM_S1'), 'telemetry crossed');

  console.log('\n── A whole match ─────────────────────────────────');

  host.clear(); s1.clear(); s2.clear();
  host.send({ t: 'match/start', rounds: 2 });
  await sleep(400);
  check('match starts', !!host.last('round/begin') || !!host.last('lobby'), 'no briefing went out');

  const brief = s1.last('round/begin');
  check('screens get a track for the round', !!brief?.trackId, JSON.stringify(brief));
  check('every screen gets the same track', s1.last('round/begin')?.trackId === s2.last('round/begin')?.trackId);

  // Wait out the briefing, then report a score from each seat.
  await sleep(1400);
  const go = s1.last('round/go');
  check('round goes live', !!go, 'no go signal');

  s1.send({ t: 'round/finish', score: 900, time: 21.5, rings: 5, missed: 0, hits: 0, crashes: 0, landing: 0.2 });
  s2.send({ t: 'round/finish', score: 500, time: 30.1, rings: 4, missed: 1, hits: 2, crashes: 0, landing: 0.6 });
  await sleep(700);

  const board = host.last('leaderboard') || host.last('round/end');
  check('scores reach the scoreboard', !!board, 'no leaderboard or round end');

  // Round 2 should come round on its own.
  await sleep(2500);
  const briefs = s1.all('round/begin').length;
  check('the next round starts by itself', briefs >= 2, `${briefs} briefings seen`);

  s1.send({ t: 'round/finish', score: 700, time: 25, rings: 5, missed: 0, hits: 0, crashes: 0, landing: 0.3 });
  s2.send({ t: 'round/finish', score: 800, time: 24, rings: 5, missed: 0, hits: 1, crashes: 0, landing: 0.1 });
  await sleep(2500);

  const end = host.last('match/end');
  check('the match ends', !!end, 'never finished');
  check('the final table has both pilots', (end?.rows?.length ?? 0) === 2, `${end?.rows?.length} rows`);
  check('the table is ranked', !end || end.rows.every((r, i, a) => i === 0 || a[i - 1].total >= r.total), JSON.stringify(end?.rows?.map((r) => r.total)));
  check('awards are handed out', !!end?.awards?.fastest && !!end?.awards?.cleanest);

  console.log('\n── Dropouts ──────────────────────────────────────');

  host.clear(); s1.clear();
  host.send({ t: 'match/start', rounds: 1 });
  await sleep(1500);
  s2.close();                                   // a pilot walks out mid-round
  await sleep(400);
  check('relay survives a screen leaving mid-round', !dead);
  s1.send({ t: 'round/finish', score: 600, time: 28, rings: 5, missed: 0, hits: 0, crashes: 0, landing: 0.4 });
  await sleep(2500);
  const end2 = host.last('match/end');
  check('the match still finishes without them', !!end2, 'hung waiting for the pilot who left');

  console.log('\n── Abuse ─────────────────────────────────────────');

  // A phone should not be able to drive the match.
  p1.clear();
  p1.send({ t: 'match/start', rounds: 5 });
  await sleep(400);
  check('a phone cannot start a match', !p1.last('round/begin'), 'a controller started a match');

  p1.send({ t: 'round/finish', score: 999999, time: -5, rings: 999, missed: -1, hits: -1, crashes: -1 });
  await sleep(300);
  check('relay survives a nonsense score', !dead);

  for (let i = 0; i < 400; i++) p1.send({ t: 'input', a: { r: 0, p: 0, y: 0, t: 0.5 } });
  await sleep(600);
  check('relay survives an input flood', !dead);

  console.log('\n── Result ────────────────────────────────────────');
  console.log(`  ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  if (dead) console.log('\n  server tail:\n' + out.split('\n').slice(-12).map((l) => '    ' + l).join('\n'));

  for (const c of [host, s1, s2, p1, p2]) c.close();
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  process.exit(fail ? 1 : 0);
}

main();
