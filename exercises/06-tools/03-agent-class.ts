/**
 * Exercise 06-tools/03-agent-class.ts
 *
 * CONCEPTS: Agent class, TypedEventEmitter, tool registration, the agent loop
 *
 * Run with: ANTHROPIC_API_KEY=sk-... npm run ex exercises/06-tools/03-agent-class.ts
 * Simulation: npm run ex exercises/06-tools/03-agent-class.ts
 *
 * This is the architectural heart of pi-mono.
 * The Agent class lives OUTSIDE React — it's pure TypeScript.
 * It emits events; the UI (Ink) subscribes and updates state.
 *
 * Key insight: separating agent logic from UI means you can:
 *   - Test the agent without a terminal
 *   - Swap the UI (Ink → web → Slack) without changing agent code
 *   - Reuse the agent in scripts, tests, RPC servers
 *
 * From packages/agent/src/agent.ts and agent-loop.ts
 *
 * This file EXPORTS the Agent class (used by 05-capstone.tsx)
 * AND runs a demo at the bottom when executed directly.
 */

import Anthropic from "@anthropic-ai/sdk";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";

// ─── TOOL DEFINITION ─────────────────────────────────────────────────────────

export type AgentTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>; // JSON Schema for parameters
	execute: (input: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
};

// ─── AGENT EVENTS ─────────────────────────────────────────────────────────────
// Every state change the Agent emits as an event.
// The UI subscribes and translates events → React state updates.

export type AgentEvent =
	| { type: "turn_start"; turn: number }
	| { type: "text_delta"; text: string }
	| { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_call_done"; id: string; name: string; result: string; isError: boolean }
	| { type: "turn_done"; text: string; hadTools: boolean }
	| { type: "done"; text: string; turns: number; inputTokens: number; outputTokens: number }
	| { type: "error"; message: string }
	| { type: "cancelled" };

// ─── TYPED EVENT EMITTER (from 02-async/02-async-await.ts) ────────────────────

class TypedEmitter<TEvents extends Record<string, unknown[]>> {
	private emitter = new EventEmitter();

	on<K extends keyof TEvents & string>(
		event: K,
		listener: (...args: TEvents[K]) => void,
	): () => void {
		this.emitter.on(event, listener as (...args: unknown[]) => void);
		return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
	}

	emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K]): void {
		this.emitter.emit(event, ...args);
	}
}

// ─── AGENT CLASS ──────────────────────────────────────────────────────────────

export type AgentOptions = {
	model?: string;
	maxTokens?: number;
	maxTurns?: number;      // safety limit on agent loop iterations
	systemPrompt?: string;
};

export class Agent extends TypedEmitter<{ event: [AgentEvent] }> {
	private tools = new Map<string, AgentTool>();
	private client: Anthropic | null;
	private options: Required<AgentOptions>;

	constructor(apiKey?: string, options: AgentOptions = {}) {
		super();
		this.client = apiKey ? new Anthropic({ apiKey }) : null;
		this.options = {
			model: options.model ?? "claude-haiku-4-5-20251001",
			maxTokens: options.maxTokens ?? 1024,
			maxTurns: options.maxTurns ?? 10,
			systemPrompt: options.systemPrompt ?? "You are a helpful assistant.",
		};
	}

	// Register a tool. Returns `this` for chaining:
	//   agent.register(readTool).register(bashTool).register(writeTool)
	register(tool: AgentTool): this {
		this.tools.set(tool.name, tool);
		return this;
	}

	unregister(name: string): this {
		this.tools.delete(name);
		return this;
	}

	get toolNames(): string[] {
		return [...this.tools.keys()];
	}

	// Build the Anthropic tool spec from registered tools:
	private getAnthropicTools(): Anthropic.Tool[] {
		return [...this.tools.values()].map((t) => ({
			name: t.name,
			description: t.description,
			input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
		}));
	}

	// Convert messages to Anthropic's format:
	private static toApiMessages(messages: { role: "user" | "assistant"; content: string }[]): Anthropic.MessageParam[] {
		return messages.map((m) => ({ role: m.role, content: m.content }));
	}

	// THE AGENT LOOP ─────────────────────────────────────────────────────────
	// This method drives the entire agent lifecycle.
	// It runs until:
	//   1. The LLM stops using tools (stop_reason = "stop")
	//   2. maxTurns is exceeded
	//   3. signal is aborted
	//   4. An error occurs

