import "dotenv/config";
import fs from "fs";
import { App, LogLevel } from "@slack/bolt";
import { SessionManager, type SessionEvent } from "./session-manager";
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

// Shared session-start logic used by both !new and natural language
function sessionCallback(channelId: string) {
  return async (event: SessionEvent) => {
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
    } else if (event.type === "error") {
      await postToSlack(channelId, () =>
        app.client.chat.postMessage({
          channel: channelId,
          text: `❌ *Error:* ${event.content}`,
        }) as Promise<any>
      );
    }
  };
}

// Extract a directory path (~/... or /...) and strip it + connector phrases from the message
function extractPath(text: string): { cwd: string | undefined; rest: string } {
  // Match connector phrases like "directory of ~/path", "in ~/path", "with dir ~/path", etc.
  const connectorRe = /(?:(?:(?:working\s+)?(?:directory|dir|folder))\s+(?:of\s+)?|(?:in|with|from)\s+)(~\/\S+|\/\S+)/i;
  const connectorMatch = text.match(connectorRe);
  if (connectorMatch) {
    const rawPath = connectorMatch[1].replace(/^~/, process.env.HOME || "~");
    const rest = text.replace(connectorMatch[0], "").replace(/\s{2,}/g, " ").trim();
    return { cwd: rawPath, rest };
  }
  // Fallback: bare path anywhere in message
  const bareRe = /(~\/\S+|\/(?![\s,.])\S+)/;
  const bareMatch = text.match(bareRe);
  if (bareMatch) {
    const rawPath = bareMatch[1].replace(/^~/, process.env.HOME || "~");
    const rest = text.replace(bareMatch[0], "").replace(/\s{2,}/g, " ").trim();
    return { cwd: rawPath, rest };
  }
  return { cwd: undefined, rest: text };
}

// Detect end-session intent (requires "session" or "claude" to avoid false positives)
const END_INTENT_RE = /\b(end|stop|kill|close|quit)\s+(the\s+)?(session|claude)\b/i;

// Detect status intent
const STATUS_INTENT_RE = /^!?status$|(?:session\s+)?status|\bwhat(?:'s| is)\s+(?:the\s+)?status\b/i;

// !new [--dir /path] [task] — start a session, optionally in a specific directory
app.message(/^\!new(.*)$/, async ({ message, say }) => {
  if (message.subtype) return;
  const msg = message as any;
  let rawArgs = msg.text.replace(/^\!new\s*/, "").trim();

  // Parse --dir flag if present
  let cwd: string | undefined;
  const dirMatch = rawArgs.match(/^--dir\s+(\S+)(?:\s+(.+))?$/);
  if (dirMatch) {
    cwd = dirMatch[1].replace(/^~/, process.env.HOME || "~");
    rawArgs = (dirMatch[2] || "").trim();
  }
  const initialPrompt = rawArgs || undefined;

  const channelId = msg.channel;

  if (sessions.hasActiveSession(channelId)) {
    await say("⚠️ Active session already running here. Type `!end` to close it first.");
    return;
  }

  if (cwd && !fs.existsSync(cwd)) {
    await say(`❌ Directory not found: \`${cwd}\``);
    return;
  }

  const dirLabel = cwd ? ` in \`${cwd}\`` : "";
  const taskLabel = initialPrompt ? `\n> ${initialPrompt}` : "";
  await say(`🚀 *Starting session${dirLabel}...*${taskLabel}`);

  sessions.startSession(channelId, initialPrompt, sessionCallback(channelId), cwd);
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

// Everything else → natural language intent detection + route to session
app.message(async ({ message, say }) => {
  if (message.subtype) return;
  const msg = message as any;
  if (!msg.text) return;

  // Skip commands already handled above
  if (/^!(new|end|status)/.test(msg.text)) return;
  // Skip bot messages
  if (msg.bot_id) return;

  const channelId = msg.channel;

  // --- No active session: treat any message as a new session request ---
  if (!sessions.hasActiveSession(channelId)) {
    const { cwd, rest } = extractPath(msg.text);

    if (cwd && !fs.existsSync(cwd)) {
      await say(`❌ Directory not found: \`${cwd}\``);
      return;
    }

    // Strip common preamble phrases to get the actual task prompt
    const prompt = rest
      .replace(/^(please\s+)?((start|create|open|launch|spin up|begin)\s+(a\s+)?(new\s+)?(claude(\s+code)?\s+)?(session|instance)\s*(and\s+)?)/i, "")
      .replace(/^\s*(then\s+)?/i, "")
      .trim() || undefined;

    const dirLabel = cwd ? ` in \`${cwd}\`` : "";
    const taskLabel = prompt ? `\n> ${prompt}` : "";
    await say(`🚀 *Starting session${dirLabel}...*${taskLabel}`);

    sessions.startSession(channelId, prompt, sessionCallback(channelId), cwd);
    return;
  }

  // --- Active session: check for end/status intents ---
  if (END_INTENT_RE.test(msg.text)) {
    sessions.endSession(channelId);
    await say("🛑 Session ended.");
    return;
  }

  if (STATUS_INTENT_RE.test(msg.text)) {
    const info = sessions.getSessionInfo(channelId);
    if (info) {
      await say(`📊 *Active session*\nStarted: ${info.startedAt}\nMessages: ${info.messageCount}\nWorking dir: \`${info.cwd}\``);
    }
    return;
  }

  // --- Default: route to Claude ---
  const result = sessions.sendMessage(channelId, msg.text);

  if (result === "queued") {
    await say("⏳ _Claude is still working — your message is queued and will be sent when this turn finishes._");
  } else if (result === "accepted") {
    await say("⏳ _Working on it..._");
  }
});

(async () => {
  await app.start();
  console.log("⚡ Claude Code Slack bridge running");
  console.log("Commands: !new [--dir /path] <task> | !end | !status | or just talk naturally");

  const shutdown = () => {
    console.log("\nShutting down...");
    sessions.endAllSessions();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
