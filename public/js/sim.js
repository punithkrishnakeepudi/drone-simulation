/**
 * Simulator — runs on the laptop.
 *
 * Owns the physics, the scene and the session state. The phone only sends
 * stick positions and button presses; everything else happens here so that a
 * dropped packet never corrupts the flight.
 *
 * Three sessions:
 *   free  — open field, full physics, nothing explained and nothing scored
 *   task  — five tyre courses; the first one talks you through the controls
 *   arena — a team of up to five, a track a round, scored. The relay owns the
 *           match; this screen owns its own flight and reports its own score,
 *           and never receives anything about anybody else's drone.
 */

import * as THREE from 'three';
import { Drone, PROFILES } from './physics.js';
import { TASKS, FREE, TaskRunner, GUIDE } from './tasks.js';
import { THEMES, trackById, trackProfile, scoreRound } from './tracks.js';
import { buildWorld, buildDrone, buildFlightAids, courseLayer, PILOT_POS } from './world.js';
import { drawRadar, drawAltTape, drawStick } from './hud.js';
import { drawPathBox } from './pathbox.js';
import { Link } from './net.js';

const $ = (id) => document.getElementById(id);

/* ---------------- scene ---------------- */

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 1200);
const world = buildWorld(scene);
const droneMesh = buildDrone();
droneMesh.castShadow = true;
scene.add(droneMesh);
const aids = buildFlightAids(scene);
const course = courseLayer(scene);

/** Cached pixel rect of the drone-cam inset; null means "measure it again". */
let dcamRect = null;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dcamRect = null;   // the inset moved with the layout
}
window.addEventListener('resize', resize);
resize();

/* ---------------- state ---------------- */

const drone = new Drone();
const runner = new TaskRunner(onTaskEvent);

let session = 'free';       // 'free' | 'task' | 'arena'
let taskIndex = 0;
let profileKey = 'cruise';
let aidsOn = false;
let trailOn = false;
let pulse = 0;
let courseKey = '';

/**
 * Arena state.
 *
 * The relay owns the match — which round it is, which track was drawn and when
 * the clock stops. This screen owns the flight and its own score, and reports
 * both upwards. Nothing about any other pilot's drone is ever received here,
 * which is what makes the isolation between pilots real rather than cosmetic.
 */
const arena = {
  seat: null,
  team: null,         // the team code this screen is in
  isDefault: true,    // true while in the shared default room, i.e. no team yet
  phase: 'lobby',     // team | lobby | briefing | flying | results | ended
  round: 0,
  of: 0,
  track: null,
  endsAt: 0,
  countdownAt: 0,
  hits: 0,
  crashes: 0,
  respawnAt: 0,
  finished: false,
  rows: [],
  sentAt: 0,
};

const ui = { camChanges: 0 };
const input = { roll: 0, pitch: 0, yaw: 0, thr: 0 };
const phone = { roll: 0, pitch: 0, yaw: 0, thr: 0, at: -99, ts: 0 };
const keys = Object.create(null);

/** Points the path box draws as "where you actually flew". */
const trace = [];
const TRACE_MAX = 1400;
let traceAcc = 0;

const CAMS = [
  { id: 'pilot', label: 'Pilot view' },
  { id: 'chase', label: 'Chase' },
  { id: 'fpv', label: 'Nose camera' },
  { id: 'top', label: 'Overhead' },
];
let camIndex = 0;

const chasePos = new THREE.Vector3(0, 2, 6);
const tmp = new THREE.Vector3();
const lookTmp = new THREE.Vector3();

/**
 * The camera bolted to the drone, drawn into the inset panel.
 *
 * It is on a gimbal, the way the camera on a real Tello or Mavic is: it follows
 * the nose in yaw but the horizon stays level and it looks slightly down, so
 * the picture is steady enough to fly off. The unstabilised racing view — the
 * one that rolls with the airframe — is still the "Nose camera" View mode.
 */
const dcam = new THREE.PerspectiveCamera(72, 16 / 9, 0.04, 1200);
const DCAM_TILT = 0.13;     // radians below the horizon
let dcamOn = true;

/* ---------------- link ---------------- */

const params = new URLSearchParams(location.search);
const link = new Link({
  role: 'sim',
  pin: params.get('pin') || '',
  // A reload rejoins the team it was in rather than dropping into the shared room.
  team: (params.get('team') || savedTeam()).toUpperCase(),
  onMessage: onPacket,
  onStatus: renderStatus,
  onPeers: onPeers,
});

let phoneSeen = false;

