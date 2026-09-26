/**
 * The collection, read-only.
 *
 *   GET /api/cards/mints  ->  { total, cards: [...], counts: {...}, tierAt, tierIn }
 *
 * mints.json was write-only: every card's number and traits were being carefully recorded into
 * a file nothing ever read back. A numbered card whose number nobody can look up is just a
 * picture. This is the other half.
 *
 * Deliberately a separate route from mint.mjs, which only answers POST — looking at the
 * collection must never be able to hand out a number.
 *
 * No token needed: the board-data branch is public, so this reads the raw file. That also means
 * it keeps working if the mint endpoint's token is ever rotated.
 */

const OWNER = process.env.BOARD_REPO_OWNER || process.env.VERCEL_GIT_REPO_OWNER || "";
const REPO = process.env.BOARD_REPO || process.env.VERCEL_GIT_REPO_SLUG || "";
const BRANCH = process.env.BOARD_BRANCH || "board-data";

const TIERS = [[0.05, "Mythic"], [0.14, "Rare"], [0.32, "Uncommon"], [1, "Common"]];
const TIER_FLOOR = Math.ceil(1 / TIERS[0][0]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "s-maxage=30, stale-while-revalidate=300" }
});

export async function GET() {
  if (!OWNER || !REPO) return json({ configured: false, total: 0, cards: [], counts: {} });
  let cards = [];
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/mints.json`, {
      headers: { "user-agent": "crownorclown" }, signal: AbortSignal.timeout(8000)
    });
    if (r.status === 404) return json({ configured: true, total: 0, cards: [], counts: {}, tierAt: TIER_FLOOR, tierIn: TIER_FLOOR });
    if (!r.ok) throw new Error(String(r.status));
    const parsed = await r.json();
    cards = Array.isArray(parsed.cards) ? parsed.cards : [];
  } catch (e) {
    return json({ configured: false, total: 0, cards: [], counts: {}, note: String(e.message || e) }, 502);
  }

  // How many cards share each trait value. This is what makes rarity a count rather than a label.
  const counts = {};
  for (const c of cards) {
    for (const [k, v] of Object.entries(c.traits || {})) {
      (counts[k] || (counts[k] = {}))[v] = (counts[k][v] || 0) + 1;
    }
  }

  return json({
    configured: true,
    total: cards.length,
    tierAt: TIER_FLOOR,
    tierIn: Math.max(0, TIER_FLOOR - cards.length),
    counts,
    // Only what the mint recorded. There are no names in mints.json and none are invented here.
    cards: cards.map(c => ({ n: c.n, at: c.at, traits: c.traits || {} })).sort((a, z) => z.n - a.n)
  });
}