	async run(
		userMessage: string,
		history: { role: "user" | "assistant"; content: string }[] = [],
		signal = new AbortController().signal,
	): Promise<void> {
		if (!this.client) {
			// Simulation mode (no API key):
			await this.simulate(userMessage, signal);
			return;
		}

		const apiMessages: Anthropic.MessageParam[] = [
			...Agent.toApiMessages(history),
			{ role: "user", content: userMessage },
		];

		let turn = 0;
		let finalText = "";
		let totalInputTokens = 0;
		let totalOutputTokens = 0;

		while (!signal.aborted && turn < this.options.maxTurns) {
			turn++;
			this.emit("event", { type: "turn_start", turn });

			let turnText = "";
			const toolCallsThisTurn: Anthropic.ToolUseBlock[] = [];

			// Stream LLM response:
			try {
				const stream = this.client.messages.stream(
					{
						model: this.options.model,
						max_tokens: this.options.maxTokens,
						system: this.options.systemPrompt,
						tools: this.getAnthropicTools(),
						messages: apiMessages,
					},
					{ signal },
				);

				for await (const event of stream) {
					if (signal.aborted) break;

					if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
						this.emit("event", { type: "text_delta", text: event.delta.text });
						turnText += event.delta.text;
					}

					if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
						// Tool call detected — input will be complete in finalMessage
					}
				}

				const finalMsg = await stream.finalMessage();
				totalInputTokens += finalMsg.usage.input_tokens;
				totalOutputTokens += finalMsg.usage.output_tokens;

				// Collect complete tool use blocks:
				for (const block of finalMsg.content) {
					if (block.type === "tool_use") toolCallsThisTurn.push(block);
				}

				if (finalMsg.stop_reason !== "tool_use" || signal.aborted) {
					// We're done — no more tools needed
					finalText = turnText;
					this.emit("event", { type: "turn_done", text: turnText, hadTools: false });
					break;
				}

				// Append assistant turn to message history:
				apiMessages.push({ role: "assistant", content: finalMsg.content });

			} catch (err) {
				if (signal.aborted) { this.emit("event", { type: "cancelled" }); return; }
				this.emit("event", { type: "error", message: err instanceof Error ? err.message : String(err) });
				return;
			}

			// Execute all tool calls (in parallel):
			this.emit("event", { type: "turn_done", text: turnText, hadTools: true });

			const toolResults = await Promise.all(
				toolCallsThisTurn.map(async (block): Promise<Anthropic.ToolResultBlockParam> => {
					const tool = this.tools.get(block.name);
					const input = block.input as Record<string, unknown>;

					this.emit("event", { type: "tool_call_start", id: block.id, name: block.name, input });

					let result = "";
					let isError = false;

					if (!tool) {
						result = `Unknown tool: ${block.name}`;
						isError = true;
					} else {
						try {
							result = await tool.execute(input, signal);
						} catch (e) {
							result = e instanceof Error ? e.message : String(e);
							isError = true;
						}
					}

					this.emit("event", { type: "tool_call_done", id: block.id, name: block.name, result, isError });
					return { type: "tool_result", tool_use_id: block.id, content: result, is_error: isError };
				}),
			);

			// Append tool results so the LLM can continue:
			apiMessages.push({ role: "user", content: toolResults });
		}

		if (turn >= this.options.maxTurns) {
			this.emit("event", { type: "error", message: `Exceeded maxTurns (${this.options.maxTurns})` });
			return;
		}

		this.emit("event", {
			type: "done",
			text: finalText,
			turns: turn,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
		});
	}

	// Simulation (no API key needed for testing):
	private async simulate(prompt: string, signal: AbortSignal): Promise<void> {
		async function delay(ms: number) {
			await new Promise<void>((r, rej) => {
				const t = setTimeout(r, ms);
				signal.addEventListener("abort", () => { clearTimeout(t); rej(); });
			});
		}

		this.emit("event", { type: "turn_start", turn: 1 });

		if (this.tools.size > 0) {
			const firstTool = [...this.tools.values()][0];
			await delay(200);
			this.emit("event", { type: "tool_call_start", id: "sim1", name: firstTool.name, input: {} });
			await delay(400);
			try {
				const result = await firstTool.execute({}, signal);
				this.emit("event", { type: "tool_call_done", id: "sim1", name: firstTool.name, result, isError: false });
			} catch (e) {
				this.emit("event", { type: "tool_call_done", id: "sim1", name: firstTool.name, result: String(e), isError: true });
			}
			this.emit("event", { type: "turn_done", text: "", hadTools: true });
			this.emit("event", { type: "turn_start", turn: 2 });
		}

		const response = `[sim] You asked: "${prompt}". I'm a simulated agent. Available tools: ${[...this.tools.keys()].join(", ") || "none"}.`;
		for (const char of response) {
			if (signal.aborted) return;
			await delay(15);
			this.emit("event", { type: "text_delta", text: char });
		}

		this.emit("event", { type: "turn_done", text: response, hadTools: false });
		this.emit("event", { type: "done", text: response, turns: this.tools.size > 0 ? 2 : 1, inputTokens: 0, outputTokens: 0 });
	}
}

