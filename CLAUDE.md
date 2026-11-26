# Alpha Scout: working notes for Claude

Read this first. It carries the decisions and context from earlier sessions so a new chat can pick up the work.

## The owner
- Jason (Sleeper "Nattieon", roster 7, team "Akari my beloved") does not code. Claude does all coding, testing, committing and pushing; explain results in plain language, no jargon.
- Least hassle: never hand him manual copy-paste steps. Work on one issue at a time. Don't open GitHub issues until it's time to solve them.
- His league: "Noob", Sleeper league id 1411809868335112192, 10 teams, NBA **Lock-In** mode (one locked game per slot; unlocked slots take their final game; Sleeper hides locks until the week ends).

## Site and branches
- `main` → https://nattieon.github.io/alpha-scout-app/ ; `experimental` → /lab/ (the lab). `data` branch = snapshots.
- Model / lock-math changes go to the **lab first**; promote to main only after he agrees. Display-only features (e.g. rankings modes) can go to both.
- `npm test` must pass on both branches before pushing. Pages workflow tests both.
- Commit messages end with the attribution lines the session gives you.

## Lock math (js/model.js), decisions already made
- Optimal stopping: V1 = mean, Vk = E[max(X, V(k-1))]; calls are made on win probability for the matchup, using the opponent's banked scores too.
- **Each player's remaining chances are his own.** Starters are pinned to their own slot (`positions: []`); no late-swap or bench backups count toward a starter's chances (he decided this: a swap-in who is much worse only saves you from a 0).
- `s.ifOut` = one "if he's ruled out" safety line: best bench player who fits and plays after the starter's last game; skips players with p(out) ≥ 0.5; ranked by (1 - p) × projection.
- Projections = Sleeper projection × recent-form ratio clamped to 0.75–1.25.
- Safety cushion slider: effect ≈ 1 - √(V/(V+σ²)) per point, so one point moves a bar only ~0.1. Not a bug.

## Lab experiment being watched (report when he asks)
- Lab rule "keep a big game": lock any score ≥ the player's 80th-percentile game (`BIG_GAME = 0.8`, `bigAt`), and tonight's bar is capped at `bigAt`.
- Backtest: `node scripts/backtest.mjs <jsDir> <dataDir>` (experimental branch). It replays every finished week, **all rosters**, using the **real nightly lineups** (mid-week lineup moves matter). Evaluations must always cover every week and every roster, never just his team.
- Result so far (weeks 1-4, 799 decisions): main 39,159 vs lab 39,221 (+62). Passing on a top-20% game was right 7 of 20 times.
- When asked: report calls the rule changed this week and how they turned out, rerun the backtest including the newest finished week, and recommend promote / tweak / drop.

## Rankings (js/rankings.js)
- Modes: points per game (default, also the lineup badges), **Lock-In value**, season total.
- Lock-In value = FP/G × spike factor. Spike factor = (V3 + V4)/2 of the lock math run on his games ÷ his average, blended with the league pool (every game of every player with 8+ games, as game/avg), weighted n : 10. League typical ≈ ×1.31.
- The snapshot job writes `rankings/{league}/latest.json` and `latest.csv` on the data branch (includes lockValue, spikeFactor, lockRank) so other agents can read them:
  https://raw.githubusercontent.com/Nattieon/alpha-scout-app/data/rankings/1411809868335112192/latest.json

## Trade valuation he uses
- Value over replacement = Lock-In value minus the best free agent's Lock-In value.
- Roster-aware mode: compare his top-10 lineup sums before and after the trade. In a 2-for-1 he cuts his worst player (keeps one slot open for streaming); the other team cuts its worst player or adds the best free agent.
- Possible future tool he mentioned: a trade analyzer (side A vs side B, stat comparison, plain and Lock-In modes). Not started; only build if he confirms.

## League managers: names to use in group-chat content
Cong (BocuaQuan, roster 3), Quan (anhquannghiem, 6), Trung (thaotheaccountant, 2), Jason (Nattieon, 7), Lam (Bachbachbitches, 1, commissioner), Tommy (bringbackbensimmons, 5), Hoang Anh (3ggr0ll, 4), Sang (cookmyass, 9), Tu (CEOatTOMFOOLERY, 10), Bill (BillVu, 8). Team names change often; go by roster id and username.

## Known Sleeper quirks
- League IR allows Out, Suspended and DNR only. When an IR player becomes healthy Sleeper should lock the roster, but this season it doesn't seem to enforce it (several managers moved lineups with a healthy player on IR).
