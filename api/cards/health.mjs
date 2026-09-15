export function GET() {
  const need = ["DISCORD_APP_ID","DISCORD_PUBLIC_KEY","DISCORD_BOT_TOKEN","WEBHOOK_INTRODUCTIONS","WEBHOOK_TRADE_BLOCK"];
  const lines = need.map(k => `${process.env[k] ? "OK     " : "MISSING"}  ${k}`);
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain" } });
}
