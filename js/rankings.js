// Player rankings: every NBA player, this season only, scored with the league's own settings.
// Default order: fantasy points per game (completed games only), with a minimum games played so a
// two-game hot streak doesn't top the list. Tier lines at 10/30/50/70/90/120/150.
//
// Data: Sleeper's weekly stats (~1.5 MB a week). A finished week is downloaded once per device and kept
// as a small summary (each player's games: date, points in this league's scoring, minutes). The current
// week is re-fetched on every refresh.
import * as S from "./sleeper.js?v=__V__";
import { dow, fantasyPoints } from "./model.js?v=__V__";

const TIERS = [10, 30, 50, 70, 90, 120, 150];
const r2 = (x) => Math.round(x * 100) / 100;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : (Math.round(x * 10) / 10).toFixed(1));
const shiftDay = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

/** Short stable hash of the scoring settings (cached summaries are per scoring). */
function scoringKey(scoring) {
  const s = JSON.stringify(Object.keys(scoring || {}).sort().map((k) => [k, scoring[k]]));
  let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const cacheGet = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private mode: just re-fetch next time */ } };

/** One week as {games: {pid: [[date, fp, min], ...]}, meta: {pid: [name, team, positions]}}. Completed games only. */
async function weekSummary(season, week, scoring, { complete, final, fresh }) {
  const key = `as.rk1.${season}.w${week}.${scoringKey(scoring)}`;
  if (final) { const c = cacheGet(key); if (c) return c; }
  const rows = await S.weekStats(season, week, fresh);
  const games = {}, meta = {};
  for (const r of rows || []) {
    const st = r.stats || {};
    const min = st.min ?? (st.sp ? st.sp / 60 : 0);
    if (!(min > 0) || (complete && r.game_id && !complete.has(r.game_id))) continue;
    (games[r.player_id] ||= []).push([r.date, r2(fantasyPoints(st, scoring) || 0), Math.round(min * 10) / 10]);
    const p = r.player || {};
    meta[r.player_id] = [`${p.first_name || ""} ${p.last_name || ""}`.trim() || r.player_id, p.team || r.team || "FA", p.fantasy_positions || []];
  }
  const out = { games, meta };
  if (final) cacheSet(key, out);
  return out;
}

let cache = null;   // {key, at, players, today, teamGames}
/**
 * Everyone's games this season. Re-used for 5 minutes unless `fresh`.
 * Returns {players: [{pid, name, team, pos, games: [[date, fp, min]]}], today, teamGames, at}
 */
export async function seasonPlayers(scoring, { fresh = false } = {}) {
  const key = scoringKey(scoring);
  if (cache && cache.key === key && !fresh && Date.now() - cache.at < 5 * 60e3) return cache;
  const st = await S.state();
  const season = st.league_season, current = st.week || st.display_week || 1;
  const schedule = await S.schedule(season, fresh);
  const complete = new Set(schedule.filter((g) => g.status === "complete").map((g) => g.game_id));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const weekEnd = {};
  for (const g of schedule) weekEnd[g.week] = !weekEnd[g.week] || g.date > weekEnd[g.week] ? g.date : weekEnd[g.week];
  const weeks = []; for (let w = 1; w <= current; w++) weeks.push(w);
  // a week is final (cacheable) 3 days after its last game, to let stat corrections land
  const sums = await Promise.all(weeks.map((w) => weekSummary(season, w, scoring,
    { complete, final: w < current && weekEnd[w] && shiftDay(weekEnd[w], 3) < today, fresh: fresh || w >= current - 1 })));
  const by = new Map();
  // Sleeper's stats include each NBA team's totals as a "player" (position TEAM): not players, leave out
  const isTeam = (pid, meta) => !/^\d+$/.test(pid) || (meta?.[2] || []).includes("TEAM");
  for (const s of sums) {
    for (const [pid, gs] of Object.entries(s.games)) {
      if (isTeam(pid, s.meta[pid])) continue;
      const p = by.get(pid) || { pid, games: [] };
      p.games.push(...gs);
      const [name, team, pos] = s.meta[pid];
      Object.assign(p, { name, team, pos });     // later weeks win (trades, position changes)
      by.set(pid, p);
    }
  }
  const players = [...by.values()];
  for (const p of players) p.games.sort((a, b) => a[0].localeCompare(b[0]));
  // games each team has played: the basis for the automatic minimum
  const tg = {};
  for (const g of schedule) if (g.status === "complete") for (const t of [g.home?.team, g.away?.team]) tg[t] = (tg[t] || 0) + 1;
  const counts = Object.values(tg).sort((a, b) => a - b);
  cache = { key, at: Date.now(), players, today, season, teamGames: counts[Math.floor(counts.length / 2)] || 0 };
  return cache;
}

