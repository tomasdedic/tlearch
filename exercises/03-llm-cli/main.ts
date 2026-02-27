/**
 * Exercise 03-llm-cli/main.ts
 *
 * STAGE 1 CAPSTONE: A minimal streaming CLI agent
 *
 * Run with: ANTHROPIC_API_KEY=sk-... npm run ex exercises/03-llm-cli/main.ts
 *
 * This combines everything from stages 01 and 02:
 *   - Discriminated union message types (01-types/04)
 *   - Async iterables + for-await-of (02-async/03)
 *   - AbortSignal cancellation (02-async/04)
 *   - TypedEventEmitter (02-async/02)
 *
 * Architecture mirrors pi-mono:
 *   UserInput → messages[] → SDK stream → StreamEvent → terminal output
 *                 ↑                                           |
 *                 └──────────── tool results ────────────────┘
 */

import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline";

// ─── TYPES (from 01-types exercises) ─────────────────────────────────────────

type UserMessage = { role: "user"; content: string };
type AssistantMessage = { role: "assistant"; content: string };
type Message = UserMessage | AssistantMessage;

type StreamEvent =
	| { type: "start" }
	| { type: "text_delta"; text: string }
	| { type: "done"; stopReason: string }
	| { type: "error"; message: string };

// ─── STREAM ADAPTER ───────────────────────────────────────────────────────────
// Wraps the Anthropic SDK's stream into our typed StreamEvent async iterable.
// This is the same pattern as packages/ai/src/providers/anthropic.ts.

async function* streamFromAnthropic(
	client: Anthropic,
	messages: Message[],
	signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
	yield { type: "start" };

	let stream: Anthropic.Stream<Anthropic.MessageStreamEvent> | undefined;

	try {
		stream = client.messages.stream(
			{
				model: "claude-haiku-4-5-20251001",
				max_tokens: 1024,
				messages,
			},
			{ signal },
		);

		for await (const event of stream) {
			// The SDK emits MessageStreamEvent — we map to our StreamEvent type.
			if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
				yield { type: "text_delta", text: event.delta.text };
			}
		}

		const finalMessage = await stream.finalMessage();
		yield { type: "done", stopReason: finalMessage.stop_reason ?? "stop" };
	} catch (err) {
		if (signal.aborted) {
			yield { type: "done", stopReason: "cancelled" };
		} else {
			const message = err instanceof Error ? err.message : String(err);
			yield { type: "error", message };
		}
	}
}

// ─── RENDERER ─────────────────────────────────────────────────────────────────
// Consumes a StreamEvent async iterable and renders to the terminal.
// Returns the full assembled text.

async function renderStream(events: AsyncIterable<StreamEvent>): Promise<string> {
	let text = "";
	let started = false;

	for await (const event of events) {
		switch (event.type) {
			case "start":
				if (!started) {
					process.stdout.write("\x1b[32mAssistant:\x1b[0m "); // green
					started = true;
				}
				break;

			case "text_delta":
				process.stdout.write(event.text);
				text += event.text;
				break;

			case "done":
				console.log(event.stopReason === "cancelled" ? " \x1b[33m[cancelled]\x1b[0m" : "");
				break;

			case "error":
				console.error(`\n\x1b[31mError:\x1b[0m ${event.message}`);
				break;
		}
	}

	return text;
}

// ─── AGENT ────────────────────────────────────────────────────────────────────
// Holds conversation state. Streams responses. Supports cancellation.

class MinimalAgent {
	private client: Anthropic;
	private history: Message[] = [];
	private controller: AbortController | null = null;

	constructor(apiKey: string) {
		this.client = new Anthropic({ apiKey });
	}

	cancel(): void {
		this.controller?.abort();
		this.controller = null;
	}

	async send(userText: string): Promise<void> {
		// Add user message to history:
		const userMessage: UserMessage = { role: "user", content: userText };
		this.history.push(userMessage);

		// Set up cancellation:
		this.cancel();
		this.controller = new AbortController();
		const { signal } = this.controller;

		// Stream the response:
		const events = streamFromAnthropic(this.client, this.history, signal);
		const assistantText = await renderStream(events);

		// Only add to history if we got a real response:
		if (assistantText.trim()) {
			this.history.push({ role: "assistant", content: assistantText.trim() });
		}

		this.controller = null;
	}

	get messageCount(): number {
		return this.history.length;
	}

	clearHistory(): void {
		this.history = [];
		console.log("\x1b[33m[history cleared]\x1b[0m");
	}
}

// ─── READLINE LOOP ────────────────────────────────────────────────────────────
// Reads lines from stdin and sends them to the agent.
// Handles special commands: /quit, /clear, /help.

async function runCLI(agent: MinimalAgent): Promise<void> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
	});

	const prompt = () => rl.question("\n\x1b[36mYou:\x1b[0m ", async (line) => {
		const input = line.trim();

		if (!input) {
			prompt();
			return;
		}

		switch (input) {
			case "/quit":
			case "/exit":
				console.log("Goodbye!");
				rl.close();
				process.exit(0);
				break;

			case "/clear":
				agent.clearHistory();
				prompt();
				break;

			case "/help":
				console.log("\nCommands: /quit, /clear, /help");
				console.log("Press Ctrl+C during a response to cancel it.\n");
				prompt();
				break;

			default:
				await agent.send(input);
				prompt();
				break;
		}
	});

	// Ctrl+C during streaming cancels, second press exits:
	let cancelPresses = 0;
	process.on("SIGINT", () => {
		if (agent.messageCount > 0) {
			agent.cancel();
			cancelPresses++;
			if (cancelPresses >= 2) {
				console.log("\nExiting.");
				process.exit(0);
			}
			console.log("\n\x1b[33m[Press Ctrl+C again to exit]\x1b[0m");
		} else {
			process.exit(0);
		}
	});

	// Start:
	console.log("\x1b[1mMinimal LLM CLI\x1b[0m");
	console.log("Type a message and press Enter. /help for commands.\n");
	prompt();
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
		console.error("Run with: ANTHROPIC_API_KEY=sk-... npm run ex exercises/03-llm-cli/main.ts");
		process.exit(1);
	}

	const agent = new MinimalAgent(apiKey);
	await runCLI(agent);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

/**
 * TASK (extending this into Stage 2 territory):
 *
 * 1. Add a simple `read_file` tool:
 *    - Define: { name: "read_file", input_schema: { path: string } }
 *    - Pass it to the messages.stream() call as `tools: [...]`
 *    - Handle `tool_use` content blocks in the stream
 *    - Execute the tool using fs/promises.readFile
 *    - Append the tool result as a message and continue streaming
 *    This is the core agent loop from packages/agent/src/agent-loop.ts!
 *
 * 2. Add a `/history` command that prints all messages in the conversation.
 *
 * 3. Add a `/save <filename>` command that writes the conversation history
 *    to a JSON file (the beginning of session persistence from Stage 5).
 *
 * 4. Add a `/load <filename>` command that restores a saved conversation.
 *    Notice: you've now built the core of pi-mono's session manager!
 */
