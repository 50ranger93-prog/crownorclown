# What already runs — read this before building anything

Everything in this repo that posts, writes or schedules itself, in one place.
It exists because things kept getting rebuilt that already existed.

**If you are about to add something that posts to Discord or runs on a cron: read this file
first, and add your thing to it in the same commit.**

---

## Scheduled jobs

All times Mountain (UTC−6 in season). Crons sit off the hour because GitHub throttles
top-of-the-hour schedules hard.

| Workflow | When | What it does | Script |
|---|---|---|---|
| **Archive the week** | daily 09:07 + 16:07, Tue 10:20 | Snapshots ESPN gameday data into `weeks/<season>/` and commits it. ESPN deletes weather, the matchup predictor and unresolved injury designations once a game goes final, so a daily pass is the only way to keep them. | `tools/archive-week.mjs` |
| **Channel pulse** | six beats, see below | Keeps the Discord moving without anyone posting. | `tools/pulse.mjs` |
| **Post the week** | Tue 09:25 | Crown / clown / closest game / beatdown / robbed for all three boards, plus the Go get it leaderboard. | `tools/weekly-post.mjs` |
| **Post the polls** | Thu 09:25 | One native Discord poll per board, built from that league's own standings and slate. | `tools/poll-post.mjs` |
| **Weekly DK reconciliation** | Sun 10:00 | Finds the only two places ESPN and DraftKings scoring can diverge and reports a checklist. | `tools/reconcile.mjs`, see `tools/README.md` |

### Channel pulse beats

| Beat | When | Webhook secret | Live? |
|---|---|---|---|
| `slate` | Sun 09:00 | `PULSE_WEBHOOK_GENERAL` | yes |
| `inactives` | Sun 11:15 | `PULSE_WEBHOOK_GENERAL` | yes |
| `injuries` | Wed + Fri 10:00 | `PULSE_WEBHOOK_GENERAL` | yes |
| `faab` | Thu 10:00 | `PULSE_WEBHOOK_TRADE` | yes |
| `crownvest` | Tue 10:00 | `PULSE_WEBHOOK_CROWNVEST` | **deliberately dark** |
| `hottake` | Fri 10:00 | `PULSE_WEBHOOK_HOTTAKE` | dark |

> **Do not set `PULSE_WEBHOOK_CROWNVEST`.** That beat does the same job as *Post the week* and is
> scheduled 35 minutes after it. Setting the secret gives the server the same news twice on a
> Tuesday morning. *Post the week* is the one that's kept: it splits crowns and clowns into two
> rooms, carries the leaderboard, and nudges `/intro` at the bottom.
>
> Every pulse beat posts only if its webhook secret is set, which is the on/off switch — no code
> change needed to silence or revive one.

---

## Live endpoints (Vercel)

| Route | What |
|---|---|
| `/api/board` | Go get it leaderboard. Stored as `board.json` on the **`board-data`** branch of this repo via the GitHub Contents API — no database, nothing rented. Deployments are disabled for that branch both ways so posting a score never triggers a build. |
| `/api/cards/interactions` | Discord slash-command endpoint (`/intro`, `/block`). Ed25519 verified, locked to one guild id. |
| `/api/cards/post` | Renders a built card into `#meet-the-crew` or `#trade-block`. Asks for a forum thread and falls back once if the channel doesn't want one. |
| `/api/cards/teams` | Team names + logos per board, from ESPN. |
| `/api/cards/roster` | One board's rosters, so `/block` is a tap list instead of typing. |
| `/api/cards/register` | Re-registers the slash commands. Closed behind `?key=<DISCORD_PUBLIC_KEY>`. |
| `/api/cards/health` | Says which env vars are present. Never prints a value. |
| `/api/cards/img` | Image proxy for the card builder. |

The Discord endpoint must be set to the **`www.`** host. `crownorclown.com` 308-redirects to
`www.crownorclown.com`, and **Discord does not follow redirects** when it verifies an
interactions endpoint. `fetch` does, which hides the problem from every test you'll try.

