import { query } from "@anthropic-ai/claude-code";

export type SessionEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; content: string }
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
  abortController: AbortController | null;
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
      abortController: null,
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

    const abortController = new AbortController();
    session.abortController = abortController;

    const options: any = {
      outputFormat: "stream-json",
      cwd: session.cwd,
    };

    if (session.sessionId) {
      options.resume = session.sessionId;
    } else if (process.env.CLAUDE_CONTINUE === "true") {
      options.continue = true;
    }

    if (process.env.CLAUDE_SKIP_PERMISSIONS === "true") {
      options.permissionMode = "bypassPermissions";
    }

    console.log(`[${channelId}] Turn started: "${prompt.substring(0, 80)}"${session.sessionId ? ` (resume ${session.sessionId.substring(0, 8)}...)` : ""}`);

    let accumulatedText = "";
    let flushTimer: NodeJS.Timeout | null = null;
    let lastToolDesc = "";

    const flushText = async () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (accumulatedText.trim()) {
        await session.callback({ type: "text", content: accumulatedText.trim() });
        accumulatedText = "";
      }
    };

    try {
      for await (const message of query({ prompt, abortController, options })) {
        if (!session.active) break;

        // Capture session ID
        if ((message as any).session_id && !session.sessionId) {
          session.sessionId = (message as any).session_id;
          console.log(`[${channelId}] Got session_id: ${session.sessionId}`);
        }

        if (message.type === "assistant") {
          const content = (message as any).message?.content || [];
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              accumulatedText += block.text;
              if (flushTimer) clearTimeout(flushTimer);
              flushTimer = setTimeout(flushText, 1200);
            } else if (block.type === "tool_use") {
              await flushText();
              const desc = formatToolUse(block);
              if (desc !== lastToolDesc) {
                lastToolDesc = desc;
                await session.callback({ type: "tool_use", content: desc });
              }
            }
          }
        } else if (message.type === "result") {
          await flushText();
          console.log(`[${channelId}] Turn complete (cost: $${(message as any).total_cost_usd?.toFixed(4) || "?"})`);
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError" || !session.active) {
        return; // Session was ended by user
      }
      console.error(`[${channelId}] Turn error:`, err.message);
      await session.callback({ type: "error", content: err.message });
      session.active = false;
      this.sessions.delete(channelId);
      return;
    }

    session.abortController = null;

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
    if (session.abortController) {
      session.abortController.abort();
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
  const name = block.name || "unknown";
  const input = block.input || {};
  switch (name) {
    case "bash":        return `bash: \`${(input.command || "").substring(0, 100)}\``;
    case "read":        return `read: \`${input.file_path || input.path || ""}\``;
    case "write":       return `write: \`${input.file_path || input.path || ""}\``;
    case "edit":
    case "str_replace": return `edit: \`${input.path || ""}\``;
    case "glob":        return `glob: \`${input.pattern || ""}\``;
    case "grep":        return `grep: \`${input.pattern || ""}\``;
    default:            return name;
  }
}
