# Drone Trainer

A WebGL drone simulator you fly from your phone over your own Wi-Fi or laptop hotspot.
Built for the first hour of learning — the hour before you risk a real DJI Tello.

- **Simulator** runs in the browser on your laptop (Three.js + WebGL).
- **Controller** runs in the browser on your phone: two gimbals in the standard Mode 2 layout.
- **Relay** is a small Node server. Both devices connect to it over the local network; no internet, no cloud, no accounts.

```
phone (controller.html)  ──input 30 Hz──▶  node relay  ──▶  laptop (index.html)
                         ◀──telemetry 15 Hz──          ◀──
```

Up to five of those pairs at once — see **Arena** below. Traffic is routed
between the two devices of one seat, never broadcast, so five phones fly five
drones rather than all five flying the same one.

---

## Run it

```bash
npm install
npm start
```

The terminal prints the addresses and a four-digit pairing code, plus a QR code you can scan.

1. On the **laptop**, open `http://localhost:8080`.
2. Connect the phone to the same network as the laptop — join the laptop's hotspot, or put both on the same Wi-Fi.
3. On the **phone**, scan the QR code, or open `http://<laptop-ip>:8080/controller.html` and type the pairing code.

The pairing screen disappears on the laptop the moment the phone links up.

Change the port or fix the code with environment variables:

```bash
PORT=9000 PIN=4321 npm start
```

No phone handy? Click **Fly with the keyboard** on the pairing screen.
`W`/`S` throttle · `A`/`D` yaw · arrow keys pitch and roll · `T` take off · `L` land · `C` camera · `R` reset · `F` full screen · `V` drone camera.

Both screens go full screen: **F** or the *Full screen* chip on the laptop, and the
expand button in the top-right corner of the phone transmitter. The phone strips
itself down to the sticks at the same time. On iPhone, where Safari has no
Fullscreen API, use Share → Add to Home Screen and open it from there.

---

## The controls

Mode 2, the layout on almost every real transmitter, including the Tello app:

| Stick | Axis | What the drone does |
|---|---|---|
| Left | up / down | climbs or descends |
| Left | left / right | spins on the spot (yaw) — it does **not** move sideways |
| Right | up / down | flies forward or backward |
| Right | left / right | slides left or right (roll) |

Every input is relative to the **drone's** nose, not to you. That is the single thing beginners get wrong, so the simulator draws the drone's nose in orange, puts you on the radar as a fixed dot at the bottom, and warns you the moment the nose swings back toward you and your left/right inputs mirror.

### Flight modes

| Mode | What changes |
|---|---|
| **Beginner** | Altitude hold, 16° maximum tilt, no wind, and hard landings are forgiven. Centre the sticks and it hovers. |
| **Sport** | 28° tilt, faster yaw, light wind, and a hard landing ends the flight. Roughly Tello in sport mode. |
| **Cruise** | Realistic tilt, momentum and wind, but the flight controller still holds height. Let go of the throttle and it springs to centre and parks at the altitude you left it. **This is what Free flight starts in.** |
| **Realistic** | No altitude hold. The left stick is raw throttle and stays where your thumb leaves it; the hover point is yours to hold. This is what real flying feels like. |
| **Acro** | Rate mode. The sticks command rotation speed, not angle — let go and it stays where you put it. |

---

## The syllabus

Lessons are ordered so each adds exactly one skill:

1. **Hover** — take off, park it in the ring, hold for eight seconds, land on the pad.
2. **Altitude** — left stick only. Climb, descend, stop on the number.
3. **Left and right** — roll only, nose fixed away from you.
4. **The box** — four corners at 2 m with a fixed nose.
5. **Nose-in** — turn the nose to face you and fly it anyway. The lesson everyone skips and everyone needs.
6. **Gate run** — five gates in order, in sport mode, timed.
7. **Spot landing** — up to 8 m, then back on the pad inside 30 cm without a thump.

