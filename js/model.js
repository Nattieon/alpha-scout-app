// Turns raw Sleeper data into slot states, per-game projections and lock calls.
import { buildShape, lockCall, percentileOf, slotMoments, slotValue, winProbability } from "./lockmath.js?v=__V__";
import { availabilityProfile, gameSitRisks, shiftDay } from "./availability.js?v=__V__";
import { canFill, planSlots } from "./swaps.js?v=__V__";

export const DEFAULTS = { baseDnp: 0.04, pairRest: 0.19, injuryDecay: 0.7, mode: "win", cvPrior: 0.30, projBasis: "next", oppSwaps: true, b2bFlags: {} };

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
export function todayET(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(at);
}
export const dow = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
export const md = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// ------------------------------------------------------------------ build
/**
 * raw: {league, rosters, users, matchups, schedule, stats: [...rows], projections: [...rows], week, players?,
 *       logs?: {pid: [{date, stats}]}  -- each starter's game log (last season + this season)}
 * myUserId: Sleeper user_id of the viewer (raw.viewRosterId, if set, picks the team instead).
 * marks: {pid: "YYYY-MM-DD" | "locked" | "open"} -- the viewer's lock overrides for this week (either
 *        team): the date of the locked game ("locked" = his latest game), or "open" for not locked.
 */
