import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";

export type SessionEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; content: string }
  | { type: "heartbeat" }
  | { type: "waiting" }
  | { type: "error"; content: string };

type EventCallback = (event: SessionEvent) => Promise<void>;

interface Session {
  callback: EventCallback;
  startedAt: string;
  messageCount: number;
  cwd: string;
  sessionId: string | null;
  waitingForInput: boolean;
  active: boolean;
  pendingMessage: string | null;
  activeQuery: Query | null;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();

  hasActiveSession(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  getSessionInfo(channelId: string) {
    const session = this.sessions.get(channelId);
    if (!session) return null;
    return {
      startedAt: session.startedAt,
      messageCount: session.messageCount,
      cwd: session.cwd,
      waitingForInput: session.waitingForInput,
    };
  }

  startSession(channelId: string, initialPrompt: string | undefined, callback: EventCallback, cwd?: string) {
    cwd = cwd || process.env.CLAUDE_WORK_DIR || process.cwd();

    const session: Session = {
      callback,
      startedAt: new Date().toLocaleString(),
      messageCount: 0,
      cwd,
      sessionId: null,
      waitingForInput: !initialPrompt,
      active: true,
      pendingMessage: null,
      activeQuery: null,
    };

    this.sessions.set(channelId, session);
    console.log(`[${channelId}] Session created in ${cwd}`);

    if (initialPrompt) {
      this.runTurn(channelId, session, initialPrompt);
    }
  }

  private async runTurn(channelId: string, session: Session, prompt: string) {
    session.waitingForInput = false;
    session.messageCount++;

    const options: Options = {
      cwd: session.cwd,
      abortController: new AbortController(),
    };

    if (session.sessionId) {
      options.resume = session.sessionId;
    } else if (process.env.CLAUDE_CONTINUE === "true") {
      options.continue = true;
    }

    if (process.env.CLAUDE_SKIP_PERMISSIONS === "true") {
      options.permissionMode = "bypassPermissions";
      options.allowDangerouslySkipPermissions = true;
    }

    console.log(`[${channelId}] Turn started: "${prompt.substring(0, 80)}"${session.sessionId ? ` (resume ${session.sessionId.substring(0, 8)}...)` : ""}`);

    let accumulatedText = "";
    let textFlushTimer: NodeJS.Timeout | null = null;
    let accumulatedTools: string[] = [];
    let toolFlushTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;

    const HEARTBEAT_INTERVAL = 120_000; // 2 minutes

    const resetHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(async function beat() {
        if (!session.active || !session.activeQuery) return;
        await session.callback({ type: "heartbeat" });
        heartbeatTimer = setTimeout(beat, HEARTBEAT_INTERVAL);
      }, HEARTBEAT_INTERVAL);
    };

    const stopHeartbeat = () => {
      if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    };

    const flushText = async () => {
      if (textFlushTimer) { clearTimeout(textFlushTimer); textFlushTimer = null; }
      if (accumulatedText.trim()) {
        await session.callback({ type: "text", content: accumulatedText.trim() });
        accumulatedText = "";
        resetHeartbeat();
      }
    };

    const flushTools = async () => {
      if (toolFlushTimer) { clearTimeout(toolFlushTimer); toolFlushTimer = null; }
      if (accumulatedTools.length > 0) {
        const batch = accumulatedTools.join("\n");
        accumulatedTools = [];
        await session.callback({ type: "tool_use", content: batch });
        resetHeartbeat();
      }
    };

    resetHeartbeat();

    try {
      const q = query({ prompt, options });
      session.activeQuery = q;

      for await (const message of q) {
        if (!session.active) break;

        // Capture session ID from any message
        if ("session_id" in message && message.session_id && !session.sessionId) {
          session.sessionId = message.session_id;
          console.log(`[${channelId}] Got session_id: ${session.sessionId}`);
        }

        // Debug: log every message type
        const subtype = "subtype" in message ? `/${message.subtype}` : "";
        console.log(`[${channelId}] SDK message: ${message.type}${subtype}`);

        if (message.type === "assistant") {
          const content = (message as any).message?.content || [];
          console.log(`[${channelId}] Assistant blocks: ${content.map((b: any) => b.type).join(", ") || "(empty)"}`);
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              await flushTools();
              accumulatedText += block.text;
              if (textFlushTimer) clearTimeout(textFlushTimer);
              textFlushTimer = setTimeout(flushText, 1200);
            } else if (block.type === "tool_use") {
              await flushText();
              const desc = formatToolUse(block);
              // Deduplicate consecutive identical tool descriptions
              if (accumulatedTools.length === 0 || accumulatedTools[accumulatedTools.length - 1] !== desc) {
                accumulatedTools.push(desc);
              }
              if (toolFlushTimer) clearTimeout(toolFlushTimer);
              toolFlushTimer = setTimeout(flushTools, 1500);
            }
          }
        } else if (message.type === "result") {
          await flushTools();
          await flushText();
          stopHeartbeat();
          const cost = (message as any).total_cost_usd;
          console.log(`[${channelId}] Turn complete (cost: $${cost?.toFixed(4) || "?"})`);
        }
      }
    } catch (err: any) {
      stopHeartbeat();
      if (err.name === "AbortError" || !session.active) {
        return; // Session was ended by user
      }
      console.error(`[${channelId}] Turn error:`, err.message);
      await session.callback({ type: "error", content: err.message });
      session.active = false;
      this.sessions.delete(channelId);
      return;
    }

    session.activeQuery = null;

    if (!session.active) return;

    // Turn complete — check for queued message
    if (session.pendingMessage !== null) {
      const queued = session.pendingMessage;
      session.pendingMessage = null;
      this.runTurn(channelId, session, queued);
    } else {
      session.waitingForInput = true;
      await session.callback({ type: "waiting" });
    }
  }

  sendMessage(channelId: string, text: string): "accepted" | "queued" | "no_session" {
    const session = this.sessions.get(channelId);
    if (!session) return "no_session";

    if (!session.waitingForInput) {
      session.pendingMessage = text;
      return "queued";
    }

    this.runTurn(channelId, session, text);
    return "accepted";
  }

  endSession(channelId: string) {
    const session = this.sessions.get(channelId);
    if (!session) return;
    session.active = false;
    if (session.activeQuery) {
      session.activeQuery.close();
    }
    this.sessions.delete(channelId);
  }

  endAllSessions() {
    for (const [channelId] of this.sessions) {
      this.endSession(channelId);
    }
  }
}