**Free flight** has no objectives if you just want to mess around.

### Training aids

Toggle them off in the Lessons sheet once you no longer need them.

- A ground shadow and a vertical drop line, so you can see where the drone actually is
- A fading trail, so drift shows up before it becomes a problem
- Four camera views: **Pilot** (from where you stand — the one that transfers to real flying), **Chase**, **Nose camera**, **Overhead**
- The **drone camera**, always in the top-right corner: a live picture from a gimbal on the drone, so you keep the pilot's view *and* the drone's view at once. It follows the nose in yaw but holds the horizon level, like the camera on a real Tello or Mavic. Toggle with **V** or the *Drone cam* chip. It hides itself in Nose-camera view, where the main screen is already showing it.

---

## Arena — up to five pilots

A team of five, a different track every round, and nobody able to see or block
anybody else.

Each pilot needs **two devices**: a phone for the sticks and their own
laptop or tablet for the picture. That is the pairing the trainer already uses —
Arena just runs five of them at once and keeps them apart.

```bash
npm start
```

1. On the machine running the server, open **`http://localhost:8080/host`** —
   the scoreboard. Press **Create a team**. You get a four-character **team
   code**, printed big. Read it out.
2. Each pilot opens **`http://<host-ip>:8080/`** on their own screen, picks
   **Arena**, and types the team code. The screen is handed a seat number.
3. Each pilot opens the controller on their phone, types a **callsign**, then
   the same team code, then taps their seat.
4. The host picks 1, 3 or 5 rounds and presses start.

The team code is what keeps groups apart: **several teams of five can run on one
server at the same time**, each with its own lobby, its own match and its own
leaderboard. Codes avoid `I`, `O`, `0` and `1`, which are the four characters
that get misheard across a room.

Both the code and the callsign are remembered, so a reload — or a laptop that
sleeps between rounds — comes straight back to the same seat. If one person is
running a screen and a phone together, moving the screen into a team takes the
phone with it; there is nothing to type twice.

Every round: a ten-second briefing, then everyone flies the **same** track at
the same time, each in their own copy of it. Nothing about anyone else's drone is
ever sent to your screen — the isolation is not a rendering trick, the data is
simply not there.

### The tracks

Twelve courses across five arenas, drawn at random, never repeating inside a
match:

| Arena | What it is |
|---|---|
| **Junkyard** | Stacked wrecks, tyre piles and a crane jib at 16 m |
| **City block** | Six towers, 6 m alleys, rooftop gates at 19 m |
| **Warehouse** | Indoors between the racking. No wind and no room |
| **Forest trail** | Trunks close to the line, canopy at 8 m |
| **Harbour** | Container stacks and a gantry crane, strongest wind |

Everyone in a round flies the same flight model, set by the track, so nobody
gains from a softer one. The mode button on the phone is locked while a round is
live.

### Scoring

```
1000  − 4 a second
      − 50 a missed ring
      − 25 a rim hit
      − 150 a crash        (the drone goes back on the pad, the clock keeps running)
      + 100 for a clean round
      + up to 60 for the landing
out of time = 0 for that round
```

Team score is the sum of everyone's rounds. Fastest lap and cleanest flight are
called out at the end.

Round lengths are tunable — handy for a demo or for a room of first-timers:

```bash
BRIEFING_SECONDS=5 ROUND_SECONDS=120 RESULTS_SECONDS=6 npm start
```

`npm run check` verifies that every ring in every track is actually flyable
against that arena's scenery. Run it after moving a wall or a gate.

---

## When it does not connect

**The phone cannot load the page at all.** Almost always the laptop firewall. On Windows, allow Node.js on *private* networks; on macOS, System Settings → Network → Firewall → Options → allow incoming connections for `node`. On Linux, `sudo ufw allow 8080/tcp`.

**You typed `localhost` on the phone.** `localhost` means the phone itself. Use the laptop's IP address — the server prints every one it can see.

