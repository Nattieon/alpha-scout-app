// Will he play? Per-player sit risk from his own game log.
//
// Inputs are rows for every team game while he was on a roster: {date, team, played}.
// From them we estimate, each pulled toward a league default until he has enough history:
//   normal  - chance he sits an ordinary game (rest, illness, short knock)
//   q       - chance he rests one night of a back-to-back pair
//   s       - when he does, chance it's the second night
//   durability - share of his team's games he missed over the last 82 (injuries included)
//   ramp    - how far into his return from a long absence he is (1 = just back, 0 = done)
// A per-game sit chance then combines independent reasons, and the second night of a pair
// is linked to the first: after he plays night 1 the rest is still to come; after he sits it,
// the rest is used up.

export const AVAIL_DEFAULTS = {
  normalPrior: 0.04, normalWeight: 20,        // league: sits 4% of ordinary games
  pairPrior: 0.19, pairWeight: 8,             // league: rests one night of 19% of back-to-backs
  nightPrior: 0.73, nightWeight: 6,           // ...and 73% of those rests are night 2
  durabilityK: 0.04,                          // missed half of last 82 -> +2% per game
  stretch: 5,                                 // 5+ straight missed games = an injury, not rest
  longStretch: 10, majorStretch: 40,          // a return ramp starts after 10+; longer after 40+
  rampGames: 15, rampGamesMajor: 25,
  rampPair: 0.6, rampOther: 0.03,             // ramp adds rest risk to back-to-backs (and a little elsewhere)
  currentSeasonWeight: 2,
  flaggedPair: 0.95,                          // "sits back-to-backs" checked
  injuryDecay: 0.7,
};

export const INJURY_SIT = {
  probable: 0.10, dtd: 0.30, "day-to-day": 0.30, gtd: 0.35, questionable: 0.45,
  doubtful: 0.80, out: 0.97, ir: 1.0, suspended: 1.0, inactive: 0.97,
};

const DAY = 86400000;
export const shiftDay = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
const combine = (...hs) => 1 - hs.reduce((t, h) => t * (1 - Math.min(Math.max(h || 0, 0), 1)), 1);

/**
 * rows: [{date, team, played}] sorted or not; currentSeasonStart: ISO date (rows on/after it weigh more).
 * Returns the player's availability profile.
 */
export function availabilityProfile(rows, currentSeasonStart, cfg = {}) {
  const c = { ...AVAIL_DEFAULTS, ...cfg };
  const r = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const n = r.length;
  const w = (row) => (row.date >= currentSeasonStart ? c.currentSeasonWeight : 1);

  // Injury stretches: runs of `stretch`+ straight missed team games.
  const inStretch = new Array(n).fill(false);
  const stretches = [];
  for (let i = 0; i < n;) {
    if (r[i].played) { i++; continue; }
    let j = i; while (j < n && !r[j].played) j++;
    if (j - i >= c.stretch) { for (let k = i; k < j; k++) inStretch[k] = true; stretches.push({ start: i, end: j - 1, len: j - i }); }
    i = j;
  }
  // The games right after an injury belong to the return ramp, not to his normal habits.
  const inRamp = new Array(n).fill(false);
  for (const st of stretches) for (let k = st.end + 1; k < Math.min(n, st.end + 1 + c.rampGames); k++) inRamp[k] = true;
  const clean = (i) => !inStretch[i] && !inRamp[i];

  // Back-to-back pairs: consecutive-day games for the same team.
  const idx = new Map(r.map((row, i) => [row.date, i]));
  const pairIdx = new Set();
  let pairs = 0, n1 = 0, n2 = 0, both = 0;
  for (let i = 0; i < n; i++) {
    const j = idx.get(shiftDay(r[i].date, 1));
    if (j === undefined || r[j].team !== r[i].team) continue;
    pairIdx.add(i); pairIdx.add(j);
    if (!clean(i) || !clean(j)) continue;
    const wt = Math.max(w(r[i]), w(r[j]));
    pairs += wt;
    if (!r[i].played && !r[j].played) both += wt;
    else if (!r[i].played) n1 += wt;
    else if (!r[j].played) n2 += wt;
  }
  // Ordinary games: clean and not part of any back-to-back.
  let games = 0, sat = 0;
  for (let i = 0; i < n; i++) {
    if (!clean(i) || pairIdx.has(i)) continue;
    games += w(r[i]); if (!r[i].played) sat += w(r[i]);
  }
  const normal = (sat + c.normalWeight * c.normalPrior) / (games + c.normalWeight);
  const q = (n1 + n2 + c.pairWeight * c.pairPrior) / (pairs + c.pairWeight);
  const s = (n2 + c.nightWeight * c.nightPrior) / (n1 + n2 + c.nightWeight);

  const last82 = r.slice(-82);
  const durability = last82.length >= 20 ? last82.filter((x) => !x.played).length / last82.length : 0;

  // Return ramp: the latest long absence that he has come back from.
  let ramp = 0, gamesBack = null, absence = null;
  const lastLong = [...stretches].reverse().find((st) => st.len >= c.longStretch);
  if (lastLong && lastLong.end < n - 1) {
    const after = r.slice(lastLong.end + 1);
    gamesBack = after.filter((x) => x.played).length;
    if (gamesBack > 0) {
      const G = lastLong.len >= c.majorStretch ? c.rampGamesMajor : c.rampGames;
      ramp = Math.max(0, 1 - gamesBack / G);
      // each back-to-back he has played both nights of since returning halves what's left
      let b2bPlayed = 0;
      for (let k = lastLong.end + 1; k < n; k++) {
        const j = idx.get(shiftDay(r[k].date, 1));
        if (j !== undefined && r[k].played && r[j].played) b2bPlayed++;
      }
      ramp *= 0.5 ** b2bPlayed;
      absence = lastLong.len;
    }
  }
  return { normal, q, s, durability, ramp, gamesBack, absence, history: { games, sat, pairs, n1, n2, both, rows: n } };
}