function onPacket(m) {
  if (m.t === 'input') {
    phone.roll = m.a?.r ?? 0;
    phone.pitch = m.a?.p ?? 0;
    phone.yaw = m.a?.y ?? 0;
    phone.thr = m.a?.t ?? 0;
    phone.at = performance.now();
    phone.ts = m.ts || 0;
  } else if (m.t === 'cmd') {
    handleCommand(m.name, m.value);
  } else if (m.t === 'welcome') {
    arena.seat = m.seat ?? null;
    arena.team = m.team ?? null;
    arena.isDefault = m.isDefault !== false;
    // A reconnect can land somewhere other than where we left — a restarted
    // relay has forgotten every team — so the arena screen has to be redrawn
    // rather than left showing a team that no longer exists.
    updateSessionChip();
    if (session === 'arena' && arena.phase !== 'flying' && arena.phase !== 'briefing') {
      arena.phase = 'lobby';
      showArenaSheet(arena.isDefault ? 'team' : 'lobby');
    }
  } else if (m.t === 'team/joined') {
    arena.team = m.code;
    arena.seat = m.seat ?? arena.seat;
    arena.isDefault = !!m.isDefault;
    rememberTeam(m.isDefault ? '' : m.code);
    if (session === 'arena') {
      arena.phase = 'lobby';
      showArenaSheet(m.isDefault ? 'team' : 'lobby');
    }
    updateSessionChip();
  } else if (m.t === 'team/error') {
    $('ar-err').textContent = m.reason || 'That did not work';
  } else if (m.t === 'round/begin') {
    onRoundBegin(m);
  } else if (m.t === 'round/go') {
    onRoundGo(m);
  } else if (m.t === 'leaderboard') {
    arena.rows = m.rows || [];
  } else if (m.t === 'round/end') {
    onRoundEnd(m);
  } else if (m.t === 'match/end') {
    onMatchEnd(m);
  } else if (m.t === 'match/abort') {
    arena.phase = 'lobby';
    if (session === 'arena') showArenaSheet(arena.isDefault ? 'team' : 'lobby');
  } else if (m.t === 'lobby') {
    arena.lobby = m;
    // Without a team there is nothing to show a lobby for, and redrawing here
    // would wipe the team gate out from under the pilot.
    if (session === 'arena' && arena.phase === 'lobby') showArenaSheet(arena.isDefault ? 'team' : 'lobby');
  }
}

/**
 * The relay tells both ends how many of each role are connected. That is what
 * lets this page get out of the way on its own: the instant a phone pairs, the
 * pairing card confirms it and hands over to the mode picker. Nobody has to
 * reach for the laptop.
 */
function onPeers(peers) {
  const phoneOn = (peers.ctrl || 0) > 0;
  $('pair').classList.toggle('linked', phoneOn);
  renderStatus();

  if (!phoneOn) {
    phoneSeen = false;
    return;
  }
  if (phoneSeen) return;
  phoneSeen = true;

  // A beat on "Phone connected" so the jump does not feel like a glitch, then
  // straight through to the next step.
  clearTimeout(handoffTimer);
  handoffTimer = setTimeout(() => {
    $('pair').hidden = true;
    if (!started) $('modes').hidden = false;
  }, 700);
}

let handoffTimer = 0;

/** Leaving the pairing card by any route should close it for good. */
function leavePairing() {
  clearTimeout(handoffTimer);
  $('pair').hidden = true;
}

function handleCommand(name, value) {
  // During the briefing everyone sits on the pad, and once a round is running
  // the flight model is the same for all five pilots — so neither is the
  // pilot's to change.
  // Only while a round is actually live. In the arena lobby the pilot is free
  // to wander back to free flight like anybody else.
  const live = session === 'arena' && (arena.phase === 'briefing' || arena.phase === 'flying');
  if (live) {
    if (arena.phase === 'briefing' && (name === 'arm' || name === 'takeoff')) {
      return toast('Wait for GO');
    }
    if (name === 'mode') return toast('The track sets the flight model');
    if (name === 'task') return;
    if (name === 'session' && value !== 'arena') return toast('Finish the round first');
    // Reset is a crash penalty here, not a clean restart.
    if (name === 'reset' && arena.phase === 'flying') {
      if (!drone.crashed) return;
      arena.respawnAt = performance.now();
      return;
    }
  }

  switch (name) {
    case 'arm': drone.arm(!!value); break;
    case 'takeoff': drone.takeoff(); break;
    case 'land': drone.land(); break;
    case 'reset': resetFlight(); break;
    case 'camera': cycleCamera(); break;
    case 'mode': setProfile(value); break;
    case 'aids': setAids(!!value); break;
    case 'session': setSession(value); break;
    case 'task': loadTask(value); break;
  }
}

function renderStatus() {
  const chip = $('chip-link');
  const label = chip.querySelector('span');
  const ctrl = link.peers.ctrl || 0;
  chip.className = 'chip ' + (ctrl > 0 ? 'ok' : link.status === 'online' ? 'warn' : '');
  const text =
    link.status !== 'online'
      ? 'Server offline'
      : ctrl > 0
        ? `Phone linked${ctrl > 1 ? ` ×${ctrl}` : ''}`
        : 'Waiting for phone';
  label.textContent = text;

  const wait = $('pair-status');
  if (wait) wait.textContent = ctrl > 0 ? 'Phone connected — opening the simulator…' : text + '…';
}

/* ---------------- input ---------------- */

const KEYMAP = {
  KeyW: ['thr', 1], KeyS: ['thr', -1],
  KeyA: ['yaw', -1], KeyD: ['yaw', 1],
  ArrowUp: ['pitch', 1], ArrowDown: ['pitch', -1],
  ArrowLeft: ['roll', -1], ArrowRight: ['roll', 1],
};

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (KEYMAP[e.code]) { keys[e.code] = 1; e.preventDefault(); }
  if (e.code === 'KeyT') drone.takeoff();
  if (e.code === 'KeyL') drone.land();
  if (e.code === 'KeyR') resetFlight();
  if (e.code === 'KeyC') cycleCamera();
  if (e.code === 'KeyM') setSession(session === 'free' ? 'task' : 'free');
  if (e.code === 'Space') { drone.arm(!drone.armed); e.preventDefault(); }
  if (e.code === 'KeyF') toggleFullscreen();
  if (e.code === 'KeyV') setDroneCam(!dcamOn);
  if (e.code === 'Escape') { $('tasks').hidden = true; }
});
addEventListener('keyup', (e) => { if (KEYMAP[e.code]) keys[e.code] = 0; });
addEventListener('blur', () => { for (const k in keys) keys[k] = 0; });

let linkLostWarned = false;

