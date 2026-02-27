/**
 * Exercise 07-rocketchat/bot.ts
 *
 * CONCEPTS: transport adapter pattern, per-channel queuing, live message editing
 *
 * Run simulation: npm run ex exercises/07-rocketchat/bot.ts
 * Run real bot:   ROCKETCHAT_HOST=... ROCKETCHAT_USER=... ROCKETCHAT_PASS=...
 *                 ANTHROPIC_API_KEY=... npm run ex exercises/07-rocketchat/bot.ts --live
 *
 * Real bot requires: npm install @rocket.chat/sdk
 *
 * ─── WHY THIS MATTERS ────────────────────────────────────────────────────────
 *
 * Because the Agent class (Stage 4) is decoupled from the UI, adding a new
 * "mode" is just writing a new adapter. Nothing in the agent changes.
 *
 * This is exactly pi-mono's architecture:
 *
 *        ┌─────────────────────────────────────────────────────┐
 *        │              Agent (03-agent-class.ts)              │
 *        │  .register(tools)  .on("event", fn)  .run(msg)      │
 *        └────────────────────────┬────────────────────────────┘
 *                                 │ AgentEvents
 *              ┌──────────────────┼──────────────────┐
 *              ▼                  ▼                  ▼
 *        ┌──────────┐    ┌──────────────┐    ┌──────────────┐
 *        │ Ink TUI  │    │ RocketChat   │    │ Print mode   │
 *        │ Stage 4  │    │ this file    │    │ --no-tty     │
 *        └──────────┘    └──────────────┘    └──────────────┘
 *           (React)       (SDK adapter)      (stdout only)
 *
 * pi-mono's equivalent: packages/mom/ (Slack bot)
 * Key patterns mirrored from packages/mom/src/slack.ts and agent.ts:
 *   1. Per-channel ChannelQueue (serial processing within a room)
 *   2. Live message editing with throttle (not spamming new messages)
 *   3. Stop command to cancel in-flight runs
 *   4. Per-channel conversation history
 *   5. Pre-startup message filter (ignore old messages)
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	Agent,
	type AgentEvent,
	getTimeTool,
	listDirTool,
	readFileTool,
} from "../06-tools/03-agent-class.js";

// ─── ROCKETCHAT DRIVER INTERFACE ─────────────────────────────────────────────
// We define the interface we need from the SDK.
// This makes it easy to swap the real SDK for a mock in simulation mode.

type IncomingMessage = {
	_id: string;       // message ID
	rid: string;       // room ID
	msg: string;       // message text
	u: { _id: string; username: string }; // sender
	ts: { $date: number }; // timestamp (unix ms)
};

type SentMessage = {
	_id: string;       // message ID assigned by server
	rid: string;
	msg: string;
};

interface RocketChatDriver {
	connect(opts: { host: string; useSsl: boolean }): Promise<void>;
	login(opts: { username: string; password: string }): Promise<{ userId: string }>;
	subscribeToMessages(): Promise<void>;
	joinRoom(roomId: string): Promise<void>;
	onMessage(handler: (message: IncomingMessage) => void): void;
	sendToRoom(roomId: string, text: string): Promise<SentMessage>;
	updateMessage(msgId: string, roomId: string, text: string): Promise<void>;
}

// ─── CHANNEL QUEUE ────────────────────────────────────────────────────────────
// Ensures messages in the same room are processed one at a time.
// If user sends 3 messages quickly, they run sequentially — not in parallel.
// This is the same pattern as pi-mom's ChannelQueue.

class ChannelQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue(task: () => Promise<void>): void {
		// Chain the new task onto the end of the current tail.
		// Each task waits for the previous one to finish.
		this.tail = this.tail.then(task).catch(() => {
			// Swallow errors so one failed task doesn't block the queue.
		});
	}
}

// ─── PER-CHANNEL STATE ────────────────────────────────────────────────────────
// Each room gets its own queue, history, and abort controller.

type ChannelState = {
	queue: ChannelQueue;
	history: { role: "user" | "assistant"; content: string }[];
	controller: AbortController | null;
};

// ─── ROCKETCHAT BOT ───────────────────────────────────────────────────────────

type BotConfig = {
	botUsername: string;
	sessionDir: string;    // where to persist per-channel history
	maxHistory: number;    // max messages to keep in context
	updateThrottleMs: number; // min ms between Rocket message edits
	stopCommand: string;   // text that cancels the current run
};

const DEFAULT_CONFIG: BotConfig = {
	botUsername: "bot",
	sessionDir: ".sessions/rocketchat",
	maxHistory: 40,
	updateThrottleMs: 400, // edit message at most every 400ms
	stopCommand: "stop",
};

// Each message run gets its own Agent instance, so events from concurrent
// channel runs never leak into each other's accumulators.
// This mirrors pi-mom: a new agent context is created per incoming message.
type AgentFactory = () => Agent;

class RocketChatBot {
	private channels = new Map<string, ChannelState>();
	private startedAt = Date.now();
	private agentFactory: AgentFactory;
	private config: BotConfig;

	constructor(agentFactory: AgentFactory, config: Partial<BotConfig> = {}) {
		this.agentFactory = agentFactory;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	// ── Entry point ───────────────────────────────────────────────────────────

	async start(driver: RocketChatDriver): Promise<void> {
		await mkdir(this.config.sessionDir, { recursive: true });

		driver.onMessage((msg) => this.handleIncoming(msg, driver));

		console.log(`[bot] started as @${this.config.botUsername}`);
		console.log(`[bot] ignoring messages older than startup time`);
	}

	// ── Message dispatch ──────────────────────────────────────────────────────

	private handleIncoming(msg: IncomingMessage, driver: RocketChatDriver): void {
		// 1. Ignore our own messages:
		if (msg.u.username === this.config.botUsername) return;

		// 2. Pre-startup filter: ignore messages that existed before we booted.
		//    This prevents the bot from replying to a backlog of old messages.
		//    Same pattern as pi-mom's timestamp filter.
		if (msg.ts.$date < this.startedAt) return;

		// 3. Stop command — cancel immediately, don't queue:
		if (msg.msg.trim().toLowerCase() === this.config.stopCommand) {
			this.getChannel(msg.rid).controller?.abort();
			driver.sendToRoom(msg.rid, "_Stopped._").catch(() => {});
			return;
		}

		// 4. Enqueue in the channel's serial queue:
		const channel = this.getChannel(msg.rid);
		channel.queue.enqueue(() => this.processMessage(msg, channel, driver));
	}

	// ── Process one message (runs serially per channel) ───────────────────────

	private async processMessage(
		msg: IncomingMessage,
		channel: ChannelState,
		driver: RocketChatDriver,
	): Promise<void> {
		// Cancel any lingering previous run (shouldn't happen due to queue, but safe):
		channel.controller?.abort();
		const controller = new AbortController();
		channel.controller = controller;

		// Load persistent history from disk (survives bot restarts):
		await this.loadHistory(msg.rid, channel);

		// Send a "thinking" placeholder that we'll edit as text streams in:
		let liveMessage: SentMessage;
		try {
			liveMessage = await driver.sendToRoom(msg.rid, "_thinking..._");
		} catch {
			return; // can't send — bail out
		}

		let accumulatedText = "";
		let lastEditAt = 0;

		// Flush accumulated text to Rocket message (throttled):
		const flush = async (final = false) => {
			const now = Date.now();
			if (!final && now - lastEditAt < this.config.updateThrottleMs) return;
			lastEditAt = now;

			const display = accumulatedText + (final ? "" : " ▋");
			try {
				await driver.updateMessage(liveMessage._id, msg.rid, display || "_..._");
			} catch {
				// update failed (message deleted etc.) — ignore
			}
		};

		// Create a fresh agent for this run — isolates events from other concurrent runs:
		const agent = this.agentFactory();

		// Subscribe to agent events for this run:
		const unsub = agent.on("event", (event: AgentEvent) => {
			switch (event.type) {
				case "text_delta":
					accumulatedText += event.text;
					flush().catch(() => {}); // non-blocking throttled edit
					break;
				case "tool_call_start":
					// Post a small tool indicator (doesn't replace the main message):
					driver.sendToRoom(msg.rid, `_tool: ${event.name}..._`).catch(() => {});
					break;
				case "done":
				case "cancelled":
					break;
				case "error":
					accumulatedText += `\n\n⚠️ ${event.message}`;
					break;
			}
		});

		try {
			await agent.run(
				msg.msg,
				[...channel.history], // pass current history
				controller.signal,
			);
		} finally {
			unsub();
			channel.controller = null;

			// Final flush — send complete text without cursor:
			await flush(true);

			// Update per-channel history:
			if (accumulatedText.trim()) {
				channel.history.push(
					{ role: "user", content: msg.msg },
					{ role: "assistant", content: accumulatedText.trim() },
				);
				// Trim to maxHistory:
				if (channel.history.length > this.config.maxHistory) {
					channel.history = channel.history.slice(-this.config.maxHistory);
				}
				// Persist to disk:
				await this.saveHistory(msg.rid, channel.history);
			}
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private getChannel(roomId: string): ChannelState {
		if (!this.channels.has(roomId)) {
			this.channels.set(roomId, {
				queue: new ChannelQueue(),
				history: [],
				controller: null,
			});
		}
		return this.channels.get(roomId)!;
	}

	private historyPath(roomId: string): string {
		// Sanitise roomId — it's used as a filename:
		return join(this.config.sessionDir, `${roomId.replace(/[^a-z0-9]/gi, "_")}.json`);
	}

	private async loadHistory(
		roomId: string,
		channel: ChannelState,
	): Promise<void> {
		if (channel.history.length > 0) return; // already loaded
		try {
			const raw = await readFile(this.historyPath(roomId), "utf-8");
			channel.history = JSON.parse(raw);
		} catch {
			channel.history = []; // no history yet
		}
	}

	private async saveHistory(
		roomId: string,
		history: { role: string; content: string }[],
	): Promise<void> {
		try {
			await writeFile(this.historyPath(roomId), JSON.stringify(history, null, 2));
		} catch {
			// non-fatal
		}
	}
}

// ─── SIMULATION DRIVER ────────────────────────────────────────────────────────
// A fake RocketChat driver for testing without a real server.
// Implements the same interface as the real @rocket.chat/sdk driver.

class SimulatedDriver implements RocketChatDriver {
	private handlers: ((msg: IncomingMessage) => void)[] = [];
	private msgCounter = 0;
	private messages = new Map<string, { roomId: string; text: string }>();
	// Track which messages are "live" (started as _thinking..._).
	// These are only printed once, on final flush.
	private liveMessages = new Set<string>();

	// Serialise all stdout writes: one line at a time, never interleaved.
	// Without this, two concurrent channels calling console.log() simultaneously
	// can interleave on piped stdout (Node.js writes are not atomic on pipes).
	private logQueue = Promise.resolve();
	private log(line: string): void {
		this.logQueue = this.logQueue.then(() => {
			process.stdout.write(line + "\n");
		});
	}

	async connect() { this.log("[sim] connected"); }
	async login() { this.log("[sim] logged in"); return { userId: "bot-user" }; }
	async subscribeToMessages() { this.log("[sim] subscribed to messages"); }
	async joinRoom(id: string) { this.log(`[sim] joined room ${id}`); }

	onMessage(handler: (msg: IncomingMessage) => void): void {
		this.handlers.push(handler);
	}

	async sendToRoom(roomId: string, text: string): Promise<SentMessage> {
		const id = `msg-${++this.msgCounter}`;
		this.messages.set(id, { roomId, text });
		if (text === "_thinking..._") {
			// Placeholder — printed later by updateMessage on final flush
			this.liveMessages.add(id);
		} else {
			this.log(`\n[${roomId}] bot → ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`);
		}
		return { _id: id, rid: roomId, msg: text };
	}

	async updateMessage(msgId: string, roomId: string, text: string): Promise<void> {
		const entry = this.messages.get(msgId);
		if (entry) entry.text = text;
		// Only print on final flush (cursor gone) — not on every streaming update.
		if (this.liveMessages.has(msgId) && !text.endsWith(" ▋") && text !== "_..._") {
			const display = text.length > 400 ? `${text.slice(0, 400)}...` : text;
			this.log(`\n[${roomId}] bot → ${display}`);
		}
	}

	// Inject a fake user message (used by the simulation):
	injectMessage(roomId: string, username: string, text: string): void {
		const msg: IncomingMessage = {
			_id: `in-${++this.msgCounter}`,
			rid: roomId,
			msg: text,
			u: { _id: `user-${username}`, username },
			ts: { $date: Date.now() },
		};
		for (const handler of this.handlers) handler(msg);
	}
}

// ─── REAL DRIVER LOADER ───────────────────────────────────────────────────────
// Dynamically import @rocket.chat/sdk only when --live flag is passed.
// This way the file runs fine without the SDK installed (simulation mode).

async function loadRealDriver(): Promise<RocketChatDriver> {
	try {
		const { driver } = await import("@rocket.chat/sdk") as { driver: RocketChatDriver };
		return driver;
	} catch {
		throw new Error(
			"@rocket.chat/sdk not installed.\n" +
			"Run: npm install @rocket.chat/sdk\n" +
			"Then set ROCKETCHAT_HOST, ROCKETCHAT_USER, ROCKETCHAT_PASS env vars.",
		);
	}
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

async function main() {
	const isLive = process.argv.includes("--live");
	const apiKey = process.env.ANTHROPIC_API_KEY;

	// Agent factory: each message run gets an isolated Agent instance.
	// This prevents text_delta events from one channel leaking into another's
	// accumulator when two channels process messages concurrently.
	const agentFactory: AgentFactory = () =>
		new Agent(apiKey, {
			model: "claude-haiku-4-5-20251001",
			systemPrompt:
				"You are a helpful bot in a RocketChat workspace. " +
				"Be concise. Use tools when asked about files or directories.",
			maxTurns: 6,
		})
			.register(readFileTool)
			.register(listDirTool)
			.register(getTimeTool);

	const bot = new RocketChatBot(agentFactory, {
		botUsername: process.env.ROCKETCHAT_USER ?? "bot",
	});

	if (isLive) {
		// ── Real RocketChat mode ────────────────────────────────────────────
		const host = process.env.ROCKETCHAT_HOST;
		const user = process.env.ROCKETCHAT_USER;
		const pass = process.env.ROCKETCHAT_PASS;

		if (!host || !user || !pass) {
			console.error("Set ROCKETCHAT_HOST, ROCKETCHAT_USER, ROCKETCHAT_PASS");
			process.exit(1);
		}

		const driver = await loadRealDriver();
		await driver.connect({ host, useSsl: process.env.ROCKETCHAT_SSL === "true" });
		await driver.login({ username: user, password: pass });
		await driver.subscribeToMessages();

		const rooms = (process.env.ROCKETCHAT_ROOMS ?? "GENERAL").split(",");
		for (const room of rooms) await driver.joinRoom(room.trim());

		await bot.start(driver);
		console.log("[bot] listening for messages. Ctrl+C to stop.");

	} else {
		// ── Simulation mode ─────────────────────────────────────────────────
		console.log("RocketChat Bot — Simulation Mode");
		console.log("(run with --live for real RocketChat)\n");

		const driver = new SimulatedDriver();
		await driver.connect({ host: "sim", useSsl: false });
		await driver.login({ username: "bot", password: "" });
		await driver.subscribeToMessages();
		await driver.joinRoom("GENERAL");
		await bot.start(driver);

		// Simulate a conversation across two rooms:
		const scenarios: Array<{ delay: number; room: string; user: string; msg: string }> = [
			{ delay: 300,  room: "GENERAL",  user: "alice", msg: "What time is it?" },
			{ delay: 500,  room: "GENERAL",  user: "bob",   msg: "List the files here" },
			// Test per-channel queuing: bob sends again before alice's response finishes
			{ delay: 600,  room: "GENERAL",  user: "bob",   msg: "What is TypeScript?" },
			// Different room — processed in parallel with GENERAL
			{ delay: 400,  room: "team-dev", user: "carol", msg: "Read the package.json" },
			// Test stop command
			{ delay: 2000, room: "GENERAL",  user: "alice", msg: "stop" },
		];

		console.log("Injecting simulated messages...\n");
		for (const s of scenarios) {
			await new Promise((r) => setTimeout(r, s.delay));
			console.log(`\n[${s.room}] ${s.user}: ${s.msg}`);
			driver.injectMessage(s.room, s.user, s.msg);
		}

		// Wait for all queued work to finish before exiting:
		await new Promise((r) => setTimeout(r, 5000));
		console.log("\n[sim] done");
	}
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) main().catch(console.error);

/**
 * WHAT YOU JUST BUILT vs. pi-mono's packages/mom/:
 *
 * This file     ←→  pi-mom
 * ─────────────────────────────────────────────────────
 * ChannelQueue  ←→  ChannelQueue in slack.ts
 * ChannelState  ←→  per-channel state map in SlackBot
 * processMessage←→  handler.handleEvent() in main.ts
 * flush()       ←→  updatePromise chain in SlackContext
 * loadHistory() ←→  SessionManager loading context.jsonl
 * saveHistory() ←→  SessionManager persisting context.jsonl
 * stop command  ←→  stopRequested flag + abort in slack.ts
 * startedAt     ←→  timestamp filter in slack.ts
 *
 * What pi-mom has that this doesn't (yet):
 *   - Thread replies (tool results go to thread, not main channel)
 *   - Message splitting at 40,000 char Slack limit
 *   - MEMORY.md per-channel working memory
 *   - Cron scheduling (process messages on a schedule)
 *   - Sandbox runtime integration
 *
 * TASK:
 *
 * 1. Add thread replies: when a tool call happens, send the result to the
 *    thread of the original message (not the main channel).
 *    In @rocket.chat/sdk, this is done by passing `tmid: originalMsgId`
 *    to sendToRoom(). Track `liveMessage._id` as the thread root.
 *
 * 2. Add message splitting: if accumulatedText exceeds 4000 chars,
 *    start a new message (sendToRoom) instead of editing the original.
 *    Track multiple message IDs and edit the latest one.
 *
 * 3. Add a /memory command: `!memory <text>` appends a line to a
 *    per-channel MEMORY.md file. Include that file's content in the
 *    system prompt on every run. This is pi-mom's memory system.
 *
 * 4. Add mention filtering: in a public channel, only respond when
 *    the bot is @mentioned. In DMs, respond to all messages.
 *    Check if msg.msg contains `@botUsername` for public channels.
 *    This is the app_mention vs. message.im distinction in pi-mom.
 */
