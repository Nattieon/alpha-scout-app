// Offline backtest: rerun every night of every finished week with a given formula (a js/ folder),
// and score each lock call the way the calibration does (follow the call vs do the opposite, real results).
// usage: node scripts/backtest.mjs <jsDir> <dataDir (a checkout of the data branch)> [cfgJSON]
import fs from "fs"; import zlib from "zlib"; import path from "path"; import { pathToFileURL } from "url";
const [jsDir, D, cfgArg] = process.argv.slice(2);
const { buildModel, DEFAULTS } = await import(pathToFileURL(path.join(jsDir, "model.js")).href);
const { lockBars } = await import(pathToFileURL(path.join(jsDir, "lockmath.js")).href);
const L = path.join(D, "leagues/1411809868335112192/2026");
const schedule = JSON.parse(fs.readFileSync(path.join(D, "schedule/2026.json")));
const tipAll = JSON.parse(fs.readFileSync(path.join(D, "tipoffs/2026.json")));
const logCache = {};
const logOf = (pid) => logCache[pid] ||= ["2025", "2026"].flatMap((s) => { try { return JSON.parse(fs.readFileSync(path.join(D, `logs/${s}/${pid}.json`))); } catch { return []; } });
const shift = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const cfg = { ...DEFAULTS, b2bFlags: {}, ...(cfgArg ? JSON.parse(cfgArg) : {}) };
const calls = [];
const lineupNote = {};
const weeks = fs.readdirSync(L).filter((d) => /^w\d+$/.test(d)).sort();
for (const w of weeks) {
  const f = path.join(L, w, "backtest.json.gz");
  if (!fs.existsSync(f)) continue;
  const B = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  // Mid-week lineups: managers move players in and out all week, so each night uses the lineup that
  // actually played that evening (the morning snapshot, plus the lineup moves logged up to 7pm ET),
  // not the week's final lineup. Weeks before the snapshots began fall back to the final lineup.
  const nd = path.join(L, w, "nightly");
  const mornings = {};
  if (fs.existsSync(nd)) for (const f of fs.readdirSync(nd).filter((x) => x.endsWith(".inputs.json.gz")))
    mornings[f.slice(0, 10)] = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(nd, f))));
  let events = [];
  try { events = JSON.parse(fs.readFileSync(path.join(L, w, "events.json"))).filter((e) => e.type === "lineup").sort((a, b) => a.at.localeCompare(b.at)); } catch {}
  // every player seen on any roster this week: stats, projections, team, actual scores
  const statKey = new Set(B.stats.map((r) => `${r.player_id}@${r.date}`)), projKey = new Set(B.projections.map((r) => `${r.player_id}@${r.date}`));
  for (const mo of Object.values(mornings)) {
    for (const r of mo.stats || []) if (!statKey.has(`${r.player_id}@${r.date}`)) { statKey.add(`${r.player_id}@${r.date}`); B.stats.push(r); }
    for (const r of mo.projections || []) if (!projKey.has(`${r.player_id}@${r.date}`)) { projKey.add(`${r.player_id}@${r.date}`); B.projections.push(r); }
  }
  const { fantasyPoints } = await import(pathToFileURL(path.join(jsDir, "model.js")).href);
  for (const r of [...B.stats, ...B.projections]) if (!B.teamOf[r.player_id]) B.teamOf[r.player_id] = r.team || r.player?.team;
  for (const r of B.stats) if (r.stats && (r.stats.min || 0) > 0 && B.fpOn[r.player_id]?.[r.date] === undefined) (B.fpOn[r.player_id] ||= {})[r.date] = fantasyPoints(r.stats, B.league.scoring_settings);
  const teamDatesOf = (pid) => B.teamDates[B.teamOf[pid]] || [];
  const actualOf = (pid, d) => B.actuals[pid]?.[d] ?? (teamDatesOf(pid).includes(d) ? Math.round((B.fpOn[pid]?.[d] ?? 0) * 100) / 100 : 0);
  const lineupOn = (Dn) => {
    const mo = mornings[Dn];
    if (!mo) return null;
    const by = Object.fromEntries(mo.matchups.map((m) => [m.roster_id, { starters: [...(m.starters || [])], players: [...(m.players || [])] }]));
    for (const e of events) {
      if (e.at <= `${Dn}T04:59` || e.at > `${Dn}T19:00`) continue;
      const L2 = by[e.rosterId];
      if (!L2) continue;
      for (const mv of e.moves || []) {
        const i = L2.starters.findIndex((p) => p === (mv.out || "0"));
        if (i >= 0) L2.starters[i] = mv.in || "0";
        if (mv.in && !L2.players.includes(mv.in)) L2.players.push(mv.in);
      }
    }
    return by;
  };
  let nightsWithLineups = 0;
  const pids = [...new Set([...B.finalMatchups, ...Object.values(mornings).flatMap((mo) => mo.matchups)].flatMap((m) => [...(m.starters || []), ...(m.players || [])]))].filter((p) => p && p !== "0");
  const seen = new Set();
  for (const Dn of B.weekDates.slice(0, -1)) {
    const lu = lineupOn(Dn);
    if (lu) nightsWithLineups++;
    lineupNote[w] = `${w}: ${nightsWithLineups} of ${B.weekDates.length - 1} nights with real lineups`;
    const matchups = B.finalMatchups.map((m0) => {
      const m = lu?.[m0.roster_id] ? { ...m0, ...lu[m0.roster_id] } : m0;
      const sp = (m.starters || []).map((pid) => {
        if (!pid || pid === "0") return 0;
        const played = (B.teamDates[B.teamOf[pid]] || []).filter((d) => d <= Dn && B.fpOn[pid]?.[d] !== undefined).sort();
        return played.length ? B.fpOn[pid][played.at(-1)] : 0;
      });
      const pp = Object.fromEntries((m.players || []).map((pid) => { const ds = (B.teamDates[B.teamOf[pid]] || []).filter((d) => d <= Dn).sort(); return [pid, ds.length ? B.fpOn[pid]?.[ds.at(-1)] ?? 0 : 0]; }));
      return { ...m, starters_points: sp, players_points: pp, points: sp.reduce((t, x) => t + x, 0) };
    });
    const rawD = { league: B.league, rosters: B.rosters, users: B.users, players: B.players || undefined, week: B.week,
      today: shift(Dn, 1), tipoffs: tipAll,
      schedule: schedule.map((g) => (g.week === B.week ? { ...g, status: g.date <= Dn ? "complete" : "pre_game" } : g)),
      stats: B.stats.filter((r) => r.date <= Dn), projections: B.projections,
      logs: Object.fromEntries(pids.map((pid) => [pid, logOf(pid).filter((g) => g.date <= Dn)])),
      matchups };
    const ids = new Map();
    for (const m of matchups) if (m.matchup_id) (ids.get(m.matchup_id) || ids.set(m.matchup_id, []).get(m.matchup_id)).push(m.roster_id);
    for (const rids of ids.values()) {
      const m = buildModel({ ...rawD, viewRosterId: Math.min(...rids) }, null, cfg, B.marks[Dn]);
      for (const t of [m.me, m.opp].filter(Boolean)) for (const sl of t.slots) {
        if (!sl.call || !sl.contGames?.length || sl.forcedPass) continue;
        const key = `${t.rosterId}:${sl.pid}:${sl.lastDone?.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bars = lockBars(sl.contGames);
        const big = sl.p.bigAt ?? null;
        const seq = sl.contGames.map((g, k) => ({ who: g.who || sl.pid, d: g.date, bar: bars[k] == null ? null : big != null ? Math.min(bars[k], big) : bars[k] }));
        let pv = 0;
        for (const [i, g] of seq.entries()) {
          const fp = actualOf(g.who, g.d);
          if (i === seq.length - 1 || (g.bar !== null && fp >= g.bar)) { pv = fp; break; }
        }
        const lock = sl.call.verdict === "LOCK";
        calls.push({ w, rid: t.rosterId, team: t.name, player: sl.p.name, v: sl.call.verdict, score: sl.score, pv, gain: lock ? sl.score - pv : pv - sl.score, pct: sl.p.pct(sl.score) });
      }
    }
  }
}
if (process.env.VERBOSE) console.error(Object.values(lineupNote).join("; "));
const sum = (cs) => cs.reduce((t, c) => t + c.gain, 0);
const got = (cs) => cs.reduce((t, c) => t + (c.v === "LOCK" ? c.score : c.pv), 0);
const line = (label, cs) => cs.length ? `${label.padEnd(30)} ${String(cs.length).padStart(4)} calls  right ${String(cs.filter((c) => c.gain >= 0).length).padStart(4)} (${(100 * cs.filter((c) => c.gain >= 0).length / cs.length).toFixed(0)}%)  net ${sum(cs) >= 0 ? "+" : ""}${sum(cs).toFixed(0)}  points if followed ${got(cs).toFixed(0)}` : `${label.padEnd(30)} none`;
console.log(line("all", calls));
console.log(line("  LOCK", calls.filter((c) => c.v === "LOCK")));
console.log(line("  PASS", calls.filter((c) => c.v === "PASS")));
console.log(line("  PASS on his top-20% game", calls.filter((c) => c.v === "PASS" && c.pct >= 0.8)));
console.log(line("  LOCK on his bottom-half game", calls.filter((c) => c.v === "LOCK" && c.pct < 0.5)));
console.log(line("  your team", calls.filter((c) => c.rid === 7)));
for (const w of [...new Set(calls.map((c) => c.w))]) console.log(line(`  ${w}`, calls.filter((c) => c.w === w)));
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(calls));
