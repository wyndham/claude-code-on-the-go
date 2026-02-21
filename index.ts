import "dotenv/config";
import { App, LogLevel } from "@slack/bolt";
import { SessionManager } from "./session-manager";
import { formatForSlack } from "./formatter";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

const sessions = new SessionManager();

// Per-channel message queue — throttles Slack API calls to ~1/sec to avoid rate limits
const messageQueues = new Map<string, { queue: Array<() => Promise<void>>; processing: boolean }>();

async function postToSlack(channelId: string, fn: () => Promise<void>) {
  let entry = messageQueues.get(channelId);
  if (!entry) {
    entry = { queue: [], processing: false };
    messageQueues.set(channelId, entry);
  }
  entry.queue.push(fn);
  if (entry.processing) return;
  entry.processing = true;
  while (entry.queue.length > 0) {
    const next = entry.queue.shift()!;
    try { await next(); } catch (err) { console.error(`[${channelId}] Slack post error:`, err); }
    if (entry.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  entry.processing = false;
}

// !new [--dir /path] <task> — start a session, optionally in a specific directory
app.message(/^\!new(.*)$/, async ({ message, say }) => {
  if (message.subtype) return;
  const msg = message as any;
  let rawArgs = msg.text.replace(/^\!new\s*/, "").trim();

  if (!rawArgs) {
    await say("Start a session with: `!new <task>` or `!new --dir /path/to/project <task>`");
    return;
  }

  // Parse --dir flag if present
  let cwd: string | undefined;
  const dirMatch = rawArgs.match(/^--dir\s+(\S+)\s+(.+)$/);
  if (dirMatch) {
    cwd = dirMatch[1].replace(/^~/, process.env.HOME || "~");
    rawArgs = dirMatch[2];
  }
  const initialPrompt = rawArgs;

  const channelId = msg.channel;

  if (sessions.hasActiveSession(channelId)) {
    await say("⚠️ Active session already running here. Type `!end` to close it first.");
    return;
  }

  const dirLabel = cwd ? ` in \`${cwd}\`` : "";
  await say(`🚀 *Starting session${dirLabel}...*\n> ${initialPrompt}`);

  sessions.startSession(channelId, initialPrompt, async (event) => {
    if (event.type === "text") {
      await postToSlack(channelId, () =>
        app.client.chat.postMessage({
          channel: channelId,
          text: formatForSlack(event.content),
          unfurl_links: false,
        }) as Promise<any>
      );
    } else if (event.type === "tool_use") {
      await postToSlack(channelId, () =>
        app.client.chat.postMessage({
          channel: channelId,
          text: `🔧 ${event.content}`,
        }) as Promise<any>
      );
    } else if (event.type === "waiting") {
      await postToSlack(channelId, () =>
        app.client.chat.postMessage({
          channel: channelId,
          text: `💬 _Waiting for your reply..._`,
        }) as Promise<any>
      );
    } else if (event.type === "complete") {
      await postToSlack(channelId, () =>
        app.client.chat.postMessage({
          channel: channelId,
          text: `✅ *Session complete.* Type \`!new <task>\` to start another.`,
        }) as Promise<any>
      );
    } else if (event.type === "error") {
      await postToSlack(channelId, () =>
        app.client.chat.postMessage({
          channel: channelId,
          text: `❌ *Error:* ${event.content}`,
        }) as Promise<any>
      );
    }
  }, cwd);
});

// !end — kill session
app.message(/^\!end$/, async ({ message, say }) => {
  if (message.subtype) return;
  const msg = message as any;

  if (!sessions.hasActiveSession(msg.channel)) {
    await say("No active session here.");
    return;
  }

  sessions.endSession(msg.channel);
  await say("🛑 Session ended.");
});

// !status
app.message(/^\!status$/, async ({ message, say }) => {
  if (message.subtype) return;
  const msg = message as any;
  const info = sessions.getSessionInfo(msg.channel);

  if (!info) {
    await say("No active session. Start one with `!new <task>`");
    return;
  }

  await say(`📊 *Active session*\nStarted: ${info.startedAt}\nMessages: ${info.messageCount}\nWorking dir: \`${info.cwd}\``);
});

// Everything else → route to session
app.message(async ({ message, say }) => {
  if (message.subtype) return;
  const msg = message as any;
  if (!msg.text) return;

  // Skip commands already handled above
  if (/^!(new|end|status)/.test(msg.text)) return;
  // Skip bot messages
  if (msg.bot_id) return;

  const channelId = msg.channel;
  const result = sessions.sendMessage(channelId, msg.text);

  if (result === "no_session") {
    await say("No active session. Start one with `!new <task>`");
  } else if (result === "queued") {
    await say("⏳ _Claude is still working — your message is queued and will be sent when this turn finishes._");
  }
  // "accepted" — no reply needed, session will post when ready
});

(async () => {
  await app.start();
  console.log("⚡ Claude Code Slack bridge running");
  console.log("Commands: !new [--dir /path] <task> | !end | !status");

  const shutdown = () => {
    console.log("\nShutting down...");
    sessions.endAllSessions();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
