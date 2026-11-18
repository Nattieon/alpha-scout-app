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
for (const w of ["w01", "w02", "w03", "w04"]) {
  const f = path.join(L, w, "backtest.json.gz");
  if (!fs.existsSync(f)) continue;
  const B = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  const pids = [...new Set(B.finalMatchups.flatMap((m) => [...(m.starters || []), ...(m.players || [])]))].filter((p) => p && p !== "0");
  const seen = new Set();
  for (const Dn of B.weekDates.slice(0, -1)) {
    const matchups = B.finalMatchups.map((m) => {
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
          const fp = B.actuals[g.who]?.[g.d] ?? 0;
          if (i === seq.length - 1 || (g.bar !== null && fp >= g.bar)) { pv = fp; break; }
        }
        const lock = sl.call.verdict === "LOCK";
        calls.push({ w, rid: t.rosterId, team: t.name, player: sl.p.name, v: sl.call.verdict, score: sl.score, pv, gain: lock ? sl.score - pv : pv - sl.score, pct: sl.p.pct(sl.score) });
      }
    }
  }
}
const sum = (cs) => cs.reduce((t, c) => t + c.gain, 0);
const got = (cs) => cs.reduce((t, c) => t + (c.v === "LOCK" ? c.score : c.pv), 0);
const line = (label, cs) => cs.length ? `${label.padEnd(30)} ${String(cs.length).padStart(4)} calls  right ${String(cs.filter((c) => c.gain >= 0).length).padStart(4)} (${(100 * cs.filter((c) => c.gain >= 0).length / cs.length).toFixed(0)}%)  net ${sum(cs) >= 0 ? "+" : ""}${sum(cs).toFixed(0)}  points if followed ${got(cs).toFixed(0)}` : `${label.padEnd(30)} none`;
console.log(line("all", calls));
console.log(line("  LOCK", calls.filter((c) => c.v === "LOCK")));
console.log(line("  PASS", calls.filter((c) => c.v === "PASS")));
console.log(line("  PASS on his top-20% game", calls.filter((c) => c.v === "PASS" && c.pct >= 0.8)));
console.log(line("  LOCK on his bottom-half game", calls.filter((c) => c.v === "LOCK" && c.pct < 0.5)));
console.log(line("  your team", calls.filter((c) => c.rid === 7)));
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(calls));
