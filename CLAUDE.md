# CLAUDE.md

Project context for Claude Code (and any AI agent working on this codebase).

## What this is

A Slack bridge for Claude Code. It spawns interactive Claude Code CLI sessions as child processes and pipes messages between Slack channels and Claude's stdin/stdout. One session per channel, turn-based interaction.

## Architecture

```
Slack channel  -->  index.ts (Bolt app, socket mode)
                      |
                SessionManager (session-manager.ts)
                      |
                claude CLI subprocess (--output-format stream-json --verbose)
                      |  stdin/stdout pipes
                Claude Code agent
```

### Files

- **index.ts** - Slack Bolt app. Handles `!new`, `!end`, `!status` commands and routes all other messages to the active session. Includes a per-channel rate-limiting queue for Slack API calls (~1 msg/sec). `!new` supports `--dir` flag for per-session working directories.
- **session-manager.ts** - Spawns and manages Claude CLI child processes. Parses the stream-json output, handles turn sequencing (waitingForInput flag), queues messages sent while Claude is busy, and auto-sends them when the turn ends. Uses a serial async queue to prevent readline callback interleaving.
- **formatter.ts** - Converts Claude's markdown to Slack mrkdwn (bold, headers, code blocks, horizontal rules).

### Key design decisions

- **Interactive subprocess, not SDK** - Uses `spawn("claude", ...)` with piped stdio, not the `@anthropic-ai/claude-code` npm package. The CLI stays alive across turns.
- **Turn-based** - Claude can't be interrupted mid-turn. The `waitingForInput` flag gates when user messages are written to stdin. If a message arrives mid-turn, it's queued in `pendingMessage` and auto-sent on the next `result` event.
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

Requires `claude` CLI installed and authenticated on the host machine.

## Environment variables

Set in `.env` (loaded via dotenv):

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | Slack app token (`xapp-...`) with `connections:write` |
| `SLACK_SIGNING_SECRET` | yes | Slack signing secret |
| `CLAUDE_WORK_DIR` | no | Working directory for Claude (defaults to `process.cwd()`) |
| `CLAUDE_CONTINUE` | no | Set `true` to resume last session on `!new` |
| `CLAUDE_SKIP_PERMISSIONS` | no | Set `true` to pass `--dangerously-skip-permissions` |

## Session event flow

1. User sends `!new <task>` (or `!new --dir /path <task>`) in Slack
2. `SessionManager.startSession()` spawns `claude --output-format stream-json --verbose`
3. Initial prompt written to stdin
4. Claude's stdout emits JSON lines:
   - `{"type": "assistant", "message": {"content": [...]}}` - text and tool_use blocks
   - `{"type": "result", ...}` - turn complete, Claude is idle on stdin
   - `{"type": "system", "subtype": "init"}` - startup, ignored
5. On `result`: if `pendingMessage` exists, auto-send it; otherwise emit `waiting` to Slack
6. User replies -> written to stdin -> cycle repeats
7. Process close -> emit `complete` or `error`

## Conventions

- TypeScript strict mode
- No classes in index.ts, functional style for Slack handlers
- `SessionManager` is the only class, owns all process lifecycle
- Avoid adding dependencies unless necessary - this is intentionally minimal (~3 files)
- Commands use `!` prefix (`!new`, `!end`, `!status`) — plain messages, not Slack slash commands (Slack intercepts `/`)
