// Rosters for one board, so the trade block can be tapped instead of typed.
// Typing "Kenneth Walker III" and then hunting KC out of a 32-team dropdown was the
// worst part of the flow; ESPN already knows every name, position and NFL team.
const LEAGUES = { "Board 1": "951407474", "Board 2": "1963204215", "Board 3": "976183547" };

// ESPN's proTeam ids. Their Washington abbrev is WSH; the card art uses WAS.
const PRO = { 1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",10:"TEN",
  11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",18:"NO",19:"NYG",20:"NYJ",
  21:"PHI",22:"ARI",23:"PIT",24:"LAC",25:"SF",26:"SEA",27:"TB",28:"WAS",29:"CAR",30:"JAX",
  33:"BAL",34:"HOU" };
const POS = { 1:"QB", 2:"RB", 3:"WR", 4:"TE", 5:"K", 16:"D/ST" };
const ORDER = { QB:0, RB:1, WR:2, TE:3, K:4, "D/ST":5 };
const BENCH = new Set([20, 21]); // bench and IR

export async function GET(request) {
  const b = new URL(request.url).searchParams.get("b") || "";
  const id = LEAGUES[b];
  if (!id) return new Response(JSON.stringify({ error: "Unknown board." }), { status: 404, headers: { "content-type": "application/json" } });

  let d;
  try {
    const r = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${id}?view=mRoster&view=mTeam`);
    if (!r.ok) throw new Error(String(r.status));
    d = await r.json();
  } catch {
    return new Response(JSON.stringify({ error: "ESPN didn't answer." }), { status: 502, headers: { "content-type": "application/json" } });
  }

  const teams = {};
  for (const t of d.teams || []) {
    const rows = [];
    for (const e of (t.roster && t.roster.entries) || []) {
      const p = (e.playerPoolEntry && e.playerPoolEntry.player) || {};
      const pos = POS[p.defaultPositionId];
      if (!pos || !p.fullName) continue;
      // [position, name, NFL team, starting?, hurt?]
      rows.push([pos, p.fullName, PRO[p.proTeamId] || "", BENCH.has(e.lineupSlotId) ? 0 : 1,
        p.injuryStatus && p.injuryStatus !== "ACTIVE" ? 1 : 0]);
    }
    rows.sort((a, z) => (ORDER[a[0]] - ORDER[z[0]]) || (z[3] - a[3]) || a[1].localeCompare(z[1]));
    teams[String(t.name || "").trim()] = rows;
  }
  return new Response(JSON.stringify({ teams }), {
    headers: { "content-type": "application/json", "cache-control": "s-maxage=300, stale-while-revalidate=1800" }
  });
}