---

## Secrets

**GitHub repo secrets** (Settings → Secrets and variables → Actions) — used by the workflows:

| Secret | Channel | Used by |
|---|---|---|
| `WEBHOOK_CROWN` | `#crown-and-vest` | Post the week |
| `WEBHOOK_SHAME` | `#hall-of-shame` | Post the week (without it, clowns ride along with the crowns) |
| `WEBHOOK_LEAGUE1` | `#expansion-league` | Post the polls |
| `WEBHOOK_LEAGUE2` | `#expansion-league-2` | Post the polls |
| `WEBHOOK_LEAGUE3` | `#expansion-league-3` | Post the polls |
| `WEBHOOK_TRASH` / `WEBHOOK_WAIVERS` / `WEBHOOK_GENERAL` | shared rooms | Post the polls, only with `per: 2` |
| `PULSE_WEBHOOK_GENERAL` / `_TRADE` / `_CROWNVEST` / `_HOTTAKE` | see beats table | Channel pulse |
| `RECONCILE_WEBHOOK` | optional | Weekly DK reconciliation |

**Vercel environment variables** — used by the live site, *not* by the workflows:
`DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `LINK_SECRET`,
`WEBHOOK_INTRODUCTIONS`, `WEBHOOK_TRADE_BLOCK`, `GH_TOKEN` (board writes).

`WEBHOOK_INTRODUCTIONS` still carries its old name and points at **#meet-the-crew** — a webhook
follows the channel, not the channel's name, so renaming the room didn't break it and renaming
the variable would mean touching Vercel for nothing.

Two different places. A webhook the workflows need goes in **GitHub**; a webhook the site needs
goes in **Vercel**. `/api/cards/health` lists what Vercel has.

---

## The leagues

Three 12-team leagues, 36 managers. Lineup is 1QB / 2RB / 3WR / 1TE / 2FLEX / **2 OP** / K / DST,
so **three quarterbacks start**. Scored on ESPN using **DraftKings** scoring.

| Board | ESPN league id | Discord room |
|---|---|---|
| Board 1 | `951407474` | `#expansion-league` |
| Board 2 | `1963204215` | `#expansion-league-2` |
| Board 3 | `976183547` | `#expansion-league-3` |

ESPN endpoints used, none needing auth:
`lm-api-reads.fantasy.espn.com` (leagues, rosters, matchups), `site.api.espn.com` (scoreboard,
summary, teams), `sports.core.api.espn.com` (depth charts). Open-Meteo for weather, forecast
and historical archive, no key.

---

## Things that bit us, so they don't again

- **ESPN team stats are from the offense's point of view.** `sacksYardsLost`, `interceptions`
  and `fumblesLost` on a team's line describe what *happened to* that team. A team's defensive
  numbers come off its **opponent's** line.
- **ESPN depth charts:** `slot` is the lineup spot, `rank` is depth within that spot. Sorting by
  rank then slot interleaves every starter ahead of every backup. It looks right and is wrong.
- **ESPN ranks a whole position room in one list**, injured players at the bottom, so it cannot
  tell you who actually replaces an injured starter. Use the box score once the game is played
  and show nothing before kickoff.
- **ESPN deletes weather once a game is final** — from both the scoreboard and the summary.
- **Discord won't render SVG** in an embed thumbnail, and every stock ESPN team logo is an SVG.
- **A Discord forum channel has no loose messages.** A webhook posting to one must send
  `thread_name`; a plain text channel rejects that same field. And **a text channel cannot be
  converted into a forum** — you create a new one.
- **`[hidden]` loses to any author rule that sets `display`.** An invisible overlay ate every tap
  on the game for a day. `[hidden]{display:none !important}` is in the stylesheet for this reason.
- **`requestAnimationFrame` is frozen in a hidden tab.**
- **Vercel `.mjs` is ESM regardless of package.json**, and a single project can mix
  `module.exports = (req,res)` files with `export function GET(request)` files.