/** Automatic minimum games: 40% of a typical team's games so far (at least 1). */
export const autoMinGames = (teamGames) => Math.max(1, Math.floor(teamGames * 0.4));

// ------------------------------------------------------------------ Lock-In value
// In Lock-In you keep (roughly) your best game of the week, so a spiky player is worth more than his average.
// Lock-In value = FP/G x spike factor. The spike factor is what the lock math expects you to keep in a 3-4 game
// week, as a multiple of his average: V1 = average, Vk = average of max(game, V(k-1)), factor = (V3 + V4) / 2,
// worked out on his games divided by his average. Few games say little, so his games are blended with the
// league's typical spread (every game of every player with 8+ games, as game / his average), weighted
// n : 10 (5 games = one third his own, 20 games = two thirds).
export const LOCK_PRIOR = 10, LOCK_POOL_MIN = 8;

/** The league's typical spread: sorted game/average ratios with prefix sums, so E[max(x, v)] is a quick lookup. */
export function lockPool(gameLists) {
  const xs = [];
  for (const fps of gameLists) {
    if (fps.length < LOCK_POOL_MIN) continue;
    const mu = fps.reduce((a, b) => a + b, 0) / fps.length;
    if (mu > 0) for (const x of fps) xs.push(x / mu);
  }
  xs.sort((a, b) => a - b);
  const pre = [0]; for (const x of xs) pre.push(pre[pre.length - 1] + x);
  // average over the pool of max(x, v)
  const maxAvg = (v) => {
    if (!xs.length) return Math.max(1, v);
    let lo = 0, hi = xs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m + 1; else hi = m; }
    return (lo * v + pre[xs.length] - pre[lo]) / xs.length;
  };
  const pool = { size: xs.length, maxAvg };
  pool.typical = spikeFactor([], pool);
  return pool;
}

/** A player's spike factor from his game scores and the league pool. */
export function spikeFactor(fps, pool) {
  const n = fps.length, mu = n ? fps.reduce((a, b) => a + b, 0) / n : 0;
  if (n && !(mu > 0)) return pool.typical ?? 1;
  const own = n ? fps.map((x) => x / mu) : [];
  const wOwn = n / (n + LOCK_PRIOR), wPool = 1 - wOwn;
  const step = (v) => (n ? wOwn * own.reduce((a, x) => a + Math.max(x, v), 0) / n : 0) + wPool * pool.maxAvg(v);
  let v = 1;                     // V1: both halves average exactly 1 (each game is divided by its player's average)
  const vs = [v];
  for (let k = 2; k <= 4; k++) { v = step(v); vs.push(v); }
  return (vs[2] + vs[3]) / 2;
}

/**
 * Rank players. by: "pg" (points per game) | "total" | "lock" (Lock-In value). asOf: only games on or before that date.
 * Every row also carries spike (the spike factor) and lock (Lock-In value).
 * Returns the ranked list (rank 1 = best) and how many were left out by the minimum.
 */
export function rankPlayers(players, { by = "pg", minGames = 1, asOf = null } = {}) {
  let hidden = 0;
  const list = [];
  const gamesOf = new Map(players.map((p) => [p, asOf ? p.games.filter((g) => g[0] <= asOf) : p.games]));
  const pool = lockPool([...gamesOf.values()].map((gs) => gs.map((g) => g[1])));
  for (const p of players) {
    const gs = gamesOf.get(p);
    if (!gs.length) continue;
    const total = gs.reduce((t, g) => t + g[1], 0);
    const row = { ...p, gp: gs.length, total, pg: total / gs.length, min: gs.reduce((t, g) => t + g[2], 0) / gs.length,
      last5: gs.slice(-5).reduce((t, g) => t + g[1], 0) / Math.min(5, gs.length) };
    if (row.gp < minGames) { hidden++; continue; }
    row.spike = spikeFactor(gs.map((g) => g[1]), pool);
    row.lock = row.pg * row.spike;
    list.push(row);
  }
  const key = by === "total" ? (r) => r.total : by === "lock" ? (r) => r.lock : (r) => r.pg;
  list.sort((a, b) => key(b) - key(a) || b.total - a.total);
  list.forEach((r, i) => (r.rank = i + 1));
  return { list, hidden, typicalSpike: pool.typical };
}