function gatherInput() {
  const kb = { roll: 0, pitch: 0, yaw: 0, thr: 0 };
  for (const code in KEYMAP) {
    if (keys[code]) {
      const [axis, sign] = KEYMAP[code];
      kb[axis] += sign;
    }
  }

  const fresh = performance.now() - phone.at < 600;
  if (!fresh && phone.at > 0 && !linkLostWarned && drone.airborne) {
    toast('Link lost — sticks centred');
    linkLostWarned = true;
  }
  if (fresh) linkLostWarned = false;

  for (const axis of ['roll', 'pitch', 'yaw', 'thr']) {
    const v = (fresh ? phone[axis] : 0) + kb[axis];
    input[axis] = Math.max(-1, Math.min(1, v));
  }

  // In a profile with no altitude hold the throttle stick is an absolute
  // position, so a centred keyboard means "hover", not "motors off".
  if (!PROFILES[profileKey].altHold && !fresh) {
    input.thr = kb.thr !== 0 ? kb.thr : hoverStick();
  }
}

/** Throttle stick value that roughly hovers, used as the keyboard neutral. */
function hoverStick() {
  const p = PROFILES[profileKey];
  return (1 / p.twr) * 2 - 1;
}

/* ---------------- events ---------------- */

let toastTimer = 0;
function toast(text, good = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast' + (good ? ' good' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function onTaskEvent(kind) {
  if (kind === 'tyre') {
    pulse++;
    toast(`Tyre ${runner.at} of ${runner.tyres.length}`, true);
  } else if (kind === 'miss') {
    toast('Missed that one — go back around');
  } else if (kind === 'guide-step') {
    pulse++;
  } else if (kind === 'guide-done') {
    pulse++;
    toast('Walk-through done — fly the course', true);
  } else if (kind === 'course-done') {
    pulse++;
    toast('All tyres — now land on the pad', true);
  } else if (kind === 'task-complete') {
    pulse += 2;
    const s = runner.score;
    toast(
      `${runner.task.name} complete · ${s.time.toFixed(1)}s · ${s.misses} missed · ${(s.landing * 100).toFixed(0)} cm`,
      true
    );
  }
}

function drainDroneEvents() {
  const scoring = session === 'arena' && arena.phase === 'flying';
  for (const e of drone.events) {
    // The arena counts these itself: drone.bumps goes back to zero on every
    // respawn, and a round's penalties have to survive that.
    if (scoring && (e === 'bump' || e === 'hard-landing')) arena.hits++;
    if (scoring && e === 'crash') arena.crashes++;

    if (e === 'crash') toast(scoring ? `Crashed — ${drone.crashReason}` : `Crashed — ${drone.crashReason}. Press R to reset`);
    else if (e === 'hard-landing') toast('Hard landing — descend slower');
    else if (e === 'bump') pulse++;
    else if (e === 'fence') toast('Edge of the flying area');
    else if (e === 'battery-empty') toast('Battery empty — landing');
  }
  drone.events.length = 0;
}

/* ---------------- session and tasks ---------------- */

let started = false;

function setSession(next) {
  if (next !== 'free' && next !== 'task' && next !== 'arena') return;
  session = next;
  started = true;
  leavePairing();
  $('modes').hidden = true;
  $('hud').hidden = false;

  if (session === 'arena') {
    // The relay runs the match. This screen takes a seat and waits to be told
    // which track to build, so there is nothing to load yet.
    $('btn-tasks').hidden = true;
    $('task-card').classList.remove('free');
    updateSessionChip();
    if (arena.phase !== 'flying' && arena.phase !== 'briefing') {
      arena.phase = 'lobby';
      // No team yet means the team gate, not the seat card.
      showArenaSheet(arena.isDefault ? 'team' : 'lobby');
    }
    renderTaskCard();
    return;
  }

  hideArenaSheet();
  arena.phase = 'lobby';
  arena.track = null;
  // Free flight and the tyre courses are flown on the field, so an arena the
  // pilot has just left has to be taken down with it.
  world.setTheme('field');

  if (session === 'free') {
    runner.load(FREE);
    setProfile('cruise');
    setAids(false);
    setTrail(false);
    course.clear();
    world.rings = [];
    courseKey = '';
    $('task-card').classList.add('free');
    $('btn-tasks').hidden = true;
    toast('Free flight', true);
  } else {
    $('task-card').classList.remove('free');
    $('btn-tasks').hidden = false;
    setAids(true);
    setTrail(true);
    loadTask(taskIndex);
  }

  $('chip-session').querySelector('span').textContent = session === 'free' ? 'Free flight' : 'Task mode';
  $('guide-card').hidden = runner.phase !== 'guide';
  resetFlight(true);
  renderTaskCard();
}

function loadTask(which) {
  const i = typeof which === 'number' ? which : TASKS.findIndex((t) => t.id === which);
  const task = TASKS[i];
  if (!task) return;

  session = 'task';
  started = true;
  taskIndex = i;
  runner.load(task);
  setProfile(task.profile);

  world.rings = task.tyres;
  course.set(task.tyres, 0);
  courseKey = `${task.id}|0`;

  leavePairing();
  $('modes').hidden = true;
  $('hud').hidden = false;
  $('tasks').hidden = true;
  $('task-card').classList.remove('free');
  $('btn-tasks').hidden = false;
  $('chip-session').querySelector('span').textContent = 'Task mode';
  for (const b of $('task-list').querySelectorAll('button')) {
    b.setAttribute('aria-current', String(b.dataset.id === task.id));
  }

  resetFlight(true);
  renderTaskCard();
  buildGuideDots();
}

