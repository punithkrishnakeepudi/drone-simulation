/**
 * Controller — runs on the phone.
 *
 * Mode 2 layout, the one nearly every real transmitter uses:
 *   left  stick — throttle (up/down) and yaw (turn on the spot)
 *   right stick — pitch (forward/back) and roll (slide left/right)
 *
 * The phone holds no flight state. It sends stick positions ~30 times a second
 * and draws whatever the simulator reports back — including the coach text for
 * the guided task, so you never have to look up at the laptop.
 */

import { Link } from './net.js';

const $ = (id) => document.getElementById(id);
const clamp = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

/* The five courses, mirrored here so the phone can offer them offline. */
const TASK_MENU = [
  ['line', '1 · Straight line', 'Guided · four tyres in a row'],
  ['slalom', '2 · Slalom', 'Five tyres, alternating left and right'],
  ['stair', '3 · Staircase', 'Five tyres, up to 5 m and back down'],
  ['circle', '4 · Circle', 'Six tyres around a 12 m ring'],
  ['eight', '5 · Figure eight', 'Eight tyres, two loops, two heights'],
];

/* ---------------- gimbals ---------------- */

/**
 * One stick.
 *
 * Two things make it behave like a real gimbal rather than a game pad:
 *
 *   1. The grab is *relative*. Putting a thumb down anywhere on the pad does
 *      not teleport the stick — it picks the stick up where it already sits and
 *      moves it by however far the thumb travels. On a ratcheted throttle that
 *      is the difference between a smooth correction and dropping out of the
 *      sky because you tapped near the bottom of the pad.
 *
 *   2. Every pad owns exactly one pointer id and ignores all the others, so two
 *      thumbs drive two sticks at the same time. Nothing is captured to an
 *      element, so a thumb that slides off its pad keeps flying instead of
 *      sticking at the last value it had.
 *
 * Self-centring axes spring back on release; the throttle stays put when the
 * flight model has no altitude hold, exactly like a Mode 2 transmitter.
 */

const PADS = [];
const SPRING = 30;      // return rate, ~1/e per 33 ms — quick but not a snap
const DEADZONE = 0.02;  // kills the last sliver of thumb noise around centre

