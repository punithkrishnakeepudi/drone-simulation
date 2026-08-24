/**
 * Arena host — the big screen.
 *
 * It starts the match and shows the leaderboard. It deliberately never receives
 * a single pilot's flight state, so there is no view here that could be used to
 * watch somebody fly: the relay only ever sends this page ring counts, clocks
 * and scores.
 */

import { Link } from './net.js';
import { THEMES, trackById } from './tracks.js';

const $ = (id) => document.getElementById(id);
const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

const state = {
  team: null,
  isDefault: true,
  seats: [],
  phase: 'lobby',     // lobby | briefing | flying | results | ended
  round: 0,
  of: 0,
  track: null,
  endsAt: 0,
  rows: [],
};

let rounds = 3;
let link = null;

/* ---------------- link ---------------- */

function connect(pin) {
  if (link) return link.repair(pin);
  link = new Link({ role: 'host', pin, team: savedTeam(), onMessage: onPacket, onStatus: onStatus });
}

function savedTeam() {
  try { return localStorage.getItem('dt-team') || ''; } catch { return ''; }
}

function rememberTeam(code) {
  try {
    if (code) localStorage.setItem('dt-team', code);
    else localStorage.removeItem('dt-team');
  } catch { /* private mode */ }
}

function onStatus(status, detail) {
  if (status === 'denied') {
    $('h-gate').hidden = false;
    $('h-err').textContent = detail || 'Rejected';
    try { localStorage.removeItem('dt-pin'); } catch { /* private mode */ }
  } else if (status === 'online') {
    $('h-gate').hidden = true;
    try { localStorage.setItem('dt-pin', link.pin); } catch { /* private mode */ }
  }
}

function onPacket(m) {
  switch (m.t) {
    case 'welcome':
      if (m.pin) $('h-code').textContent = m.pin;
      state.team = m.team ?? null;
      state.isDefault = m.isDefault !== false;
      render();
      break;
    case 'team/joined':
      state.team = m.code;
      state.isDefault = !!m.isDefault;
      rememberTeam(m.isDefault ? '' : m.code);
      $('h-err').textContent = '';
      render();
      break;
    case 'team/error':
      $('h-team-note').textContent = m.reason || 'That did not work';
      break;
    case 'lobby':
      state.seats = m.seats || [];
      state.team = m.team ?? state.team;
      state.isDefault = !!m.isDefault;
      if (!m.inMatch && state.phase !== 'ended') state.phase = 'lobby';
      render();
      break;
    case 'round/begin':
      state.phase = 'briefing';
      state.round = m.round;
      state.of = m.of;
      state.track = trackById(m.trackId);
      state.endsAt = 0;
      state.rows = [];
      $('h-results').hidden = true;
      render();
      break;
    case 'round/go':
      state.phase = 'flying';
      state.endsAt = Date.now() + (m.limitMs || 180000);
      render();
      break;
    case 'leaderboard':
      state.rows = m.rows || [];
      state.endsAt = m.endsAt || state.endsAt;
      render();
      break;
    case 'round/end':
      state.phase = 'results';
      showResults(`Round ${m.round} of ${m.of} · ${trackName(m.trackId)}`, m.rows || [], false);
      render();
      break;
    case 'match/end':
      state.phase = 'ended';
      showFinal(m);
      render();
      break;
    case 'match/abort':
      state.phase = 'lobby';
      $('h-results').hidden = true;
      render();
      break;
    default:
      break;
  }
}

function trackName(id) {
  const t = trackById(id);
  return t ? `${t.name} · ${THEMES[t.theme].name}` : id;
}

/* ---------------- render ---------------- */

function render() {
  const crewed = state.seats.filter((s) => s.screen && s.phone);
  const running = state.phase === 'briefing' || state.phase === 'flying';

  $('h-phase').textContent =
    state.phase === 'lobby' ? 'Lobby'
      : state.phase === 'briefing' ? `Round ${state.round} · briefing`
        : state.phase === 'flying' ? `Round ${state.round} of ${state.of}`
          : state.phase === 'results' ? `Round ${state.round} · results`
            : 'Match over';

  $('h-sub').textContent =
    state.phase === 'flying' && state.endsAt
      ? `${state.track ? trackName(state.track.id) : ''} · ${mmss((state.endsAt - Date.now()) / 1000)} left`
      : running && state.track
        ? trackName(state.track.id)
        : `${crewed.length} of ${state.seats.length} seats crewed`;

  $('h-team').textContent = state.isDefault ? '----' : state.team || '----';
  $('h-start').disabled = running || crewed.length === 0 || state.isDefault;
  $('h-start').textContent = state.phase === 'ended' ? 'Start a new match' : 'Start the match';
  $('h-abort').hidden = !running;
  $('h-note').textContent = state.isDefault
    ? 'Create a team first. A match needs a team code so the right five people end up in it.'
    : crewed.length
      ? running
        ? 'A match is running. Aborting drops everyone back to the lobby.'
        : `${crewed.length} pilot${crewed.length === 1 ? '' : 's'} ready · ${rounds} rounds, one track each`
      : 'Each seat needs a screen open on the simulator and a phone in that seat.';

  $('h-team-note').textContent = state.isDefault
    ? 'Create a team, then read the code out. Pilots type it on their screen and their phone.'
    : `Team ${state.team}. Anyone typing that code lands in this lobby.`;

  const list = $('h-list');
  list.innerHTML = '';
  for (const s of state.seats) {
    const row = state.rows.find((r) => r.seat === s.id);
    const li = document.createElement('li');
    li.className = 'h-seat';
    if (row?.done) li.classList.add('done');
    else if (running && s.phone) li.classList.add('flying');
    else if (s.screen && s.phone) li.classList.add('ready');

    const status = !s.screen ? 'no screen' : !s.phone ? 'waiting for a phone' : running ? 'flying' : 'ready';
    const prog = row ? (row.done ? 'finished' : `${row.ring}/${row.rings} · ${row.elapsed.toFixed(1)}s`) : '—';
    const pts = row?.done ? row.score ?? 0 : s.total || 0;

    li.innerHTML = '<span class="n"></span><div><div class="who"></div><div class="st"></div></div><span class="prog"></span><span class="pts"></span>';
    li.querySelector('.n').textContent = s.id;
    li.querySelector('.who').textContent = s.callsign || (s.screen ? 'Open seat' : '—');
    li.querySelector('.st').textContent = status.toUpperCase();
    li.querySelector('.prog').textContent = running ? prog : '';
    li.querySelector('.pts').textContent = pts ? String(pts) : '';
    list.appendChild(li);
  }
}


