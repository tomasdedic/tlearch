# Exercise 07 — RocketChat Bot Mode

## Overview

Because the `Agent` class (Stage 4) is decoupled from the UI via `TypedEmitter`,
adding a new "mode" is just writing a new **transport adapter**. Nothing in the
agent changes.

```
        Agent (03-agent-class.ts)
        .register(tools)  .on("event", fn)  .run(msg)
                          |
           +--------------+--------------+
           v                             v                   v
     Ink TUI (Stage 4)        RocketChat (this file)    Print mode
        (React)                (SDK adapter)            (stdout only)
```

## How it works end-to-end

```
User types in RocketChat              Bot process (your server)
--------------------                  -------------------------
@bot what time is it?  --SDK ws-->  onMessage(msg)
                                          |
                                    handleIncoming()
                                          | ignore backlog, check "stop"
                                    channel.queue.enqueue(...)
                                          |
                                    sendToRoom("_thinking..._")  -->  [_thinking..._] appears
                                          |
                                    agent.run(msg, history)
                                          |
                                    text_delta "It's "          -->  updateMessage() edits live:
                                    text_delta "3pm"            -->  "It's 3pm ▋"
                                    text_delta "."              -->
                                          |
                                    flush(final=true)           -->  final edit: "It's 3pm."
                                          |
                                    saveHistory(channel)
```

Key points:
- **One placeholder message** is posted (`_thinking..._`), then edited in place as tokens stream in (throttled to 400ms). Users see it update live.
- **`stop` command** aborts the in-flight `AbortController` immediately and posts `_Stopped._`.
- **Per-channel `ChannelQueue`** ensures serial processing within a room even if users send multiple messages quickly.
- **Agent factory** — a fresh `Agent` instance is created per message run, so concurrent channels never share the same event emitter and leak text into each other.

## Running

**Simulation (no server needed):**
```bash
npm run ex exercises/07-rocketchat/bot.ts
```

**Real RocketChat:**
```bash
npm install @rocket.chat/sdk

ROCKETCHAT_HOST=your.rocket.chat \
ROCKETCHAT_USER=bot \
ROCKETCHAT_PASS=secret \
ROCKETCHAT_ROOMS=GENERAL,team-dev \
ANTHROPIC_API_KEY=sk-ant-... \
npm run ex exercises/07-rocketchat/bot.ts -- --live
```

`ROCKETCHAT_SSL=true` if your server uses HTTPS.

## Key patterns

| Pattern | Where | Why |
|---------|-------|-----|
| `AgentFactory = () => Agent` | `RocketChatBot` constructor | Isolates events per run; prevents concurrent channels sharing one event bus |
| `ChannelQueue` (promise chain) | per room | Serial message processing within a room |
| Throttled `updateMessage` | `flush()` | Avoids spamming the server with an edit per token |
| Pre-startup filter (`msg.ts.$date < startedAt`) | `handleIncoming` | Ignores backlog of old messages on boot |
| Per-channel `history` + JSON persist | `loadHistory` / `saveHistory` | Conversation survives bot restarts |
| Output queue (`logQueue` promise chain) | `SimulatedDriver` | Serialises stdout writes so concurrent channels don't interleave |

## Comparison with pi-mono mom

Same core architecture — different scope.

### What maps directly

| Our `bot.ts` | pi-mono `packages/mom/` |
|---|---|
| `ChannelQueue` (promise chain) | `ChannelQueue` (array + `processing` flag + `processNext()`) |
| `startedAt` ms filter | `startupTs` Slack float-seconds filter |
| Stop command bypasses queue, aborts | Same |
| `AgentFactory` → fresh `Agent` per run | New `AgentRunner` per channel in `agent.ts` |
| `loadHistory` / `saveHistory` → `history.json` | `SessionManager` syncing `log.jsonl` → `context.jsonl` |
| `flush()` throttled `updateMessage` | `replaceMessage()` accumulation in `SlackContext` |

### What pi-mom has that ours doesn't

**1. 3-layer separation** — pi-mom splits responsibility across three files we collapsed into one:

```
pi-mom:                              our bot:
  SlackBot      (platform adapter)
  main.ts       (glue + context)      RocketChatBot  (does all three)
  AgentRunner   (agent core)
```

**2. Mention filtering** — pi-mom has two separate Slack event handlers:
- `app_mention` → fires only when @mentioned in a public channel
- `message` → fires for DMs and all channel messages (for logging)