**Which IP?** If the laptop is running the hotspot, it is usually `192.168.137.1` on Windows and `192.168.2.1` on macOS. Otherwise pick the one on the same subnet as your phone.

**Some networks block device-to-device traffic.** Public and campus Wi-Fi often have client isolation on. Use the laptop hotspot instead — it is the reliable path and it needs no internet at all.

**The page loads but says "Wrong pairing code."** The code changes each time the server restarts. Read the current one off the laptop screen, or pin it with `PIN=1234 npm start`.

**Controls feel laggy.** Check the `LINK` readout on the phone. Under about 40 ms feels direct. If it is high, you are probably on a busy Wi-Fi network — switch to the hotspot.

---

## How it is put together

```
server.js              HTTP + WebSocket relay, seats, match state machine, QR
tools/check-tracks.mjs track geometry check (npm run check)
docs/MULTIPLAYER.md    the arena design, in full
public/
  index.html           simulator page — free flight, tasks, arena
  controller.html      phone transmitter page
  host.html            arena scoreboard
  css/sim.css
  css/controller.css
  css/host.css
  js/
    physics.js         flight model — tilt, drag, altitude hold, battery, collisions
    missions.js        lesson definitions and the objective engine
    tasks.js           the five tyre courses and the ring/landing runner
    tracks.js          arena ring layouts + scoring — pure data, used by the server too
    arenas.js          the five arenas' scenery
    world.js           scene, swappable theme layer, drone model, markers, flight aids
    hud.js             canvas instruments — radar, altitude tape, stick mirrors
    net.js             WebSocket client with reconnect, shared by all three pages
    sim.js             render loop, cameras, input merging, telemetry, arena rounds
    controller.js      gimbals, buttons, callsign, seat picker, send loop
    host.js            lobby, match control, leaderboard
```

**The phone holds no flight state.** It sends stick positions and button presses; the simulator owns the physics and sends telemetry back. A dropped packet can never corrupt the flight, and if the link goes quiet for 600 ms the sticks centre themselves and — in Beginner and Sport — the drone simply holds its hover.

**The flight model** is not a full 6-DOF rigid body sim. It models what you actually feel on a small quad: commanded tilt is reached with a first-order lag, tilt becomes horizontal acceleration (`a = g·tan θ`), linear drag sets the top speed, and vertical motion is a velocity controller in the altitude-hold modes and raw thrust in Manual. Physics runs on a fixed 120 Hz step, decoupled from the frame rate, so behaviour is identical on a fast and a slow machine.

**Three.js is served from `node_modules`**, not a CDN, so the whole thing works on a hotspot with no internet connection.

**Security is deliberately minimal** — a four-digit pairing code, and the
simulator page is trusted without one when it is served to the machine running
the server. Four digits is ten thousand guesses with no rate limiting behind it,
so this is designed for your own hotspot and the room you are standing in. Do
not put it on the open internet.

---

## Making it yours

- **New lesson:** add an entry to `MISSIONS` in `missions.js`. The builders `hold`, `reach`, `climbAbove`, `descendBelow`, `landOn`, `faceThePilot` and `gateRun` cover most of what you need, and any objective is just `{ label, hint, marker, test(ctx, dt, mem) }` returning progress from 0 to 1.
- **New flight mode:** add a profile to `PROFILES` in `physics.js`. Tilt, yaw rate, climb rate, drag, expo, wind and forgiveness are all in one object.
- **New scenery:** the `box`, `pylon` and `tree` helpers in `world.js` add a mesh and its collision volume together.
- **Talking to a real Tello:** the controller already speaks a clean stick protocol. A bridge that maps `{r, p, y, t}` onto Tello's `rc a b c d` UDP command is roughly thirty lines of Node on the laptop side — but fly the lessons first.

MIT licensed. Fly the hover lesson until it is boring; that is the whole trick.
