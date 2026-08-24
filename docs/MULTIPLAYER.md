# Multiplayer — Arena Mode

A design for **Mode 3: Arena** — five pilots, one team, a fresh track every round,
each pilot flying alone in their own copy of the world.

Status: **built**. Phases 1–3 of §8 are done and tested; §8 Phase 4 (reconnect
polish, ghosts, replays) is not.

Where the built thing differs from this design, this document has been updated
to describe what exists. The differences worth naming:

- **There is no `play.html`.** Arena is a third mode on the existing simulator
  page, because a separate page would have duplicated the whole HUD for no gain.
- **Teams, not one room.** §6 originally described a single room keyed on the
  pairing code. What exists is a `teams` map: anyone can create a team and gets
  a four-character code, and screens, phones and hosts all join by that code.
  Several teams of five run side by side on one server, each with its own seats,
  match, timers and leaderboard. Anything that arrives without a code lands in a
  default room, which is where the plain one-phone-one-laptop pairing lives, so
  the solo flow is unchanged.
- **Round lengths are configurable** from the environment:
  `BRIEFING_SECONDS`, `ROUND_SECONDS`, `RESULTS_SECONDS`.
- **A reloaded screen resumes its old seat** if that seat has already flown
  rounds, rather than taking the lowest free one and orphaning the scores.
- **`tracks.js` and `arenas.js`** split the way §7 describes, except that the
  pure ring/scoring data lives in `tracks.js` (imported by the server too) and
  only the Three.js scenery lives in `arenas.js`.
- `tools/check-tracks.mjs` (`npm run check`) verifies every ring in every track
  is actually flyable against that arena's obstacles. It found fourteen blocked
  gates during authoring.

---

## 1. The shape of a session

```
  Host opens the simulator on the laptop running the server
        │
        ├─ creates a ROOM (4-digit code, the existing pairing code)
        │
  5 pilots, each with a phone AND their own laptop/tablet
        │
        ├─ screen  → http://<host-ip>:8080/          → "Arena" → claims a SEAT (1…5)
        ├─ phone   → http://<host-ip>:8080/controller  → types CALLSIGN → picks that seat
        │
  Host presses START
        │
  ROUND 1 ─ briefing 10 s ─ fly (3 min limit) ─ results
  ROUND 2 ─ …
  ROUND 3 ─ …
        │
  MATCH RESULT: per-pilot points, team total, fastest lap, cleanest flight
```

Each pilot needs two devices: the phone is the transmitter, their own
laptop/tablet is the screen. That is exactly the pairing that already exists —
Arena mode just runs five of them at once and keeps them apart.

### Why the worlds are separate

Nothing about another pilot's drone is ever sent to your screen. Not the
position, not the yaw, nothing. Isolation is therefore not a rendering trick you
could work around — the data simply is not there. Each screen builds its own
scene, runs its own physics, and owns its own set of rings.

That gives, for free, exactly what was asked for: every drone has its own ring
circle, nobody can see anybody else, and nobody can be blocked, bumped or
distracted by another pilot. The only thing that crosses between pilots is the
scoreboard.

---

## 2. Joining — what a pilot actually does

### 2.1 The screen (laptop/tablet)

1. Opens the simulator, `/`, and picks **Arena** on the mode card.
2. It is handed the **lowest free seat** — or the seat it held before, if it is
   reconnecting into a match already in progress — and shows `SEAT 3 · waiting
   for a pilot`.
3. Once a phone claims that seat, the card is replaced by the briefing.

### 2.2 The phone (transmitter)

1. Opens `/controller.html?pin=…` — unchanged.
2. **New first step: callsign.** A single text field, 2–12 characters, letters,
   digits and spaces. This is the name that appears on the leaderboard and it is
   required — you cannot claim a seat without one. It is remembered in
   `localStorage` so a pilot types it once, ever.
3. A seat list appears: five rows, each showing `SEAT n` plus either
   `open`, `screen ready`, or the callsign already in it. Taps an open seat with
   a ready screen.
4. Straight through to the sticks. Everything from here is the transmitter that
   already exists, with a round banner across the top.