class Gimbal {
  constructor(el, { mirror = false } = {}) {
    this.el = el;
    this.mirror = mirror;   // which edge the vertical deflection bar sits on
    this.canvas = el.querySelector('canvas');
    this.g = this.canvas.getContext('2d');

    this.x = 0;         // -1 … 1, left/right (yaw or roll)
    this.y = 0;         // -1 … 1, down/up   (throttle or pitch)
    this.rest = 0;      // where a ratcheted throttle wants to sit to hover
    this.stickyY = false;

    this.id = null;     // pointer id currently holding this stick
    this.gx = 0;        // thumb position at the moment of the grab
    this.gy = 0;
    this.bx = 0;        // stick position at the moment of the grab
    this.by = 0;
    this.ux = 1;        // usable half-width / half-height, in px
    this.uy = 1;
    this.knob = 26;
    this.rx = 1;
    this.ry = 1;
    this.press = 0;     // 0…1, drives the halo under the thumb

    el.addEventListener('pointerdown', (e) => this.grab(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    PADS.push(this);
  }

  /** Sticky = the throttle stays where you left it, like a real gimbal. */
  setSticky(on, rest = 0) {
    this.rest = rest;
    if (this.stickyY === on) return;
    this.stickyY = on;
    this.y = on ? rest : 0;
  }

  measure() {
    const r = this.el.getBoundingClientRect();
    this.knob = Math.max(17, Math.min(26, Math.min(r.width, r.height) * 0.085));
    let rx = Math.max(1, r.width / 2 - this.knob);
    let ry = Math.max(1, r.height / 2 - this.knob);
    // A real gimbal gate is square. A tall portrait pad would otherwise give
    // pitch three times the travel of roll, which flies horribly, so the gate
    // is held to a sane aspect and the spare pad area is just margin.
    const CAP = 1.75;
    ry = Math.min(ry, rx * CAP);
    rx = Math.min(rx, ry * CAP);
    this.rx = rx;
    this.ry = ry;
    this.ux = rx;
    this.uy = ry;
  }

  grab(e) {
    if (this.id !== null) return;      // already has a thumb on it
    this.id = e.pointerId;
    this.measure();
    this.gx = e.clientX;
    this.gy = e.clientY;
    this.bx = this.x;
    this.by = this.y;
    navigator.vibrate?.(8);
    e.preventDefault();
  }

  drag(e) {
    if (e.pointerId !== this.id) return;

    // Relative travel from the grab point, re-anchored whenever the stick is
    // already against a stop — otherwise dragging 3 units past the edge would
    // need 3 units of travel back before the stick moved again.
    const nx = this.bx + (e.clientX - this.gx) / this.ux;
    const ny = this.by - (e.clientY - this.gy) / this.uy;
    this.x = clamp(nx);
    this.y = clamp(ny);
    if (nx !== this.x) { this.bx = this.x; this.gx = e.clientX; }
    if (ny !== this.y) { this.by = this.y; this.gy = e.clientY; }

    e.preventDefault();
  }

  release(e) {
    if (e.pointerId !== this.id) return;
    this.id = null;
  }

  /** Spring the untouched axes back to centre. */
  tick(dt) {
    this.press += ((this.id !== null ? 1 : 0) - this.press) * Math.min(1, dt * 14);
    if (this.id !== null) return;
    const k = 1 - Math.exp(-SPRING * dt);
    this.x += -this.x * k;
    if (!this.stickyY) this.y += -this.y * k;
    if (Math.abs(this.x) < 0.002) this.x = 0;
    if (!this.stickyY && Math.abs(this.y) < 0.002) this.y = 0;
  }

  /** What actually goes on the wire. */
  out(axis) {
    const v = axis === 'x' ? this.x : this.y;
    if (axis === 'y' && this.stickyY) return v;   // absolute throttle, no deadzone
    return Math.abs(v) < DEADZONE ? 0 : v;
  }

  draw() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
      this.measure();
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const rx = this.rx;
    const ry = this.ry;
    const px = cx + this.x * rx;
    const py = cy - this.y * ry;

    // the gate the stick travels in
    g.strokeStyle = 'rgba(35,45,68,0.9)';
    g.lineWidth = 1;
    g.beginPath();
    g.rect(cx - rx, cy - ry, rx * 2, ry * 2);
    g.stroke();

    // crosshair + centre detent
    g.beginPath();
    g.moveTo(cx, cy - ry);
    g.lineTo(cx, cy + ry);
    g.moveTo(cx - rx, cy);
    g.lineTo(cx + rx, cy);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, 15, 0, Math.PI * 2);
    g.stroke();

    // In sticky mode, mark the hover position so you know where to come back to.
    if (this.stickyY) {
      const hy = cy - this.rest * ry;
      g.strokeStyle = 'rgba(47,211,156,0.55)';
      g.setLineDash([5, 5]);
      g.beginPath();
      g.moveTo(cx - rx, hy);
      g.lineTo(cx + rx, hy);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(47,211,156,0.75)';
      g.font = '9px ui-monospace, monospace';
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText('HOVER', cx - rx + 2, hy - 3);
    }

    // deflection bars hard against the outer edges, the way a transmitter OSD
    // shows them — clear of the axis labels sitting just inside
    this.bar(g, cx, h - 6, rx, this.x, false);
    this.bar(g, this.mirror ? w - 6 : 6, cy, ry, this.y, true);

    // halo while a thumb is on the pad
    if (this.press > 0.01) {
      g.fillStyle = `rgba(255,122,26,${0.13 * this.press})`;
      g.beginPath();
      g.arc(px, py, this.knob * (1.35 + 0.3 * this.press), 0, Math.PI * 2);
      g.fill();
    }

    // the arm from centre to the stick
    g.strokeStyle = 'rgba(255,122,26,0.3)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(px, py);
    g.stroke();

    // the stick head
    const k = this.knob;
    const grad = g.createRadialGradient(px - k * 0.3, py - k * 0.4, k * 0.1, px, py, k);
    grad.addColorStop(0, this.id !== null ? '#ffa055' : '#ff7a1a');
    grad.addColorStop(1, this.id !== null ? '#e8620a' : '#c95a10');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(px, py, k, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(7,11,20,0.55)';
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = '#070b14';
    g.beginPath();
    g.arc(px, py, k * 0.22, 0, Math.PI * 2);
    g.fill();
  }

  /** A centre-anchored bar showing one axis' deflection. */
  bar(g, x, y, half, v, vertical) {
    g.strokeStyle = 'rgba(35,45,68,0.9)';
    g.lineWidth = 3;
    g.lineCap = 'butt';
    g.beginPath();
    if (vertical) { g.moveTo(x, y - half); g.lineTo(x, y + half); }
    else { g.moveTo(x - half, y); g.lineTo(x + half, y); }
    g.stroke();

    if (Math.abs(v) < 0.005) return;
    g.strokeStyle = '#2fd39c';
    g.beginPath();
    if (vertical) { g.moveTo(x, y); g.lineTo(x, y - v * half); }
    else { g.moveTo(x, y); g.lineTo(x + v * half, y); }
    g.stroke();
  }
}

const left = new Gimbal($('g-left'));
const right = new Gimbal($('g-right'), { mirror: true });

// No pointer capture anywhere: touch pointers are implicitly retargeted to the
// pad they started on, so these three listeners see every move of every thumb,
// and each pad picks out the one id it owns.
addEventListener('pointermove', (e) => { for (const p of PADS) p.drag(e); }, { passive: false });
addEventListener('pointerup', (e) => { for (const p of PADS) p.release(e); });
addEventListener('pointercancel', (e) => { for (const p of PADS) p.release(e); });
addEventListener('resize', () => { for (const p of PADS) p.measure(); });

/* ---------------- link ---------------- */

const params = new URLSearchParams(location.search);
const savedPin = (() => { try { return localStorage.getItem('dt-pin') || ''; } catch { return ''; } })();
let pin = params.get('pin') || savedPin || '';
let link = null;
let lastPulse = 0;
let savedPinWritten = '';
let choseAt = -1e9;   // when this phone last picked a mode, for the grace window

const state = { air: false, crash: false, armed: false, session: null, started: false, modeIndex: 0, sim: 0, anySim: 0 };
/** True while the pilot deliberately opened the picker mid-flight. */
let pickManual = false;

/* The arena side of the phone: a callsign, a seat, and the round mirrored from
   the screen. The callsign is remembered so it is typed once, ever. */
const savedCall = (() => { try { return localStorage.getItem('dt-callsign') || ''; } catch { return ''; } })();
const savedTeam = (() => { try { return localStorage.getItem('dt-team') || ''; } catch { return ''; } })();
const arena = { callsign: savedCall, team: savedTeam, isDefault: true, seat: null, lobby: null };

function rememberTeam(code) {
  arena.team = code;
  try {
    if (code) localStorage.setItem('dt-team', code);
    else localStorage.removeItem('dt-team');
  } catch { /* private mode */ }
}

function connect(code) {
  pin = code;
  if (link) return link.repair(code);
  link = new Link({
    role: 'ctrl',
    pin: code,
    callsign: arena.callsign,
    team: arena.team,
    onMessage: onPacket,
    onStatus: onLinkStatus,
    onPeers: onPeers,
  });
}

function onLinkStatus(status, detail) {
  if (status === 'denied') {
    savedPinWritten = '';
    try { localStorage.removeItem('dt-pin'); } catch { /* private mode */ }
    show('gate');
    $('gate-card').classList.remove('busy');
    $('gate-err').textContent = detail || 'Rejected';
  } else if (status === 'online') {
    // Remember the code once, on the way in — peer updates re-report 'online'
    // and there is no reason to touch storage on every one of them.
    if (savedPinWritten !== pin) {
      savedPinWritten = pin;
      try { localStorage.setItem('dt-pin', pin); } catch { /* private mode */ }
    }
    // Paired. Where we land depends on whether the simulator is up yet, which
    // the peer count tells us a beat later.
    if (!state.started && $('gate').hidden === false) show(state.sim > 0 ? 'pick' : 'wait');
    keepAwake();
  } else if (status === 'offline') {
    $('t-link').textContent = '––';
    setLinkWarn(true, 'Reconnecting to the server…');
  }
}

function onPeers(peers) {
  state.sim = peers.sim || 0;
  // `any` counts screens in every team, not just this phone's. A phone that has
  // only just paired is in the default room, so judging on `sim` alone would
  // strand it on the waiting screen the moment every screen had joined a team.
  state.anySim = peers.any ?? peers.sim ?? 0;
  // The moment a simulator appears anywhere, move off the waiting screen.
  if (state.anySim > 0) {
    setLinkWarn(false);
    if (!$('wait').hidden) show(state.started ? 'tx' : 'pick');
  } else if (link?.status === 'online') {
    setLinkWarn(true, 'Simulator is not running — start it on the computer.');
    if (!$('tx').hidden || !$('pick').hidden) show('wait');
  }
}

function setLinkWarn(on, text = '') {
  const el = $('linkwarn');
  el.hidden = !on;
  if (on) el.textContent = text;
}

/** Only one screen is ever up. */
const SCREENS = ['gate', 'wait', 'name', 'team', 'seats', 'pick', 'tx', 'tasksheet'];
function show(which) {
  for (const id of SCREENS) $(id).hidden = id !== which;
  if (which === 'tx') for (const p of PADS) p.measure();
  // Nothing to go back to before the first choice is made.
  $('pick-back').hidden = !state.started;
  if (which === 'seats') renderSeats();
  if (which === 'name') $('cs-input').value = arena.callsign;
  if (which === 'team') {
    $('team-who').textContent = arena.callsign || 'Pilot';
    $('team-input').value = arena.isDefault ? '' : arena.team;
    $('team-err').textContent = '';
  }
}

const showing = (id) => $(id).hidden === false;

function onPacket(m) {
  if (m.t === 'lobby') {
    arena.lobby = m;
    arena.isDefault = !!m.isDefault;
    if (showing('seats')) renderSeats();
    return;
  }
  if (m.t === 'team/joined') {
    arena.isDefault = !!m.isDefault;
    rememberTeam(m.isDefault ? '' : m.code);
    $('team-err').textContent = '';
    // Landing in a real team is the cue to pick a seat in it.
    if (!m.isDefault && (showing('team') || showing('name'))) show('seats');
    return;
  }
  if (m.t === 'team/error') {
    $('team-err').textContent = m.reason || 'That did not work';
    if (!showing('team')) show('team');
    return;
  }
  if (m.t === 'seat/assigned') {
    arena.seat = m.seat;
    arena.callsign = m.callsign;
    if (m.team) {
      arena.isDefault = !!m.isDefault;
      rememberTeam(m.isDefault ? '' : m.team);
    }
    if (showing('seats') || showing('name')) {
      if (state.started) {
        show(state.session === 'task' ? 'tasksheet' : 'tx');
      } else {
        show('pick');
      }
    }
    return;
  }
  if (m.t === 'seat/error') {
    arena.seat = null;
    if (showing('tx')) show('seats');
    else if (showing('seats')) renderSeats();
    $('seat-err') && ($('seat-err').textContent = m.reason || '');
    setLinkWarn(true, m.reason || 'Lost the seat');
    return;
  }
  if (m.t === 'round/begin' || m.t === 'round/go') {
    // The screen switched into a round, so the phone follows it there.
    if (arena.seat != null && !showing('tx')) show('tx');
    return;
  }
  if (m.t !== 'state') return;

  // The simulator is the source of truth for which mode we are in.
  state.session = m.session;
  state.started = m.started;
  // If the laptop picked a mode while the phone was still on the chooser,
  // follow it — but never yank the pilot off a picker they opened themselves.
  if (m.started && !pickManual && (!$('pick').hidden || !$('wait').hidden)) show('tx');
  // And if the simulator was restarted, the sticks are driving nothing: go back
  // and choose again. The grace window keeps an in-flight packet from bouncing
  // the pilot off a mode they picked a moment ago.
  if (!m.started && !$('tx').hidden && performance.now() - choseAt > 1500) show('pick');

  $('t-alt').textContent = m.alt.toFixed(1);
  $('t-spd').textContent = m.spd.toFixed(1);
  $('t-batt').textContent = m.batt;
  $('tele-batt').classList.toggle('low', m.batt < 25);

  if (m.echo) $('t-link').textContent = `${Date.now() - m.echo} ms`;

  $('t-obj').textContent = m.crash ? 'Crashed — press Reset' : `${m.task} · ${m.objective}`;
  $('t-bar').style.width = `${m.prog * 100}%`;
  $('t-hint').textContent = m.detail || m.hint || '';
  $('b-mode').textContent = m.modeLabel;
  $('b-session').textContent =
    m.session === 'task' ? `Task ${m.taskIndex + 1}` : m.session === 'arena' ? `Seat ${m.arena?.seat ?? '–'}` : 'Free';
  renderArena(m.arena);
  $('b-view').textContent = m.cam?.split(' ')[0] || 'View';
  $('b-tasks').hidden = m.session !== 'task';

  // The coach panel, mirrored step for step.
  const g = m.guide;
  $('t-guide').hidden = !g;
  if (g) {
    $('g-key').textContent = g.key;
    $('g-count').textContent = `${g.n} / ${g.of}`;
    $('g-title').textContent = g.title;
    $('g-body').textContent = g.body;
    $('g-bar').style.width = `${g.p * 100}%`;
  }

  // No altitude hold means the throttle stick is an absolute position, so it
  // has to stay where the thumb left it — with the hover point marked.
  left.setSticky(!m.altHold, m.hoverStick ?? 0);

  const fly = $('b-fly');
  fly.textContent = m.crash ? 'Reset' : m.air ? 'Land' : 'Take off';
  fly.classList.toggle('armed', m.air);
  $('b-motors').setAttribute('aria-pressed', String(!!m.armed));
  state.air = m.air;
  state.crash = m.crash;
  state.armed = m.armed;
  state.modeIndex = Math.max(0, MODES.indexOf(m.mode));

  if (m.pulse !== lastPulse) {
    lastPulse = m.pulse;
    navigator.vibrate?.(30);
    openCoach();
  }
}

/* ---------------- arena ---------------- */

/** The round strip above the sticks. Hidden entirely outside the arena. */
function renderArena(a) {
  const el = $('tx-arena');
  const on = !!a;
  if (el.hidden === on) el.hidden = !on;
  if (!on) return;
  $('a-round').textContent = a.round || 0;
  $('a-of').textContent = a.of || 0;
  $('a-track').textContent =
    a.phase === 'briefing' ? `${a.track} — GO IN ${a.count}` : a.phase === 'results' ? 'Round over' : a.track || '—';
  $('a-ring').textContent = a.ring ?? 0;
  $('a-rings').textContent = a.rings ?? 0;
  $('a-time').textContent = (a.clock ?? 0).toFixed(1);
  $('a-pts').textContent = a.done ? '—' : a.pts ?? 0;
  el.classList.toggle('brief', a.phase === 'briefing');
  el.classList.toggle('low', a.phase === 'flying' && a.left > 0 && a.left < 30);
}

function renderSeats() {
  const ul = $('seat-list');
  ul.innerHTML = '';
  $('seat-who').textContent = arena.callsign || 'Pilot';
  $('seat-team').textContent = arena.lobby?.team || arena.team || '----';
  const seats = arena.lobby?.seats || [];
  if (!seats.length) {
    const li = document.createElement('li');
    li.className = 'seat-empty';
    li.textContent = 'Waiting for the relay…';
    ul.appendChild(li);
    return;
  }
  for (const s of seats) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const mine = s.id === arena.seat;
    const taken = s.phone && !mine;
    b.disabled = !s.screen || taken;
    b.innerHTML = '<span class="tn"></span><span class="ts"></span>';
    b.querySelector('.tn').textContent = `Seat ${s.id}`;
    b.querySelector('.ts').textContent = !s.screen
      ? 'no screen on this seat yet'
      : mine
        ? 'you are in this seat'
        : taken
          ? `taken by ${s.callsign}`
          : 'open — screen ready';
    if (mine) b.setAttribute('aria-current', 'true');
    b.onclick = () => {
      link?.send({ t: 'seat/claim', seat: s.id, callsign: arena.callsign });
      navigator.vibrate?.(12);
    };
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function saveCallsign(v) {
  arena.callsign = v;
  try { localStorage.setItem('dt-callsign', v); } catch { /* private mode */ }
}

$('cs-go').onclick = () => {
  const v = $('cs-input').value.trim().replace(/\s+/g, ' ');
  if (v.length < 2) {
    $('cs-err').textContent = 'At least two characters.';
    return;
  }
  $('cs-err').textContent = '';
  saveCallsign(v);
  show(arena.isDefault ? 'team' : 'seats');
};
$('cs-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('cs-go').click();
});

$('team-go').onclick = () => {
  const code = $('team-input').value.trim().toUpperCase();
  if (code.length < 3) {
    $('team-err').textContent = 'Four characters, from whoever started the team.';
    return;
  }
  $('team-err').textContent = '';
  link?.send({ t: 'team/join', code, callsign: arena.callsign });
  navigator.vibrate?.(12);
};
$('team-input').addEventListener('input', () => {
  $('team-input').value = $('team-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});
$('team-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('team-go').click();
});
$('team-make').onclick = () => {
  $('team-err').textContent = '';
  link?.send({ t: 'team/create', callsign: arena.callsign });
};
$('team-rename').onclick = () => show('name');
$('seat-team-back').onclick = () => show('team');

/* ---------------- send loop ---------------- */

const MODES = ['beginner', 'sport', 'cruise', 'realistic', 'acro'];
let lastSent = 0;
let lastFrame = performance.now();

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  // Keep ticking even behind a sheet: the sticks spring to neutral and the
  // packets keep flowing, so opening the task list parks the transmitter
  // rather than looking like a dropped link. draw() no-ops on a hidden canvas.
  for (const p of PADS) { p.tick(dt); p.draw(); }

  if (!link || now - lastSent < 33) return;
  lastSent = now;
  link.send({
    t: 'input',
    a: { t: left.out('y'), y: left.out('x'), p: right.out('y'), r: right.out('x') },
    ts: Date.now(),
  });
}
requestAnimationFrame(loop);

/* ---------------- buttons ---------------- */

function cmd(name, value) {
  link?.send({ t: 'cmd', name, value });
  navigator.vibrate?.(12);
}

$('b-fly').onclick = () => {
  if (state.crash) return cmd('reset');
  if (state.air) cmd('land');
  else cmd('takeoff');
};
$('b-motors').onclick = () => cmd('arm', !state.armed);
$('b-view').onclick = () => cmd('camera');
$('b-reset').onclick = () => cmd('reset');
$('b-mode').onclick = () => {
  state.modeIndex = (state.modeIndex + 1) % MODES.length;
  cmd('mode', MODES[state.modeIndex]);
};
$('b-session').onclick = () => { pickManual = true; show('pick'); };
$('b-tasks').onclick = () => show('tasksheet');
$('tasks-back').onclick = () => show('tx');
$('pick-back').onclick = () => { pickManual = false; show(state.started ? 'tx' : 'pick'); };

/* The coach folds away so the sticks get the whole screen; a new step pops it
   back open for a few seconds. */
let coachTimer = 0;
function openCoach(sticky = false) {
  const el = $('t-guide');
  if (el.hidden) return;
  el.classList.add('open');
  clearTimeout(coachTimer);
  if (!sticky) coachTimer = setTimeout(() => el.classList.remove('open'), 6000);
}
$('t-guide').onclick = () => {
  clearTimeout(coachTimer);
  $('t-guide').classList.toggle('open');
};

for (const b of document.querySelectorAll('.pick')) {
  b.onclick = () => {
    const which = b.dataset.session;
    state.started = true;
    choseAt = performance.now();
    pickManual = false;
    fullscreenForFlight();   // committing to fly — this tap is the gesture

    if (which === 'arena') {
      // Name, then team, then seat. Each step is skipped if it is already
      // settled, so a returning pilot goes straight to the seat list.
      cmd('session', 'arena');
      if (!arena.callsign) show('name');
      else if (arena.isDefault) show('team');
      else show('seats');
      return;
    }
    
    cmd('session', which);
    if (arena.seat == null) {
      show('seats');
      return;
    }
    
    show(which === 'task' ? 'tasksheet' : 'tx');
  };
}

function buildTaskMenu() {
  const ul = $('t-list');
  ul.innerHTML = '';
  TASK_MENU.forEach(([id, name, sub]) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.innerHTML = '<span class="tn"></span><span class="ts"></span>';
    b.querySelector('.tn').textContent = name;
    b.querySelector('.ts').textContent = sub;
    b.onclick = () => {
      choseAt = performance.now();
      fullscreenForFlight();
      cmd('task', id);
      show('tx');
    };
    li.appendChild(b);
    ul.appendChild(li);
  });
}
buildTaskMenu();

/* ---------------- pairing gate ---------------- */

$('pin-go').onclick = () => {
  const v = $('pin-input').value.trim();
  if (!/^\d{4}$/.test(v)) {
    $('gate-err').textContent = 'Four digits, from the simulator screen.';
    return;
  }
  $('gate-err').textContent = '';
  $('gate-card').classList.add('busy');
  connect(v);
};
$('pin-input').addEventListener('input', () => {
  $('pin-input').value = $('pin-input').value.replace(/\D/g, '').slice(0, 4);
  if ($('pin-input').value.length === 4) $('pin-go').click();
});
$('pin-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('pin-go').click();
});
$('rotate-stay').onclick = () => {
  document.body.classList.add('upright-ok');
  fullscreenForFlight(false);   // upright or not, the chrome still wastes screen
  for (const p of PADS) p.measure();
};
$('wait-repair').onclick = () => {
  savedPinWritten = '';
  try { localStorage.removeItem('dt-pin'); } catch { /* private mode */ }
  $('gate-card').classList.remove('busy');
  $('gate-err').textContent = '';
  show('gate');
};