/** {pid: rank} with the default settings, for badges elsewhere in the app. */
export function rankMap(data) {
  const { list } = rankPlayers(data.players, { minGames: autoMinGames(data.teamGames) });
  return Object.fromEntries(list.map((r) => [r.pid, r.rank]));
}

// ------------------------------------------------------------------ the view
let V = null;   // {el, scoring, owners, myRosterId, onClose, by, min, pos, own, q, timer}
const tierOf = (rank) => TIERS.find((t) => rank <= t) || null;

/**
 * owners: {pid: {rosterId, team}} from the open league. myRosterId: whose players are "mine".
 */
export async function openRankings(el, { scoring, owners, myRosterId, leagueName, onClose }) {
  const prev = V || {};
  clearInterval(prev.timer);
  V = { el, scoring, owners, myRosterId, leagueName, onClose,
    by: prev.by || "pg", min: prev.min ?? "auto", pos: prev.pos || "", own: prev.own || "", q: prev.q || "", limit: prev.limit || 150 };
  el.innerHTML = `<div class="h-head"><h2>Player rankings</h2><button class="chip" id="rk-close">Back</button></div><div class="skeleton"></div>`;
  el.querySelector("#rk-close").onclick = closeRankings;
  try {
    V.data = await seasonPlayers(scoring);
  } catch (e) {
    el.innerHTML = `<div class="h-head"><h2>Player rankings</h2><button class="chip" id="rk-close">Back</button></div><p class="err">${esc(e.message)}</p>`;
    el.querySelector("#rk-close").onclick = closeRankings;
    return;
  }
  draw(true);
  // keep it current while it's open (Sleeper refreshes its stats about every 5 minutes)
  V.timer = setInterval(async () => {
    if (document.visibilityState !== "visible" || !V || V.el.hidden) return;
    try { V.data = await seasonPlayers(V.scoring, { fresh: true }); draw(false); } catch { /* keep the last good list */ }
  }, 5 * 60e3);
}
export function closeRankings() { if (V) { clearInterval(V.timer); V.onClose?.(); } }

