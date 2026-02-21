# Claude Code Slack Bridge

Full interactive Claude Code sessions directly in Slack. Send messages, get responses, iterate — exactly like the terminal, but from your phone.

## How it works

Each Slack channel gets its own persistent Claude Code session. You start a task, Claude works and posts updates, you reply to steer it, it continues. No jumping to a browser, no context switching.

```
You (Slack)  ←→  Bot  ←→  Claude Code (running on your machine)
```

## Commands

| Command | What it does |
|---|---|
| `/new <task>` | Start a Claude Code session with a task |
| Any message | Sent directly to the active session |
| `/end` | Kill the current session |
| `/status` | Show session info |

## Setup

### 1. Create a Slack App

Go to https://api.slack.com/apps and click "Create New App" → "From manifest".

Paste this manifest:

```yaml
display_information:
  name: Claude Code
  description: Interactive Claude Code sessions in Slack
  background_color: "#1a1a1a"
features:
  bot_user:
    display_name: Claude Code
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  token_rotation_enabled: false
```

### 2. Get your credentials

From your app's settings page:
- **Bot Token**: OAuth & Permissions → Bot User OAuth Token (`xoxb-...`)
- **App Token**: Basic Information → App-Level Tokens → Generate token with `connections:write` scope (`xapp-...`)
- **Signing Secret**: Basic Information → App Credentials

### 3. Install and run

```bash
# Clone or copy this folder
cd claude-slack-bridge

# Install dependencies
npm install

# Copy env file and fill in your credentials
cp .env.example .env
# Edit .env with your tokens

# Run in dev mode
npm run dev

# Or build and run
npm run build
npm start
```

> **Note:** Run the bot from your project directory, or set `CLAUDE_WORK_DIR` in `.env` to point at it. Claude Code will operate in that directory.

### 4. Invite the bot to a channel

In Slack: `/invite @Claude Code` in whatever channel you want to use.

## Usage tips

- **One channel per project/task** — keeps context clean and the channel history serves as a memory log for future sessions
- **Start a new session** in a dedicated channel: `/new refactor the Atlas pricing component`
- **Just reply naturally** — your messages go straight to Claude, exactly like typing in the terminal
- **Check what Claude is doing** — tool use (file reads, bash commands) is surfaced as small status messages so you're not in the dark
- **Session memory** — at the start of future sessions, you can paste in a summary from the channel history or ask Claude to read recent context

## Running persistently

To keep the bridge running when you close your terminal:

```bash
# Using pm2
npm install -g pm2
pm2 start npm --name claude-slack -- start
pm2 save
pm2 startup
```

Or just run it in a tmux/screen session.