/* ---------------- full screen ---------------- */

/**
 * A transmitter should not have a URL bar across the top of it.
 *
 * The usual trick — scroll the page a little and let the browser hide its
 * chrome — cannot work here: scrolling is off everywhere so the sticks do not
 * drag the page around. So the Fullscreen API is the only way in, and it has to
 * be asked for from inside a real tap.
 *
 * iPhone Safari has no Fullscreen API for anything but <video>. There the
 * button hides itself and Add to Home Screen is the way to lose the chrome —
 * the apple-mobile-web-app meta tags in controller.html already set that up.
 */
const fsBtn = $('b-full');
const root = document.documentElement;
const canFullscreen = !!(root.requestFullscreen || root.webkitRequestFullscreen);
// The button is never hidden. Where the API exists it takes the browser chrome
// with it; where it does not, it still strips this page down to the sticks,
// which is most of the win.
fsBtn.hidden = false;

/** Set once the pilot leaves full screen on purpose, so we stop re-asking. */
let fsOptOut = false;
let fsTipShown = false;

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/**
 * Immersive: the transmitter with everything that is not a stick shaved off.
 * Padding, rounding, the hint line and the objective text all go, which is
 * roughly a quarter of the height back on a short phone.
 */
function setImmersive(on) {
  document.body.classList.toggle('immersive', on);
  fsBtn.setAttribute('aria-pressed', String(on));
  if (on && !canFullscreen && !fsTipShown) {
    fsTipShown = true;
    showFsTip();
  }
  // The gimbal gates are measured in pixels and the pads just changed size.
  requestAnimationFrame(() => { for (const p of PADS) p.measure(); });
}

