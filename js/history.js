// History: what the app showed at any saved moment (nightly snapshots, mid-day changes, replayed
// weeks), every lock-or-pass decision with what the team actually did, and how it ended.
import { dow } from "./model.js?v=__V__";
import { LAB } from "./lab.js?v=__V__";

const DATA = "https://raw.githubusercontent.com/Nattieon/alpha-scout-app/data/";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : (Math.round(x * 10) / 10).toFixed(1));
const pct = (x) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);
const ord = (q) => { const n = Math.min(99, Math.max(1, Math.round(q * 100))); const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const bust = () => `?t=${Math.floor(Date.now() / 120000)}`;   // GitHub's raw files are cached ~5 min
const cache = new Map();
async function get(file) {
  if (cache.has(file)) return cache.get(file);
  const p = fetch(DATA + file + bust()).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  cache.set(file, p);
  return p;
}

let H = null;   // {el, leagueId, season, mine, week, matchupKey, sideRid, at, onClose}

export async function openHistory(el, { leagueId, mineRosterId, preferRosterId, onClose }) {
  cache.clear();
  H = { el, leagueId, mine: mineRosterId, side: preferRosterId ?? mineRosterId, onClose };
  el.innerHTML = '<div class="skeleton"></div>';
  const idx = await get("index.json");
  const L = idx?.leagues?.[leagueId];
  if (!L) { el.innerHTML = header() + `<p class="empty-note">No snapshots for this league yet. The scheduled job saves one every night (about 4:30am ET) and checks lineups every 30 minutes on game days.</p>`; bind(); return; }
  H.L = L;
  H.season = Object.keys(L.seasons).sort().at(-1);
  const W = L.seasons[H.season].weeks;
  const has = (w) => ["nightly", "ticks", "replay"].some((k) => W[w]?.[k]?.length);
  const weeks = Object.keys(W).map(Number).sort((a, b) => a - b);
  H.week = [...weeks].reverse().find(has) ?? weeks.at(-1);
  await draw();
}

function header() {
  return `<div class="h-head"><h2>History</h2><button class="chip" id="h-close">Back to live</button></div>`;
}
function bind() { const b = H.el.querySelector("#h-close"); if (b) b.onclick = () => H.onClose(); }

/** Every saved moment for a week, oldest first: {file, at, label, kind}. */
function moments(W, dir) {
  const out = [];
  for (const d of W.replay || []) out.push({ file: `${dir}${LAB ? "/lab" : ""}/replay/${d}.json`, at: `${shiftDay(d, 1)}T04:30`, kind: "replay", label: `After ${dow(d)}`, night: d });
  for (const d of W.nightly || []) out.push({ file: `${dir}/nightly/${d}.json`, at: `${d}T04:30`, kind: "nightly", label: `After ${dow(shiftDay(d, -1))}`, night: shiftDay(d, -1) });
  for (const s of W.ticks || []) { const at = `${s.slice(0, 13)}:${s.slice(13)}`; out.push({ file: `${dir}/ticks/${s}.json`, at, kind: "tick", label: `${dow(s.slice(0, 10))} ${clock(s.slice(11))} ET` }); }
  // a nightly and a replay of the same night: keep the real one
  const nights = new Set(out.filter((m) => m.kind === "nightly").map((m) => m.night));
  return out.filter((m) => !(m.kind === "replay" && nights.has(m.night))).sort((a, b) => a.at.localeCompare(b.at));
}
const shiftDay = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const clock = (hhmm) => { const h = +hhmm.slice(0, 2), m = hhmm.slice(2); return `${((h + 11) % 12) + 1}:${m}${h < 12 ? "am" : "pm"}`; };

async function draw() {
  const { el, L, season } = H;
  const weeks = Object.keys(L.seasons[season].weeks).map(Number).sort((a, b) => a - b);
  const W = L.seasons[season].weeks[H.week];
  const dir = `leagues/${H.leagueId}/${season}/w${String(H.week).padStart(2, "0")}`;
  const ms = moments(W, dir);
  if (!ms.length) { el.innerHTML = header() + `<p class="empty-note">Nothing saved for week ${H.week} yet.</p>`; bind(); return; }
  const [snaps, final, events] = await Promise.all([Promise.all(ms.map((m) => get(m.file))), W.final ? (LAB ? get(`${dir}/lab/final.json`).then((f) => f || get(`${dir}/final.json`)) : get(`${dir}/final.json`)) : null, get(`${dir}/events.json`)]);
  ms.forEach((m, i) => { m.snap = snaps[i]; if (m.snap?.at && m.kind !== "replay") m.at = m.snap.at; });
  const ok = ms.filter((m) => m.snap).sort((a, b) => a.at.localeCompare(b.at));
  // which matchup: the one with the preferred team in it, else the first
  const pairs = ok[ok.length - 1].snap.matchups;
  const hasSide = (mu, rid) => mu.teams.some((t) => t.rosterId === rid);
  if (!pairs.some((mu) => hasSide(mu, H.side))) H.side = pairs[0].teams[0].rosterId;
  const pairOf = (snap) => snap.matchups.find((mu) => hasSide(mu, H.side));
  const sideOf = (mu) => mu.teams.find((t) => t.rosterId === H.side);
  const otherOf = (mu) => mu.teams.find((t) => t.rosterId !== H.side);
  const winOf = (mu) => (mu.teams[0].rosterId === H.side ? mu.win : 1 - mu.win);
  if (!H.at || !ok.some((m) => m.at === H.at)) H.at = ok.at(-1).at;
  const cur = ok.find((m) => m.at === H.at);
  const mu = pairOf(cur.snap);
  const me = sideOf(mu), them = otherOf(mu);

  // final result
  let finalLine = "";
  if (final) {
    const fa = final.matchups.find((x) => x.rosterId === me.rosterId), fb = final.matchups.find((x) => x.rosterId === them?.rosterId);
    if (fa && fb) finalLine = `<div class="h-final ${fa.points > fb.points ? "won" : "lost"}">Final: <b>${esc(me.name)} ${f1(fa.points)}</b> – ${f1(fb.points)} ${esc(them.name)} · ${fa.points > fb.points ? "won" : fa.points < fb.points ? "lost" : "tied"}
      ${final.truthHash ? "" : `<div class="muted" style="font-size:12.5px;margin-top:2px">From Sleeper's matchup data, which is unreliable for Lock-In. The official totals arrive once Sleeper updates the standings.</div>`}
      ${[me, them].filter((t) => final.truth?.[t.rosterId] === "ambiguous").map((t) => `<div class="muted" style="font-size:12.5px;margin-top:2px">${esc(t.name)}: the score fits ${final.candidates?.[t.rosterId]?.length || "several"} different sets of locks, so the "what happened" lines for this team may be off. The projected total shown under the score in the Sleeper app settles it.</div>`).join("")}</div>`;
  }
  // win % through the week
  const strip = ok.map((m) => {
    const x = pairOf(m.snap); if (!x) return "";
    return `<button class="h-moment${m.at === H.at ? " on" : ""}" data-at="${esc(m.at)}"><span>${esc(m.label)}</span><b class="num">${pct(winOf(x))}</b>${m.kind === "tick" ? '<i>change</i>' : ""}</button>`;
  }).join("");

  const decisions = mu.teams.flatMap((t) => t.slots.filter((s) => s.call).map((s) => ({ t, s })));
  const decisionHtml = decisions.length ? `<div class="h-dec">${decisions.map(({ t, s }) => decisionCard(t, s, final, t.rosterId === H.side)).join("")}</div>`
    : `<p class="muted">No lock decisions open at this moment.</p>`;
  const swapHtml = mu.teams.map((t) => (t.swaps || []).map((x) => `<li>${esc(t.name)}: <b>${esc(x.inName || x.in)}</b> into ${esc(x.slot)}${x.outName ? ` for ${esc(x.outName)}` : ""}${x.by ? ` by ${dow(x.by)}` : ""}${x.gain ? ` (+${f1(x.gain)})` : ""}</li>`).join("")).join("");
  // events since the previous moment
  const i = ok.indexOf(cur), prevAt = i > 0 ? ok[i - 1].at : "0000";
  const rids = new Set(mu.teams.map((t) => t.rosterId));
  const evs = (events || []).filter((e) => e.at > prevAt && e.at <= cur.at && (e.type !== "lineup" || rids.has(e.rosterId)));
  const evHtml = evs.length ? `<h3>Changes since the previous moment</h3><ul class="h-ev">${evs.map(eventLine).join("")}</ul>` : "";

  const [cal, calLab] = await Promise.all([get("calibration.json"), get("calibration-lab.json")]);
  el.innerHTML = `${header()}
    ${calibrationBox(cal, calLab)}
    <div class="h-controls">
      <label class="f">Week <select id="h-week">${weeks.map((w) => `<option value="${w}"${w === H.week ? " selected" : ""}>Week ${w}</option>`).join("")}</select></label>
      <label class="f">Matchup <select id="h-pair">${pairs.map((x) => `<option value="${x.teams[0].rosterId}"${hasSide(x, H.side) ? " selected" : ""}>${esc(x.teams.map((t) => t.name).join(" vs "))}</option>`).join("")}</select></label>
      <div class="seg" role="radiogroup" aria-label="Which side is you">${mu.teams.map((t) => `<button role="radio" aria-checked="${t.rosterId === H.side}" data-hside="${t.rosterId}">${esc(t.name)}${t.rosterId === H.mine ? ' <span class="tag">your team</span>' : ""}</button>`).join("")}</div>
    </div>
    ${finalLine}
    <div class="h-strip" role="list" aria-label="Saved moments, with your win %">${strip}</div>
    ${cur.snap.caveats ? `<p class="h-note">${esc(cur.snap.caveats.join(" "))}</p>` : ""}
    <div class="board h-board">
      <div class="board-top"><span>${esc(cur.snap.league)} · Week ${cur.snap.week} · ${esc(cur.label)}${cur.kind === "tick" ? "" : " (overnight)"}</span><span>model ${esc(cur.snap.model)} · ${cur.kind}</span></div>
      <div class="teams">
        <div class="team"><div class="who">${esc(me.name)}</div><div class="pts num">${f1(me.points)}</div><div class="proj num">Banked ${f1(me.banked)} · Proj ${f1(me.proj)}</div></div>
        <div class="vs">VS</div>
        <div class="team r"><div class="who">${esc(them?.name)}</div><div class="pts num">${f1(them?.points)}</div><div class="proj num">Banked ${f1(them?.banked)} · Proj ${f1(them?.proj)}</div></div>
      </div>
      <div class="winbar"><div class="lbl"><span><b class="num">${pct(winOf(mu))}</b> to win</span><span class="muted num">${pct(1 - winOf(mu))}</span></div>
        <div class="track"><div class="me" style="width:${(winOf(mu) * 100).toFixed(1)}%"></div></div></div>
    </div>
    ${evHtml}
    <h3>Decisions at this moment</h3>${decisionHtml}
    ${swapHtml ? `<h3>Planned swaps</h3><ul class="h-ev">${swapHtml}</ul>` : ""}`;
  bind();
  el.querySelector("#h-week").onchange = (e) => { H.week = Number(e.target.value); H.at = null; draw(); };
  el.querySelector("#h-pair").onchange = (e) => { H.side = Number(e.target.value); const x = pairs.find((p) => hasSide(p, H.side)); if (x && x.teams.some((t) => t.rosterId === H.mine)) H.side = H.mine; draw(); };
  el.querySelectorAll("[data-hside]").forEach((b) => (b.onclick = () => { H.side = Number(b.dataset.hside); draw(); }));
  el.querySelectorAll("[data-at]").forEach((b) => (b.onclick = () => { H.at = b.dataset.at; draw(); }));
  el.querySelector(".h-moment.on")?.scrollIntoView({ block: "nearest", inline: "center" });
}

/** One decision: the call at that moment, and (once the week is over) what the team actually did. */
function decisionCard(t, s, final, mine) {
  const c = s.call;
  let outcome = "";
  if (final) {
    const fm = final.matchups.find((x) => x.rosterId === t.rosterId);
    const i = fm ? fm.starters.indexOf(s.pid) : -1;
    if (i < 0) outcome = `<span class="muted">Moved out of the lineup later.</span>`;
    else {
      const counted = final.counted?.[`${t.rosterId}:${i}`];
      const end = fm.starters_points[i];
      const locked = counted ? counted === s.decisionGame : Math.abs(end - s.score) < 0.06;
      const agreed = (c.verdict === "LOCK") === locked;
      outcome = locked
        ? `<span class="${agreed ? "ok" : "warn"}">Locked ${f1(s.score)}${agreed ? "" : " (call was pass)"}</span>`
        : `<span class="${agreed ? "ok" : "warn"}">Passed${agreed ? "" : " (call was lock)"} · slot ended at ${f1(end)} ${end > s.score ? `(+${f1(end - s.score)})` : `(${f1(end - s.score)})`}</span>`;
    }
  } else outcome = `<span class="muted">Week still going.</span>`;
  return `<div class="h-card${mine ? " mine" : ""}">
    <div class="h-row"><b>${esc(s.name)}</b><span class="muted">${esc(t.name)} · ${esc(s.slot)}</span><span class="pill ${c.verdict === "LOCK" ? "lock" : "pass"}">${c.verdict}</span></div>
    <div class="h-row num">${dow(s.decisionGame)} ${f1(s.score)}${s.pctScore != null ? ` (${ord(s.pctScore)} pct)` : ""} · bar ${f1(c.bar)}${c.winIfLock != null ? ` · win ${pct(c.winIfLock)} if lock / ${pct(c.winIfPass)} if pass` : ""}</div>
    ${s.games?.length ? `<div class="h-row muted">Left: ${s.games.map((g) => `${dow(g.d)} ${f1(g.mu)}${g.p >= 0.15 ? ` (${pct(g.p)} sit)` : ""}`).join(", ")}${s.passTo ? ` · pass means ${esc(s.passTo.name)} takes the slot` : ""}</div>` : ""}
    <div class="h-row">${outcome}</div></div>`;
}

function eventLine(e) {
  const when = e.at ? `<span class="muted">${dow(e.at.slice(0, 10))} ${clock(e.at.slice(11).replace(":", ""))}</span> ` : "";
  if (e.type === "lineup") {
    const mv = e.moves.map((m) => `${esc(m.slot)}: ${esc(m.outName || "empty")} → ${esc(m.inName || "empty")}`);
    const ad = e.added.map((a) => `added ${esc(a.name)}`), dr = e.dropped.map((d) => `dropped ${esc(d.name)}`);
    return `<li>${when}<b>${esc(e.team)}</b> ${[...mv, ...ad, ...dr].join("; ")}</li>`;
  }
  if (e.type === "injury") return `<li>${when}<b>${esc(e.name)}</b> injury tag ${esc(e.from || "none")} → ${esc(e.to || "none")}</li>`;
  if (e.type === "transaction") return `<li>${when}${esc(e.kind.replace("_", " "))}: ${[...e.adds.map((a) => `${esc(a.to)} added ${esc(a.name)}`), ...e.drops.map((d) => `${esc(d.from)} dropped ${esc(d.name)}`)].join("; ")}</li>`;
  return "";
}

/** League-wide: how well the win % has held up so far (finished weeks, replayed with the current math). */
function calibrationBox(c, lab) {
  if (!c || !c.nights) return "";
  const rows = c.buckets.filter((b) => b.n).map((b) => `<tr><td>${esc(b.range)}</td><td class="num">${b.n}</td><td class="num">${pct(b.predicted)}</td><td class="num">${pct(b.actual)}</td></tr>`).join("");
  const dec = (x) => x?.decisions?.calls ? `${x.decisions.right}/${x.decisions.calls} calls right · ${x.decisions.points >= 0 ? "+" : ""}${f1(x.decisions.points)} pts` : "–";
  const sign = (v) => `${v >= 0 ? "+" : ""}${f1(v)}`;
  // Standard vs lab, on the same finished weeks
  const vs = lab?.nights ? `<table class="h-tab"><thead><tr><th>Formula</th><th>Win % (Brier)</th><th>Lock calls vs the opposite</th></tr></thead><tbody>
      <tr${LAB ? "" : ' class="cur"'}><td>Standard</td><td class="num">${c.brier?.toFixed(3)}</td><td class="num">${dec(c)}</td></tr>
      <tr${LAB ? ' class="cur"' : ""}><td>Lab</td><td class="num">${lab.brier?.toFixed(3)}</td><td class="num">${dec(lab)}</td></tr></tbody></table>
    <p class="muted">Lower Brier is better (a coin flip scores 0.250). "Lock calls" adds up, over every lock-or-pass call, the points from following it minus the points from doing the opposite, using what actually happened (a pass plays on with that formula's own later bars). Difference: ${sign((lab.decisions?.points ?? 0) - (c.decisions?.points ?? 0))} pts for the lab.</p>` : "";
  const mine = LAB && lab?.nights ? lab : c;
  const callRows = (mine.decisions?.best || []).concat(mine.decisions?.worst || []).map((x) => `<tr><td>${esc(x.player)}</td><td>${esc(x.team)}</td><td>${dow(x.game)} ${f1(x.score)}</td><td>${esc(x.verdict)}</td><td class="num">${sign(x.gain)}</td></tr>`).join("");
  return `<details class="h-cal"><summary>How the formula has held up · ${c.matchups} matchup${c.matchups === 1 ? "" : "s"}, ${c.weeks} week${c.weeks === 1 ? "" : "s"} · Brier ${(LAB && lab?.nights ? lab : c).brier?.toFixed(3)} · ${dec(mine)}</summary>
    ${vs}
    <p class="muted">Win %: every night of every finished week, replayed with the ${LAB ? "lab" : "current"} math, against how the matchup ended. The favourite's predicted chance vs how often favourites actually won:</p>
    <table class="h-tab"><thead><tr><th>Favourite at</th><th>Nights</th><th>Predicted</th><th>Won</th></tr></thead><tbody>${(LAB && lab?.nights ? lab : c).buckets.filter((b) => b.n).map((b) => `<tr><td>${esc(b.range)}</td><td class="num">${b.n}</td><td class="num">${pct(b.predicted)}</td><td class="num">${pct(b.actual)}</td></tr>`).join("") || rows}</tbody></table>
    ${callRows ? `<p class="muted">Best and worst lock calls (following the call vs the opposite):</p>
    <table class="h-tab"><thead><tr><th>Player</th><th>Team</th><th>Game</th><th>Call</th><th>Gain</th></tr></thead><tbody>${callRows}</tbody></table>` : ""}
    <p class="muted">${esc(c.note)}</p></details>`;
}
