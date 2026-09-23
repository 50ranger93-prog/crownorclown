/**
 * Live numbers for a card.
 *
 *   /api/cards/stats?board=Board%201&team=TumbleWEED%20Tactics
 *
 * A card rendered to a PNG is frozen the moment it is made — week 2's record sits
 * on it for the rest of the season. This is the other half of the fix: everything
 * on a card that changes gets read from ESPN at the moment somebody looks at it.
 *
 * One request to ESPN, not eighteen. The matchup view carries the whole schedule
 * with every completed matchup's points, so the best week, the worst week and the
 * count of crowns and vests all come out of a single fetch.
 *
 * The serial is computed the same way cards/index.html computes it — board index
 * times twelve plus the team's alphabetical slot — so a card never has to ask
 * anyone to type one, and two cards can never claim the same number.
 */

const LEAGUES = { "Board 1": "951407474", "Board 2": "1963204215", "Board 3": "976183547" };
const BN = Object.keys(LEAGUES);
const SEASON = Number(process.env.SEASON) || 2026;
const UA = { accept: "application/json", "user-agent": "Mozilla/5.0 CrownOrClownBot" };

const teamName = (t) => (t.name || `${t.location || ""} ${t.nickname || ""}`).trim() || `Team ${t.id}`;
const one = (n) => Math.round(Number(n) * 10) / 10;

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const board = String(q.get("board") || "");
  const want = String(q.get("team") || "").trim().toLowerCase();

  if (!LEAGUES[board]) {
    return json({ error: "Unknown board.", boards: BN }, 400);
  }
  if (!want) return json({ error: "No team given." }, 400);

  let data;
  try {
    const r = await fetch(
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUES[board]}?view=mTeam&view=mMatchupScore`,
      { headers: UA, signal: AbortSignal.timeout(15000) }
    );
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    data = await r.json();
  } catch (e) {
    // A card that cannot reach ESPN shows what it already knows rather than an
    // error page — the caller decides, so say plainly that this is stale.
    return json({ error: "Could not reach ESPN.", detail: String(e.message || e) }, 502);
  }

  const out = derive(data, board, want);
  return json(out, out.error ? 404 : 200);
}

/** Pure: an ESPN league payload in, a card's numbers out. */
export function derive(data, board, want) {
  const BNi = BN.indexOf(board);
  const teams = (data.teams || []).map(t => {
    const o = (t.record && t.record.overall) || {};
    return {
      id: t.id,
      name: teamName(t),
      logo: t.logo || "",
      wins: o.wins | 0, losses: o.losses | 0, ties: o.ties | 0,
      pointsFor: one(o.pointsFor || 0),
      pointsAgainst: one(o.pointsAgainst || 0),
    };
  });

  const me = teams.find(t => t.name.trim().toLowerCase() === String(want).trim().toLowerCase());
  if (!me) return { error: "No such team on that board.", teams: teams.map(t => t.name) };

  // Alphabetical, which is the order the builder lists them in — the slot has to
  // be stable or the serial moves when ESPN reorders its response.
  const alpha = teams.slice().sort((a, z) => a.name.toLowerCase().localeCompare(z.name.toLowerCase()));
  const slot = alpha.findIndex(t => t.id === me.id);
  const serial = `${String(BNi * 12 + slot + 1).padStart(3, "0")} / 36`;

  // Standing: wins first, then points scored, the way the league actually breaks it.
  const ranked = teams.slice().sort((a, z) => z.wins - a.wins || z.pointsFor - a.pointsFor);
  const standing = ranked.findIndex(t => t.id === me.id) + 1;

  // Walk the schedule once. Every completed matchup period gives a full set of
  // scores, which is everything needed for best week, worst week and the crowns.
  const byWeek = new Map();
  for (const m of data.schedule || []) {
    const wk = m.matchupPeriodId;
    if (!wk) continue;
    for (const side of ["home", "away"]) {
      const s = m[side];
      if (!s || s.totalPoints == null) continue;
      if (!byWeek.has(wk)) byWeek.set(wk, []);
      byWeek.get(wk).push({ id: s.teamId, pts: Number(s.totalPoints) });
    }
  }

  let best = null, worst = null, crowns = 0, clowns = 0, played = 0;
  for (const [wk, scores] of [...byWeek.entries()].sort((a, z) => a[0] - z[0])) {
    // A week nobody has played yet is a row of zeroes, not a week anyone lost.
    if (scores.length < 2 || !scores.some(s => s.pts > 0)) continue;
    const mine = scores.find(s => s.id === me.id);
    if (!mine) continue;
    played++;
    const hi = Math.max(...scores.map(s => s.pts));
    const lo = Math.min(...scores.map(s => s.pts));
    if (mine.pts === hi) crowns++;
    if (mine.pts === lo) clowns++;
    if (!best || mine.pts > best.points) best = { week: wk, points: one(mine.pts) };
    if (!worst || mine.pts < worst.points) worst = { week: wk, points: one(mine.pts) };
  }

  const currentWeek = (data.status && data.status.latestScoringPeriod) || played;

  return {
    board, serial,
    team: me.name,
    logo: me.logo,
    record: `${me.wins}-${me.losses}${me.ties ? "-" + me.ties : ""}`,
    wins: me.wins, losses: me.losses, ties: me.ties,
    pointsFor: me.pointsFor,
    pointsAgainst: me.pointsAgainst,
    standing, of: teams.length,
    bestWeek: best, worstWeek: worst,
    crowns, clowns,
    weeksPlayed: played,
    week: currentWeek,
    season: SEASON,
    updated: new Date().toISOString(),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Scores settle on Tuesday, so a few minutes of staleness costs nothing and
      // keeps thirty-six people opening their cards from hammering ESPN.
      "cache-control": status === 200
        ? "s-maxage=300, stale-while-revalidate=3600"
        : "no-store",
    },
  });
}