Our bot responds to every message in every joined room (task 4 fixes this).

**3. "Already working" reply** — pi-mom posts `_Already working. Say stop to cancel._`
if the channel is busy. We silently queue behind the existing work.

**4. Thread replies** — tool execution details (args + results) post to the thread
of the original message via `respondInThread()`. We post indicator messages to the
main channel.

**5. Full message logging** — pi-mom logs ALL messages (including ones it doesn't
act on) to `log.jsonl`, then syncs to `context.jsonl` on startup. This means the
agent sees full channel history, not just the turns it participated in.

**6. Backfill on startup** — fetches recent Slack history via API to fill in
messages that arrived while the bot was offline. We have no backfill.

**7. `SlackContext` abstraction** — wraps all platform operations behind generic
async functions passed into the agent core:

```ts
// pi-mom SlackContext shape:
{
  respond(text): Promise<void>
  replaceMessage(text): Promise<void>
  respondInThread(text): Promise<void>
  setTyping(isTyping): Promise<void>
  uploadFile(path, title?): Promise<void>
  setWorking(working): Promise<void>
  deleteMessage(): Promise<void>
}
```

Our driver interface only has `sendToRoom` and `updateMessage`.

**8. Image/attachment handling** — downloads file attachments, base64-encodes them,
and passes as `ImageContent` to the agent for vision capabilities. We ignore
attachments.

**9. Full coding agent** — pi-mom uses `@mariozechner/pi-coding-agent` with the
complete tool suite (bash, read/write/edit/grep, sandbox), `AgentSession` for
persistent context, and a rich system prompt that includes workspace layout, skills,
memory files, and Slack formatting rules. We use our simplified `Agent` from Stage 4.

### pi-mom `slack.ts` line count vs ours

| File | Lines | Scope |
|------|-------|-------|
| `packages/mom/src/slack.ts` | ~620 | Platform adapter only |
| `packages/mom/src/main.ts` | ~200 | Glue + context |
| `packages/mom/src/agent.ts` | ~250 | Agent runner |
| `packages/mom/src/` (total) | ~1500 | Full production bot |
| our `bot.ts` | ~470 | All-in-one teaching example |

## How pi-mono manages context

pi-mom has a significantly more sophisticated context system than our bot.
Here is how it works end-to-end.

### Two files per channel

```
workspace/
└── {channelId}/
    ├── log.jsonl        <- human-readable history (user messages + bot final replies, NO tool results)
    └── context.jsonl    <- structured API messages (full LLM format: tool_use + tool_result blocks)
```

`log.jsonl` is for humans and grep. `context.jsonl` is what gets sent to the LLM.
They are kept in sync by `syncLogToSessionManager()` on every run.

### Context flow on each incoming message

```
1. syncLogToSessionManager(log.jsonl → context.jsonl)
      adds any user messages logged while bot was offline or busy

2. sessionManager.buildSessionContext()
      loads context.jsonl into memory → agent.replaceMessages()

3. rebuild system prompt
      fresh MEMORY.md + channel list + user list + skills on every run

4. session.prompt(userMessage)
      appends user message, runs agent loop, auto-persists all messages to context.jsonl

5. queueChain drains (Slack API calls complete)
```

### SessionManager vs our simple array

| | Our `bot.ts` | pi-mom |
|---|---|---|
| Storage format | `{ role, content: string }[]` | Full LLM API format including `tool_use` / `tool_result` blocks |
| Persistence | `history.json` (simple JSON) | `context.jsonl` (append-only JSONL) |
| Per-channel runner | New `Agent` per message (factory) | One persistent `Agent` per channel (`channelRunners` Map) |
| Context loaded | Passed in as parameter each run | `agent.replaceMessages()` reloads from file each run |
| Offline messages | Not synced | `syncLogToSessionManager` catches up |
| Context limit | Manual trim to `maxHistory` count | Auto-compaction: summarises old messages when window fills |

### Auto-compaction

When the context window approaches its limit, `AgentSession` automatically summarises
the oldest messages into a compact summary and replaces them. The user sees
`_Compacting context..._` in Slack. Settings (from `settings.json`):

```
reserveTokens:    16384   <- always keep this many tokens free for the next reply
keepRecentTokens: 20000   <- always keep the most recent 20k tokens verbatim
```

#### How it triggers

