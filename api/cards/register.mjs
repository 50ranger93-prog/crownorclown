const COMMANDS = [
  { name: "intro", description: "Build your Expansion League card", type: 1 },
  { name: "block", description: "Put players on the trade block", type: 1 }
];
// Closed now that the commands are registered. This was an unauthenticated endpoint making an
// authenticated Discord call — never worse than a rate limit, but no reason to leave it open to
// the internet. The key is the app's own public key, readable only from the developer portal, so
// re-registering after a command change is still one URL away.
export async function GET(request) {
  const key = new URL(request.url).searchParams.get("key") || "";
  const want = process.env.DISCORD_PUBLIC_KEY || "";
  if (!want || key !== want) return new Response("Not open.", { status: 404 });
  const app = process.env.DISCORD_APP_ID, tok = process.env.DISCORD_BOT_TOKEN;
  if (!app || !tok) return new Response("Missing DISCORD_APP_ID or DISCORD_BOT_TOKEN in Vercel settings.", { status: 500 });
  const r = await fetch(`https://discord.com/api/v10/applications/${app}/commands`, {
    method: "PUT", headers: { Authorization: `Bot ${tok}`, "content-type": "application/json" }, body: JSON.stringify(COMMANDS)
  });
  const text = await r.text();
  return new Response(r.ok ? "Done. /intro and /block are registered. They can take a minute to show up in Discord." : `Discord error ${r.status}: ${text}`, { status: r.ok ? 200 : 502 });
}
