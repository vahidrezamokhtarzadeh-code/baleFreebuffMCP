# 🤖 Bale Freebuff Bot — Full Documentation

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Module Reference](#module-reference)
4. [Configuration](#configuration)
5. [Data Flow](#data-flow)
6. [Setup & Usage](#setup--usage)
7. [Bot Commands](#bot-commands)
8. [Token Authentication](#token-authentication)
9. [Limitations & Troubleshooting](#limitations--troubleshooting)

---

## Overview

**Bale Freebuff Bot** is a bridge service that connects the [Bale Messenger](https://bale.ai) bot platform (an Iranian messaging app with a Telegram-compatible Bot API) to [Freebuff](https://freebuff.com), an AI-powered coding CLI tool.

Users interact with Freebuff entirely through Bale chat messages — the bot spawns a Freebuff PTY process per user, sends their text as input, waits for a response, extracts the clean output from Freebuff's TUI, and sends it back as a Bale message.

### Key Design Decisions

- **Token-based authentication** — each Bale user gets a unique token and must authenticate before using the bot.
- **Per-user PTY sessions** — each authenticated user gets an isolated `node-pty` process running Freebuff.
- **VT100 screen buffer emulation** — because Freebuff is a TUI app, the bot must parse terminal escape sequences to extract visible text content.
- **Region-based extraction** — only the conversation area (rows 9–31) of Freebuff's screen is captured, ignoring the logo, status bar, and input area.
- **Noise filtering** — box-drawing characters, status bar text, thinking indicators, and other TUI chrome are stripped via regex patterns.
- **Inline keyboard menus** — provides button-based navigation for session status and help.

---

## Architecture

```
┌────────────────────┐         ┌──────────────┐         ┌──────────────────┐
│   Bale Messenger   │◄──────►│  Bridge.js   │◄──────►│  Freebuff CLI    │
│   (Bot API)        │  HTTP   │              │  PTY   │  (via node-pty)  │
└────────────────────┘         └──────────────┘         └──────────────────┘
       bale.js                        │                         │
                               config.js                   vt-screen.js
                               user-store.js
```

### Session Keying

```
BEFORE:  chatId → session    (1 chat = 1 session)
AFTER:   userId → session    (1 user = 1 session, regardless of chat)
```

Each authenticated user gets exactly one Freebuff PTY process. If the user chats from different conversations (group + DM), they share the same session.

### Component Summary

| File | Purpose |
|------|---------|
| `src/index.js` | Entry point — initializes bot, bridge, handles graceful shutdown |
| `src/bale.js` | Bale Bot API client (long-polling, send/delete messages, inline keyboards) |
| `src/bridge.js` | Message routing — handles auth, maps user IDs to Freebuff sessions |
| `src/user-store.js` | Token-based user authentication and persistence |
| `src/freebuff.js` | Freebuff PTY wrapper — spawns process, sends input, extracts response |
| `src/vt-screen.js` | VT100/XTerm screen buffer emulator with scrollback, for terminal output parsing |
| `src/extract.js` | Pure response-extraction logic (noise filtering, sentinel matching, diff fallback) |
| `src/replay.js` | Replays a recorded fixture through the real extraction pipeline |
| `tools/record-session.js` | Records a live Freebuff PTY session to a fixture file |
| `tools/make-fixture.js` | Generates synthetic fixtures so tests run without Freebuff |
| `src/config.js` | Configuration loader (JSON file or environment variables) |

---

## Module Reference

### `src/index.js` — Entry Point

The `main()` function:
1. Loads configuration from `src/config.js`
2. Creates a `BaleBot` instance and verifies the token via `getMe()`
3. Creates a `Bridge` instance to handle message routing
4. Starts the long-polling loop via `bot.start()` with message and callback handlers
5. Registers `SIGINT`/`SIGTERM` handlers for graceful shutdown

```bash
npm start    # Production
npm run dev  # Development (auto-reload with --watch)
```

---

### `src/bale.js` — `BaleBot` Class

A lightweight client for the Bale Bot API (compatible with Telegram Bot API).

**Base URL:** `https://tapi.bale.ai/bot{token}/`

#### Constructor

```js
new BaleBot(token, { pollTimeout = 30 })
```

- `token` — Bale Bot API token from @BotFather
- `pollTimeout` — Long-poll timeout in seconds

#### Methods

| Method | Description |
|--------|-------------|
| `call(method, params)` | Generic API call. POSTs JSON to the Bale API, checks `ok` field, returns `result`. Timeout: 60s. |
| `sendMessage(chatId, text, opts?)` | Send a text message. Options: `replyToMessageId`, `parseMode`, `reply_markup`. |
| `sendInlineKeyboard(chatId, text, keyboard, opts?)` | Send a message with inline keyboard buttons. `keyboard` is a 2D array of `{ text, callback_data }`. |
| `sendChatAction(chatId, action?)` | Send a typing indicator (default: `'typing'`). |
| `deleteMessage(chatId, messageId)` | Delete a message by ID. |
| `getUpdates()` | Long-poll for new messages. Tracks `offset` to avoid duplicates. |
| `start(onMessage, onCallbackQuery?)` | Start the polling loop. Calls `onMessage(msg)` for messages and `onCallbackQuery(query)` for button presses. |
| `stop()` | Stop the polling loop. |
| `getMe()` | Fetch bot info (username, first_name, etc.). |

---

### `src/bridge.js` — `Bridge` Class

Routes Bale messages to per-user Freebuff sessions. Manages authentication and session lifecycle.

#### Constructor

```js
new Bridge(baleBot)
```

#### Internal State

- `userStore: UserStore` — Token-based authentication store
- `sessions: Map<userId, FreebuffSession>` — Active Freebuff sessions per user
- `processing: Map<userId, boolean>` — Prevents concurrent sends to the same session

#### Methods

| Method | Description |
|--------|-------------|
| `isAuthenticated(userId)` | Returns `true` if user is authenticated via token. |
| `handleMessage(message)` | Main entry point. Routes commands vs text, checks authentication. |
| `handleCommand(chatId, userId, text, from)` | Handles `/start`, `/help`, `/new`, `/stop`, `/status` commands. |
| `handleStart(chatId, userId, token, from)` | Handles `/start` with optional token authentication. |
| `handleCallbackQuery(query)` | Handles inline keyboard button presses (status, help). |
| `sendMainMenu(chatId, text)` | Sends welcome message with inline keyboard buttons. |
| `sendToFreebuff(chatId, userId, text)` | Core flow: gets/creates session, sends input, waits for response, sends result back. |
| `createSession(userId)` | Creates a new `FreebuffSession` for the user, spawns it, waits for `ready` event. |
| `stopSession(userId)` | Destroys a user's session and removes it from the map. |
| `stopAll()` | Destroys all sessions (used during shutdown). |

---

### `src/user-store.js` — `UserStore` Class

Manages token-based user authentication with JSON file persistence.

#### Constructor

```js
new UserStore(filePath)
```

- `filePath` — Path to `users.json` file

#### Methods

| Method | Description |
|--------|-------------|
| `registerUser(userId, username, firstName)` | Register new user or return existing token. Generates 8-char random token. |
| `authenticateByToken(token, userId?)` | Validate token and mark user as authenticated. Returns `{userId, success, reason?}`. |
| `isAuthenticated(userId)` | Check if user is authenticated. |
| `getToken(userId)` | Get user's token. |
| `getUser(userId)` | Get full user record. |

#### Token Format

- Random 8-character alphanumeric string (e.g., `a7x9k2m1`)
- Generated using `crypto.randomBytes`
- Unique per user, stored in `users.json`

---

### `src/freebuff.js` — `FreebuffSession` Class

Wraps a Freebuff CLI process via `node-pty`. Extends `EventEmitter`.

#### Constructor

```js
new FreebuffSession({
  freebuffPath = 'freebuff',
  cwd = process.cwd(),
  sessionTimeoutMs = 30 * 60 * 1000,
  responseWaitMs = 60_000,
})
```

#### State Machine

```
STARTING → IDLE → PROCESSING → IDLE
                                  ↓
                               (exit/destroy)
```

| State | Meaning |
|-------|---------|
| `STARTING` | PTY spawned, waiting for startup timer (45s) |
| `IDLE` | Ready to accept input |
| `PROCESSING` | Input sent, waiting for response |

#### Methods

| Method | Description |
|--------|-------------|
| `spawn()` | Spawns the Freebuff PTY process. Sets up `onData` (feeds VTScreen) and `onExit` handlers. Starts a 45s startup timer. |
| `sendInput(text)` | Sends text + Enter to PTY. Snapshots conversation area before sending. Waits `responseWaitMs` (default 60s), then calls `_grabAndFlush()`. |
| `isAlive()` | Returns `false` if PTY is null or session timeout exceeded. |
| `isIdle()` | Returns `true` if state is `IDLE`. |
| `destroy()` | Kills the PTY process, clears all timers, emits `destroyed`. |

#### Events

| Event | Payload | When |
|-------|---------|------|
| `ready` | — | Startup complete, session is idle |
| `response` | `(text: string)` | Freebuff responded with text |
| `response_empty` | — | Freebuff responded but output was empty |
| `exit` | `({ exitCode })` | Freebuff process exited or idle timeout |
| `destroyed` | — | Session destroyed |

---

### Response extraction — `src/extract.js`

Pure functions, no PTY and no I/O, so the whole extraction pipeline can be tested offline against recorded fixtures.

| Function | Description |
|----------|-------------|
| `filterNoise(lines)` | Drop blank lines and TUI chrome (logo, status bar, input box, prompts) |
| `findSentinel(lines, sentinel)` | Index of the line echoing the prompt, or -1. Last match wins. |
| `normalizeForSentinel(line)` | Strip the decorative frame around an echoed prompt (`❯`, `▌`, `│…│`) |
| `postProcess(lines)` | Drop thinking headers and the indented reasoning under them; collapse blanks |
| `extractResponse({before, after, sentinel})` | Main entry point — returns `{text, strategy, index}` |
| `digest(text)` | FNV-1a hash of a transcript, used to detect that output has stopped changing |

#### Two extraction strategies

1. **`sentinel`** — the TUI echoes the prompt into the transcript, so everything after that echo is the reply. Robust even when the conversation scrolled and older lines repeat, because the cut point is a specific line rather than a length delta.
2. **`diff`** — when the prompt is not echoed (or has scrolled out of the scrollback window), the lines appended after the longest common prefix of the before/after transcripts are returned.

#### Completion detection

Silence is not completion. The model pauses for several seconds before its first token and again between tool calls, so a stability-only check cuts multi-step replies short. The session uses two signals:

1. **Duration footer** — Freebuff stamps a finished reply with `⎘ • 13s • △▽`. Seeing one *after* the sentinel ends the request immediately.
2. **Transcript digest** — otherwise, an FNV-1a hash of the transcript is polled every second; when it stops changing for `STABLE_MS`, the reply is done. This also catches in-place edits, which a transcript-length check misses. It only applies once actual reply text has been extracted, so a slow first token is never mistaken for an empty reply.

#### Layout detection

The conversation does not start at a fixed row and the status bar moves with the terminal size and Freebuff version. `conversationText()` finds the status bar by its own content (`✕ End session`, `45m left`, `11.9K (9%)`) and cuts the transcript just above it. This matters twice: chrome never reaches the reply, and the status bar's per-minute countdown never makes the digest look unstable.

#### Writing to the TUI

`sendInput` writes the prompt and the Enter key as **separate** writes, ~50 ms apart. Freebuff's input handler drops input when both arrive in the same tick, and the message is silently never submitted.

### `src/vt-screen.js` — `VTScreen` Class

A VT100/XTerm screen buffer emulator. Tracks virtual terminal content by processing raw escape sequences from the PTY.

#### Constructor

```js
new VTScreen(cols = 120, rows = 40)
```

#### Scrollback and scrolling regions

The emulator keeps every line that scrolls off the top of the screen, bounded by `scrollbackLimit` (default 2000 lines). Without it, a reply longer than the visible conversation pane would be silently truncated to whatever happened to fit on screen.

| Property | Type | Description |
|----------|------|-------------|
| `scrollback` | `Cell[][]` | Lines that have scrolled off the screen, oldest first |
| `scrollbackLimit` | `number` | Maximum retained scrollback lines |
| `scrollTop` / `scrollBottom` | `number` | Active scrolling region (DECSTBM / `CSI r`), inclusive |

| Method | Description |
|--------|-------------|
| `getScrollbackLength()` | Number of lines retained in scrollback |
| `getScrollbackText()` | Scrollback lines as text |
| `getTranscriptText(endRow?)` | Scrollback + visible rows above `endRow` — the full linear conversation |
| `getStreamIndex()` | Absolute line index of the cursor (scrollback + row), stable across scrolling |

A real TUI scrolls only its conversation pane and pins the logo and status bar, which is what `CSI r` support handles. Content scrolling out of that region still lands in scrollback, so long replies are never lost.

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `cols` | `number` | Screen width (columns) |
| `rows` | `number` | Screen height (rows) |
| `cursorRow` | `number` | Current cursor row (0-indexed) |
| `cursorCol` | `number` | Current cursor column (0-indexed) |
| `buffer` | `Cell[][]` | 2D array of `{ char, fg, bg }` objects |
| `dirty` | `boolean` | True if screen changed since last check |

#### Methods

| Method | Description |
|--------|-------------|
| `process(data)` | Process a chunk of raw terminal output. Handles escape sequences, CR, LF, tab, backspace, and printable chars. |
| `reset()` | Clear buffer and reset cursor to (0,0). |
| `getText()` | Get all visible text (line by line, trailing spaces trimmed). |
| `getRow(row)` | Get text content of a specific row. |
| `getRegion(startRow, endRow)` | Get text from a row range. |
| `getCleanText()` | Extract text while stripping box-drawing characters at the cell level. |
| `snapshot()` | Alias for `getText()`, used for diffing. |
| `hasChar(ch)` | Check if a character exists anywhere on screen. |

---

### `src/config.js` — Configuration

Loads configuration from `config.json` (if exists) with environment variable overrides.

#### Configuration Options

| Option | Env Variable | Default | Description |
|--------|-------------|---------|-------------|
| `baleToken` | `BALE_BOT_TOKEN` | *required* | Bale Bot API token |
| `usersFile` | `USERS_FILE` | `users.json` | Path to user authentication database |
| `freebuffPath` | `FREEBUFF_PATH` | `"freebuff"` | Path to Freebuff executable |
| `sessionTimeoutMs` | `SESSION_TIMEOUT_MS` | `1800000` (30 min) | Session max lifetime |
| `maxOutputLength` | `MAX_OUTPUT_LENGTH` | `3500` | Max chars per response (Bale limit ~4096) |
| `pollTimeout` | `POLL_TIMEOUT` | `30` | Long-poll timeout (seconds) |
| `freebuffWorkingDir` | `FREEBUFF_WORKING_DIR` | `process.cwd()` | Freebuff working directory |
| `responseWaitMs` | `RESPONSE_WAIT_MS` | `60000` (60s) | Time to wait for Freebuff response |

**Priority:** Environment variables override `config.json` values.

---

## Data Flow

### Complete Request Lifecycle

```
User sends message in Bale
        │
        ▼
┌─ bale.js: getUpdates() receives message
│
├─ bridge.js: handleMessage()
│   ├─ Check authentication (userId must be authenticated)
│   ├─ If not authenticated → Send auth reminder
│   ├─ If command (starts with /) → handleCommand()
│   └─ If text → sendToFreebuff()
│
├─ freebuff.js: sendInput(text)
│   ├─ Snapshot conversation area (VTScreen rows 9-31)
│   ├─ Write text + Enter to PTY
│   ├─ Wait 60s (responseWaitMs)
│   └─ _grabAndFlush()
│       ├─ Get current conversation area
│       ├─ Diff with snapshot → extract new lines
│       ├─ Filter noise patterns
│       └─ Emit 'response' or 'response_empty'
│
└─ bridge.js: Send response back
    ├─ Truncate if > maxOutputLength
    └─ baleBot.sendMessage(chatId, output)
```

### Authentication Flow

```
User sends /start
        │
        ▼
┌─ New user (not in users.json)
│   → registerUser(userId, username, firstName)
│   → Send: "🔑 Your token: a7x9k2m1\n\nUse /start a7x9k2m1 to activate"
│
├─ Existing user, NOT authenticated
│   → Send: "🔑 Your token: a7x9k2m1\n\nUse /start a7x9k2m1 to activate"
│
└─ Already authenticated
    → Show main menu with inline keyboard buttons
```

### Token Validation Flow

```
User sends /start a7x9k2m1
        │
        ▼
┌─ Token invalid (not found)
│   → Send: "❌ Token is not valid."
│
├─ Token belongs to another user
│   → Send: "❌ This token belongs to another user."
│
└─ Token matches this user
    → authenticateByToken(token) → authenticated = true
    → Send: "✅ Authenticated!"
    → Start Freebuff session in background (fire-and-forget)
    → Show inline keyboard: [📊 Session Status] [📖 Help]
    → When session ready: "✅ Freebuff آماده است!"
```

### PTY Interaction Detail

```
┌─────────────────────────────────────────────────┐
│  Freebuff TUI Layout (120×40 terminal)          │
├─────────────────────────────────────────────────┤
│  Rows 0-8:   Logo / branding                    │  ← Ignored
│  Rows 9-30:  Conversation content (scrollable)  │  ← Extracted
│  Rows 31-36: Status bar                         │  ← Ignored
│  Rows 37-39: Input area                         │  ← Ignored
└─────────────────────────────────────────────────┘
```

---

## Setup & Usage

### Prerequisites

- **Node.js** ≥ 18.0.0
- **Freebuff CLI** installed globally (`npm install -g freebuff`)
- **Bale account** and a bot token from @BotFather

### Installation

```bash
git clone <repo-url>
cd bale-freebuff-bot
npm install
```

### Configuration

**Option 1: Config file**

```bash
cp config.example.json config.json
# Edit config.json with your values
```

**Option 2: Environment variables**

```bash
cp .env.example .env
# Edit .env with your values
```

### Running

```bash
npm start        # Production
npm run dev      # Development with auto-reload
```

### First-Time Setup

1. Start the bot with `npm start`
2. Send `/start` to the bot in Bale
3. Copy the token shown in the response
4. Send `/start <your_token>` to authenticate
5. Freebuff session starts automatically in background
6. You'll see "✅ Freebuff آماده است!" when session is ready
7. Send any message to start using Freebuff

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show token (new users) or main menu (authenticated users) |
| `/start <token>` | Authenticate with your personal token |
| `/help` | Show help guide |
| `/new` | Destroy current session and start fresh |
| `/stop` | Stop current session |
| `/status` | Show session status (uptime, working dir) |

### Inline Keyboard Buttons

After authentication, you'll see:
- **📊 وضعیت Session** — Show current session status
- **📖 راهنما** — Show help guide

Any non-command text message is sent directly as input to Freebuff.

---

## Token Authentication

### How It Works

1. **Registration**: When a user first sends `/start`, they're automatically registered and receive a unique 8-character token
2. **Authentication**: User must send `/start <token>` to activate their account
3. **Session Creation**: After authentication, each user gets their own Freebuff PTY session
4. **Persistence**: User data is stored in `users.json` (gitignored for security)

### Token Security

- Tokens are 8-character random alphanumeric strings
- Tokens are unique per user
- Tokens cannot be reused by other users
- `users.json` is gitignored to prevent accidental credential exposure

### User Data Schema

```json
{
  "123456789": {
    "token": "a7x9k2m1",
    "username": "ali_dev",
    "firstName": "Ali",
    "authenticated": true,
    "createdAt": "2026-08-19T12:00:00.000Z"
  }
}
```

### Edge Cases

1. **User sends `/start` again after auth** → Shows main menu (idempotent)
2. **User sends `/start <token>` with already-used token** → "Token already used by another user"
3. **User sends `/start <wrong_token>`** → "Token is not valid"
4. **Multiple users try to use same token** → Second user gets "This token belongs to another user"
5. **users.json corrupted** → UserStore falls back to empty state, new tokens generated
6. **User not authenticated but sends text** → Blocked with auth reminder
7. **Session starts on authentication** → Freebuff session begins immediately when user authenticates, ready before first message

---

## Limitations & Troubleshooting

### Known Limitations

1. **Message length** — Bale limits messages to ~4096 characters. Output is truncated at 3500 chars with a "... (بریده شد)" suffix.
2. **PTY dependency** — Freebuff requires a TTY. `node-pty` is used to simulate one, which requires native compilation.
3. **Dynamic response detection** — Watches a hash of the transcript: minimum 10s wait, then 6s of unchanged output before a reply is accepted. A reply that streams faster than the screen scrolls is still captured, because scrollback is included.
4. **Single-threaded per user** — Only one input can be processed at a time per user. Concurrent messages are rejected with a "please wait" message.
5. **No persistent sessions** — Sessions are destroyed on idle timeout (30 min) or process restart.
6. **Logo filtering** — Freebuff's ASCII logo is filtered out from responses using pattern matching.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot doesn't respond | Check `BALE_BOT_TOKEN`, verify internet connection, check console logs |
| Freebuff won't start | Run `freebuff --version` to verify installation; check `freebuffPath` in config |
| Empty responses | Increase `SESSION_TIMEOUT_MS`, check `responseWaitMs` in `freebuff.js` |
| PTY native build fails | Ensure build tools are installed (`build-essential` on Linux, Xcode on macOS) |
| "Access denied" messages | You need to authenticate first — send `/start` to get your token, then `/start <token>` |
| Token not working | Make sure you're using the exact token shown in `/start` response |

### Testing

Extraction is the fragile part of this project, so it is separated from the PTY layer and tested offline with the built-in Node test runner.

```bash
npm test              # run the suite (no Freebuff, no network, no API keys needed)
npm run fixtures      # regenerate the synthetic fixtures
npm run record -- --input "your prompt" --name my-session --text
npm run replay -- fixtures/my-session.json
```

| Path | Purpose |
|------|---------|
| `test/vt-screen.test.js` | Scrollback, scrolling regions, cursor addressing, malformed escapes |
| `test/extract.test.js` | Noise filtering, sentinel matching, diff fallback, digest |
| `test/pipeline.test.js` | Replays recorded fixtures end-to-end and asserts nothing is lost or leaked |
| `fixtures/real-*.json` | Captures of actual Freebuff 0.0.153 sessions — the ground truth |
| `tools/record-session.js` | Records a live PTY session: every raw chunk with its timestamp |
| `tools/make-fixture.js` | Builds deterministic fixtures so CI needs no Freebuff install |

A recorded fixture stores the raw PTY chunks plus a marker recording the moment the prompt was submitted, so `src/replay.js` can rebuild the exact transcript and cut the reply at the same point production would — no timing or heuristics involved. Set `FREEBUFF_DEBUG=1` to get the raw transcript and extracted reply logged on every request.

The synthetic fixtures mirror the real layout recorded from Freebuff 0.0.153 (block-character splash, bordered stats box, status bar, input box, model bar) so CI needs no Freebuff install. The real fixtures are what caught every layout bug listed above — re-record them whenever Freebuff is upgraded.

### Error Handling

- **Poll timeout** — Handled gracefully, polling continues automatically.
- **API errors** — Logged to console, 3-second backoff before retry.
- **PTY spawn failure** — Emits `exit` event with code -1.
- **Session idle timeout** — Emits `exit` event, session is destroyed and cleaned up.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` handlers stop the bot and destroy all sessions.

---

## Environment Variables Reference

```bash
# Required
BALE_BOT_TOKEN=your_bot_token_here

# Optional (with defaults)
USERS_FILE=users.json                # User authentication database path
FREEBUFF_PATH=freebuff               # Path to freebuff executable
FREEBUFF_WORKING_DIR=/path/to/dir    # Freebuff working directory
SESSION_TIMEOUT_MS=1800000           # 30 minutes
MAX_OUTPUT_LENGTH=3500               # Bale message limit
POLL_TIMEOUT=30                      # Long-poll timeout in seconds
RESPONSE_WAIT_MS=60000               # 60 seconds
```
