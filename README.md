# Alpha Scout · Lock-In

**Live app:** https://nattieon.github.io/alpha-scout-app/

Lock-or-pass calls for Sleeper **Lock-In** fantasy basketball. Type your Sleeper
username, pick your league, and the page pulls everything from Sleeper:

- your matchup, your lineup, and your opponent's lineup
- your league's own scoring (bonuses included)
- every player's games this week, with per-game projections (Rotowire via Sleeper)
- injury tags and back-to-backs

From that it shows four things:

- **Win probability** for the week.
- **Decide now:** your players whose game just ended and who still have games left.
  Each gets **LOCK** or **PASS**, the score he needs (the bar), and your win odds
  either way.
- **Tonight:** the score to lock at for each player who plays today. There's also a
  "what if he finishes with…" box for live games.
- **Lineups:** both teams' slots, marked locked / your call / open / final, with each
  slot's projected value.

**Matchups ▾** (top right) switches to any team in the league (you see the week from its
side), to your other leagues, or to anyone's leagues by Sleeper username. The app reopens on
whatever you looked at last, so you only type a username once.

**History** (in the Matchups panel) shows what the app said at any saved moment: every
matchup's win % through the week, each lock-or-pass call next to what the team actually
did, lineup moves, injury-tag changes and adds/drops. A scheduled GitHub job saves the
snapshots to the `data` branch: a full one every night (~4:30am ET, when every player who
played is at his lock decision) and a light lineup check every 30 minutes on game days
(a full snapshot only when something changed). Each nightly also stores the model's inputs,
so new math can be re-run on old days. `scripts/snapshot.mjs` documents the layout.

Nothing to install, no accounts, no server. Everything runs in your browser
against Sleeper's public read-only API. Settings and your lock marks stay in your
browser only.

## How the call is made
The bar is an optimal-stopping value. It's the expected final score of the slot if
you pass, playing the rest of the week optimally:

```
V_last = (1 - p_last) · μ_last                        # an open slot takes his last game, even a DNP
V_i    = p_i · max(0, V_{i+1}) + (1 - p_i) · E[max(X_i, V_{i+1})],   X_i ~ N(μ_i, σ_i)
```

- **μᵢ** is that game's projection, scaled by how he has actually played against his
  projections (shrunk, capped at ±25%).
- **His score shape** comes from his own game log: last season plus this one, scored with
  your league's rules, as ratios to his average. It's blended with 8 prior games so a
  short log can't go wild, which gives boom-or-bust players higher bars than steady ones.
  Every score is also shown as a **percentile of his recent games**.
- **pᵢ** is the chance he sits, built per player from his own log (`js/availability.js`).
  The reasons combine as `1 − Π(1 − hᵢ)`:
  - **Ordinary-game rate:** `(sat + 20 × 4%) / (games + 20)`. Injury stretches (5+ straight
    missed games) and the 15 games after them are left out. This season counts double.
  - **Back-to-back pairs:** `q = (rested one night + 8 × 19%) / (pairs + 8)`, and which night
    `s = (night-2 rests + 6 × 73%) / (rests + 6)`. Night 1 gets `q·(1−s)`. Night 2 is linked
    to night 1: `q·s / (1 − q·(1−s))` once he has played night 1, and ~0 extra if he sat it.
    The league figures (19% / 73%) come from last season.
  - **Durability:** `0.04 × share of his team's games missed in the last 82`.
  - **Return ramp:** after a 10+ game absence (one that ran into the offseason only counts if it was 40+ games), `+60% × (1 − games back / 15)` on back-to-back
    rest (25 games after a 40+ game absence). Each back-to-back he plays both nights of
    halves what's left. Also `+3% × ramp` on other games.
  - **Sleeper injury tag** (Questionable 45%, Out 97%…) fading 30% per game, and 85% if the
    projection has him sitting.
  - **"Sits B2Bs?" checkbox:** sets his back-to-back rest chance to 95% until you uncheck it.
  The lock recursion branches on night 1 (played vs sat), so the bar for night 1 uses the
  raised night-2 risk.

**Bench swaps** (`js/swaps.js`). Any open slot can go to a bench player, or another open
starter, before his next game. Following Sleeper's rules, only starters' games count, and
an open slot takes the final game of whoever is in it at week's end. The app picks the
best player for each open slot for the rest of the week: positions respected (G = PG/SG,
F = SF/PF, UTIL = anyone), each player used once, solved exactly with the Hungarian
algorithm. A slot's lock bar is therefore what keeping it open is worth with your whole
bench available. **Swaps before tip-off** lists the moves the calls assume you'll make.
Both teams go through exactly the same steps: best bench swaps, then a lock-or-pass call on
each just-finished game, made against the other team's plan. So the win probability is a
property of the matchup: viewed from either side, the two numbers add up to 100%. The
opponent's swaps can be switched off in settings (**Opponent's bench swaps**). That makes your
side read higher, and the two sides then no longer mirror each other.

**Late swaps** (`js/chains.js`). An open slot can change hands before every tip-off, so its plan for the
rest of the week can run through several players in tip-off order: "keep Markkanen's 3:30 game if it
beats 47; otherwise Reed at 7". It's the same lock-or-pass math, applied to one sequence of games from
several players. Players nobody starts are handed out as backups, one slot each, wherever they add most.
Both teams get this. Tip-off times come from the NBA's public schedule (saved by the snapshot job).
Without them, same-day games count as simultaneous.

**Safety cushion** (setting, off by default). Decide by the chance of winning by *more than* the cushion
instead of the chance of winning, so a lead one unmodeled move could erase is played like a deficit.
*Auto* sets it to the biggest swing one of the other team's open slots can still make. The win % shown
is always the plain chance to win, and the two sides still add up to 100%.

**Calibration.** Every finished week is replayed with the current math (rebuilt whenever the math
changes), and each night's win % is checked against how the matchup ended. History shows the result
(Brier score, and how often favourites at each level actually won). That's what decides whether the
cushion should be on by default.

**Win-probability mode** (the default) also uses your opponent's slots. Locked
scores count exactly; the rest are modeled the same way. The call picks whichever
of LOCK and PASS gives the higher chance to win the week, so with a safe lead it
locks a bit early, and when behind it chases upside. The rule was picked by a Monte
Carlo bake-off of seven strategies; details are in the Alpha Scout repo.

## What Sleeper doesn't tell us
Sleeper's public data **never shows locks while the week is on**. Each slot shows the player's
latest game, and locks are applied only when Sleeper finalizes the week (Monday morning ET).
Sleeper doesn't keep past lineups either. So:

- **Earlier games nobody marked are guessed, the same way for both teams.** A sensible manager
  locked the first game that beat what the rest of his week was worth at the time. On your side
  the app asks **Did you lock these?** (Yes / No). For your opponent, copy his lock icons from the
  Sleeper app with the picker on his slot.
- **The picker** on every slot (both lineups) records a lock on any completed game. It can also
  say *Nothing locked* (his latest game is still your call), *Not locked through* a day, or that
  his latest game was played from the **bench** and can't count.
- **Banked** counts only locks you entered. **Proj** (top) counts locked slots at their score, and
  every other slot at Sleeper's projection for his next game, in your scoring. Settings can switch
  this to the expected final. The win probability always uses the full model.
- **Bench** players are listed under each lineup with their games and next-game projection.

## Development
```bash
node --test tests/*.test.mjs        # 56 tests, no dependencies
python3 -m http.server              # then open http://localhost:8000
```
Every push to `main` runs the tests and deploys to GitHub Pages.