let fsTipTimer = 0;
function showFsTip() {
  const el = $('fstip');
  el.hidden = false;
  clearTimeout(fsTipTimer);
  fsTipTimer = setTimeout(() => (el.hidden = true), 6000);
}

/**
 * Call straight out of a tap — a deferred request is rejected.
 *
 * `lockLandscape` is off for a pilot who has said they want to fly upright;
 * turning their phone for them at that exact moment would be maddening.
 */
async function enterFullscreen(lockLandscape = true) {
  setImmersive(true);
  if (!canFullscreen || isFullscreen()) return;
  try {
    await (root.requestFullscreen?.({ navigationUI: 'hide' }) ?? root.webkitRequestFullscreen());
  } catch {
    return;   // gesture expired, or the browser said no
  }
  // The lock only resolves while full screen, and only on Android. When it
  // takes, the "turn the phone sideways" nag never has to appear at all.
  if (!lockLandscape) return;
  try { await screen.orientation?.lock?.('landscape'); } catch { /* not supported */ }
}

async function exitFullscreen() {
  setImmersive(false);
  try { screen.orientation?.unlock?.(); } catch { /* not supported */ }
  try { await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.()); } catch { /* already out */ }
}

/** Auto-entry on the way to the sticks, unless the pilot has opted out. */
function fullscreenForFlight(lockLandscape = true) {
  if (!fsOptOut) enterFullscreen(lockLandscape);
}

