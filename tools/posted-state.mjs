// A memory of what has already been posted, so a late cron can't say it twice.
//
// GitHub's free scheduler is best-effort. This repo routinely sees scheduled runs land one to
// three hours behind their cron, which means "fire it manually because it's late" and "the
// scheduled run finally arrives" can both happen, and the boards get the same poll twice. The
// fix is to stop treating a run as the unit of work and start treating the post as one: each
// post has a key, the key gets written down once it's out, and any later run that sees the key
// does nothing.
//
// Storage is `posted.json` on the board-data branch — the same place and the same Contents API
// the leaderboard already uses, so there's nothing new to rent and no new secret. That branch
// has deployments disabled in both directions, so writing a key never triggers a build.
//
// In Actions the built-in GITHUB_TOKEN is enough, as long as the job asks for contents: write.

const API = "https://api.github.com";
const REPO = process.env.GITHUB_REPOSITORY || "";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const BRANCH = process.env.BOARD_BRANCH || "board-data";
const FILE = "posted.json";
const KEEP = 400;   // plenty of seasons; the file stays a few KB

const gh = (path, init = {}) => fetch(API + path, {
  ...init,
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${TOKEN}`,
    "user-agent": "crownorclown-bot",
    ...(init.body ? { "content-type": "application/json" } : {})
  }
});

// No token means no memory. Say so out loud rather than silently posting twice.
export const enabled = () => Boolean(TOKEN && REPO);

async function read() {
  const r = await gh(`/repos/${REPO}/contents/${FILE}?ref=${encodeURIComponent(BRANCH)}`);
  if (r.status === 404) return { keys: [], sha: null };
  if (!r.ok) throw new Error(`state read ${r.status}`);
  const j = await r.json();
  try {
    const parsed = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8"));
    return { keys: Array.isArray(parsed.keys) ? parsed.keys : [], sha: j.sha || null };
  } catch { return { keys: [], sha: j.sha || null }; }   // a corrupt file is an empty memory
}

export async function has(key) {
  if (!enabled()) return false;
  const { keys } = await read();
  return keys.includes(key);
}

// Returns true when this call is the one that claimed the key. Two runs racing for the same
// post both read the same sha; the loser gets a 409, re-reads, sees the key and backs off.
export async function claim(key) {
  if (!enabled()) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { keys, sha } = await read();
    if (keys.includes(key)) return false;
    const next = keys.concat(key).slice(-KEEP);
    const r = await gh(`/repos/${REPO}/contents/${FILE}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Posted: ${key}`,
        content: Buffer.from(JSON.stringify({ keys: next }, null, 1) + "\n", "utf8").toString("base64"),
        branch: BRANCH,
        ...(sha ? { sha } : {})
      })
    });
    if (r.ok) return true;
    if (r.status !== 409 && r.status !== 422) throw new Error(`state write ${r.status}`);
  }
  return false;   // lost the race three times over; somebody else has it
}

// Claiming happens before the post, so two runs can't both decide to send. If the send then
// fails, hand the key back rather than leaving a post that never happened marked as done.
export async function release(key) {
  if (!enabled()) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { keys, sha } = await read();
    if (!keys.includes(key)) return;
    const r = await gh(`/repos/${REPO}/contents/${FILE}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Unposted: ${key}`,
        content: Buffer.from(JSON.stringify({ keys: keys.filter(k => k !== key) }, null, 1) + "\n", "utf8").toString("base64"),
        branch: BRANCH,
        ...(sha ? { sha } : {})
      })
    });
    if (r.ok) return;
    if (r.status !== 409 && r.status !== 422) return;   // best effort; never fail a run over cleanup
  }
}