**Why callsign before seat:** the seat list is the only screen where a pilot can
be confused into taking someone else's place, so the name has to already exist
when the tap happens. It also means the host's lobby fills in with real names as
people join, which is how the host knows when to press start.

### 2.3 The host

`/host` on the big screen or the laptop already running the server. Shows
the room code, the QR, the five seats filling up, a 1/3/5 round picker, and the
START button, which is disabled until at least one seat is crewed. During a round it is the
leaderboard. Between rounds it is the results table.

The host never sees any pilot's view. If a "watch a pilot" feature is ever
added it belongs behind an explicit toggle that every pilot can see is on —
see §10.

---

## 3. The arenas

Five themes. Scenery is hand-built, so quality and flyability are predictable.

| Theme | What it is | What it tests |
|---|---|---|
| **Junkyard** | Stacked car wrecks, a 16 m crane jib, tyre piles, scrap heaps | Tight, low, technical. Lots of nose-in. |
| **City block** | Six towers in two rows, 6 m alleys at x = ±8, rooftop gates | Vertical. Climb, descend, judge gaps. |
| **Warehouse** | Indoor: racking rows, roof trusses, loading bays | No wind, very tight, punishing. |
| **Forest trail** | Trunks either side of the line, canopy topping out at 8 m | Continuous slalom. |
| **Harbour** | Containers, gantry crane, quayside, open water | Long straights and the strongest wind. |

Each theme carries **2–3 ring layouts**; the pool is twelve tracks.
Layouts are plain data — the same `{pos, radius, yaw, tube}` shape that
`tasks.js` already uses — so `TaskRunner`'s existing ring-crossing test,
direction check and miss detection work unchanged.

Every arena has the same fixed furniture:

- a **start pad** with the H, at the world origin, where the pilot figure stands
- **numbered rings**, 6–10 of them, in order, each with the number painted on it
- a **finish**: the last ring, then back on the pad
- the existing **geofence** (58 m radius, 40 m ceiling), themed as a fence, a
  quay edge or warehouse walls

### Track rotation

At the start of each round the **server** draws one track at random from the
pool, excluding every track already flown in this match, and sends the same
track id to all five seats. Same track for everyone in a round; a different
track each round; a different order every match.

The draw lives on the server, not on the screens, because five clients drawing
independently would not agree — and because a client-side draw is trivially
re-rollable by refreshing.

---

## 4. Round rules

**Before the round**

- Every pilot must have a callsign and a claimed seat.
- Ten-second briefing (`BRIEFING_SECONDS`): theme name, track name, ring count,
  time limit. Arming and take-off are refused until GO, and everyone is put back
  on the pad with a zero clock the moment the round starts.

**The clock**

- Starts the moment the drone first leaves the ground — not at the countdown.
  A pilot who fumbles the arm sequence loses nothing.
- Stops when the drone is stationary on the pad, having passed the last ring.
- Hard limit **180 s** by default, `ROUND_SECONDS` to change it. Hitting it is
  a DNF for that round.

**Flying**

- Rings must be taken **in order** and **in the correct direction**. The gate
  only counts on a crossing from behind the plane to in front of it, which the
  existing physics already enforces.
- Passing outside a ring but near it counts as a **miss**. You may turn around
  and take it again; the miss still costs you.
- Clipping a rim is a **hit**. It costs points but does not end the flight.
- A **crash** resets the drone to the pad. The clock keeps running. You continue
  from the ring you were on.
- **Battery** runs down as it does now. Empty means an automatic landing, which
  in practice means DNF.
- Leaving the geofence pushes you back in. No penalty — the wasted seconds are
  the penalty.

**Flight model**

Everyone in a round flies the same profile, chosen per track, so nobody gains
from a softer model. Suggested: Junkyard and Warehouse on `cruise`, City on
`sport`, Forest and Harbour on `realistic`. The mode button on the phone is
locked out during a round.

**After the round**

- Results table for eight seconds, then the next briefing.
- A pilot who finishes early watches their own results card; they cannot watch
  anyone else.

---

## 5. Scoring

Points, so tracks of different lengths stay comparable.