function draw(first) {
  const { el, data } = V;
  const minGames = V.min === "auto" ? autoMinGames(data.teamGames) : Number(V.min);
  const { list, hidden, typicalSpike } = rankPlayers(data.players, { by: V.by, minGames });
  // a week ago, same rules, for the movement arrows
  const ago = shiftDay(data.today, -7);
  const before = rankPlayers(data.players, { by: V.by, minGames: V.min === "auto" ? autoMinGames(Math.max(0, data.teamGames - 3)) : Number(V.min), asOf: ago });
  const rankAgo = Object.fromEntries(before.list.map((r) => [r.pid, r.rank]));
  const q = V.q.trim().toLowerCase();
  const own = (r) => V.owners[r.pid];
  const shown = list.filter((r) => (!V.pos || r.pos.includes(V.pos))
    && (!V.own || (V.own === "fa" ? !own(r) : V.own === "mine" ? own(r)?.rosterId === V.myRosterId : V.own === "rostered" ? !!own(r) : String(own(r)?.rosterId) === V.own))
    && (!q || r.name.toLowerCase().includes(q)));
  const filtered = !!(V.pos || V.own || q);
  const limit = filtered ? shown.length : V.limit;
  const main = (r) => (V.by === "total" ? r.total : V.by === "lock" ? r.lock : r.pg);
  const side = (r) => (V.by === "pg" ? r.total : r.pg);
  const [mainH, sideH] = V.by === "total" ? ["Total", "FP/G"] : V.by === "lock" ? ["Lock-In", "FP/G"] : ["FP/G", "Total"];
  let lastTier = null;
  const rows = [];
  for (const r of shown.slice(0, limit)) {
    const t = tierOf(r.rank);
    if (!filtered && t !== lastTier && lastTier !== null) rows.push(`<tr class="rk-tier"><td colspan="7">Top ${lastTier} ↑ · Top ${t || "150+"} ↓</td></tr>`);
    lastTier = t;
    const was = rankAgo[r.pid];
    const move = was === undefined ? `<span class="muted">new</span>` : was === r.rank ? `<span class="muted">–</span>`
      : was > r.rank ? `<span class="up">▲${was - r.rank}</span>` : `<span class="down">▼${r.rank - was}</span>`;
    const o = own(r);
    rows.push(`<tr class="${o?.rosterId === V.myRosterId ? "mine" : ""}${!o ? " fa" : ""}">
      <td class="num rk">${r.rank}${t ? `<small>top ${t}</small>` : ""}</td>
      <td><b>${esc(r.name)}</b><div class="pmeta">${esc(r.team)} · ${esc(r.pos.join("/"))}</div></td>
      <td class="num"><b>${f1(main(r))}</b>${V.by === "lock" ? `<small class="spk">×${r.spike.toFixed(2)}</small>` : ""}</td>
      <td class="num">${r.gp}</td>
      <td class="num hide-s">${f1(side(r))}</td>
      <td class="own">${o ? esc(o.team) : '<span class="fa-tag">Free agent</span>'}</td>
      <td class="num mv">${move}</td></tr>`);
  }
  const teams = [...new Map(Object.values(V.owners).map((o) => [o.rosterId, o.team])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const sel = (id, v, opts) => `<select id="${id}">${opts.map(([val, label]) => `<option value="${esc(val)}"${String(v) === String(val) ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  const updated = new Date(data.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const html = `
    <div class="h-head"><h2>Player rankings</h2><button class="chip" id="rk-close">Back</button></div>
    <p class="muted rk-sub">${esc(data.season)} season only, completed games, ${esc(V.leagueName)} scoring. Updated ${esc(updated)} · refreshes every 5 min.
      <button class="linkish" id="rk-refresh">Refresh now</button></p>
    <div class="rk-controls">
      <label class="f">Search<input id="rk-q" type="search" value="${esc(V.q)}" placeholder="Player name" autocomplete="off"></label>
      <label class="f">Position ${sel("rk-pos", V.pos, [["", "All"], ["PG", "PG"], ["SG", "SG"], ["SF", "SF"], ["PF", "PF"], ["C", "C"]])}</label>
      <label class="f">Owner ${sel("rk-own", V.own, [["", "Everyone"], ["fa", "Free agents"], ["mine", "My team"], ["rostered", "Rostered"], ...teams.map(([id, n]) => [String(id), n])])}</label>
      <label class="f">Rank by ${sel("rk-by", V.by, [["pg", "Points per game"], ["lock", "Lock-In value"], ["total", "Season total"]])}</label>
      <label class="f">Min games ${sel("rk-min", V.min, [["auto", `Auto (${autoMinGames(data.teamGames)})`], ["1", "1"], ["3", "3"], ["5", "5"], ["8", "8"], ["10", "10"]])}</label>
    </div>
    <p class="muted rk-sub">${list.length} players ranked${hidden ? ` · ${hidden} with fewer than ${minGames} game${minGames === 1 ? "" : "s"} left out` : ""}${filtered ? ` · showing ${shown.length} that match, with their overall rank` : ""}. ▲▼ = change since ${dow(ago)} ${ago.slice(5).replace("-", "/")}.</p>
    ${V.by === "lock" ? `<p class="rk-note">Lock-In value = the score you'd expect to keep in a 3–4 game week, not his average game. It's FP/G × his spike factor (the small ×). Spiky players rise, steady ones drop. A typical player is ×${typicalSpike.toFixed(2)}; players with few games are pulled toward that.</p>` : ""}
    <div class="rk-wrap"><table class="rk-table">
      <thead><tr><th>#</th><th>Player</th><th class="num">${mainH}</th><th class="num">GP</th><th class="num hide-s">${sideH}</th><th>Owner</th><th class="num">7d</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="7" class="muted">No players match.</td></tr>`}</tbody></table></div>
    ${!filtered && shown.length > limit ? `<button class="btn ghost" id="rk-more">Show ${Math.min(100, shown.length - limit)} more</button>` : ""}`;
  // keep focus and caret in the search box while typing
  const focused = document.activeElement?.id === "rk-q", caret = focused ? document.activeElement.selectionStart : 0;
  el.innerHTML = html;
  if (focused) { const i = el.querySelector("#rk-q"); i.focus(); i.setSelectionRange(caret, caret); }
  el.querySelector("#rk-close").onclick = closeRankings;
  el.querySelector("#rk-refresh").onclick = async (e) => { e.target.textContent = "Refreshing…"; try { V.data = await seasonPlayers(V.scoring, { fresh: true }); } catch { /* keep */ } draw(false); };
  el.querySelector("#rk-q").oninput = (e) => { V.q = e.target.value; draw(false); };
  for (const [id, k] of [["rk-pos", "pos"], ["rk-own", "own"], ["rk-by", "by"], ["rk-min", "min"]]) el.querySelector(`#${id}`).onchange = (e) => { V[k] = e.target.value; draw(false); };
  const more = el.querySelector("#rk-more");
  if (more) more.onclick = () => { V.limit += 100; draw(false); };
  if (first) window.scrollTo(0, 0);
}
