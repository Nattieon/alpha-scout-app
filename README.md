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
- **pᵢ** is the chance he sits: 4% base, +8% on a back-to-back, plus Sleeper's injury
  tag (Questionable 45%, Out 97%…) fading 30% per game further out, and 85% if the
  projection has him sitting.

**Win-probability mode** (the default) also uses your opponent's slots. Locked
scores count exactly; the rest are modeled the same way. The call picks whichever
of LOCK and PASS gives the higher chance to win the week, so with a safe lead it
locks a bit early, and when behind it chases upside. The rule was picked by a Monte
Carlo bake-off of seven strategies; details are in the Alpha Scout repo.

## What Sleeper doesn't tell us
Sleeper reports each slot's current score, not whether it's locked:

- If a slot shows an **earlier** game's score, it's locked. The app detects that.
- If it shows his **latest** game, it's ambiguous until his next game starts.
- Every slot on both lineups has a picker that overrides what the app infers. Pick
  **any** of his completed games this week as the locked one, **Not locked**, or
  **Auto**. Use it when you come back late, or copy your opponent's lock icons from
  Sleeper. On Auto, an opponent's score above his bar is assumed locked.
- **Banked** counts only certain locks and the ones you entered.
- **Proj** (top) counts locked slots at their score. Every other slot counts
  Sleeper's projection for his next game, in your scoring. Settings can switch this
  to the expected final, which includes future locks and sit risk. The win
  probability always uses the full model.
- **Bench** players are listed under each lineup with their games and next-game
  projection, which helps with swaps.

## Development
```bash
node --test tests/*.test.mjs        # 20 tests, no dependencies
python3 -m http.server              # then open http://localhost:8000
```
Every push to `main` runs the tests and deploys to GitHub Pages.
