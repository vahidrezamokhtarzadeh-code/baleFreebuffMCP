# 🤖 Bale Freebuff Bot — Full Documentation

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Module Reference](#module-reference)
4. [Configuration](#configuration)
5. [Data Flow](#data-flow)
6. [Setup & Usage](#setup--usage)
7. [Bot Commands](#bot-commands)
8. [Limitations & Troubleshooting](#limitations--troubleshooting)

---

## Overview

**Bale Freebuff Bot** is a bridge service that connects the [Bale Messenger](https://bale.ai) bot platform (an Iranian messaging app with a Telegram-compatible Bot API) to [Freebuff](https://freebuff.com), an AI-powered coding CLI tool.

Users interact with Freebuff entirely through Bale chat messages — the bot spawns a Freebuff PTY process per user, sends their text as input, waits for a response, extracts the clean output from Freebuff's TUI, and sends it back as a Bale message.

### Key Design Decisions

- **Per-user PTY sessions** — each user gets an isolated `node-pty` process running Freebuff.
- **VT100 screen buffer emulation** — because Freebuff is a TUI app, the bot must parse terminal escape sequences to extract visible text content.
- **Region-based extraction** — only the conversation area (rows 9–31) of Freebuff's screen is captured, ignoring the logo, status bar, and input area.
- **Noise filtering** — box-drawing characters, status bar text, thinking indicators, and other TUI chrome are stripped via regex patterns.

---

## Architecture

```
┌────────────────────┐         ┌──────────────┐         ┌──────────────────┐
│   Bale Messenger   │◄──────►│  Bridge.js   │◄──────►│  Freebuff CLI    │
│   (Bot API)        │  HTTP   │              │  PTY   │  (via node-pty)  │
└────────────────────┘         └──────────────┘         └──────────────────┘
       bale.js                        │                         │
                               config.js                   vt-screen.js
```

### Component Summary

| File | Purpose |
|------|---------|
| `src/index.js` | Entry point — initializes bot, bridge, handles graceful shutdown |
| `src/bale.js` | Bale Bot API client (long-polling, send/delete messages) |
| `src/bridge.js` | Message routing — maps Bale chat IDs to Freebuff sessions |
| `src/freebuff.js` | Freebuff PTY wrapper — spawns process, sends input, extracts response |
| `src/vt-screen.js` | VT100/XTerm screen buffer emulator for terminal output parsing |
| `src/config.js` | Configuration loader (JSON file or environment variables) |

---

## Module Reference

### `src/index.js` — Entry Point

The `main()` function:
1. Loads configuration from `src/config.js`
2. Creates a `BaleBot` instance and verifies the token via `getMe()`
3. Creates a `Bridge` instance to handle message routing
4. Starts the long-polling loop via `bot.start()`
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
| `sendMessage(chatId, text, opts?)` | Send a text message. Options: `replyToMessageId`, `parseMode`. |
| `sendChatAction(chatId, action?)` | Send a typing indicator (default: `'typing'`). |
| `deleteMessage(chatId, messageId)` | Delete a message by ID. |
| `getUpdates()` | Long-poll for new messages. Tracks `offset` to avoid duplicates. |
| `start(onMessage)` | Start the polling loop. Calls `onMessage(msg)` for each incoming message. Continues on poll timeout. Retries after 3s on other errors. |
| `stop()` | Stop the polling loop. |
| `getMe()` | Fetch bot info (username, first_name, etc.). |

---

### `src/bridge.js` — `Bridge` Class

Routes Bale messages to per-chat Freebuff sessions. Manages the session lifecycle.

#### Constructor

```js
new Bridge(baleBot)
```

#### Internal State

- `sessions: Map<chatId, FreebuffSession>` — Active Freebuff sessions per chat
- `processing: Map<chatId, boolean>` — Prevents concurrent sends to the same session

#### Methods

| Method | Description |
|--------|-------------|
| `isAuthorized(userId)` | Returns `true` if user is in `allowedUsers` (or if list is empty). |
| `handleMessage(message)` | Main entry point. Checks authorization, routes commands vs text. |
| `handleCommand(chatId, text)` | Handles `/start`, `/help`, `/new`, `/stop`, `/status` commands. |
| `sendToFreebuff(chatId, text)` | Core flow: gets/creates a session, sends input, waits for response, sends result back. Blocks if already processing. |
| `createSession(chatId)` | Creates a new `FreebuffSession`, spawns it, waits for `ready` event (with timeout). |
| `stopSession(chatId)` | Destroys a session and removes it from the map. |
| `stopAll()` | Destroys all sessions (used during shutdown). |

#### Message Flow in `sendToFreebuff`

1. Check if already processing for this chat → reject with "please wait" message
2. Get or create session (spawn + wait for ready)
3. Set up one-shot `response`/`response_empty` event listeners
4. Call `session.sendInput(text)` (fire-and-forget, it has its own timer)
5. Await the response event
6. Truncate if exceeds `maxOutputLength` (3500 chars by default)
7. Send the response back via `baleBot.sendMessage()`

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

#### Response Extraction

The `_grabAndFlush()` method:
1. Gets the current conversation area (rows 9–31) from VTScreen
2. Compares with the pre-input snapshot
3. Filters noise patterns (box-drawing, status bar, thinking indicators)
4. Identifies new lines (lines in "after" not in "before")
5. Post-processes: collapses blank lines, removes thinking blocks

#### Noise Patterns

Lines matching these are filtered out:

- Box-drawing/border characters (`╔╗╚╝═║─│╭╮╰╯...`)
- Freebuff status bar (`X of Y sessions`, `MiMo/DeepSeek...`)
- Timestamps (`[HH:MM:SS AM]`)
- Freebuff chrome (`Freebuff will run`, `Directory ~/`, `Ask Freebuff`)
- Thinking indicators (`Thinking`, `Reading`, `Editing`, `Planning`...)
- Prompt lines (`❯`, `>`, `▍`, `Enter a coding task`)
- Empty/whitespace-only lines

---

### `src/vt-screen.js` — `VTScreen` Class

A VT100/XTerm screen buffer emulator. Tracks virtual terminal content by processing raw escape sequences from the PTY.

#### Constructor

```js
new VTScreen(cols = 120, rows = 40)
```

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
| `getText()` | Get all visible text (line by line, trailing spaces trimmed). |
| `getRow(row)` | Get text content of a specific row. |
| `getRegion(startRow, endRow)` | Get text from a row range. |
| `getCleanText()` | Extract text while stripping box-drawing characters at the cell level. |
| `snapshot()` | Alias for `getText()`, used for diffing. |
| `hasChar(ch)` | Check if a character exists anywhere on screen. |
| `VTScreen.snapshotsDifferent(a, b)` | Static method to compare two snapshots. |

#### Escape Sequence Support

The VTScreen processes these escape sequences:

| Sequence | Description |
|----------|-------------|
| `ESC [` | CSI (Control Sequence Introducer) |
| `ESC ]` | OSC (Operating System Command) |
| CSI `H`/`f` | Cursor Position (CUP) |
| CSI `A`-`G` | Cursor movement (up/down/forward/back/next-line/prev-line/horizontal-absolute) |
| CSI `J` | Erase in Display (0=to-end, 1=from-start, 2/3=entire) |
| CSI `K` | Erase in Line (0=to-end, 1=from-start, 2=entire) |
| CSI `L`/`M` | Insert/Delete Lines |
| CSI `S`/`T` | Scroll Up/Down |
| CSI `X`/`P` | Erase/Delete Characters |
| CSI `d` | Vertical Position Absolute (VPA) |
| CSI `m` | SGR (colors/styles — parsed but not tracked) |
| CSI `h`/`l` | Set/Reset Mode (ignored) |
| `ESC 7`/`8` | Save/Restore Cursor |
| `ESC M` | Reverse Index |
| `ESC D` | Index (line feed) |
| `ESC c` | Full Reset |

---

### `src/config.js` — Configuration

Loads configuration from `config.json` (if exists) with environment variable overrides.

#### Configuration Options

| Option | Env Variable | Default | Description |
|--------|-------------|---------|-------------|
| `baleToken` | `BALE_BOT_TOKEN` | *required* | Bale Bot API token |
| `allowedUsers` | `ALLOWED_USERS` | `[]` (all) | Comma-separated user IDs |
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
│   ├─ Check authorization
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

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message and command list |
| `/help` | Show help guide |
| `/new` | Destroy current session and start fresh |
| `/stop` | Stop current session |
| `/status` | Show session status (uptime, working dir) |

Any non-command text message is sent directly as input to Freebuff.

---

## Limitations & Troubleshooting

### Known Limitations

1. **Message length** — Bale limits messages to ~4096 characters. Output is truncated at 3500 chars with a "... (بریده شد)" suffix.
2. **PTY dependency** — Freebuff requires a TTY. `node-pty` is used to simulate one, which requires native compilation.
3. **Response wait** — A fixed 60-second wait is used before extracting the response. Fast responses may have wasted time; slow responses may be incomplete.
4. **Single-threaded per user** — Only one input can be processed at a time per chat. Concurrent messages are rejected with a "please wait" message.
5. **No persistent sessions** — Sessions are destroyed on idle timeout (30 min) or process restart.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot doesn't respond | Check `BALE_BOT_TOKEN`, verify internet connection, check console logs |
| Freebuff won't start | Run `freebuff --version` to verify installation; check `freebuffPath` in config |
| Empty responses | Increase `SESSION_TIMEOUT_MS`, check `responseWaitMs` in `freebuff.js` |
| PTY native build fails | Ensure build tools are installed (`build-essential` on Linux, Xcode on macOS) |
| "Access denied" messages | Add your user ID to `allowedUsers` in config |

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
ALLOWED_USERS=                    # Comma-separated user IDs (empty = all)
FREEBUFF_PATH=freebuff            # Path to freebuff executable
FREEBUFF_WORKING_DIR=/path/to/dir # Freebuff working directory
SESSION_TIMEOUT_MS=1800000        # 30 minutes
MAX_OUTPUT_LENGTH=3500            # Bale message limit
POLL_TIMEOUT=30                   # Long-poll timeout in seconds
RESPONSE_WAIT_MS=60000            # 60 seconds
```
