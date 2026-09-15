const OK = ["g.espncdn.com", "a.espncdn.com", "raw.githubusercontent.com", "mystique-api.fantasy.espn.com"];
export async function GET(request) {
  const u = new URL(request.url).searchParams.get("u") || "";
  let target; try { target = new URL(u); } catch { return new Response("bad url", { status: 400 }); }
  if (target.protocol !== "https:" || !OK.includes(target.hostname)) return new Response("not allowed", { status: 403 });
  const r = await fetch(target, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) return new Response("not found", { status: 404 });
  return new Response(await r.arrayBuffer(), { headers: { "content-type": r.headers.get("content-type") || "image/png", "cache-control": "public, max-age=86400, s-maxage=604800" } });
}
