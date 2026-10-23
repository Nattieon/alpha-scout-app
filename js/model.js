// Turns raw Sleeper data into slot states, per-game projections and lock calls.
import { gameRisks, lockCall, slotMoments, slotValue, winProbability } from "./lockmath.js";

export const DEFAULTS = { baseDnp: 0.04, b2bDnp: 0.08, injuryDecay: 0.7, mode: "win", cvPrior: 0.30 };

// ------------------------------------------------------------------ scoring
const BONUS = {
  bonus_pt_40p: (s) => (s.pts || 0) >= 40, bonus_pt_50p: (s) => (s.pts || 0) >= 50,
  bonus_reb_20p: (s) => (s.reb || 0) >= 20, bonus_ast_15p: (s) => (s.ast || 0) >= 15,
};

/** Fantasy points with the league's own Sleeper scoring_settings. null if no stat line. */
export function fantasyPoints(stats, scoring, { projected = false } = {}) {
  if (!stats || !Object.keys(stats).length) return null;
  const s = { ...stats };
  const tens = ["pts", "reb", "ast", "stl", "blk"].filter((k) => (s[k] || 0) >= 10).length;
  if (s.dd === undefined) s.dd = tens >= 2 ? 1 : 0;
  if (s.td === undefined) s.td = tens >= 3 ? 1 : 0;
  for (const k of ["fgmi", "ftmi", "tpmi"]) {
    const [m, a] = { fgmi: ["fgm", "fga"], ftmi: ["ftm", "fta"], tpmi: ["tpm", "tpa"] }[k];
    if (s[k] === undefined) s[k] = Math.max((s[a] || 0) - (s[m] || 0), 0);
  }
  let total = 0;
  for (const [k, w] of Object.entries(scoring || {})) {
    if (!w) continue;
    const v = BONUS[k] ? (projected ? 0 : BONUS[k](s) ? 1 : 0) : s[k] || 0;
    total += w * v;
  }
  return Math.round(total * 100) / 100;
}

// ------------------------------------------------------------------ dates
export function todayET() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}
export const dow = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
export const md = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// ------------------------------------------------------------------ build
/**
 * raw: {league, rosters, users, matchups, schedule, stats: [...rows], projections: [...rows], week, players?}
 * myUserId: Sleeper user_id of the viewer.  locked: Set of "pid@date" the viewer marked as locked.
 */