/** The final table is a different shape from a round table, so it needs its
    own column headings — otherwise round scores end up under "Time". */
const HEAD_ROUND = ['#', 'Pilot', 'Time', 'Rings', 'Miss', 'Hits', 'Crash', 'Points'];
const HEAD_FINAL = ['#', 'Pilot', 'Round scores', '', '', '', 'Crashes', 'Total'];

function setTableHead(tr, final) {
  if (!tr) return;
  const labels = final ? HEAD_FINAL : HEAD_ROUND;
  tr.innerHTML = '';
  labels.forEach((label, i) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (i === labels.length - 1) th.className = 'num';
    tr.appendChild(th);
  });
}

function showResults(title, rows, final) {
  $('h-results').hidden = false;
  setTableHead($('h-res-head'), final);
  $('h-res-title').textContent = title;
  const body = $('h-res-rows');
  body.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    const cells = final
      ? [i + 1, r.callsign, r.rounds.join(' · '), '', '', '', r.crashes, r.total]
      : [i + 1, r.callsign, r.dnf ? 'DNF' : `${(r.time || 0).toFixed(1)}s`, r.rings ?? 0, r.missed ?? 0, r.hits ?? 0, r.crashes ?? 0, r.score ?? 0];
    cells.forEach((v, c) => {
      const td = document.createElement('td');
      td.textContent = String(v);
      if (c === 1) td.className = 'name';
      else if (c === 7) td.className = 'num pts';
      else if (c > 1 && c < 7) td.className = 'num';
      if (c === 2 && v === 'DNF') td.className = 'dnf';
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

function showFinal(m) {
  showResults('Final table', m.rows || [], true);
  const a = m.awards || {};
  const bits = [`Team total ${m.team ?? 0} points`];
  if (a.fastest && Number.isFinite(a.fastest.best)) bits.push(`Fastest lap · ${a.fastest.callsign} ${a.fastest.best.toFixed(1)}s`);
  if (a.cleanest && a.cleanest.clean) bits.push(`Cleanest · ${a.cleanest.callsign} (${a.cleanest.clean} clean)`);
  $('h-res-foot').textContent = bits.join('   ·   ');
}

/* ---------------- controls ---------------- */

function buildRoundPicker() {
  const wrap = $('h-rounds');
  wrap.innerHTML = '';
  for (const n of [1, 3, 5]) {
    const b = document.createElement('button');
    b.textContent = String(n);
    b.setAttribute('aria-pressed', String(n === rounds));
    b.onclick = () => {
      rounds = n;
      for (const other of wrap.children) other.setAttribute('aria-pressed', String(other === b));
      render();
    };
    wrap.appendChild(b);
  }
}

$('h-start').onclick = () => {
  $('h-results').hidden = true;
  link?.send({ t: 'match/start', rounds });
};
$('h-abort').onclick = () => link?.send({ t: 'match/abort' });
$('h-team-new').onclick = () => link?.send({ t: 'team/create' });
$('h-team-join').onclick = () => {
  const code = $('h-team-input').value.trim().toUpperCase();
  if (code.length < 3) {
    $('h-team-note').textContent = 'Four characters.';
    return;
  }
  link?.send({ t: 'team/join', code });
};
$('h-team-input').addEventListener('input', () => {
  $('h-team-input').value = $('h-team-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});
$('h-team-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('h-team-join').click(); });
$('h-go').onclick = () => {
  const v = $('h-pin').value.trim();
  if (!/^\d{4}$/.test(v)) {
    $('h-err').textContent = 'Four digits.';
    return;
  }
  $('h-err').textContent = '';
  connect(v);
};
$('h-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('h-go').click(); });

/* ---------------- boot ---------------- */

async function boot() {
  buildRoundPicker();
  render();

  // Opened on the machine running the server: it can read the code itself.
  try {
    const res = await fetch('/api/session');
    if (!res.ok) throw new Error('not local');
    const s = await res.json();
    $('h-code').textContent = s.pin;
    const join = s.urls[0] ? s.urls[0].split('?')[0] : '';
    $('h-url').textContent = join || `http://<your-ip>:${s.port}/controller.html`;
    if (s.urls[0]) {
      const svg = await fetch(`/api/qr.svg?url=${encodeURIComponent(s.urls[0])}`);
      if (svg.ok) $('h-qr').innerHTML = await svg.text();
    }
    connect(s.pin);
    return;
  } catch {
    /* opened from another device — ask for the code */
  }

  const params = new URLSearchParams(location.search);
  const saved = (() => { try { return localStorage.getItem('dt-pin') || ''; } catch { return ''; } })();
  const pin = params.get('pin') || saved;
  $('h-url').textContent = `${location.origin}/controller.html`;
  if (/^\d{4}$/.test(pin)) {
    $('h-pin').value = pin;
    connect(pin);
  } else {
    $('h-gate').hidden = false;
  }
}

boot();