/**
 * Sit chances for his remaining games this week.
 *  dates:       remaining game dates, in order
 *  teamDates:   Set of every game date for his team (beyond this week too, for Sun-Mon pairs)
 *  prevPlayed:  for the day before dates[0], true/false if he had a game and we know, else undefined
 *  extra[i]:    other per-game risk already known (injury tag, projected to sit), 0..1
 *  flagged:     viewer marked him as sitting back-to-backs
 * Returns [{p, pIfPrevPlayed?, pIfPrevSat?, why: [...]}] ready for the lock math.
 */
export function gameSitRisks(profile, dates, teamDates, { prevPlayed, extra = [], flagged = false, injury = null, offset = 0, cfg = {} } = {}) {
  const c = { ...AVAIL_DEFAULTS, ...cfg };
  const pr = profile || { normal: c.normalPrior, q: c.pairPrior, s: c.nightPrior, durability: 0, ramp: 0 };
  const qBase = flagged ? c.flaggedPair : pr.q;
  const q = combine(qBase, c.rampPair * pr.ramp);
  const s = pr.s;
  const injP = INJURY_SIT[String(injury || "").trim().toLowerCase()] || 0;
  return dates.map((d, i) => {
    const isN1 = teamDates.has(shiftDay(d, 1));
    const isN2 = teamDates.has(shiftDay(d, -1));
    const injury_i = injP * c.injuryDecay ** (i + offset);
    const other = combine(pr.normal, c.durabilityK * pr.durability, c.rampOther * pr.ramp, injury_i, extra[i] || 0);
    const r1 = isN1 ? q * (1 - s) : 0;
    const r2played = isN2 ? (q * s) / Math.max(1 - q * (1 - s), 1e-9) : 0;
    const why = [];
    if (isN1 || isN2) why.push(flagged ? "you marked him as resting back-to-backs" : pr.q > c.pairPrior + 0.08 ? "often rests back-to-backs" : "back-to-back");
    if (pr.ramp > 0.05) why.push(`back from a ${pr.absence}-game absence (${pr.gamesBack} games back)`);
    if (injury_i > 0.01) why.push(`listed ${injury}`);
    if ((extra[i] || 0) >= 0.5) why.push("projected to sit");
    const g = { why, b2b: isN2 ? 2 : isN1 ? 1 : 0 };
    if (!isN2) { g.p = combine(other, r1); return g; }
    const ifPlayed = combine(other, r1, r2played);
    const ifSat = combine(other, r1);                // rest already used on night 1
    const prevInList = i > 0 && dates[i - 1] === shiftDay(d, -1);
    if (prevInList) {
      g.pIfPrevPlayed = ifPlayed; g.pIfPrevSat = ifSat;
      // unconditional, for display: P(he sits) before knowing night 1
      g.p = combine(other, r1, q * s);
    } else if (prevPlayed === true) g.p = ifPlayed;
    else if (prevPlayed === false) g.p = ifSat;
    else g.p = combine(other, r1, q * s);
    return g;
  });
}