export function buildModel(raw, myUserId, cfg = {}, locked = new Set()) {
  const c = { ...DEFAULTS, ...cfg };
  const scoring = raw.league.scoring_settings || {};
  const today = raw.today || todayET();
  const week = raw.week;

  // Schedule: team -> games (whole season, for back-to-back detection) and this week's games.
  const teamGames = {};
  for (const g of raw.schedule) {
    for (const [side, other] of [["home", "away"], ["away", "home"]]) {
      const t = g[side]?.team;
      if (!t) continue;
      (teamGames[t] ||= []).push({ date: g.date, status: g.status, opp: g[other]?.team, home: side === "home", week: g.week, id: g.game_id });
    }
  }
  for (const t in teamGames) teamGames[t].sort((a, b) => a.date.localeCompare(b.date));
  const weekDates = [...new Set(raw.schedule.filter((g) => g.week === week).map((g) => g.date))].sort();

  // Per-player rows.
  const actual = {}, proj = {}, info = {};
  for (const r of raw.stats) { (actual[r.player_id] ||= {})[r.date] = r; if (r.player) info[r.player_id] ||= { ...r.player, team: r.team || r.player.team }; }
  for (const r of raw.projections) { (proj[r.player_id] ||= {})[r.date] = r; if (r.player) info[r.player_id] = { ...r.player, team: r.team || r.player.team }; }
  const dump = raw.players || {};

  const playerCache = {};
  function player(pid) {
    if (playerCache[pid]) return playerCache[pid];
    const meta = info[pid] || dump[pid] || {};
    const name = [meta.first_name, meta.last_name].filter(Boolean).join(" ") || meta.full_name || `Player ${pid}`;
    const team = meta.team || null;
    const injury = meta.injury_status || null;
    const teamDates = new Set((teamGames[team] || []).map((g) => g.date));

    // Calibrate the Rotowire projection to this player's actual results (shrunk, clipped).
    let A = 0, P = 0, n = 0; const ratios = [];
    for (const [d, row] of Object.entries(actual[pid] || {})) {
      const a = fantasyPoints(row.stats, scoring);
      const pr = proj[pid]?.[d] && fantasyPoints(proj[pid][d].stats, scoring, { projected: true });
      if (a !== null && pr > 5 && (row.stats.min || 0) > 0) { A += a; P += pr; n++; ratios.push(a / pr); }
    }
    const projVals = Object.values(proj[pid] || {}).map((r) => fantasyPoints(r.stats, scoring, { projected: true })).filter((v) => v > 0);
    const pBar = projVals.length ? projVals.reduce((s, v) => s + v, 0) / projVals.length : 0;
    const k = 3 * (pBar || 1);
    const ratio = pBar ? Math.min(Math.max((A + k) / (P + k), 0.75), 1.25) : 1;
    let cv = c.cvPrior;
    if (ratios.length >= 2) {
      const m = ratios.reduce((s, v) => s + v, 0) / ratios.length;
      const sd = Math.sqrt(ratios.reduce((s, v) => s + (v - m) ** 2, 0) / (ratios.length - 1));
      cv = (ratios.length * sd + 5 * c.cvPrior) / (ratios.length + 5);
    }
    const actualAvg = (() => {
      const v = Object.values(actual[pid] || {}).filter((r) => (r.stats?.min || 0) > 0).map((r) => fantasyPoints(r.stats, scoring));
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
    })();

    // This week's games for his team.
    const games = (teamGames[team] || []).filter((g) => g.week === week).map((g) => {
      const row = actual[pid]?.[g.date];
      const prow = proj[pid]?.[g.date];
      const projFp = prow ? fantasyPoints(prow.stats, scoring, { projected: true }) : null;
      const fp = row ? fantasyPoints(row.stats, scoring) : null;
      const played = !!row && (row.stats?.min || 0) > 0;
      return { ...g, fp: g.status === "complete" ? (played ? fp : 0) : fp, played, projFp, projectedOut: !!prow && projFp === null, live: g.status !== "complete" && g.status !== "pre_game" };
    });

    const p = { pid, name, team, injury, pos: (meta.fantasy_positions || [meta.position]).filter(Boolean).join("/"),
      ratio, cv, actualAvg, pBar, games, teamDates, n };
    playerCache[pid] = p;
    return p;
  }

  /** Remaining games as {mu, sigma, p, date, opp, why[]} for the stopping model. */
  function futureGames(p, afterDate, offset = 0) {
    const fut = p.games.filter((g) => g.date > afterDate && g.status === "pre_game");
    const risks = gameRisks(fut.map((g) => g.date), p.teamDates, p.injury, c, offset);
    return fut.map((g, i) => {
      const base = g.projFp ?? (p.pBar || p.actualAvg);
      const mu = Math.max(base * p.ratio, 0);
      let prob = risks[i].p;
      const why = [];
      if (risks[i].b2b) why.push("back-to-back");
      if (risks[i].injury) why.push(`listed ${risks[i].injury}`);
      if (g.projectedOut) { prob = Math.max(prob, 0.85); why.push("projected to sit"); }
      return { mu, sigma: Math.max(p.cv * mu, 4), p: prob, date: g.date, opp: g.opp, home: g.home, why };
    });
  }

  // ---------------------------------------------------------------- slots
  const myRoster = raw.rosters.find((r) => r.owner_id === myUserId || (r.co_owners || []).includes(myUserId));
  const myMatch = myRoster && raw.matchups.find((m) => m.roster_id === myRoster.roster_id);
  const oppMatch = myMatch && raw.matchups.find((m) => m.matchup_id === myMatch.matchup_id && m.roster_id !== myMatch.roster_id);
  const userName = (rid) => {
    const r = raw.rosters.find((x) => x.roster_id === rid);
    const u = r && raw.users.find((x) => x.user_id === r.owner_id);
    return u ? (u.metadata?.team_name || u.display_name) : `Team ${rid}`;
  };
  const slotLabels = (raw.league.roster_positions || []).filter((s) => !["BN", "IR", "TAXI"].includes(s));

  function slotsFor(match, mine) {
    if (!match) return [];
    return match.starters.map((pid, i) => {
      const label = slotLabels[i] || "UTIL";
      if (!pid || pid === "0") return { i, label, empty: true, value: { mean: 0, variance: 0 }, kind: "empty" };
      const p = player(pid);
      const shown = match.starters_points?.[i] ?? 0;
      const done = p.games.filter((g) => g.status === "complete");
      const lastDone = done[done.length - 1];
      const liveGame = p.games.find((g) => g.live);
      const nextGame = p.games.find((g) => g.status === "pre_game");
      const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.011;
      const s = { i, label, pid, p, shown, liveGame, nextGame, lastDone };

      const earlier = done.slice(0, -1).find((g) => near(g.fp, shown) && !near(lastDone.fp, shown));
      const markKey = lastDone ? `${pid}@${lastDone.date}` : null;
      if (earlier) {
        Object.assign(s, { kind: "locked", certain: true, lockedGame: earlier, value: { mean: shown, variance: 0 } });
      } else if (liveGame) {
        const after = futureGames(p, liveGame.date, 1);
        if (lastDone && near(lastDone.fp, shown) && !near(liveGame.fp ?? 0, shown) && lastDone.fp !== 0) {
          Object.assign(s, { kind: "locked", certain: false, lockedGame: lastDone, value: { mean: shown, variance: 0 } });
        } else {
          // The live game becomes a decision once it ends; model it as one more game.
          const liveMu = Math.max((liveGame.projFp ?? p.pBar) * p.ratio, 0);
          const games = [{ mu: liveMu, sigma: Math.max(p.cv * liveMu, 4), p: 0.02, date: liveGame.date, opp: liveGame.opp }, ...after];
          Object.assign(s, { kind: "live", liveFp: liveGame.fp ?? 0, after, value: slotMoments(games), games });
        }
      } else if (!lastDone) {
        const games = futureGames(p, "0000-00-00");
        Object.assign(s, { kind: games.length ? "open" : "none", games, value: slotMoments(games) });
      } else {
        const rem = futureGames(p, lastDone.date);
        if (!rem.length) {
          Object.assign(s, { kind: "final", value: { mean: lastDone.fp, variance: 0 } });
        } else if (!lastDone.played) {
          // He sat his latest game: nobody locks a 0, the slot just stays open.
          Object.assign(s, { kind: "open", games: rem, value: slotMoments(rem) });
        } else if (mine && locked.has(markKey)) {
          Object.assign(s, { kind: "locked", certain: true, manual: true, lockedGame: lastDone, value: { mean: lastDone.fp, variance: 0 } });
        } else {
          const bar = slotValue(rem);
          // Ambiguous window: Sleeper shows the same number whether he's locked or open.
          const assumeLocked = !mine && lastDone.fp >= bar;
          Object.assign(s, {
            kind: mine ? "pending" : assumeLocked ? "assumed-locked" : "assumed-open",
            score: lastDone.fp, games: rem, bar, markKey,
            value: assumeLocked ? { mean: lastDone.fp, variance: 0 } : slotMoments(rem),
          });
        }
      }
      return s;
    });
  }

  let mySlots = slotsFor(myMatch, true);
  const oppSlots = slotsFor(oppMatch, false);
  const theirs = oppSlots.map((s) => s.value);
  const useMatchup = c.mode === "win" && oppSlots.length > 0;

  // My pending slots: default them to the points rule while evaluating each other.
  for (const s of mySlots) if (s.kind === "pending") s.value = s.score >= s.bar ? { mean: s.score, variance: 0 } : slotMoments(s.games);
  for (const s of mySlots) {
    const others = mySlots.filter((o) => o !== s).map((o) => o.value);
    if (s.kind === "pending") {
      s.call = lockCall(s.score, s.games, useMatchup ? others : null, useMatchup ? theirs : null);
      s.value = s.call.verdict === "LOCK" ? { mean: s.score, variance: 0 } : slotMoments(s.games);
    }
  }
  // Tonight's bars: the score that should be locked when tonight's game ends.
  for (const s of mySlots) {
    const tonight = s.kind === "live" ? s.liveGame : (s.kind === "open" || s.kind === "pending") && s.games?.[0]?.date === today ? s.games[0] : null;
    if (!tonight) continue;
    const after = s.kind === "live" ? s.after : s.games.slice(1);
    s.tonight = { date: today, opp: tonight.opp, after, final: after.length === 0 };
    if (!after.length) continue;
    s.tonight.evBar = slotValue(after);
    s.tonight.bar = s.tonight.evBar;
    if (useMatchup) {
      const others = mySlots.filter((o) => o !== s).map((o) => o.value);
      s.tonight.bar = matchupBar(after, others, theirs) ?? s.tonight.evBar;
    }
  }

  const myValues = mySlots.map((s) => s.value);
  const win = oppSlots.length ? winProbability(myValues, theirs) : null;
  const sum = (arr) => arr.reduce((t, v) => t + v.mean, 0);
  return {
    week, weekDates, today, scoring, mode: useMatchup ? "win" : "ev",
    me: myMatch && { rosterId: myMatch.roster_id, name: userName(myMatch.roster_id), points: myMatch.points, proj: sum(myValues), slots: mySlots },
    opp: oppMatch && { rosterId: oppMatch.roster_id, name: userName(oppMatch.roster_id), points: oppMatch.points, proj: sum(theirs), slots: oppSlots },
    win, missingRoster: !myRoster, noMatchup: !!myRoster && !oppMatch,
    whatIf(slot, score) {
      const others = mySlots.filter((o) => o !== slot).map((o) => o.value);
      return lockCall(score, slot.tonight?.after || slot.games || [], useMatchup ? others : null, useMatchup ? theirs : null);
    },
  };
}

/** Lowest score worth locking when the matchup is taken into account (bisection). */
export function matchupBar(games, others, theirs) {
  const decide = (x) => lockCall(x, games, others, theirs);
  let lo = -10, hi = 160;
  if (decide(hi).verdict !== "LOCK") return null;
  if (decide(lo).verdict === "LOCK") return lo;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (decide(mid).verdict === "LOCK") hi = mid; else lo = mid;
  }
  return hi;
}