/* ---------------- arena ---------------- */

const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

/**
 * The team code is remembered so a reload — or a laptop that goes to sleep
 * between rounds — comes back to the same team instead of the shared room.
 */
function rememberTeam(code) {
  try {
    if (code) localStorage.setItem('dt-team', code);
    else localStorage.removeItem('dt-team');
  } catch { /* private mode */ }
}

function savedTeam() {
  try { return localStorage.getItem('dt-team') || ''; } catch { return ''; }
}

function updateSessionChip() {
  if (session !== 'arena') return;
  const label = arena.isDefault ? 'Arena · no team' : `Team ${arena.team} · seat ${arena.seat ?? '–'}`;
  $('chip-session').querySelector('span').textContent = label;
}

/** An arena track, dressed as something TaskRunner already knows how to fly. */
function taskFromTrack(track) {
  return {
    id: track.id,
    n: 0,
    name: track.name,
    pattern: THEMES[track.theme]?.name || track.theme,
    profile: trackProfile(track),
    guided: false,
    brief: track.brief,
    tip: '',
    tyres: track.rings,
  };
}

function onRoundBegin(m) {
  const track = trackById(m.trackId);
  if (!track) return;

  session = 'arena';
  started = true;
  arena.phase = 'briefing';
  arena.round = m.round;
  arena.of = m.of;
  arena.track = track;
  arena.endsAt = 0;
  arena.countdownAt = performance.now() + (m.briefingMs || 10000);
  arena.hits = 0;
  arena.crashes = 0;
  arena.finished = false;
  arena.respawnAt = 0;
  arena.rows = [];

  leavePairing();
  $('modes').hidden = true;
  $('tasks').hidden = true;
  $('hud').hidden = false;
  $('task-card').classList.remove('free');
  $('btn-tasks').hidden = true;
  $('chip-session').querySelector('span').textContent = `Arena · seat ${arena.seat ?? '–'}`;

  world.setTheme(track.theme);
  world.rings = track.rings;
  runner.load(taskFromTrack(track));
  setProfile(trackProfile(track));
  setAids(true);
  setTrail(true);
  course.set(track.rings, 0);
  courseKey = `${track.id}|0`;
  resetFlight(true);
  renderTaskCard();
  showArenaSheet('briefing');
}

function onRoundGo(m) {
  arena.phase = 'flying';
  arena.endsAt = performance.now() + (m.limitMs || 180000);
  arena.hits = 0;
  arena.crashes = 0;
  arena.finished = false;
  // Everyone starts from the pad with a clock on zero, whatever they were
  // doing during the briefing.
  resetFlight(true);
  hideArenaSheet();
  toast('GO', true);
}

function onRoundEnd(m) {
  arena.phase = 'results';
  arena.rows = m.rows || [];
  showArenaSheet('results');
}

function onMatchEnd(m) {
  arena.phase = 'ended';
  arena.rows = m.rows || [];
  arena.team = m.team;
  arena.awards = m.awards;
  showArenaSheet('ended');
}

/** What this pilot's round looks like right now, in scoring terms. */
function arenaRun(dnf = false) {
  const s = runner.score;
  return {
    time: +runner.clock.toFixed(2),
    rings: runner.at,
    missed: s.misses,
    hits: arena.hits,
    crashes: arena.crashes,
    landing: s.landing,
    dnf,
  };
}

function reportProgress(now) {
  if (session !== 'arena' || arena.phase !== 'flying' || arena.finished) return;
  if (now - arena.sentAt < 500) return;
  arena.sentAt = now;
  link.send({
    t: 'round/progress',
    ring: runner.at,
    rings: runner.tyres.length,
    elapsed: +runner.clock.toFixed(1),
  });
}

function finishRound(dnf) {
  if (arena.finished) return;
  arena.finished = true;
  const run = arenaRun(dnf);
  const score = scoreRound(run);
  link.send({ t: 'round/finish', ...run, score });
  toast(dnf ? 'Out of time' : `Round complete · ${score} points`, !dnf);
}

/**
 * A crash in the arena is a penalty, not the end of the round: the drone goes
 * back on the pad by itself and the clock never stops.
 */
function arenaRespawn() {
  drone.reset();
  runner.prev = null;      // no phantom gate crossing across the teleport
  aids.clear();
  trace.length = 0;
}

function updateArena(now) {
  if (session !== 'arena') return;

  if (arena.phase === 'briefing') {
    const left = Math.max(0, (arena.countdownAt - now) / 1000);
    $('ar-count-n').textContent = String(Math.ceil(left));
    return;
  }
  if (arena.phase !== 'flying') return;

  // crash → back to the pad after a beat
  if (drone.crashed && !arena.respawnAt) arena.respawnAt = now + 1600;
  if (arena.respawnAt && now >= arena.respawnAt) {
    arena.respawnAt = 0;
    arenaRespawn();
  }

  if (runner.complete && !arena.finished) finishRound(false);
  if (!arena.finished && arena.endsAt && now >= arena.endsAt) finishRound(true);

  reportProgress(now);
}