function formatToolUse(block: any): string {
  const name = (block.name || "unknown").toLowerCase();
  const input = block.input || {};
  switch (name) {
    case "bash":          return `Bash: \`${(input.command || "").substring(0, 120)}\``;
    case "read":          return `Read: \`${input.file_path || input.path || ""}\``;
    case "write":         return `Write: \`${input.file_path || input.path || ""}\``;
    case "edit":
    case "str_replace":   return `Edit: \`${input.file_path || input.path || ""}\``;
    case "glob":          return `Glob: \`${input.pattern || ""}\``;
    case "grep":          return `Grep: \`${input.pattern || ""}\` in \`${input.path || "."}\``;
    case "task":          return `Task: ${input.description || input.prompt?.substring(0, 120) || "subagent"}`;
    case "webfetch":      return `WebFetch: \`${input.url || ""}\``;
    case "websearch":     return `WebSearch: ${input.query || ""}`;
    case "notebookedit":  return `NotebookEdit: \`${input.notebook_path || ""}\``;
    default:              return `${block.name || name}: ${summarizeInput(input)}`;
  }
}

function summarizeInput(input: Record<string, any>): string {
  const vals = Object.values(input).filter(v => typeof v === "string" && v.length > 0);
  if (vals.length === 0) return "";
  const first = vals[0] as string;
  return first.length > 120 ? first.substring(0, 120) + "..." : first;
}