```
round score = 1000
            −   4 × seconds elapsed          (rounded)
            −  50 × rings missed
            −  25 × rim hits
            − 150 × crashes
            + 100  if clean          (no miss, no hit, no crash)
            +  max(0, 60 − 100 × landing offset in metres)

DNF (time limit, battery, or never finished) = 0 for that round.
Rings completed are still shown, so a DNF is not invisible.
Round score is floored at 0 — a disaster is worth nothing, never negative.
```

Worked example, a 6-ring junkyard lap:

| | Ana | Bo | Cy |
|---|---|---|---|
| Time | 48.2 s | 41.0 s | 63.5 s |
| Missed | 0 | 2 | 0 |
| Hits | 0 | 1 | 3 |
| Crashes | 0 | 0 | 1 |
| Landing offset | 0.18 m | 0.51 m | 0.90 m |
| **Score** | 1000−193+100+42 = **949** | 1000−164−100−25+9 = **720** | 1000−254−75−150+0 = **521** |

- **Pilot match score** = sum of their rounds.
- **Team score** = sum of all five pilots. Everyone's flight matters, which is
  the point of flying as a team.
- Tie-break: fewest total crashes, then fastest single round.

Side awards, because they are cheap and they change how people fly:
**Fastest lap**, **Cleanest flight** (most clean rounds), **Most improved**
(largest round-1 to final-round gain).

---

## 6. Protocol

The relay currently keeps two flat sets — `sims` and `ctrls` — and broadcasts
every packet to the other set. Five pilots on one relay means every phone would
be flying every drone. So the relay grows rooms and seats.

### 6.1 Server state

```js
Room {
  pin,                    // 4 digits, also the room code
  host,                   // ws of /host.html, may be null
  seats: Map<1..5, Seat>,
  match: { round, of, trackId, flownTracks: [], startedAt, phase }
}

Seat {
  id,                     // 1..5
  screen,                 // ws of the simulator page in arena mode
  phone,                  // ws of /controller.html
  callsign,
  rounds: [ { trackId, time, rings, missed, hits, crashes, landing, score, dnf } ]
}
```

### 6.2 Messages

Client → server

| `t` | From | Payload | Meaning |
|---|---|---|---|
| `hello` | both | `{role:'screen'\|'phone'\|'host', pin}` | as today, plus the host role |
| `seat/claim` | phone | `{seat, callsign}` | take a seat |
| `seat/release` | phone | — | leave the seat |
| `match/start` | host | `{rounds}` | begin |
| `round/progress` | screen | `{seat, ring, elapsed}` | ~2 Hz, for the leaderboard |
| `round/finish` | screen | `{seat, score…}` | one per round |
| `input` / `cmd` | phone | as today | routed to **that seat's screen only** |
| `state` | screen | as today | routed to **that seat's phone only** |

Server → clients

| `t` | To | Payload |
|---|---|---|
| `lobby` | all | `{seats:[{id, callsign, screenReady, phoneReady}]}` |
| `round/begin` | all | `{round, of, trackId, theme, profile, limit, startAt}` |
| `leaderboard` | host + phones | `{rows:[{seat, callsign, ring, elapsed, score}]}` |
| `round/end` | all | `{rows:[…full round scores…]}` |
| `match/end` | all | `{rows, team, awards}` |

`input`, `cmd` and `state` stop being broadcasts and become point-to-point
between the two sockets of one seat. That single change is what makes five
simultaneous flights possible, and it also fixes the current behaviour where a
second phone on the network flies your drone.

### 6.3 Who owns what

- **Server** owns: the room, seat assignment, the random track draw, the round
  clock, and the leaderboard.
- **Screen** owns: physics, scene, ring detection, and its own score. It reports
  the result up.
- **Phone** owns: nothing, exactly as today.

The screen computing its own score is a deliberate trade. On a LAN, among people
in the same room, the cost of a cheat is low and the cost of server-side physics
is high. See §10 if that stops being true.

---

## 7. Files

New

| File | What it holds |
|---|---|
| `public/host.html` + `css/host.css` + `js/host.js` | Room code, QR, lobby, live leaderboard, results. |
| `public/js/arenas.js` | The five themes' scenery. Imports nothing — helpers arrive in a `ctx`, so world.js → arenas.js stays one-way. |
| `public/js/tracks.js` | Ring layouts, theme metadata and the scoring function. Pure data, imported by the **server** as well as the browser. |
| `tools/check-tracks.mjs` | `npm run check` — proves every ring is flyable. |