After every LLM response, `AgentSession` checks:

```
contextTokens > contextWindow - reserveTokens
```

Token count comes from the last assistant message's `usage` field (real server count).
Any messages after that are estimated at `chars / 4`.
With a 200k context window: triggers at ~184k tokens.

#### What happens step by step

```
1. findCutPoint()
      walks backwards from newest message, accumulates estimated token sizes
      stops when accumulated >= keepRecentTokens (20k)
      everything BEFORE the cut → summarised and discarded
      everything AFTER the cut → kept verbatim

2. never cut at tool results
      cut points are only valid at: user / assistant / bashExecution / custom messages
      a tool_result must always follow its tool_call, so they stay together

3. split-turn handling
      if the cut point lands mid-turn (inside a long tool loop),
      generate a separate "turn prefix summary" for the discarded part of that turn
      merge into the main summary as "Turn Context (split turn)"

4. generateSummary()
      sends the messages-to-discard to the LLM (with reasoning: "high")
      produces a structured markdown checkpoint:

        ## Goal
        ## Constraints & Preferences
        ## Progress / Done / In Progress / Blocked
        ## Key Decisions
        ## Next Steps
        ## Critical Context
        ## Files Read / Modified

5. iterative update
      if there was a previous compaction, its summary is passed in as
      <previous-summary> and the LLM updates it rather than starting fresh
      → the summary accumulates knowledge across multiple compactions

6. store in context.jsonl
      a compaction entry is appended: { summary, firstKeptEntryId, tokensBefore }
      old entries before firstKeptEntryId are no longer loaded into the agent
      the summary becomes a compactionSummary message in the LLM context window
```

#### What the LLM sees after compaction

```
[compactionSummary]  ← the structured markdown summary of all discarded history
[user turn N]        ← first kept message (recent 20k tokens)
[assistant turn N]
[tool calls...]
[user turn N+1]      ← current message
```

The discarded messages are gone from the API call, replaced by the summary.
The summary is kept across future compactions (iteratively updated).

#### File tracking

The compaction also records which files were read and modified in the discarded
portion and appends them to the summary:

```
## Files Read
- src/foo.ts, src/bar.ts

## Files Modified
- src/foo.ts
```

This means even after compaction the LLM knows the history of what it touched.

### MEMORY.md — persistent working memory

Every run the system prompt is rebuilt and includes the content of two memory files:

```
workspace/MEMORY.md               <- global (shared across all channels)
workspace/{channelId}/MEMORY.md   <- channel-specific
```

The agent can write to these files using its `write` tool. This is how it remembers
things across conversations without needing them in the context window.
Example system prompt section:

```
## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (workspace/MEMORY.md): skills, preferences, project info
- Channel (workspace/C123/MEMORY.md): channel-specific decisions, ongoing work
```

### User message format

Every user message is prefixed with a timestamp and username before being sent to the LLM:

```
[2025-11-26 10:44:00+01:00] [mario]: what does the deploy script do?
```

This lets the model know who said what and when, without those details occupying
space in the system prompt.

### For older history: log queries

The system prompt tells the agent it can grep `log.jsonl` directly for history
that has been compacted out of the context window:

```bash
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'
grep -i "deploy" log.jsonl | jq -c '{date: .date[0:19], user: .userName, text}'
```

This is an elegant fallback: full tool_use history lives in the context window,
plain-text history lives in `log.jsonl` and can be searched with bash.

### What our bot does instead

Our `bot.ts` takes a much simpler approach sufficient for learning:

```
history = [{ role: "user"|"assistant", content: string }]
  - stored in .sessions/rocketchat/{roomId}.json
  - passed into agent.run() as a parameter each call
  - trimmed to maxHistory (40) messages by count
  - no tool_use/tool_result blocks (only final text per turn)
  - no auto-compaction
  - no MEMORY.md
```

The trade-off: simpler to understand and implement, but loses tool execution
history from the context, has no graceful handling of context overflow, and
cannot remember things explicitly across conversations.

## Mention filtering (task 4)

In a real deployment you typically only want the bot to respond in public channels
when it is @mentioned, and respond to everything in DMs.

```ts
// In handleIncoming(), before enqueuing:
const isDM = msg.rid.startsWith("D");   // DM room IDs start with D
const mentioned = msg.msg.includes(`@${this.config.botUsername}`);
if (!isDM && !mentioned) return;
```
