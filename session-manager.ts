import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";

export type SessionEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; content: string }
  | { type: "waiting" }        // Turn complete — Claude is waiting for your reply
  | { type: "complete" }       // Session ended naturally
  | { type: "error"; content: string };

type EventCallback = (event: SessionEvent) => Promise<void>;

interface Session {
  process: ChildProcess;
  callback: EventCallback;
  startedAt: string;
  messageCount: number;
  cwd: string;
  waitingForInput: boolean;    // true when result event received, false mid-turn
  active: boolean;
  pendingMessage: string | null; // queued message sent while Claude was busy
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();

  hasActiveSession(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  isWaitingForInput(channelId: string): boolean {
    return this.sessions.get(channelId)?.waitingForInput ?? false;
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

  startSession(channelId: string, initialPrompt: string, callback: EventCallback, cwd?: string) {
    cwd = cwd || process.env.CLAUDE_WORK_DIR || process.cwd();

    // Build args — configurable via env vars
    const args = ["--output-format", "stream-json", "--verbose"];

    // Resume the most recent session in this working directory
    if (process.env.CLAUDE_CONTINUE === "true") {
      args.push("--continue");
    }

    // Skip all permission prompts (file writes, bash commands, etc.)
    // Only use if you trust the task — removes the mid-session approval step
    if (process.env.CLAUDE_SKIP_PERMISSIONS === "true") {
      args.push("--dangerously-skip-permissions");
    }

    // No --print: runs interactively, stays alive across turns, waits at stdin between turns
    const proc = spawn("claude", args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: Session = {
      process: proc,
      callback,
      startedAt: new Date().toLocaleString(),
      messageCount: 1,
      cwd,
      waitingForInput: false,
      active: true,
      pendingMessage: null,
    };

    this.sessions.set(channelId, session);
    this.attachHandlers(channelId, session);

    // Kick off with initial prompt
    if (proc.stdin && !proc.stdin.destroyed) {
      proc.stdin.write(initialPrompt + "\n");
    }
  }

  private attachHandlers(channelId: string, session: Session) {
    const rl = readline.createInterface({ input: session.process.stdout! });
    let accumulatedText = "";
    let lastToolDesc = "";
    let flushTimer: NodeJS.Timeout | null = null;

    // Serial async queue — ensures readline events are processed in order
    // even though handlers are async (readline doesn't respect backpressure)
    let lineQueue: string[] = [];
    let processingLines = false;

    const flushText = async () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (accumulatedText.trim()) {
        await session.callback({ type: "text", content: accumulatedText.trim() });
        accumulatedText = "";
      }
    };

    const processLine = async (line: string) => {
      if (!line.trim()) return;

      let event: any;
      try { event = JSON.parse(line); }
      catch {
        accumulatedText += line + "\n";
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flushText, 1200);
        return;
      }

      if (event.type === "assistant") {
        for (const block of (event.message?.content || [])) {
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

      } else if (event.type === "result") {
        // ← KEY MOMENT: Claude finished a turn and is now idle on stdin
        await flushText();

        // If a message was queued while Claude was busy, auto-send it now
        if (session.pendingMessage !== null) {
          const queued = session.pendingMessage;
          session.pendingMessage = null;
          session.messageCount++;
          if (session.process.stdin && !session.process.stdin.destroyed) {
            session.process.stdin.write(queued + "\n");
          }
          // Don't emit "waiting" — Claude is immediately resuming
        } else {
          session.waitingForInput = true;
          await session.callback({ type: "waiting" });
        }

      } else if (event.type === "system" && event.subtype === "init") {
        // Startup noise — ignore
      }
    };

    const drainQueue = async () => {
      if (processingLines) return;
      processingLines = true;
      while (lineQueue.length > 0) {
        const line = lineQueue.shift()!;
        try { await processLine(line); } catch (err) { console.error(`[${channelId}] line error:`, err); }
      }
      processingLines = false;
    };

    rl.on("line", (line) => {
      lineQueue.push(line);
      drainQueue();
    });

    session.process.stderr!.on("data", (data) => {
      const text = data.toString().trim();
      if (text && !text.includes("Loaded") && !text.includes("cwd:") && !text.includes("MCP")) {
        console.error(`[${channelId}] stderr:`, text);
      }
    });

    session.process.on("close", async (code) => {
      if (flushTimer) clearTimeout(flushTimer);
      await flushText();
      if (!session.active) return;
      session.active = false;
      if (code !== 0 && code !== null) {
        await session.callback({ type: "error", content: `Claude exited with code ${code}` });
      } else {
        await session.callback({ type: "complete" });
      }
      this.sessions.delete(channelId);
    });

    session.process.on("error", async (err) => {
      session.active = false;
      await session.callback({ type: "error", content: err.message });
      this.sessions.delete(channelId);
    });
  }

  /**
   * Send a user message to the session.
   *
   * "accepted"  — Claude was waiting, message sent, session resumes
   * "queued"    — Claude is mid-turn; message saved and will auto-send when Claude finishes
   * "no_session" — no session in this channel
   */
  sendMessage(channelId: string, text: string): "accepted" | "queued" | "no_session" {
    const session = this.sessions.get(channelId);
    if (!session) return "no_session";

    if (!session.waitingForInput) {
      // Queue the message — will be sent automatically when Claude's turn ends
      session.pendingMessage = text;
      return "queued";
    }

    if (!session.process.stdin || session.process.stdin.destroyed) {
      return "no_session";
    }

    session.waitingForInput = false;
    session.messageCount++;
    session.process.stdin.write(text + "\n");
    return "accepted";
  }

  endSession(channelId: string) {
    const session = this.sessions.get(channelId);
    if (!session) return;
    session.active = false;
    try { session.process.kill("SIGTERM"); } catch {}
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