fsBtn.onclick = () => {
  if (document.body.classList.contains('immersive')) {
    fsOptOut = true;
    exitFullscreen();
  } else {
    fsOptOut = false;
    enterFullscreen();
  }
};

function onFullscreenChange() {
  const on = isFullscreen();
  // Leaving by the system back gesture or Esc is also an opt-out; re-entering
  // on the next tap would fight the pilot. The stripped layout goes with it, so
  // the button and the screen never disagree about which state we are in.
  if (!on) {
    fsOptOut = true;
    setImmersive(false);
  }
  // The viewport just changed size and the gimbal gates are measured in pixels.
  for (const p of PADS) p.measure();
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

/* ---------------- phone housekeeping ---------------- */

let wakeLock = null;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener?.('release', () => { wakeLock = null; });
  } catch {
    /* not supported over plain http on some phones — harmless */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) keepAwake();
  // A backgrounded phone never delivers pointerup, so drop every stick.
  if (document.visibilityState === 'hidden') for (const p of PADS) p.id = null;
});

// Stop double-tap zoom and rubber-band scrolling on iOS, but let the sheets
// scroll.
document.addEventListener(
  'touchmove',
  (e) => {
    if (!e.target.closest?.('.scrolls')) e.preventDefault();
  },
  { passive: false }
);
document.addEventListener('gesturestart', (e) => e.preventDefault());

if (/^\d{4}$/.test(pin)) {
  $('gate-card').classList.add('busy');
  $('pin-input').value = pin;
  connect(pin);
}
