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

// /new <task> — start a session
app.message(/^\/new(.*)$/, async ({ message, say }) => {
  if (message.subtype) return;
  const msg = message as any;
  const initialPrompt = msg.text.replace(/^\/new\s*/, "").trim();

  if (!initialPrompt) {
    await say("Start a session with: `/new <your task description>`");
    return;
  }

  const channelId = msg.channel;

  if (sessions.hasActiveSession(channelId)) {
    await say("⚠️ Active session already running here. Type `/end` to close it first.");
    return;
  }

  await say(`🚀 *Starting session...*\n> ${initialPrompt}`);

  sessions.startSession(channelId, initialPrompt, async (event) => {
    if (event.type === "text") {
      await app.client.chat.postMessage({
        channel: channelId,
        text: formatForSlack(event.content),
        unfurl_links: false,
      });
    } else if (event.type === "tool_use") {
      await app.client.chat.postMessage({
        channel: channelId,
        text: `🔧 ${event.content}`,
      });
    } else if (event.type === "waiting") {
      await app.client.chat.postMessage({
        channel: channelId,
        text: `💬 _Waiting for your reply..._`,
      });
    } else if (event.type === "complete") {
      await app.client.chat.postMessage({
        channel: channelId,
        text: `✅ *Session complete.* Type \`/new <task>\` to start another.`,
      });
    } else if (event.type === "error") {
      await app.client.chat.postMessage({
        channel: channelId,
        text: `❌ *Error:* ${event.content}`,
      });
    }
  });
});

// /end — kill session
app.message(/^\/end$/, async ({ message, say }) => {
  if (message.subtype) return;
  const msg = message as any;

  if (!sessions.hasActiveSession(msg.channel)) {
    await say("No active session here.");
    return;
  }

  sessions.endSession(msg.channel);
  await say("🛑 Session ended.");
});

// /status
app.message(/^\/status$/, async ({ message, say }) => {
  if (message.subtype) return;
  const msg = message as any;
  const info = sessions.getSessionInfo(msg.channel);

  if (!info) {
    await say("No active session. Start one with `/new <task>`");
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
  if (/^\/(new|end|status)/.test(msg.text)) return;
  // Skip bot messages
  if (msg.bot_id) return;

  const channelId = msg.channel;
  const result = sessions.sendMessage(channelId, msg.text);

  if (result === "no_session") {
    await say("No active session. Start one with `/new <task>`");
  } else if (result === "busy") {
    // Claude is mid-turn — acknowledge but don't drop the message
    // Optionally queue it; for now just let the user know
    await say("⏳ _Claude is still working... reply again once you see the_ 💬 _prompt._");
  }
  // "accepted" — no reply needed, session will post when ready
});

(async () => {
  await app.start();
  console.log("⚡ Claude Code Slack bridge running");
  console.log("Commands: /new <task> | /end | /status");
})();