function updateArenaBar() {
  const on = session === 'arena' && (arena.phase === 'flying' || arena.phase === 'briefing');
  const bar = $('arena-bar');
  if (bar.hidden === on) bar.hidden = !on;
  if (!on) return;

  $('ab-round').textContent = arena.round;
  $('ab-of').textContent = arena.of;
  $('ab-track').textContent = arena.track ? `${arena.track.name} · ${THEMES[arena.track.theme].name}` : '—';
  $('ab-ring').textContent = runner.at;
  $('ab-rings').textContent = runner.tyres.length;
  $('ab-time').textContent = runner.clock.toFixed(1);

  const left = arena.endsAt ? (arena.endsAt - performance.now()) / 1000 : 0;
  $('ab-left').textContent = mmss(left);
  bar.classList.toggle('low', arena.endsAt > 0 && left < 30);
  $('ab-pts').textContent = String(scoreRound(arenaRun(false)));

  const board = $('ab-board');
  const rows = arena.rows;
  board.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    if (r.seat === arena.seat) li.className = 'you';
    else if (r.done) li.className = 'done';
    li.innerHTML = '<span class="bn"></span><span class="bc"></span><span class="bt"></span>';
    li.querySelector('.bn').textContent = r.seat;
    li.querySelector('.bc').textContent = r.callsign;
    li.querySelector('.bt').textContent = r.done ? `${r.score ?? 0}` : `${r.ring}/${r.rings}`;
    board.appendChild(li);
  }
}

/* --- the arena sheet: seat, briefing, results, final table --- */

