/**
 * Keep a copy of every card that posts.
 *
 * Wyatt's card went out with a black hole where his photo should have been, and putting it right
 * took hours: the card had to be read back off a PNG in a Discord channel, pixel by pixel,
 * because nothing anywhere had kept what he actually built. Every card now leaves a copy behind,
 * so the next repair is a one-liner instead of an archaeology dig.
 *
 * Two things are kept, both on the board-data branch beside the leaderboard and the mint ledger:
 *
 *   cards/<n>.png    the exact image that was posted
 *   cards/<n>.json   the number, the Discord message id, the traits, and the card's own state —
 *                    name, team, colours, badges, flair, the take, the framing
 *
 * The state is what makes a rebuild possible without asking anybody anything. The photo is in
 * the PNG. Together they are enough to redraw the card or hand it to a chain later.
 *
 * Best effort by design: a card that posts must never fail because its copy didn't save.
 */

const TOKEN = process.env.GH_TOKEN || process.env.BOARD_TOKEN || "";
const OWNER = process.env.BOARD_REPO_OWNER || process.env.VERCEL_GIT_REPO_OWNER || "";
const REPO = process.env.BOARD_REPO || process.env.VERCEL_GIT_REPO_SLUG || "";
const BRANCH = process.env.BOARD_BRANCH || "board-data";
const API = "https://api.github.com";

const gh = (path, opts = {}) => fetch(API + path, {
  ...opts,
  headers: {
    authorization: "Bearer " + TOKEN,
    accept: "application/vnd.github+json",
    "user-agent": "crownorclown-archive",
    "content-type": "application/json"
  }
});

async function put(path, buf, message) {
  // Two commits to the same branch at the same moment is a 409 from GitHub — the second one
  // is written against a head that already moved. Card #007 posted with no copy saved for
  // exactly that reason, and nothing said so, because the result was thrown away. Each write
  // now re-reads the sha and tries again, and hands back why it failed if it still fails.
  for (let attempt = 0; attempt < 3; attempt++) {
    let sha = null;
    const head = await gh(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${encodeURIComponent(BRANCH)}`);
    if (head.ok) sha = (await head.json()).sha || null;
    const r = await gh(`/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: buf.toString("base64"), branch: BRANCH, ...(sha ? { sha } : {}) })
    });
    if (r.ok) return "";
    const why = `${r.status} ${(await r.text().catch(() => "")).slice(0, 180)}`;
    if (r.status !== 409 && r.status !== 422) return why;
    if (attempt === 2) return why;
    await new Promise(done => setTimeout(done, 350 * (attempt + 1)));
  }
  return "gave up";
}

// Only the keys a card is actually made of, each clipped, so a public endpoint can't write
// anything it likes into the repository.
const STR = (v, n) => (typeof v === "string" || typeof v === "number") ? String(v).replace(/[\u0000-\u001f]/g, " ").slice(0, n) : "";
function clean(s) {
  if (!s || typeof s !== "object") return {};
  const flair = {};
  if (s.flair && typeof s.flair === "object")
    for (const k of Object.keys(s.flair).slice(0, 24)) flair[STR(k, 40)] = STR(s.flair[k], 300);
  return {
    name: STR(s.name, 40), nick: STR(s.nick, 60), since: STR(s.since, 40), where: STR(s.where, 60),
    nfl: STR(s.nfl, 4), ed: STR(s.ed, 20), layout: STR(s.layout, 10),
    treat: STR(s.treat, 24), foil: STR(s.foil, 24), pattern: STR(s.pattern, 24),
    holoAmt: Number(s.holoAmt) || 0,
    photoFit: STR(s.photoFit, 10), photoZ: Number(s.photoZ) || 100, photoY: Number(s.photoY) || 50,
    accent: STR(s.accent, 9), nameC: STR(s.nameC, 9), teamC: STR(s.teamC, 9),
    take: STR(s.take, 800),
    badges: Array.isArray(s.badges) ? s.badges.slice(0, 40).map(b => STR(b, 40)) : [],
    teams: (s.teams && typeof s.teams === "object")
      ? Object.fromEntries(Object.keys(s.teams).slice(0, 3).map(k => [STR(k, 20), STR(s.teams[k], 80)])) : {},
    flair
  };
}

export async function keep({ n, messageId, png, state, traits }) {
  if (!TOKEN || !OWNER || !REPO || !n) {
    const missing = [!TOKEN && "token", !OWNER && "owner", !REPO && "repo", !n && "mint"].filter(Boolean);
    console.error("card archive skipped — no " + missing.join(", "));
    return false;
  }
  const num = String(n).padStart(3, "0");
  const body = {
    n, messageId: String(messageId || ""), at: new Date().toISOString(),
    traits: traits && typeof traits === "object" ? traits : {},
    state: clean(state)
  };
  // One after the other, not at once: both land on the same branch head.
  const a = await put(`cards/${num}.png`, png, `Card #${num}`);
  const b = await put(`cards/${num}.json`,
    Buffer.from(JSON.stringify(body, null, 1) + "\n", "utf8"), `Card #${num} details`);
  if (a || b) {
    console.error(`card archive #${num} failed — png: ${a || "ok"} · json: ${b || "ok"}`);
    return false;
  }
  return true;
}