Changed

| File | Change |
|---|---|
| `server.js` | Rooms, seats, point-to-point routing, match clock, track draw. The biggest single change — roughly 250 lines. |
| `public/js/world.js` | Scenery moved into a swappable `world.setTheme(id)` layer; the base field, sky, sun, pad and fence are shared by every arena. |
| `public/js/tasks.js` | Untouched. An arena track is dressed as a task, so `TaskRunner`'s ring crossing, direction check, miss detection and landing test are reused as they are. |
| `public/index.html` + `css/sim.css` + `js/sim.js` | A third mode card, the arena sheet (seat / briefing / results / final table) and the round strip across the HUD. |
| `public/js/controller.js` + `.html` + `.css` | Callsign screen, seat picker, arena round strip. |
| `README.md` | How to run an event. |

Untouched: `physics.js`, `hud.js`, `pathbox.js`, `net.js`. The flight model and
the instruments do not care how many people are flying.

---

## 8. Build order

Each phase leaves the app working.

**Phase 1 — rooms and seats.** Server-side rooms, point-to-point routing,
callsign, seat claim, lobby. No arenas yet; seats fly the existing tasks.
*This is the phase that unblocks everything and it is the only risky one.*

**Phase 2 — match and scoring.** Round state machine, the 180 s clock, the
scoring formula, the results card, `host.html` with a live leaderboard. Runs on
the existing five tyre courses as the track pool.

**Phase 3 — arenas.** The five themes and their layouts. Purely additive: new
scenery, new ring data, and the random draw switched over to the new pool.

**Phase 4 — polish.** Reconnect inside a round (the seat is held for 30 s and
the flight is frozen), a spectator ghost toggle, a shareable results card,
per-round replay from the existing trace buffer.

---

## 9. Failure handling

| What happens | What the system does |
|---|---|
| Phone drops mid-round | Sticks centre after 600 ms, as today. In `cruise` the drone holds its hover. The seat is held for 30 s; the clock keeps running. |
| Phone reconnects | Same callsign re-claims the same seat automatically. Straight back to the sticks. |
| Screen drops mid-round | That pilot's round is a DNF. The seat stays in the match for the next round. |
| Host drops | The match keeps running. Screens hold the leaderboard they last had; the host rejoins into the live match. |
| Someone joins late | They take an open seat and sit out until the next round begins. No mid-round joins. |
| Fewer than five pilots | Fine. Team score is the sum of whoever is in. The host sees the seat count. |

---

## 10. Fairness, and what is deliberately not solved

- **Same track, same profile, same round, everyone at once.** That is the whole
  fairness model, and it is enough for a room full of people who can see each
  other.
- **Scores are computed client-side.** A pilot who opens devtools can send any
  number they like. Making that impossible means running all five flight models
  on the server, which is a different project. If an event ever needs it, the
  cheapest honest fix is to have each screen also send its ring-crossing
  timestamps and have the server sanity-check them against the track geometry.
- **Nobody can watch anybody.** If a spectator view is ever added, it must be a
  room-wide toggle that every pilot can see is on, and it must never be the
  default. The current guarantee — the data is not sent — is worth more than the
  feature.
- **The relay is still only protected by a 4-digit code**, as it is today. This
  is a hotspot-and-a-room design, not an internet one.

---

## 11. Open questions

1. **Rounds per match** — 3 is the default here. 5 makes a match ~25 minutes.
2. **Practice round** — should round 0 be an untimed lap of the same track?
   Strongly recommended for a first-time group; it costs three minutes and it
   removes most of the "I did not know where the rings were" complaints.
3. **Teams** — the design assumes one team of five. Two teams of five means a
   second room code, or a `team` field on the seat and two totals. Say which.
4. **Track pool size** — twelve tracks across five themes means a three-round
   match repeats nothing. Building five themes is the bulk of Phase 3; a first
   event could ship with Junkyard and City only.