// ─── BUILT-IN TOOLS ───────────────────────────────────────────────────────────
// Ready-to-register tool implementations.
// In a real project these would be imported from separate files.

export const readFileTool: AgentTool = {
	name: "read_file",
	description: "Read a file's contents. Returns text with line numbers.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path to read" },
			max_lines: { type: "number", description: "Max lines to return (default 100)" },
		},
		required: ["path"],
	},
	async execute(input) {
		const path = input.path as string;
		const maxLines = (input.max_lines as number) ?? 100;
		const content = await fs.readFile(path, "utf-8");
		const lines = content.split("\n");
		const slice = lines.slice(0, maxLines).map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
		return `${path} (${lines.length} lines):\n${slice}${lines.length > maxLines ? `\n... (${lines.length - maxLines} more)` : ""}`;
	},
};

export const listDirTool: AgentTool = {
	name: "list_dir",
	description: "List files in a directory.",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string", description: "Directory path (default: .)" } },
		required: [],
	},
	async execute(input) {
		const path = (input.path as string) ?? ".";
		const entries = await fs.readdir(path, { withFileTypes: true });
		return entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`).join("\n");
	},
};

export const getTimeTool: AgentTool = {
	name: "get_time",
	description: "Get the current date and time.",
	inputSchema: { type: "object", properties: {} },
	async execute() { return new Date().toLocaleString(); },
};

// ─── DEMO (runs when file is executed directly) ────────────────────────────────

async function main() {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	const isLive = !!apiKey;

	console.log(`\x1b[1m=== Agent Class Demo (${isLive ? "live API" : "simulation"}) ===\x1b[0m\n`);

	const agent = new Agent(apiKey, {
		systemPrompt: "You are a helpful coding assistant. Be concise.",
	})
		.register(readFileTool)
		.register(listDirTool)
		.register(getTimeTool);

	console.log(`Registered tools: ${agent.toolNames.join(", ")}\n`);

	// Subscribe to events and render to stdout:
	const controller = new AbortController();
	let currentTurn = 0;

	agent.on("event", (event) => {
		switch (event.type) {
			case "turn_start":
				currentTurn = event.turn;
				if (event.turn > 1) console.log();
				process.stdout.write(`\x1b[33m[turn ${event.turn}]\x1b[0m `);
				break;
			case "text_delta":
				process.stdout.write(event.text);
				break;
			case "tool_call_start":
				process.stdout.write(`\n\x1b[36m  tool: ${event.name}\x1b[0m `);
				if (Object.keys(event.input).length > 0) {
					process.stdout.write(`\x1b[2m${JSON.stringify(event.input)}\x1b[0m `);
				}
				break;
			case "tool_call_done":
				process.stdout.write(
					event.isError
						? `\x1b[31m[error]\x1b[0m\n`
						: `\x1b[32m[done]\x1b[0m\n`,
				);
				break;
			case "done":
				console.log(`\n\n\x1b[32m✓\x1b[0m ${event.turns} turn(s), ${event.inputTokens + event.outputTokens} tokens total`);
				break;
			case "error":
				console.error(`\n\x1b[31mError:\x1b[0m ${event.message}`);
				break;
			case "cancelled":
				console.log("\n\x1b[33mCancelled\x1b[0m");
				break;
		}
	});

	const prompt = "List the files in the current directory and tell me what this project is about.";
	console.log(`\x1b[36mPrompt:\x1b[0m ${prompt}\n`);

	await agent.run(prompt, [], controller.signal);
}

// Only run demo when executed directly (not when imported by another file).
// ESM equivalent of Python's `if __name__ == "__main__"`:
const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) main().catch(console.error);

/**
 * TASK:
 *
 * 1. Add a `history` parameter to `Agent.run()` so multi-turn conversations
 *    work. The caller maintains the history array and passes it on each call.
 *    Test it by calling agent.run() twice in sequence.
 *
 * 2. Add a `maxRetries` option: if a tool throws, retry it up to N times
 *    with exponential backoff (100ms, 200ms, 400ms...) before giving up.
 *    This mirrors how pi-mono handles transient tool failures.
 *
 * 3. Add tool middleware: `agent.use((tool, input, next) => next(input))`
 *    that wraps every tool call. Implement two middlewares:
 *    - loggingMiddleware: logs tool name + input before calling
 *    - timingMiddleware: wraps next() with Date.now() before/after
 *    This is the "middleware pipeline" pattern from Express/Koa.
 *
 * 4. Add an `onProgress` callback option: called with the partial text after
 *    each text_delta. This lets callers stream without subscribing to events.
 *    The Ink components in the capstone can use this instead of the event bus.
 */
