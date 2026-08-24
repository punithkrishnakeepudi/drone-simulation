/**
 * Drone Trainer — relay server
 *
 * Serves the simulator (laptop) and the controller (phone), and relays
 * control packets between them over the local network.
 *
 *   phone  --input-->  server  --input-->  laptop simulator
 *   phone  <--state--  server  <--state--  laptop simulator
 *
 * Run:  npm install && npm start
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
// Pure data, no three: the server draws the track for each round, so both ends
// have to be reading the same pool.
import { TRACK_IDS } from './public/js/tracks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8080);

// A short pairing code so a stray device on the hotspot can't grab your sticks.
const PIN = String(process.env.PIN || Math.floor(1000 + Math.random() * 9000));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 
    'Content-Type': type, 
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

// --- QR code (optional dependency; falls back to plain text) -----------------
let QR = null;
try {
  QR = (await import('qrcode')).default;
} catch {
  /* no qrcode installed — the URL is printed instead */
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/phone' || pathname === '/controller') pathname = '/controller.html';
  if (pathname === '/host' || pathname === '/arena') pathname = '/host.html';

  // Three.js is served from node_modules so the whole thing works with no internet.
  if (pathname === '/vendor/three.module.js') {
    const p = path.join(__dirname, 'node_modules', 'three', 'build', 'three.module.js');
    if (!fs.existsSync(p)) return send(res, 500, 'three is not installed. Run: npm install');
    return serveFile(res, p);
  }

  // The simulator asks for the pairing code. Only the machine running the
  // server can read it; the phone has to be told the code by a human.
  if (pathname === '/api/session') {
    const urls = lanAddresses().map((a) => `http://${a.address}:${PORT}/controller.html?pin=${PIN}`);
    return send(res, 200, JSON.stringify({ pin: PIN, port: PORT, urls }), MIME['.json']);
  }

  if (pathname === '/api/qr.svg') {
    if (!QR) return send(res, 404, 'qrcode not installed');
    const target = url.searchParams.get('url') || '';
    QR.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((svg) => send(res, 200, svg, MIME['.svg']))
      .catch(() => send(res, 500, 'QR failed'));
    return;
  }

  const file = path.join(PUBLIC, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  serveFile(res, file);
});
// --- teams -------------------------------------------------------------------
/**
 * A team is a room: up to five seats, its own host, its own match.
 *
 * A seat is a screen (the simulator) plus the phone that flies it, and every
 * control packet is routed between exactly those two sockets — never broadcast.
 * That is what lets five people fly at once without flying each other's drone.
 *
 * Teams are addressed by a short code that a human can read out across a room.
 * Everything that arrives without one lands in the default team, which is what
 * the plain one-phone-one-laptop pairing has always used.
 */
const SEAT_COUNT = 5;
// Round length is worth tuning for a room: a first-timers' event wants longer,
// a demo wants much shorter. BRIEFING=3 ROUND=30 makes a whole match a minute.
const BRIEFING_MS = Number(process.env.BRIEFING_SECONDS || 10) * 1000;
const ROUND_LIMIT_MS = Number(process.env.ROUND_SECONDS || 180) * 1000;
const RESULTS_MS = Number(process.env.RESULTS_SECONDS || 9) * 1000;
const LEADERBOARD_MS = 500;

/** No I, O, 0 or 1 — those are the four that get misread over a noisy room. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const DEFAULT_TEAM = 'HOME';

const teams = new Map();

function makeTeam(code) {
  const t = {
    code,
    seats: new Map(),
    hosts: new Set(),
    /** Phones that have joined the team but not yet taken a seat. */
    unseated: new Set(),
    match: null,
    phaseTimer: null,
    boardTimer: null,
  };
  for (let i = 1; i <= SEAT_COUNT; i++) {
    t.seats.set(i, { id: i, screen: null, phone: null, callsign: '', progress: null, rounds: [] });
  }
  teams.set(code, t);
  return t;
}

function newCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!teams.has(c)) return c;
  }
  return `T${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

const normaliseCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

makeTeam(DEFAULT_TEAM);

const teamOf = (ws) => (ws.team ? teams.get(ws.team) : null) || null;

/** A team with nobody in it is rubbish; the default one always stays. */
function reapTeam(team) {
  if (!team || team.code === DEFAULT_TEAM) return;
  const busy =
    team.hosts.size ||
    team.unseated.size ||
    [...team.seats.values()].some((s) => s.screen || s.phone);
  if (busy) return;
  clearTimers(team);
  teams.delete(team.code);
  console.log(`  ~ team ${team.code} closed`);
}

/* --- who is in a team --------------------------------------------------- */

const live = (ws) => ws && ws.readyState === 1;
const claimedSeats = (t) => [...t.seats.values()].filter((s) => s.screen && s.phone);
const activeSeats = (t) => [...t.seats.values()].filter((s) => s.screen);
/**
 * Everyone who belongs on the scoreboard: crewed seats, plus any seat that has
 * already flown a round. Without the second half, a pilot whose screen drops out
 * disappears from the table and takes their earlier rounds with them.
 */
const scoringSeats = (t) => [...t.seats.values()].filter((s) => (s.screen && s.phone) || s.rounds.some(Boolean));

function sendTo(ws, obj) {
  if (live(ws)) ws.send(JSON.stringify(obj));
}

function broadcast(team, obj) {
  const msg = JSON.stringify(obj);
  for (const s of team.seats.values()) {
    if (live(s.screen)) s.screen.send(msg);
    if (live(s.phone)) s.phone.send(msg);
  }
  for (const h of team.hosts) if (live(h)) h.send(msg);
  for (const ws of team.unseated) if (live(ws)) ws.send(msg);
}

function lobby(team) {
  return {
    t: 'lobby',
    team: team.code,
    isDefault: team.code === DEFAULT_TEAM,
    inMatch: !!team.match,
    seats: [...team.seats.values()].map((s) => ({
      id: s.id,
      callsign: s.callsign,
      screen: !!s.screen,
      phone: !!s.phone,
      total: s.rounds.reduce((a, r) => a + (r.score || 0), 0),
    })),
  };
}

/** Screens across every team, not just this one. */
function globalSimCount() {
  let n = 0;
  for (const t of teams.values()) n += activeSeats(t).length;
  return n;
}

/**
 * Both shapes go out together: `peers` keeps the solo pairing cards working.
 *
 * `any` is the count across all teams. A phone that has just paired sits in the
 * default room, so without it a phone would be told "no simulator" whenever
 * every screen in the building had already moved into a team — and it could
 * never reach the screen where it would type the team code.
 */
function announce(team) {
  if (!team) return;
  broadcast(team, {
    t: 'peers',
    sim: activeSeats(team).length,
    ctrl: [...team.seats.values()].filter((s) => s.phone).length + team.unseated.size,
    any: globalSimCount(),
  });
  broadcast(team, lobby(team));
}

/** Screens moving between teams changes `any` for everybody. */
function announceAll() {
  for (const t of [...teams.values()]) announce(t);
}

/* --- moving between teams ------------------------------------------------ */

function seatOf(ws) {
  const team = teamOf(ws);
  return team && ws.seat ? team.seats.get(ws.seat) : null;
}

function freeScreenSeats(team) {
  return [...team.seats.values()].filter((s) => s.screen && !s.phone);
}

function attachScreen(team, ws) {
  // Prefer a seat that lost its screen mid-match: a reload should come back to
  // the same seat, with the rounds it has already flown still attached.
  const resumable = [...team.seats.values()].find((s) => !s.screen && s.rounds.some(Boolean));
  const free = resumable || [...team.seats.values()].find((s) => !s.screen);
  if (!free) return null;
  free.screen = ws;
  ws.seat = free.id;
  return free;
}

/** Detach a socket from whatever team it is currently in. */
function leaveTeam(ws) {
  const team = teamOf(ws);
  if (!team) return null;
  team.hosts.delete(ws);
  team.unseated.delete(ws);
  const seat = ws.seat ? team.seats.get(ws.seat) : null;
  if (seat) {
    if (seat.screen === ws) seat.screen = null;
    if (seat.phone === ws) seat.phone = null;
  }
  ws.seat = null;
  ws.team = null;
  return team;
}

/**
 * Put a socket into a team, taking it out of the one it was in.
 *
 * @returns {string|null} an error to show the client, or null on success
 */
function joinTeam(ws, code, { callsign, quiet = false } = {}) {
  const team = teams.get(code);
  if (!team) return 'No team with that code';

  // A screen and the phone flying it are one pilot. When the screen moves team,
  // the phone has to come with it or the pilot is left holding sticks that are
  // wired to nothing.
  const oldTeam = teamOf(ws);
  const oldSeat = oldTeam && ws.seat ? oldTeam.seats.get(ws.seat) : null;
  const partner = ws.role === 'sim' && oldSeat?.screen === ws ? oldSeat.phone : null;

  const previous = leaveTeam(ws);
  ws.team = code;

  if (ws.role === 'host') {
    team.hosts.add(ws);
  } else if (ws.role === 'sim') {
    const seat = attachScreen(team, ws);
    if (!seat) {
      // Put it back where it came from rather than leaving it in limbo.
      ws.team = previous?.code ?? null;
      if (previous) joinTeam(ws, previous.code);
      return 'That team is full';
    }
    // Carry the phone across and put it straight back in the same seat. No
    // round trip, and nothing for the pilot to type.
    if (partner && live(partner) && partner !== ws) {
      joinTeam(partner, code, { callsign: partner.callsign });
      claimSeat(partner, seat.id, partner.callsign);
    }
  } else {
    team.unseated.add(ws);
    if (callsign) ws.callsign = String(callsign).trim().slice(0, 12);
  }

  // The handshake already reports the team on the welcome, so the implicit
  // landing in the default room does not need announcing twice.
  if (!quiet) sendTo(ws, { t: 'team/joined', code, seat: ws.seat ?? null, isDefault: code === DEFAULT_TEAM });
  if (previous && previous !== team) {
    announce(previous);
    reapTeam(previous);
  }
  if (ws.role === 'sim') announceAll();
  else announce(team);
  return null;
}

function claimSeat(ws, id, callsign) {
  const team = teamOf(ws);
  if (!team) return 'Not in a team';
  const seat = team.seats.get(Number(id));
  if (!seat) return 'No such seat';
  if (!seat.screen) return 'That seat has no screen yet';
  if (seat.phone && seat.phone !== ws) return 'Someone is already in that seat';
  const prev = ws.seat ? team.seats.get(ws.seat) : null;
  if (prev && prev !== seat && prev.phone === ws) prev.phone = null;
  seat.phone = ws;
  seat.callsign = String(callsign || ws.callsign || '').trim().slice(0, 12) || `Seat ${seat.id}`;
  ws.seat = seat.id;
  team.unseated.delete(ws);
  sendTo(ws, { t: 'seat/assigned', seat: seat.id, callsign: seat.callsign, team: team.code, isDefault: team.code === DEFAULT_TEAM });
  return null;
}

/* --- the match ----------------------------------------------------------- */

function clearTimers(team) {
  clearTimeout(team.phaseTimer);
  clearInterval(team.boardTimer);
  team.phaseTimer = null;
  team.boardTimer = null;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startMatch(team, rounds) {
  const playing = claimedSeats(team);
  if (!playing.length) return;
  const pool = shuffle(TRACK_IDS.slice());
  const n = Math.max(1, Math.min(Number(rounds) || 3, pool.length));
  team.match = { round: 0, of: n, order: pool.slice(0, n), phase: 'idle' };
  for (const s of team.seats.values()) s.rounds = [];
  console.log(`  * team ${team.code}: ${n} rounds — ${team.match.order.join(', ')}`);
  beginRound(team);
}

function beginRound(team) {
  const match = team.match;
  if (!match) return;
  clearTimers(team);
  match.round++;
  if (match.round > match.of) return endMatch(team);

  match.trackId = match.order[match.round - 1];
  match.phase = 'briefing';
  match.finished = new Set();
  for (const s of team.seats.values()) s.progress = null;

  broadcast(team, {
    t: 'round/begin',
    round: match.round,
    of: match.of,
    trackId: match.trackId,
    briefingMs: BRIEFING_MS,
    limitMs: ROUND_LIMIT_MS,
  });

  team.phaseTimer = setTimeout(() => goRound(team), BRIEFING_MS);
}

function goRound(team) {
  const match = team.match;
  if (!match) return;
  match.phase = 'flying';
  match.endsAt = Date.now() + ROUND_LIMIT_MS;
  broadcast(team, { t: 'round/go', endsAt: match.endsAt, limitMs: ROUND_LIMIT_MS });
  team.phaseTimer = setTimeout(() => endRound(team), ROUND_LIMIT_MS);
  team.boardTimer = setInterval(() => pushLeaderboard(team), LEADERBOARD_MS);
}

function pushLeaderboard(team) {
  const match = team.match;
  if (!match || match.phase !== 'flying') return;
  broadcast(team, {
    t: 'leaderboard',
    round: match.round,
    endsAt: match.endsAt,
    rows: scoringSeats(team).map((s) => ({
      seat: s.id,
      callsign: s.callsign,
      ring: s.progress?.ring ?? 0,
      rings: s.progress?.rings ?? 0,
      elapsed: s.progress?.elapsed ?? 0,
      done: match.finished.has(s.id),
      score: s.rounds[match.round - 1]?.score ?? null,
    })),
  });
}

function endRound(team) {
  const match = team.match;
  if (!match || match.phase === 'results') return;
  clearTimers(team);
  match.phase = 'results';

  // Anybody still airborne when the clock ran out did not finish.
  for (const s of claimedSeats(team)) {
    if (!match.finished.has(s.id)) {
      s.rounds[match.round - 1] = {
        trackId: match.trackId,
        dnf: true,
        score: 0,
        time: 0,
        rings: s.progress?.ring ?? 0,
        missed: 0,
        hits: 0,
        crashes: 0,
        landing: null,
      };
    }
  }

  broadcast(team, {
    t: 'round/end',
    round: match.round,
    of: match.of,
    trackId: match.trackId,
    rows: roundRows(team, match.round),
  });
  team.phaseTimer = setTimeout(() => beginRound(team), RESULTS_MS);
}

function roundRows(team, round) {
  return scoringSeats(team)
    .map((s) => ({ seat: s.id, callsign: s.callsign, ...(s.rounds[round - 1] || { dnf: true, score: 0 }) }))
    .sort((a, b) => b.score - a.score);
}

function endMatch(team) {
  clearTimers(team);
  const rows = scoringSeats(team)
    .map((s) => {
      const done = s.rounds.filter(Boolean);
      return {
        seat: s.id,
        callsign: s.callsign,
        total: done.reduce((a, r) => a + (r.score || 0), 0),
        crashes: done.reduce((a, r) => a + (r.crashes || 0), 0),
        best: done.reduce((a, r) => (r.dnf ? a : Math.min(a, r.time || Infinity)), Infinity),
        clean: done.filter((r) => !r.dnf && !r.missed && !r.hits && !r.crashes).length,
        rounds: done.map((r) => r.score || 0),
      };
    })
    .sort((a, b) => b.total - a.total || a.crashes - b.crashes || a.best - b.best);

  const team_total = rows.reduce((a, r) => a + r.total, 0);
  const awards = {
    fastest: rows.slice().sort((a, b) => a.best - b.best)[0] || null,
    cleanest: rows.slice().sort((a, b) => b.clean - a.clean)[0] || null,
  };
  broadcast(team, { t: 'match/end', rows, team: team_total, awards });
  team.match = null;
  announce(team);
}

function abortMatch(team) {
  if (!team.match) return;
  clearTimers(team);
  team.match = null;
  broadcast(team, { t: 'match/abort' });
  announce(team);
}

// --- WebSocket relay ---------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  ws.role = null;
  ws.team = null;
  ws.seat = null;
  ws.callsign = '';
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (m.t === 'hello') return onHello(ws, req, m);
    if (!ws.role) return;

    const team = teamOf(ws);

    switch (m.t) {
      case 'team/create': {
        const code = newCode();
        makeTeam(code);
        console.log(`  ~ team ${code} opened`);
        const err = joinTeam(ws, code, { callsign: m.callsign });
        if (err) sendTo(ws, { t: 'team/error', reason: err });
        return;
      }
      case 'team/join': {
        const code = normaliseCode(m.code);
        const err = joinTeam(ws, code, { callsign: m.callsign });
        if (err) sendTo(ws, { t: 'team/error', reason: err });
        return;
      }
      case 'team/leave': {
        joinTeam(ws, DEFAULT_TEAM);
        return;
      }
      case 'seat/claim': {
        const err = claimSeat(ws, m.seat, m.callsign);
        if (err) sendTo(ws, { t: 'seat/error', reason: err });
        announce(teamOf(ws));
        return;
      }
      case 'seat/release': {
        const seat = seatOf(ws);
        if (seat && seat.phone === ws) seat.phone = null;
        ws.seat = null;
        if (team) team.unseated.add(ws);
        announce(team);
        return;
      }
      case 'match/start':
        if (ws.role === 'host' && team) startMatch(team, m.rounds);
        return;
      case 'match/abort':
        if (ws.role === 'host' && team) abortMatch(team);
        return;
      case 'round/progress': {
        const seat = seatOf(ws);
        if (seat && ws.role === 'sim') {
          seat.progress = { ring: m.ring | 0, rings: m.rings | 0, elapsed: +m.elapsed || 0 };
        }
        return;
      }
      case 'round/finish': {
        const seat = seatOf(ws);
        if (!seat || ws.role !== 'sim' || !team?.match) return;
        seat.rounds[team.match.round - 1] = {
          trackId: team.match.trackId,
          dnf: !!m.dnf,
          score: m.score | 0,
          time: +m.time || 0,
          rings: m.rings | 0,
          missed: m.missed | 0,
          hits: m.hits | 0,
          crashes: m.crashes | 0,
          landing: m.landing ?? null,
        };
        team.match.finished.add(seat.id);
        pushLeaderboard(team);
        if (claimedSeats(team).every((s) => team.match.finished.has(s.id))) endRound(team);
        return;
      }
      default:
        break;
    }

    // Flight traffic is point to point: phone → its screen, screen → its phone.
    const seat = seatOf(ws);
    if (!seat) return;
    const text = raw.toString();
    if (ws.role === 'ctrl' && live(seat.screen)) seat.screen.send(text);
    else if (ws.role === 'sim' && live(seat.phone)) seat.phone.send(text);
  });

  ws.on('close', () => onClose(ws));
});

function onHello(ws, req, m) {
  const role = m.role === 'sim' ? 'sim' : m.role === 'host' ? 'host' : 'ctrl';

  // Everyone must present the pin except the simulator (which reads it from /api/session).
  // Now that we're on the cloud, the sim doesn't need to be loopback.
  if (role !== 'sim' && String(m.pin) !== PIN) {
    sendTo(ws, { t: 'denied', reason: 'Wrong pairing code' });
    return ws.close();
  }

  ws.role = role;
  ws.callsign = String(m.callsign || '').trim().slice(0, 12);

  // A remembered team code comes back on the greeting, so a reload lands where
  // it left off instead of dropping the pilot into the default room.
  const wanted = normaliseCode(m.team);
  const code = wanted && teams.has(wanted) ? wanted : DEFAULT_TEAM;
  const err = joinTeam(ws, code, { callsign: ws.callsign, quiet: true });
  if (err && code !== DEFAULT_TEAM) joinTeam(ws, DEFAULT_TEAM, { callsign: ws.callsign, quiet: true });

  const team = teamOf(ws);
  sendTo(ws, {
    t: 'welcome',
    role,
    pin: role === 'host' ? PIN : undefined,
    seat: ws.seat ?? undefined,
    team: team?.code ?? null,
    isDefault: team?.code === DEFAULT_TEAM,
    seatCount: SEAT_COUNT,
  });

  if (role === 'ctrl') {
    // With exactly one screen waiting and nobody else flying, take the seat
    // automatically — that is the solo case, and it should stay one tap.
    const free = freeScreenSeats(team);
    if (free.length === 1 && claimedSeats(team).length === 0 && !team.match) {
      claimSeat(ws, free[0].id, ws.callsign);
    }
  }

  if (role === 'sim') announceAll();
  else announce(team);
  console.log(`  + ${role} connected to ${team?.code}${ws.seat ? ` seat ${ws.seat}` : ''} (${req.socket.remoteAddress})`);
}

function onClose(ws) {
  if (!ws.role) return;
  const team = teamOf(ws);
  if (!team) return;

  team.hosts.delete(ws);
  team.unseated.delete(ws);

  const seat = ws.seat ? team.seats.get(ws.seat) : null;
  if (seat) {
    if (seat.screen === ws) {
      seat.screen = null;
      // A screen that vanishes mid-round takes its pilot's round with it.
      const match = team.match;
      if (match && match.phase === 'flying' && !match.finished.has(seat.id)) {
        match.finished.add(seat.id);
        seat.rounds[match.round - 1] = {
          trackId: match.trackId, dnf: true, score: 0, time: 0,
          rings: seat.progress?.ring ?? 0, missed: 0, hits: 0, crashes: 0, landing: null,
        };
      }
      // With the screen gone the seat cannot fly, so the phone is freed too.
      if (seat.phone) {
        sendTo(seat.phone, { t: 'seat/error', reason: 'The screen for that seat disconnected' });
        seat.phone.seat = null;
        team.unseated.add(seat.phone);
        seat.phone = null;
      }
    } else if (seat.phone === ws) {
      seat.phone = null;
    }
  }
  ws.seat = null;
  ws.team = null;

  console.log(`  - ${ws.role} left ${team.code}`);
  const match = team.match;
  if (match && match.phase === 'flying' && claimedSeats(team).length && claimedSeats(team).every((s) => match.finished.has(s.id))) {
    endRound(team);
  }
  if (ws.role === 'sim') announceAll();
  else announce(team);
  reapTeam(team);
}

// Drop half-open sockets so a phone that walks out of range is noticed fast.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000).unref();


server.listen(PORT, '0.0.0.0', async () => {
  const addrs = lanAddresses();
  const primary = addrs[0]?.address || 'localhost';
  const phoneUrl = `http://${primary}:${PORT}/controller.html?pin=${PIN}`;

  console.log('\n  DRONE TRAINER');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Simulator (this computer):  http://localhost:${PORT}`);
  console.log('  Controller (your phone):');
  for (const a of addrs) console.log(`      http://${a.address}:${PORT}/controller.html   [${a.name}]`);
  console.log(`\n  Arena host / leaderboard:   http://localhost:${PORT}/host`);
  console.log(`  Pilot screens (up to ${SEAT_COUNT}):     http://${primary}:${PORT}/?pin=${PIN}`);
  console.log(`\n  Pairing code:  ${PIN}`);
  console.log('  Phone and computer must be on the same Wi-Fi / hotspot.\n');

  if (QR) {
    try {
      const art = await QR.toString(phoneUrl, { type: 'terminal', small: true });
      console.log('  Scan this on your phone:\n');
      console.log(art);
    } catch {
      /* ignore */
    }
  }
});