export function buildModel(raw, myUserId, cfg = {}, marks = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const availCfg = { normalPrior: c.baseDnp, pairPrior: c.pairRest, injuryDecay: c.injuryDecay };
  marks = normalizeMarks(marks);
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
    // His own scoring pattern: every logged game as a ratio to that season's average,
    // blended with a few prior games so a short log can't produce a wild shape.
    const log = (raw.logs?.[pid] || []).slice(-100);
    const fromLog = log.map((g) => ({ date: g.date, fp: fantasyPoints(g.stats, scoring) })).filter((g) => g.fp !== null);
    const logDates = new Set(fromLog.map((g) => g.date));
    for (const [d, row] of Object.entries(actual[pid] || {}))          // this week's games if the log lags
      if (!logDates.has(d) && (row.stats?.min || 0) > 0) fromLog.push({ date: d, fp: fantasyPoints(row.stats, scoring) });
    const history = fromLog.sort((a, b) => a.date.localeCompare(b.date));
    const shapeRatios = [];
    const bySeason = {};
    const seasonOf = (d) => (+d.slice(5, 7) >= 8 ? +d.slice(0, 4) : +d.slice(0, 4) - 1);   // Oct-Apr season = start year
    for (const g of history) (bySeason[seasonOf(g.date)] ||= []).push(g.fp);
    for (const fps of Object.values(bySeason)) {
      const m = fps.reduce((t, x) => t + x, 0) / fps.length;
      if (fps.length >= 3 && m > 5) fps.forEach((x) => shapeRatios.push(x / m));
    }
    const shape = buildShape(shapeRatios, { cvPrior: c.cvPrior });
    const cv = Math.sqrt(shape.reduce((t, r) => t + (r - 1) ** 2, 0) / shape.length);
    const histFps = history.map((g) => g.fp);

    // Availability: every completed team game in his log, played or not.
    const seasonStart = raw.schedule.reduce((m, g) => (g.date < m ? g.date : m), "9999-12-31");
    const completed = new Set(raw.schedule.filter((g) => g.status === "complete").flatMap((g) => [`${g.home?.team}@${g.date}`, `${g.away?.team}@${g.date}`]));
    const availRows = (raw.logs?.[pid] || [])
      .filter((g) => g.date < seasonStart || completed.has(`${g.team}@${g.date}`))
      .map((g) => ({ date: g.date, team: g.team, played: !!(g.stats && (g.stats.min || 0) > 0) }));
    const avail = availRows.length ? availabilityProfile(availRows, seasonStart, availCfg) : null;
    const playedOn = new Map(availRows.map((g) => [g.date, g.played]));
    const pct = (x) => (histFps.length >= 5 ? percentileOf(x, histFps) : null);
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
      ratio, cv, shape, pct, nHistory: histFps.length, actualAvg, pBar, games, teamDates, n,
      avail, playedOn, flagged: !!c.b2bFlags?.[pid],
      positions: (meta.fantasy_positions || [meta.position]).filter(Boolean) };
    playerCache[pid] = p;
    return p;
  }

  /** Remaining games as {mu, shape, p (+ linked-night fields), date, opp, why[]} for the stopping model. */
  function futureGames(p, afterDate, offset = 0, asOf = false) {
    // asOf: every game after afterDate, finished or not, as it looked beforehand (for "would he have locked it then?")
    const fut = p.games.filter((g) => g.date > afterDate && (asOf || g.status === "pre_game"));
    if (!fut.length) return [];
    // Did he play the day before the first remaining game? (matters if that was night 1 of a back-to-back)
    const dayBefore = shiftDay(fut[0].date, -1);
    const wk = p.games.find((g) => g.date === dayBefore);
    let prevPlayed;
    if (wk) prevPlayed = wk.status === "complete" ? wk.played : wk.live ? true : undefined;
    else if (p.playedOn.has(dayBefore)) prevPlayed = p.playedOn.get(dayBefore);
    const risks = gameSitRisks(p.avail, fut.map((g) => g.date), p.teamDates, {
      prevPlayed, flagged: p.flagged, injury: p.injury, offset, cfg: availCfg,
      extra: fut.map((g) => (g.projectedOut ? 0.85 : 0)),
    });
    return fut.map((g, i) => {
      const base = g.projFp ?? (p.pBar || p.actualAvg);
      const mu = Math.max(base * p.ratio, 0);
      return { mu, sigma: Math.max(p.cv * mu, 4), shape: p.shape, ...risks[i], date: g.date, opp: g.opp, home: g.home };
    });
  }

  // ---------------------------------------------------------------- slots
  // raw.viewRosterId: look at the week from any team's side (another matchup in the league).
  const myRoster = (raw.viewRosterId != null && raw.rosters.find((r) => r.roster_id === raw.viewRosterId))
    || raw.rosters.find((r) => r.owner_id === myUserId || (r.co_owners || []).includes(myUserId));
  const myMatch = myRoster && raw.matchups.find((m) => m.roster_id === myRoster.roster_id);
  const oppMatch = myMatch && raw.matchups.find((m) => m.matchup_id === myMatch.matchup_id && m.roster_id !== myMatch.roster_id);
  const userName = (rid) => {
    const r = raw.rosters.find((x) => x.roster_id === rid);
    const u = r && raw.users.find((x) => x.user_id === r.owner_id);
    return u ? (u.metadata?.team_name || u.display_name) : `Team ${rid}`;
  };
  const slotLabels = (raw.league.roster_positions || []).filter((s) => !["BN", "IR", "TAXI"].includes(s));

  /** Sleeper's own projection (in your scoring) for his next game that hasn't finished. */
  function nextProjection(p) {
    const g = p.games.find((x) => x.status !== "complete");
    if (!g) return null;
    if (g.projFp !== null && g.projFp !== undefined) return g.projFp;
    return g.projectedOut ? 0 : (p.pBar || p.actualAvg || 0);
  }

  function slotsFor(match) {
    if (!match) return [];
    return match.starters.map((pid, i) => {
      const label = slotLabels[i] || "UTIL";
      if (!pid || pid === "0") return { i, label, empty: true, value: { mean: 0, variance: 0 }, kind: "empty" };
      const p = player(pid);
      const shown = match.starters_points?.[i] ?? 0;
      // Sleeper's public data never says whether a slot is locked: during the week a slot shows the
      // player's latest game (locks are applied only when the week is finalized). So locks come from
      // the viewer's marks, and otherwise from a guess (below), the same for both teams.
      //   mark = a game date (locked that game) | "locked" (his latest) | "open" (not locked so far)
      //        | "after:DATE" (on the bench through DATE: those games can't count)
      //        | "pass:DATE"  (not locked through DATE: those lock windows are closed)
      const mark = marks[pid];
      const closed = typeof mark === "string" && /^(after|pass):/.test(mark) ? mark.slice(mark.indexOf(":") + 1) : null;
      const benchedThrough = typeof mark === "string" && mark.startsWith("after:") ? closed : null;
      const allDone = p.games.filter((g) => g.status === "complete");
      const done = closed ? allDone.filter((g) => g.date > closed) : allDone;
      const lastDone = done[done.length - 1];
      const liveGame = p.games.find((g) => g.live);
      const nextGame = p.games.find((g) => g.status === "pre_game");
      const lockable = done.filter((g) => g.played);
      const s = { i, label, pid, p, shown, liveGame, nextGame, lastDone, mark, markKey: pid, lockable, completed: allDone, benchedThrough, passedThrough: benchedThrough ? null : closed, nextProj: nextProjection(p) };
      const markedGame = !mark || mark === "open" || closed ? null : mark === "locked" ? lockable.at(-1) : lockable.find((g) => g.date === mark);
      const userOpen = mark === "open" || !!benchedThrough;

      if (markedGame) {
        Object.assign(s, { kind: "locked", certain: true, manual: true, lockedGame: markedGame, value: { mean: markedGame.fp, variance: 0 } });
        return s;
      }
      // Games whose lock window has closed (his next game has started). Nobody told us whether they
      // were locked, so assume a sensible manager: he locked the first one that beat what the rest of
      // his week was worth at the time.
      const closedGames = liveGame ? done : done.slice(0, -1);
      if (mark !== "open") for (const g of closedGames) {
        if (!g.played || !(g.fp > 0)) continue;
        const after = futureGames(p, g.date, 0, true);
        const bar = after.length ? slotValue(after) : 0;
        if (after.length && g.fp >= bar) {
          Object.assign(s, { kind: "assumed-locked", guess: true, lockedGame: g, score: g.fp, guessBar: bar, pctScore: p.pct(g.fp), value: { mean: g.fp, variance: 0 } });
          return s;
        }
      }
      if (liveGame) {
        const after = futureGames(p, liveGame.date, 1);
        // The live game becomes a decision once it ends; model it as one more game.
        const liveMu = Math.max((liveGame.projFp ?? p.pBar) * p.ratio, 0);
        const games = [{ mu: liveMu, sigma: Math.max(p.cv * liveMu, 4), shape: p.shape, p: 0.02, date: liveGame.date, opp: liveGame.opp }, ...after];
        Object.assign(s, { kind: "live", liveFp: liveGame.fp ?? 0, after, value: slotMoments(games), games });
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
        } else {
          // His latest game, still lockable until his next game tips off.
          const bar = slotValue(rem);
          Object.assign(s, { ambiguous: true, score: lastDone.fp, games: rem, bar,
            pctScore: p.pct(lastDone.fp), pctBar: p.pct(bar) });
          // A decision for whichever team owns him. "Not locked" (mark "open") means it isn't locked:
          // the model then counts the slot as passed, on either side.
          Object.assign(s, { kind: "pending", forcedPass: userOpen, value: slotMoments(rem) });
        }
      }
      if (userOpen && s.kind !== "pending" && s.kind !== "final") s.manual = true;
      return s;
    });
  }

  /** Bench players: not counted, but shown so swaps are easy to spot. */
  function benchFor(match) {
    if (!match) return [];
    const starters = new Set(match.starters || []);
    return (match.players || []).filter((pid) => pid && !starters.has(pid)).map((pid) => {
      const p = player(pid);
      return { pid, p, points: match.players_points?.[pid] ?? 0, nextProj: nextProjection(p) };
    }).sort((a, b) => (b.nextProj ?? -1) - (a.nextProj ?? -1));
  }

  const oppRoster = oppMatch && raw.rosters.find((r) => r.roster_id === oppMatch.roster_id);
  const mySlots = slotsFor(myMatch);
  const oppSlots = slotsFor(oppMatch);
  const yesterday = shiftDay(today, -1);
  const useMatchup = c.mode === "win" && oppSlots.length > 0;

  /** Swap candidates for one team: players in open slots + (optionally) bench players with games left. */
  function swapCandidates(slots, match, roster, openKinds, bench = true) {
    const reserveIds = new Set(roster?.reserve || []);
    const out = [];
    for (const s of slots) {
      if (!openKinds.has(s.kind) || !s.p) continue;
      const games = s.games || futureGames(s.p, yesterday);
      out.push({ key: s.pid, p: s.p, positions: s.p.positions, games, value: slotValue(games), from: s.label, starter: true });
    }
    if (bench) for (const pid of match ? (match.players || []) : []) {
      if (!pid || match.starters.includes(pid) || reserveIds.has(pid)) continue;
      const bp = player(pid);
      const games = futureGames(bp, yesterday);
      if (games.length) out.push({ key: pid, p: bp, positions: bp.positions, games, value: slotValue(games), from: "bench", starter: false });
    }
    return out;
  }

  // ---------------------------------------------------------------- team plans
  // Both teams go through exactly the same steps, so the matchup reads the same from either
  // side (your win % + theirs = 100%). Only what's displayed differs.
  //  1. prepare: each open slot's best holder for the rest of the week (bench swaps, level 1),
  //     and each just-finished game's value if passed (with the bench available).
  //  2. decide:  lock or pass each just-finished game, against the other team's step-1 values.
  //  3. finish:  re-plan with the locked slots taken out; list the swaps.
  const OPEN = new Set(["pending", "open", "none", "final", "empty"]);
  function prepare(slots, match, roster, bench) {
    const candidates = swapCandidates(slots, match, roster, OPEN, bench);
    const byKey = new Map(candidates.map((x) => [x.key, x]));
    const planRows = (lockedKeys = new Set()) => slots.filter((s) => OPEN.has(s.kind) && !lockedKeys.has(s.i)).map((s) => ({
      key: s.i, label: s.label, current: s.pid || null,
      keepScore: s.kind === "pending" ? (s.forcedPass ? null : s.score) : s.kind === "final" ? s.value.mean : null,
    }));
    const firstPlan = planSlots(planRows(), candidates);
    for (const s of slots) if (s.kind === "pending") {
      const { assign } = firstPlan.openValue(s.i);
      const occ = byKey.get(assign[s.i]);
      s.contGames = occ ? (occ.key === s.pid ? s.games : occ.games) : [];
      s.contBy = occ && occ.key !== s.pid ? occ : null;
      s.value = !s.forcedPass && s.score >= slotValue(s.contGames) ? { mean: s.score, variance: 0 } : slotMoments(s.contGames);
    }
    return { slots, candidates, byKey, planRows };
  }
  function decide(t, theirs) {
    for (const s of t.slots) {
      if (s.kind !== "pending") continue;
      const others = t.slots.filter((o) => o !== s).map((o) => o.value);
      s.call = lockCall(s.score, s.contGames, useMatchup ? others : null, useMatchup ? theirs : null);
      s.bar = s.call.bar;
      s.value = s.call.verdict === "LOCK" && !s.forcedPass ? { mean: s.score, variance: 0 } : slotMoments(s.contGames);
    }
  }
  function finish(t) {
    const { slots, candidates, byKey, planRows } = t;
    const lockedNow = new Set(slots.filter((s) => s.kind === "pending" && s.call.verdict === "LOCK" && !s.forcedPass).map((s) => s.i));
    const lockedPlayers = new Set(slots.filter((s) => lockedNow.has(s.i)).map((s) => s.pid));
    const plan = planSlots(planRows(lockedNow), candidates.filter((x) => !lockedPlayers.has(x.key)));
    const swaps = [];
    for (const s of slots) {
      if (!OPEN.has(s.kind) || lockedNow.has(s.i)) continue;
      const occ = byKey.get(plan.assign[s.i]) || null;
      const keepNow = plan.keep[s.i];
      if (occ && occ.key !== s.pid) {
        s.swapIn = occ;
        s.value = slotMoments(occ.games);
        const without = s.kind === "pending" ? slotValue(s.games) : s.kind === "final" ? s.value.mean : (byKey.get(s.pid)?.value ?? 0);
        const stay = s.kind === "final" ? s.lastDone?.fp ?? 0 : s.kind === "pending" ? slotValue(s.games) : (byKey.get(s.pid)?.value ?? 0);
        const gain = occ.value - Math.max(stay, 0);
        // Games the current player still gets before the incoming player's first game: no need to
        // swap yet. Let him play them, lock a big one, and only swap if he falls short.
        const deadline = occ.games[0]?.date;
        const keepFirst = s.p ? (s.games || []).filter((g) => deadline && g.date < deadline) : [];
        if (gain >= 1) swaps.push({ slot: s, into: occ, out: s.p || null, gain, deadline, without, keepFirst });
      } else if (keepNow && s.kind === "final") {
        s.value = { mean: s.lastDone?.fp ?? s.value.mean, variance: 0 };
      } else if (!occ && s.kind !== "final") {
        s.value = { mean: 0, variance: 0 };
      }
    }
    swaps.sort((a, b) => (a.deadline || "").localeCompare(b.deadline || "") || b.gain - a.gain);
    return { plan, swaps };
  }

  // Opponent bench swaps are a setting (on by default). Turned off, his bench is ignored and
  // the two sides no longer mirror each other exactly.
  const mine = prepare(mySlots, myMatch, myRoster, true);
  const opp = prepare(oppSlots, oppMatch, oppRoster, !!c.oppSwaps);
  const evMine = mySlots.map((s) => s.value), evOpp = oppSlots.map((s) => s.value);
  decide(mine, evOpp);
  decide(opp, evMine);
  const { plan, swaps } = finish(mine);
  const { swaps: oppSwaps } = finish(opp);
  const { candidates } = mine;
  // The opponent's just-finished games are shown as guesses of what he'll do.
  for (const s of oppSlots) if (s.kind === "pending") {
    if (s.forcedPass) { s.kind = "open"; s.manual = true; }
    else s.kind = s.call.verdict === "LOCK" ? "assumed-locked" : "assumed-open";
  }
  const theirs = oppSlots.map((s) => s.value);

  // Tonight's bars: the score that should be locked when tonight's game ends.
  // Passing keeps the slot open for his later games or for a free bench player.
  const usedBench = new Set(Object.values(plan.assign).filter(Boolean));
  for (const s of mySlots) {
    const tonight = s.kind === "live" ? s.liveGame : (s.kind === "open" || s.kind === "pending") && s.games?.[0]?.date === today ? s.games[0] : null;
    if (!tonight) continue;
    // A planned swap whose incoming player starts later: he still plays tonight, and the swap is his fallback.
    if (s.swapIn && !(s.swapIn.games[0]?.date > today)) continue;
    let after = s.swapIn ? s.swapIn.games : s.kind === "live" ? s.after : s.games.slice(1);
    let afterBy = s.swapIn || null;
    for (const x of candidates) {
      if (s.swapIn || x.starter || usedBench.has(x.key) || !canFill(s.label, x.positions)) continue;
      const later = x.games.filter((g) => g.date > today);
      if (later.length && slotValue(later) > slotValue(after)) { after = later; afterBy = x; }
    }
    s.tonight = { date: today, opp: tonight.opp, after, afterBy, final: after.length === 0 };
    if (!after.length) continue;
    s.tonight.evBar = slotValue(after);
    s.tonight.bar = s.tonight.evBar;
    if (useMatchup) {
      const others = mySlots.filter((o) => o !== s).map((o) => o.value);
      s.tonight.bar = matchupBar(after, others, theirs) ?? s.tonight.evBar;
    }
    s.tonight.pctBar = s.p.pct(s.tonight.bar);
  }

  const myValues = mySlots.map((s) => s.value);
  const win = oppSlots.length ? winProbability(myValues, theirs) : null;
  const sum = (arr) => arr.reduce((t, v) => t + v.mean, 0);
  // "next" basis: any slot not locked counts Sleeper's projection for his next game
  // (or the game he's playing now); locked and finished slots count their score.
  const slotShown = (x) => {
    if (x.swapIn) return nextProjection(x.swapIn.p) ?? x.value.mean;
    if (x.kind === "locked" || x.kind === "final" || x.kind === "assumed-locked" || x.kind === "empty") return x.value.mean;
    if (x.kind === "none") return 0;
    // Your undecided slot: follow the call (locking it counts tonight's score) unless you said "Not locked".
    if (x.kind === "pending" && x.mark !== "open" && x.call?.verdict === "LOCK") return x.score;
    return x.nextProj ?? x.value.mean;
  };
  for (const x of [...mySlots, ...oppSlots]) x.shownProj = c.projBasis === "smart" ? x.value.mean : slotShown(x);
  const projOf = (slots) => slots.reduce((t, x) => t + x.shownProj, 0);
  const banked = (slots) => slots.filter((x) => (x.kind === "locked" && x.certain) || x.kind === "final").reduce((t, x) => t + x.value.mean, 0);
  return {
    week, weekDates, today, scoring, mode: useMatchup ? "win" : "ev", projBasis: c.projBasis,
    me: myMatch && { rosterId: myMatch.roster_id, name: userName(myMatch.roster_id), points: myMatch.points, proj: projOf(mySlots), banked: banked(mySlots), slots: mySlots, bench: benchFor(myMatch) },
    opp: oppMatch && { rosterId: oppMatch.roster_id, name: userName(oppMatch.roster_id), points: oppMatch.points, proj: projOf(oppSlots), banked: banked(oppSlots), slots: oppSlots, bench: benchFor(oppMatch) },
    win, missingRoster: !myRoster, noMatchup: !!myRoster && !oppMatch, swaps, oppSwaps, oppSwapsModeled: !!c.oppSwaps,
    whatIf(slot, score) {
      const others = mySlots.filter((o) => o !== slot).map((o) => o.value);
      return lockCall(score, slot.tonight?.after || slot.contGames || slot.games || [], useMatchup ? others : null, useMatchup ? theirs : null);
    },
  };
}

/** Accepts current marks plus the two older formats (a Set of "pid@date", or {"pid@date": "locked"|"open"}). */
export function normalizeMarks(marks) {
  if (!marks) return {};
  const entries = marks instanceof Set ? [...marks].map((k) => [k, "locked"]) : Object.entries(marks);
  const out = {};
  for (const [k, v] of entries) {
    const at = k.indexOf("@");
    if (at === -1) { out[k] = v; continue; }
    const pid = k.slice(0, at), date = k.slice(at + 1);
    out[pid] = v === "open" ? "open" : date;
  }
  return out;
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
