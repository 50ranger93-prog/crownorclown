const LEAGUES = { "Board 1": "951407474", "Board 2": "1963204215", "Board 3": "976183547" };
export async function GET() {
  const boards = {};
  await Promise.all(Object.entries(LEAGUES).map(async ([b, id]) => {
    const r = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${id}?view=mTeam`);
    const d = await r.json();
    boards[b] = (d.teams || []).map(t => [String(t.name || "").trim(), t.logo || ""]).sort((a, z) => a[0].toLowerCase().localeCompare(z[0].toLowerCase()));
  }));
  return new Response(JSON.stringify({ boards }), { headers: { "content-type": "application/json", "cache-control": "s-maxage=600, stale-while-revalidate=3600" } });
}
