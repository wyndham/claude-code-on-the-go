# CLAUDE.md

Project context for Claude Code (and any AI agent working on this codebase).

## What this is

A Slack bridge for Claude Code. It uses the `@anthropic-ai/claude-agent-sdk` to run programmatic Claude Code sessions and pipes messages between Slack channels and Claude. One session per channel, turn-based interaction.

## Architecture

```
Slack channel  -->  index.ts (Bolt app, socket mode)
                      |
                SessionManager (session-manager.ts)
                      |
                @anthropic-ai/claude-agent-sdk  query()
                      |  async generator
                Claude Code agent
```

### Files

- **index.ts** - Slack Bolt app. Handles `!new`, `!end`, `!status` commands and routes all other messages to the active session. Includes a per-channel rate-limiting queue for Slack API calls (~1 msg/sec). `!new` supports `--dir` flag for per-session working directories. The catch-all handler also supports natural language: any message with no active session starts one (with path extraction from phrases like "in ~/path"), and "end the session" / "status" work during active sessions.
- **session-manager.ts** - Manages Claude Code sessions via the Agent SDK's `query()` async generator. Handles turn sequencing (waitingForInput flag), queues messages sent while Claude is busy, and auto-sends them when the turn ends. Uses `session_id` for session resumption across turns.
- **formatter.ts** - Converts Claude's markdown to Slack mrkdwn (bold, headers, code blocks, horizontal rules).

### Key design decisions

- **Agent SDK, not CLI subprocess** - Uses `query()` from `@anthropic-ai/claude-agent-sdk` which returns an async generator of SDK messages. Each turn is a separate `query()` call, resumed via `session_id`.
- **Turn-based** - Claude can't be interrupted mid-turn. The `waitingForInput` flag gates when new turns begin. If a message arrives mid-turn, it's queued in `pendingMessage` and auto-sent on the next `result` event.
- **One session per channel** - Enforced by the `sessions` Map keyed on channel ID.
- **Text debounce** - Assistant text blocks are accumulated and flushed after 1200ms of quiet, so rapid streaming doesn't spam the channel.
- **Tool deduplication** - Consecutive identical tool_use descriptions are suppressed.

## Build and run

```bash
npm install
npm run dev       # tsx watch, auto-reloads
npm run build     # tsc -> dist/
npm start         # node dist/index.js
```

Requires Claude Code CLI installed and authenticated on the host machine (the SDK spawns it internally).

## Environment variables

Set in `.env` (loaded via dotenv):

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | Slack app token (`xapp-...`) with `connections:write` |
| `SLACK_SIGNING_SECRET` | yes | Slack signing secret |
| `CLAUDE_WORK_DIR` | no | Working directory for Claude (defaults to `process.cwd()`) |
| `CLAUDE_CONTINUE` | no | Set `true` to resume last session on `!new` |
| `CLAUDE_SKIP_PERMISSIONS` | no | Set `true` to bypass all permission prompts |

## Session event flow

1. User sends `!new <task>` (or `!new --dir /path <task>`) in Slack, or any natural language message when no session is active (e.g., "fix the login bug in ~/myproject")
2. `SessionManager.startSession()` calls `query({ prompt, options })` from the Agent SDK
3. The SDK returns an async generator of `SDKMessage` objects
4. Messages processed:
   - `type: "assistant"` - contains `message.content[]` with text and tool_use blocks
   - `type: "result"` - turn complete
   - `type: "system"` - init/status events (session_id captured here)
5. On turn complete: if `pendingMessage` exists, start a new `query()` with `resume: sessionId`; otherwise emit `waiting` to Slack
6. User replies -> new `query()` call with `resume` -> cycle repeats
7. Session end -> `Query.close()` terminates the underlying process

## Conventions

- TypeScript strict mode
- No classes in index.ts, functional style for Slack handlers
- `SessionManager` is the only class, owns all process lifecycle
- Avoid adding dependencies unless necessary - this is intentionally minimal (~3 files)
- Commands use `!` prefix (`!new`, `!end`, `!status`) — plain messages, not Slack slash commands (Slack intercepts `/`)
- Natural language also works: any message sent without an active session starts one (with optional path extraction). "end the session" / "session status" work as alternatives to `!end` / `!status`.