function showArenaSheet(kind) {
  const sheet = $('arena-sheet');
  const table = $('ar-table');
  const count = $('ar-count');
  sheet.hidden = false;
  table.hidden = true;
  count.hidden = true;
  $('ar-team').hidden = kind !== 'team';
  $('ar-code-strip').hidden = kind === 'team' || arena.isDefault;
  // 'HOME' is the relay's internal name for the shared room, not a team code.
  $('ar-code-big').textContent = arena.isDefault ? '----' : arena.team || '----';
  $('ar-foot').textContent = '';

  if (kind === 'team') {
    $('ar-eyebrow').textContent = 'Arena';
    $('ar-title').textContent = 'Which team?';
    $('ar-lede').textContent =
      'A team is up to five pilots flying the same tracks against each other. ' +
      'One person creates it and reads out the code; everyone else types that code in.';
    $('ar-foot').textContent = 'Each pilot needs their own screen and their own phone.';
    return;
  }

  if (kind === 'lobby') {
    const seats = arena.lobby?.seats || [];
    const mine = seats.find((s) => s.id === arena.seat);
    $('ar-eyebrow').textContent = `Team ${arena.team} · seat ${arena.seat ?? '–'}`;
    $('ar-title').textContent = mine?.phone ? `${mine.callsign} is on the sticks` : 'Waiting for a pilot';
    $('ar-lede').textContent = mine?.phone
      ? 'Seat ready. The round starts when the host says so.'
      : 'Open the controller on a phone, enter a callsign and take this seat.';
    const ready = seats.filter((s) => s.screen && s.phone).length;
    $('ar-foot').textContent = `${ready} of ${seats.length} seats crewed · the host starts the match`;
    return;
  }

  if (kind === 'briefing') {
    const t = arena.track;
    const theme = THEMES[t.theme];
    $('ar-eyebrow').textContent = `Round ${arena.round} of ${arena.of} · ${theme.name}`;
    $('ar-title').textContent = t.name;
    $('ar-lede').textContent = `${t.brief} ${theme.blurb}`;
    $('ar-foot').textContent =
      `${t.rings.length} rings in order, then land on the pad · ${trackProfile(t)} flight model · 3 minutes`;
    count.hidden = false;
    return;
  }

  if (kind === 'results') {
    $('ar-eyebrow').textContent = `Round ${arena.round} of ${arena.of}`;
    $('ar-title').textContent = 'Round result';
    $('ar-lede').textContent = arena.track ? `${arena.track.name} · ${THEMES[arena.track.theme].name}` : '';
    fillArenaTable(arena.rows, false);
    $('ar-foot').textContent = arena.round >= arena.of ? 'Final table next…' : 'Next round in a few seconds…';
    return;
  }

  // the whole match
  $('ar-eyebrow').textContent = 'Arena · match over';
  $('ar-title').textContent = 'Final table';
  const a = arena.awards || {};
  $('ar-lede').textContent = `Team total ${arena.team ?? 0} points`;
  fillArenaTable(arena.rows, true);
  const bits = [];
  if (a.fastest && Number.isFinite(a.fastest.best)) bits.push(`Fastest lap · ${a.fastest.callsign} ${a.fastest.best.toFixed(1)}s`);
  if (a.cleanest && a.cleanest.clean) bits.push(`Cleanest · ${a.cleanest.callsign} (${a.cleanest.clean} clean rounds)`);
  $('ar-foot').textContent = bits.join('   ·   ') || 'No clean rounds this time.';
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

function fillArenaTable(rows, final) {
  const table = $('ar-table');
  setTableHead($('ar-head'), final);
  const body = $('ar-rows');
  table.hidden = false;
  body.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (r.seat === arena.seat) tr.className = 'you';
    const cells = final
      ? [i + 1, r.callsign, r.rounds.join(' · '), '', '', '', r.crashes, r.total]
      : [
          i + 1,
          r.callsign,
          r.dnf ? 'DNF' : `${(r.time || 0).toFixed(1)}s`,
          r.rings ?? 0,
          r.missed ?? 0,
          r.hits ?? 0,
          r.crashes ?? 0,
          r.score ?? 0,
        ];
    cells.forEach((v, c) => {
      const td = document.createElement('td');
      td.textContent = String(v);
      if (c === 1) td.className = 'name';
      if (c === 7) td.className = 'num pts';
      if (c > 1 && c < 7) td.className = 'num';
      if (c === 2 && v === 'DNF') td.className = 'dnf';
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

function hideArenaSheet() {
  $('arena-sheet').hidden = true;
}

function renderTaskCard() {
  const t = runner.task;
  const card = $('task-card');
  // In the arena the strip along the top says all of this and more, so the
  // card would just be repeating itself in the corner.
  card.hidden = session === 'arena';
  if (session === 'arena') return;
  $('task-eyebrow').textContent = session === 'free' ? 'Mode 1 · free' : `Task ${t.n} of ${TASKS.length} · ${t.pattern}`;
  $('task-name').textContent = t.name;
  $('obj-hint').textContent = t.brief;
  $('guide-card').hidden = runner.phase !== 'guide';
}

function resetFlight(quiet = false) {
  drone.reset();
  runner.restart();
  aids.clear();
  trace.length = 0;
  courseKey = '';
  ui.camChanges = 0;
  $('guide-card').hidden = runner.phase !== 'guide';
  if (!quiet) toast('Reset', true);
}

function setProfile(key) {
  if (!PROFILES[key]) return;
  profileKey = key;
  $('chip-mode').querySelector('span').textContent = PROFILES[key].label;
  $('mode-blurb').textContent = PROFILES[key].blurb;
  for (const b of $('mode-picker').children) b.setAttribute('aria-pressed', String(b.dataset.key === key));
}

function setAids(on) {
  aidsOn = on;
  aids.setVisible(on);
  $('opt-aids').checked = on;
}

function setTrail(on) {
  trailOn = on;
  aids.setTrail(on);
  $('opt-trail').checked = on;
}

/* ---------------- full screen ---------------- */

/**
 * A simulator is a window you look through, so the browser chrome above it is
 * wasted screen. Esc leaves; the button and F both toggle. Nothing here can be
 * called on load — the Fullscreen API only answers inside a real gesture.
 */
const docEl = document.documentElement;

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
  // Both calls hand back a promise that rejects when the browser says no —
  // usually because the gesture that asked for it has already expired.
  const done = isFullscreen()
    ? (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document)
    : (docEl.requestFullscreen ?? docEl.webkitRequestFullscreen)?.call(docEl, { navigationUI: 'hide' });
  Promise.resolve(done).catch(() => toast('The browser would not go full screen — press F11'));
}

function onFullscreenChange() {
  const on = isFullscreen();
  const b = $('btn-full');
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('span').textContent = on ? 'Exit full screen' : 'Full screen';
  // Chrome resizes the canvas for us on the way in, but not always on the way
  // back out of a browser that animates the transition.
  requestAnimationFrame(resize);
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

function cycleCamera() {
  camIndex = (camIndex + 1) % CAMS.length;
  ui.camChanges++;
  $('chip-cam').querySelector('span').textContent = CAMS[camIndex].label;
}

/* ---------------- camera ---------------- */

function updateCamera(dt) {
  const p = drone.pos;
  const mode = CAMS[camIndex].id;

  if (mode === 'pilot') {
    camera.position.set(PILOT_POS.x, 1.68, PILOT_POS.z);
    const dist = Math.hypot(p.x - PILOT_POS.x, p.y - 1.68, p.z - PILOT_POS.z);
    setFov(Math.max(18, 58 - dist * 0.8), dt, 4);
    camera.up.set(0, 1, 0);
    camera.lookAt(p.x, p.y, p.z);
  } else if (mode === 'chase') {
    const n = drone.nose();
    tmp.set(p.x - n.x * 3.6, p.y + 1.2, p.z - n.z * 3.6);
    chasePos.lerp(tmp, Math.min(1, dt * 4.5));
    camera.position.copy(chasePos);
    camera.up.set(0, 1, 0);
    setFov(56, dt);
    camera.lookAt(p.x, p.y + 0.15, p.z);
  } else if (mode === 'fpv') {
    const n = drone.nose();
    camera.position.set(p.x + n.x * 0.16, p.y + 0.06, p.z + n.z * 0.16);
    camera.up.set(0, 1, 0);
    setFov(85, dt);
    // A real FPV camera is tilted up; the horizon rolls with the airframe.
    lookTmp.set(p.x + n.x * 14, p.y + 2.4 - drone.pitch * 26, p.z + n.z * 14);
    camera.lookAt(lookTmp);
    camera.rotateZ(-drone.roll * 0.85);
  } else {
    camera.position.set(p.x, p.y + 18, p.z + 0.01);
    camera.up.set(0, 0, -1);
    setFov(52, dt);
    camera.lookAt(p.x, p.y, p.z);
  }
}

/* ---------------- the drone's own camera ---------------- */

function placeDroneCam() {
  const p = drone.pos;
  const n = drone.nose();
  // Just ahead of the nose and a little above it, so no part of the airframe
  // sits in shot and the props stay out of the corners.
  dcam.position.set(p.x + n.x * 0.15, p.y + 0.04, p.z + n.z * 0.15);
  dcam.up.set(0, 1, 0);
  const reach = 16;
  lookTmp.set(
    p.x + n.x * reach,
    p.y + 0.04 - Math.tan(DCAM_TILT) * reach,
    p.z + n.z * reach
  );
  dcam.lookAt(lookTmp);
}

/**
 * Second render pass, scissored to the panel's rect.
 *
 * gl.clear obeys the scissor box, so `render` wipes only the inset and the main
 * view underneath survives. The rect is cached because reading it every frame,
 * straight after updateHUD has written to the DOM, would force a reflow 60
 * times a second.
 */
function renderDroneCam() {
  const wrap = $('dcam-wrap');
  if (wrap.hidden || $('hud').hidden) return;

  if (!dcamRect) {
    const r = $('dcam').getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    dcamRect = { x: r.left, y: window.innerHeight - r.bottom, w: r.width, h: r.height };
    dcam.aspect = r.width / r.height;
    dcam.updateProjectionMatrix();
  }

  placeDroneCam();
  const { x, y, w, h } = dcamRect;
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.setScissorTest(true);
  renderer.render(scene, dcam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.setScissor(0, 0, window.innerWidth, window.innerHeight);
}

function setDroneCam(on) {
  dcamOn = on;
  $('btn-dcam').setAttribute('aria-pressed', String(on));
  dcamRect = null;
}

function setFov(target, dt, rate = 5) {
  if (Math.abs(camera.fov - target) < 0.05) return;
  camera.fov += (target - camera.fov) * Math.min(1, dt * rate);
  camera.updateProjectionMatrix();
}

/* ---------------- HUD ---------------- */

const guideDots = [];

function buildGuideDots() {
  const wrap = $('guide-dots');
  wrap.innerHTML = '';
  guideDots.length = 0;
  $('guide-total').textContent = String(GUIDE.length);
  for (let i = 0; i < GUIDE.length; i++) {
    const d = document.createElement('i');
    wrap.appendChild(d);
    guideDots.push(d);
  }
}

function updateGuide() {
  const on = runner.phase === 'guide';
  $('guide-card').hidden = !on;
  if (!on) return;
  const step = runner.guide;
  if (!step) return;
  $('guide-n').textContent = String(runner.guideIndex + 1);
  $('guide-key').textContent = step.key;
  $('guide-title').textContent = step.title;
  $('guide-body').textContent = step.body;
  $('guide-bar').style.width = `${runner.guideProgress * 100}%`;
  guideDots.forEach((d, i) => {
    d.className = i < runner.guideIndex ? 'done' : i === runner.guideIndex ? 'now' : '';
  });
}

function updateHUD() {
  $('obj-label').textContent = runner.objective;
  $('obj-bar').style.width = `${runner.progress * 100}%`;
  $('obj-detail').textContent = runner.detail || '';
  if (session === 'task') $('obj-hint').textContent = runner.hint || runner.task.brief;

  $('ro-spd').textContent = drone.speed.toFixed(1);
  const hdg = ((drone.yaw * 180) / Math.PI + 360) % 360;
  $('ro-hdg').textContent = String(Math.round(hdg)).padStart(3, '0');
  $('ro-dist').textContent = Math.hypot(drone.pos.x - PILOT_POS.x, drone.pos.z - PILOT_POS.z).toFixed(1);
  $('ro-wind').textContent = drone.windSpeed.toFixed(1);
  $('ro-batt').textContent = Math.round(drone.battery);
  $('batt-bar').style.width = `${drone.battery}%`;
  document.querySelector('.batt').classList.toggle('low', drone.battery < 25);

  // The inset would only be showing what the main view already shows.
  const dcamVisible = dcamOn && CAMS[camIndex].id !== 'fpv';
  if ($('dcam-wrap').hidden === dcamVisible) $('dcam-wrap').hidden = !dcamVisible;
  if (dcamVisible) $('dc-alt').textContent = drone.altitude.toFixed(1);

  drawAltTape($('alt-tape'), drone.altitude, drone.vel.y, drone.holdAlt != null ? drone.holdAlt - 0.06 : null);
  const r = drawRadar($('radar'), drone, PILOT_POS, runner.tyres, runner.at);
  $('nose-warn').hidden = session === 'free' || !(r.noseIn && drone.airborne);
  drawPathBox($('pathbox'), drone, trace, runner.path, runner.tyres, runner.at, PILOT_POS);
  drawStick($('stick-l'), input.yaw, input.thr, ['THROTTLE', 'YAW']);
  drawStick($('stick-r'), input.roll, input.pitch, ['PITCH', 'ROLL']);

  updateGuide();
  updateArenaBar();

  const key = `${runner.task.id}|${runner.at}`;
  if (key !== courseKey) {
    courseKey = key;
    course.set(runner.tyres, runner.at);
  }
}

/* ---------------- telemetry back to the phone ---------------- */

let lastSend = 0;
function sendState(now) {
  if (now - lastSend < 66) return;
  lastSend = now;
  const step = runner.guide;
  link.send({
    t: 'state',
    alt: +drone.altitude.toFixed(2),
    spd: +drone.speed.toFixed(2),
    batt: Math.round(drone.battery),
    armed: drone.armed,
    air: drone.airborne,
    crash: drone.crashed,
    session,
    started,
    task: runner.task.name,
    taskIndex: session === 'task' ? taskIndex : -1,
    mode: profileKey,
    modeLabel: PROFILES[profileKey].label,
    altHold: PROFILES[profileKey].altHold,
    hoverStick: +hoverStick().toFixed(3),
    objective: runner.objective,
    detail: runner.detail || '',
    hint: runner.hint || '',
    prog: +runner.progress.toFixed(2),
    tyres: runner.tyres.length,
    at: runner.at,
    guide: step ? { n: runner.guideIndex + 1, of: GUIDE.length, key: step.key, title: step.title, body: step.body, p: +runner.guideProgress.toFixed(2) } : null,
    cam: CAMS[camIndex].label,
    pulse,
    echo: phone.ts,
    // Mirrored to the phone so the pilot never has to look up at the screen.
    arena:
      session === 'arena'
        ? {
            seat: arena.seat,
            phase: arena.phase,
            round: arena.round,
            of: arena.of,
            track: arena.track?.name || '',
            theme: arena.track ? THEMES[arena.track.theme].name : '',
            ring: runner.at,
            rings: runner.tyres.length,
            clock: +runner.clock.toFixed(1),
            left: arena.endsAt ? Math.max(0, Math.round((arena.endsAt - now) / 1000)) : 0,
            count: arena.phase === 'briefing' ? Math.ceil(Math.max(0, (arena.countdownAt - now) / 1000)) : 0,
            pts: scoreRound(arenaRun(false)),
            done: arena.finished,
          }
        : null,
  });
}

/* ---------------- loop ---------------- */

const STEP = 1 / 120;
let acc = 0;
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  gatherInput();
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard++ < 12) {
    drone.update(STEP, input, PROFILES[profileKey], world);
    runner.update(STEP, drone, input, ui);
    acc -= STEP;
  }
  drainDroneEvents();

  // --- the drone in the scene ---
  droneMesh.position.set(drone.pos.x, drone.pos.y, drone.pos.z);
  droneMesh.rotation.set(0, 0, 0);
  droneMesh.rotateY(drone.yaw);
  droneMesh.rotateX(drone.pitch);
  droneMesh.rotateZ(-drone.roll);

  const spin = drone.armed ? 0.5 + drone.throttle * 2.4 : 0;
  for (const prop of droneMesh.userData.props) prop.rotation.y += spin * prop.userData.dir * dt * 42;
  const blur = Math.min(1, Math.max(0, (spin - 0.6) / 1.4));
  for (const d of droneMesh.userData.discs) d.material.opacity = blur * 0.28;
  for (const prop of droneMesh.userData.props) prop.material.opacity = 0.9 - blur * 0.75;

  // --- the path the box draws ---
  traceAcc += dt;
  if (traceAcc >= 0.06 && (drone.airborne || trace.length)) {
    traceAcc = 0;
    trace.push({ x: drone.pos.x, y: drone.pos.y, z: drone.pos.z });
    if (trace.length > TRACE_MAX) trace.shift();
  }

  updateArena(now);

  if (aidsOn || trailOn) aids.update(dt, drone.pos);
  world.update(dt, drone.wind);
  updateCamera(dt);
  updateHUD();
  sendState(now);

  renderer.render(scene, camera);
  renderDroneCam();
}

/* ---------------- UI wiring ---------------- */

function buildTaskList() {
  const ul = $('task-list');
  ul.innerHTML = '';
  for (const t of TASKS) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.dataset.id = t.id;
    b.innerHTML = `<span class="tn"></span><span class="tp"></span><span class="tb"></span>`;
    b.querySelector('.tn').textContent = `${t.n} · ${t.name}`;
    b.querySelector('.tp').textContent = t.guided ? 'Guided' : `${t.tyres.length} tyres`;
    b.querySelector('.tb').textContent = t.brief;
    b.onclick = () => loadTask(t.id);
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function buildModePicker() {
  const wrap = $('mode-picker');
  wrap.innerHTML = '';
  for (const key of Object.keys(PROFILES)) {
    const b = document.createElement('button');
    b.dataset.key = key;
    b.textContent = PROFILES[key].label;
    b.onclick = () => setProfile(key);
    wrap.appendChild(b);
  }
}

for (const b of document.querySelectorAll('.mode-card')) {
  b.onclick = () => setSession(b.dataset.session);
}

$('btn-full').onclick = toggleFullscreen;
$('btn-dcam').onclick = () => setDroneCam(!dcamOn);

/* --- the team gate --- */
$('ar-create').onclick = () => {
  $('ar-err').textContent = '';
  link.send({ t: 'team/create' });
};
$('ar-join').onclick = () => {
  const code = $('ar-code').value.trim().toUpperCase();
  if (code.length < 3) {
    $('ar-err').textContent = 'Four characters, from whoever made the team.';
    return;
  }
  $('ar-err').textContent = '';
  link.send({ t: 'team/join', code });
};
$('ar-code').addEventListener('input', () => {
  $('ar-code').value = $('ar-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});
$('ar-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ar-join').click(); });
$('ar-leave').onclick = () => {
  rememberTeam('');
  link.send({ t: 'team/leave' });
};
$('btn-tasks').onclick = () => ($('tasks').hidden = false);
$('tasks-close').onclick = () => ($('tasks').hidden = true);
$('btn-session').onclick = () => ($('modes').hidden = false);
$('guide-skip').onclick = () => {
  runner.guideIndex = -1;
  runner.phase = 'fly';
  $('guide-card').hidden = true;
};
$('opt-aids').onchange = (e) => setAids(e.target.checked);
$('opt-trail').onchange = (e) => setTrail(e.target.checked);
$('pair-skip').onclick = () => {
  leavePairing();
  $('modes').hidden = false;
};

async function loadSession() {
  try {
    const res = await fetch('/api/session');
    if (!res.ok) throw new Error('not local');
    const s = await res.json();
    $('pair-pin').textContent = s.pin;
    $('pair-url').textContent = s.urls[0] ? s.urls[0].split('?')[0] : `http://<your-ip>:${s.port}/controller.html`;
    if (s.urls[0]) {
      const svg = await fetch(`/api/qr.svg?url=${encodeURIComponent(s.urls[0])}`);
      if (svg.ok) $('qr').innerHTML = await svg.text();
      else $('qr').remove();
    }
  } catch {
    $('pair-url').textContent = 'Open this page on the computer running the server';
    $('pair-pin').textContent = '––––';
  }
}

buildTaskList();
buildModePicker();
buildGuideDots();
runner.load(FREE);
setProfile('cruise');
setAids(false);
setTrail(false);
$('task-card').classList.add('free');
$('btn-tasks').hidden = true;
renderTaskCard();
loadSession();
requestAnimationFrame(frame);
