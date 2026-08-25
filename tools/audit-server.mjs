/**
 * Server audit — HTTP surface, WebSocket auth, and robustness.
 *
 * Boots the real server on a scratch port and attacks it. Every check prints
 * PASS or FAIL with the evidence, so the output is the report.
 *
 *   node tools/audit-server.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'audit-token-1234';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a socket, say hello, resolve with whatever comes back first. */
function hello(payload, { wait = 700 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WSURL);
    const got = [];
    let settled = false;
    const done = (verdict) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already gone */ }
      resolve({ verdict, got });
    };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', ...payload })));
    ws.on('message', (r) => {
      const m = JSON.parse(r);
      got.push(m);
      if (m.t === 'welcome') done('welcome');
      if (m.t === 'denied') done('denied');
    });
    ws.on('error', () => done('error'));
    setTimeout(() => done(got.length ? 'other' : 'silent'), wait);
  });
}

async function main() {
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), PIN: '', SESSION_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += d));
  child.stderr.on('data', (d) => (serverOut += d));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  let dead = false;
  child.on('exit', () => (dead = true));

  await sleep(1400);

  console.log('\n── HTTP ──────────────────────────────────────────');

  const root = await fetch(`${BASE}/`);
  check('GET / serves the simulator', root.status === 200);

  const ctrl = await fetch(`${BASE}/controller.html`);
  check('GET /controller.html serves', ctrl.status === 200);

  const host = await fetch(`${BASE}/host`);
  check('GET /host serves the arena screen', host.status === 200);

  const four04 = await fetch(`${BASE}/nope.html`);
  check('unknown path is 404', four04.status === 404, `got ${four04.status}`);

  // --- path traversal, several encodings ---
  for (const probe of [
    '/../server.js',
    '/%2e%2e/server.js',
    '/..%2fserver.js',
    '/%2e%2e%2f%2e%2e%2fserver.js',
    '/a/../../server.js',
    '/....//server.js',
  ]) {
    const r = await fetch(BASE + probe, { redirect: 'manual' });
    const body = r.status === 200 ? await r.text() : '';
    check(`traversal blocked: ${probe}`, !body.includes('WebSocketServer'), 'LEAKED server.js');
  }

  // --- the pairing code ---
  const s1 = await (await fetch(`${BASE}/api/session`)).json();
  check('/api/session returns a 4-digit code', /^\d{4}$/.test(s1.pin), JSON.stringify(s1.pin));

  const s2 = await (await fetch(`${BASE}/api/session`)).json();
  check('code rolls when nobody is connected', s1.pin !== s2.pin, `${s1.pin} then ${s2.pin}`);

  const s3 = await (await fetch(`${BASE}/api/session?keep`)).json();
  check('?keep holds the code', s2.pin !== s3.pin ? false : true, `${s2.pin} then ${s3.pin}`);

  // On a public host, loopback means nothing, so a forwarded request must be
  // refused unless it carries the token.
  const fwd = await fetch(`${BASE}/api/session`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
  check('/api/session refuses proxied requests without a token', fwd.status === 403, `got ${fwd.status}`);

  const fwdTok = await fetch(`${BASE}/api/session?token=${TOKEN}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
  check('/api/session accepts the right token', fwdTok.status === 200, `got ${fwdTok.status}`);

  const fwdBad = await fetch(`${BASE}/api/session?token=wrong`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
  check('/api/session refuses a wrong token', fwdBad.status === 403, `got ${fwdBad.status}`);

  console.log('\n── WebSocket auth ────────────────────────────────');

  // Re-read it: the token check above legitimately rolled the code, so s3 is
  // stale by now. `keep` leaves whatever is current alone.
  const PIN = (await (await fetch(`${BASE}/api/session?keep`)).json()).pin;

  const good = await hello({ role: 'ctrl', pin: PIN });
  check('correct code is accepted', good.verdict === 'welcome', good.verdict);

  const bad = await hello({ role: 'ctrl', pin: '0000' === PIN ? '1111' : '0000' });
  check('wrong code is refused', bad.verdict === 'denied', bad.verdict);

  const noPin = await hello({ role: 'ctrl' });
  check('missing code is refused', noPin.verdict === 'denied', noPin.verdict);

  const simNoPin = await hello({ role: 'sim' });
  check(
    'sim role requires a code',
    simNoPin.verdict === 'denied',
    `sim connected with NO pin (verdict: ${simNoPin.verdict})`
  );

  const simGood = await hello({ role: 'sim', pin: PIN });
  check('sim with the right code is accepted', simGood.verdict === 'welcome', simGood.verdict);

  const hostNoPin = await hello({ role: 'host' });
  check('host role requires a code', hostNoPin.verdict === 'denied', hostNoPin.verdict);

  // --- brute force ---
  let lockedAfter = -1;
  for (let i = 0; i < 12; i++) {
    const guess = String(9000 + i);           // never the real code
    const r = await hello({ role: 'ctrl', pin: guess }, { wait: 250 });
    const reason = r.got.find((g) => g.t === 'denied')?.reason || '';
    if (/wait|too many/i.test(reason) && lockedAfter < 0) lockedAfter = i + 1;
  }
  check(
    'brute force is locked out',
    lockedAfter > 0 && lockedAfter <= 8,
    lockedAfter < 0 ? '12 wrong codes in a row, never locked out' : `locked after ${lockedAfter}`
  );

  // A locked-out address must not be able to get in even with the right code,
  // and must not lock anybody else out.
  const duringLock = await hello({ role: 'ctrl', pin: PIN }, { wait: 250 });
  check('lockout also blocks the correct code', duringLock.verdict === 'denied', duringLock.verdict);

  console.log('\n── Robustness ────────────────────────────────────');

  // --- malformed JSON over a good socket ---
  await new Promise((resolve) => {
    const ws = new WebSocket(WSURL);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'ctrl', pin: PIN }));
      setTimeout(() => {
        ws.send('{not json at all');
        ws.send('null');
        ws.send('[]');
        ws.send(JSON.stringify({ t: 'input', a: null }));
        ws.send(JSON.stringify({ t: 'seat/claim', seat: 'banana' }));
        ws.send(JSON.stringify({ t: 'round/finish', score: 'NaN', time: {} }));
        setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 400);
      }, 250);
    });
    ws.on('error', () => resolve());
  });
  await sleep(300);
  check('survives malformed JSON and junk fields', !dead, 'server exited');

  // --- oversized frame ---
  await new Promise((resolve) => {
    const ws = new WebSocket(WSURL);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'ctrl', pin: PIN }));
      setTimeout(() => {
        try { ws.send(JSON.stringify({ t: 'input', pad: 'x'.repeat(8 * 1024 * 1024) })); } catch { /* ignore */ }
        setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 700);
      }, 200);
    });
    ws.on('error', () => resolve());
  });
  await sleep(300);
  check('survives an 8 MB frame', !dead, 'server exited');

  // --- protocol violation: unmasked client frame ---
  await new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: PORT }, () => {
      const key = Buffer.from(Math.random().toString(36)).toString('base64');
      sock.write(
        `GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
      setTimeout(() => {
        sock.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])); // unmasked
        setTimeout(() => { sock.destroy(); resolve(); }, 500);
      }, 300);
    });
    sock.on('error', () => resolve());
  });
  await sleep(600);
  check(
    'survives a protocol-violating frame',
    !dead,
    'server process died — any client can kill it with one frame'
  );

  if (dead) {
    console.log('\n  server stderr tail:');
    console.log(
      serverOut.split('\n').filter((l) => l.includes('Error') || l.includes('code:')).slice(0, 4).map((l) => '    ' + l).join('\n')
    );
  }

  console.log('\n── Result ────────────────────────────────────────');
  console.log(`  ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }

  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  await exited;
  process.exit(fail ? 1 : 0);
}

main();
