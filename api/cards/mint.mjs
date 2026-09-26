/**
 * Mint numbers, traits and rarity.
 *
 *   POST /api/cards/mint   ->  { n: 7 }
 *
 * A card's number is the order it was made in. Not a seat, not a board position,
 * not out of anything — #1 is whoever built the first one and it keeps counting.
 * Somebody making five cards gets five numbers. That is what a mint number is.
 *
 * Stored exactly the way the leaderboard is: one JSON file on the board-data
 * branch of this repository, written through the GitHub Contents API. No
 * database, nothing rented, and every increment is a commit you can read.
 *
 * Numbers are handed out when a card reaches the preview, so the number can be
 * printed on the card before the image is made. Abandon the preview and that
 * number is spent — which is why the sequence can have gaps, and gaps are fine:
 * a mint number says when you turned up, not how many exist.
 *
 * Each mint also records its traits, which is what makes this a collection rather
 * than a pile of pictures. Rarity is then not a label anybody chose: it is
 * counted. "Prismatic, 2 of 19" is a fact about what the league actually built.
 *
 * Rarity only starts being claimed once there are enough cards for it to mean
 * something. With four cards in, everything is one-of-four, and calling that
 * Mythic would be a lie.
 */

const TOKEN  = process.env.GH_TOKEN || process.env.BOARD_TOKEN || "";
const OWNER  = process.env.BOARD_REPO_OWNER || process.env.VERCEL_GIT_REPO_OWNER || "";
const REPO   = process.env.BOARD_REPO       || process.env.VERCEL_GIT_REPO_SLUG  || "";
const BRANCH = process.env.BOARD_BRANCH     || "board-data";
const FILE   = "mints.json";
const API    = "https://api.github.com";

const gh = (path, opts = {}) => fetch(API + path, {
  ...opts,
  headers: {
    authorization: "Bearer " + TOKEN,
    accept: "application/vnd.github+json",
    "user-agent": "crownorclown-mint",
    "content-type": "application/json",
    ...(opts.headers || {}),
  },
});

async function read() {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${encodeURIComponent(BRANCH)}`);
  if (r.status === 404) return { next: 1, cards: [], sha: null };
  if (!r.ok) throw new Error("read " + r.status);
  const j = await r.json();
  try {
    const parsed = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8"));
    const n = Number(parsed && parsed.next);
    // A corrupt or missing counter must never restart at 1 and hand out a number
    // somebody already has. Refusing is better than duplicating.
    if (!Number.isInteger(n) || n < 1) throw new Error("counter unreadable");
    return { next: n, cards: Array.isArray(parsed.cards) ? parsed.cards : [], sha: j.sha || null };
  } catch (e) {
    if (String(e.message) === "counter unreadable") throw e;
    throw new Error("counter unreadable");
  }
}

async function write(next, cards, sha) {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Mint #${next - 1}`,
      content: Buffer.from(JSON.stringify({ next, cards, updated: new Date().toISOString() }, null, 1) + "\n", "utf8").toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (r.status === 409 || r.status === 422) return false;   // somebody minted first
  if (!r.ok) throw new Error("write " + r.status);
  return true;
}

/* Traits are somebody else's text arriving at a public endpoint, so nothing is
   trusted: only the keys the card actually has are kept, each clipped to a sane
   length, and anything else is dropped on the floor. */
const TRAIT_KEYS = ["Edition", "Treatment", "Finish", "Pattern", "Hologram", "NFL team", "Boards", "Artwork", "Layout"];
function cleanTraits(t) {
  const out = {};
  if (!t || typeof t !== "object") return out;
  for (const k of TRAIT_KEYS) {
    const v = t[k];
    if (typeof v !== "string" && typeof v !== "number") continue;
    const str = String(v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 40);
    if (str) out[k] = str;
  }
  return out;
}

/* Rarity, counted rather than decided. Each trait reports how many cards share
   its value; the card's tier comes from its rarest one. */
const TIERS = [[0.05, "Mythic"], [0.14, "Rare"], [0.32, "Uncommon"], [1, "Common"]];

// The floor is derived, not picked. The rarest tier is 5%, so one card cannot BE 5% of the
// collection until there are twenty of them — below that "Mythic" is unreachable by arithmetic
// and any tier shown would be an artefact of a small sample, not a fact about the league.
// It was a hardcoded 8 before, which came from nowhere.
const TIER_FLOOR = Math.ceil(1 / TIERS[0][0]);

export function rarityOf(traits, cards) {
  const total = cards.length;
  const breakdown = {};
  let rarest = 1;
  for (const [k, v] of Object.entries(traits)) {
    const count = cards.filter(c => c.traits && c.traits[k] === v).length;
    const share = total ? count / total : 1;
    breakdown[k] = { value: v, count, of: total };
    if (share < rarest) rarest = share;
  }
  // Counts are a fact at any size and always ship. The tier is a claim, so it waits until the
  // collection is big enough for the claim to be earnable — and says how far off it is.
  const tier = total < TIER_FLOOR ? null : (TIERS.find(t => rarest <= t[0]) || TIERS[3])[1];
  return { total, tier, breakdown, tierAt: TIER_FLOOR, tierIn: Math.max(0, TIER_FLOOR - total) };
}

export async function POST(request) {
  if (!TOKEN || !OWNER || !REPO) {
    // Not configured is not an error the card should die on — it just means no
    // number, and the card says so rather than printing a made-up one.
    return json({ configured: false, note: "Mint storage not configured." });
  }
  let traits = {};
  try { traits = cleanTraits(await request.json()); } catch (e) { /* a mint with no traits is still a mint */ }
  try {
    // Two people hitting preview together invalidates one sha; take turns.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { next, cards, sha } = await read();
      const entry = { n: next, at: new Date().toISOString(), traits };
      const nextCards = cards.concat(entry);
      if (await write(next + 1, nextCards, sha))
        return json({ configured: true, n: next, ...rarityOf(traits, nextCards) });
    }
    return json({ configured: false, note: "Mint busy, try again." }, 503);
  } catch (e) {
    return json({ configured: false, note: String(e.message || e) }, 502);
  }
}

// A number must never be handed out by something that only meant to look.
export async function GET() {
  return new Response("Mint numbers are issued on POST.", { status: 405, headers: { allow: "POST" } });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
