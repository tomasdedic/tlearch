/**
 * Exercise 05-llm-tui/02-streaming-text.tsx
 *
 * CONCEPTS: LLM streaming → Ink state, stream adapter, cancellation
 *
 * Run with: ANTHROPIC_API_KEY=sk-... npm run ex exercises/05-llm-tui/02-streaming-text.tsx
 * Simulation (no key needed): npm run ex exercises/05-llm-tui/02-streaming-text.tsx
 *
 * This is the core of pi-mono's streaming pipeline:
 *   SDK events → typed StreamEvent union → component state updates
 *
 * The adapter pattern (packages/ai/src/providers/anthropic.ts) decouples
 * the component from the SDK — you can swap providers without changing UI code.
 */

import Anthropic from "@anthropic-ai/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── STREAM EVENT TYPES (from 01-types/04 and 03-llm-cli) ────────────────────

type StreamEvent =
	| { type: "start" }
	| { type: "text_delta"; text: string }
	| { type: "done"; stopReason: string; inputTokens: number; outputTokens: number }
	| { type: "error"; message: string };

// ─── STREAM ADAPTER ───────────────────────────────────────────────────────────
// Converts the Anthropic SDK's raw events → our clean StreamEvent union.
// This decouples the UI from the SDK entirely — swap the provider here,
// everything downstream stays the same.

async function* anthropicStream(
	client: Anthropic,
	messages: Anthropic.MessageParam[],
	signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
	yield { type: "start" };

	try {
		const stream = client.messages.stream({ model: "claude-haiku-4-5-20251001", max_tokens: 512, messages }, { signal });

		for await (const event of stream) {
			if (signal.aborted) return;
			if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
				yield { type: "text_delta", text: event.delta.text };
			}
		}

		const msg = await stream.finalMessage();
		yield {
			type: "done",
			stopReason: msg.stop_reason ?? "stop",
			inputTokens: msg.usage.input_tokens,
			outputTokens: msg.usage.output_tokens,
		};
	} catch (err) {
		if (signal.aborted) return;
		yield { type: "error", message: err instanceof Error ? err.message : String(err) };
	}
}

// ─── SIMULATION (no API key needed) ──────────────────────────────────────────

async function* simulatedStream(prompt: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
	yield { type: "start" };
	const text = `[simulated] You asked: "${prompt}"\n\nTypeScript is a statically typed superset of JavaScript. It adds type annotations, interfaces, and generics that help catch bugs at compile time. When combined with Ink, you can build powerful terminal applications with full type safety throughout the entire codebase.`;

	for (const char of text) {
		if (signal.aborted) return;
		await new Promise<void>((r, rej) => {
			const t = setTimeout(r, 15);
			signal.addEventListener("abort", () => { clearTimeout(t); rej(); });
		});
		yield { type: "text_delta", text: char };
	}
	yield { type: "done", stopReason: "stop", inputTokens: 12, outputTokens: text.length / 4 | 0 };
}

// ─── STREAMING HOOK ───────────────────────────────────────────────────────────
// Encapsulates the entire "run a stream and accumulate state" pattern.
// This is the hook you'd use in any Ink component that streams from an LLM.

type StreamState = {
	status: "idle" | "streaming" | "done" | "error";
	text: string;
	inputTokens: number;
	outputTokens: number;
	errorMessage: string;
};

function useStreamingResponse(
	getStream: (signal: AbortSignal) => AsyncGenerator<StreamEvent>,
	trigger: number,
): StreamState & { cancel: () => void } {
	const [state, setState] = useState<StreamState>({
		status: "idle",
		text: "",
		inputTokens: 0,
		outputTokens: 0,
		errorMessage: "",
	});

	const controllerRef = useRef<AbortController | null>(null);

	useEffect(() => {
		if (trigger === 0) return; // don't run on mount

		// Cancel any in-flight stream:
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;

		// Reset state for new stream:
		setState({ status: "streaming", text: "", inputTokens: 0, outputTokens: 0, errorMessage: "" });

		async function run() {
			for await (const event of getStream(controller.signal)) {
				if (controller.signal.aborted) break;

				switch (event.type) {
					case "text_delta":
						// Functional update: never close over stale state
						setState((prev) => ({ ...prev, text: prev.text + event.text }));
						break;
					case "done":
						setState((prev) => ({
							...prev,
							status: "done",
							inputTokens: event.inputTokens,
							outputTokens: event.outputTokens,
						}));
						break;
					case "error":
						setState((prev) => ({ ...prev, status: "error", errorMessage: event.message }));
						break;
				}
			}
		}

		run();
		return () => controller.abort();
	}, [trigger]); // only getStream changes when prompt changes; keep it stable

	const cancel = useCallback(() => {
		controllerRef.current?.abort();
		setState((prev) => (prev.status === "streaming" ? { ...prev, status: "done" } : prev));
	}, []);

	return { ...state, cancel };
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner() {
	const [f, setF] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setF((n) => (n + 1) % SPINNER_FRAMES.length), 80);
		return () => clearInterval(t);
	}, []);
	return <Text color="cyan">{SPINNER_FRAMES[f]}</Text>;
}

function TokenCount({ input, output }: { input: number; output: number }) {
	return (
		<Text dimColor>
			{input}↑ {output}↓ tokens
		</Text>
	);
}

function StatusBadge({ status }: { status: StreamState["status"] }) {
	switch (status) {
		case "idle":      return <Text dimColor>idle</Text>;
		case "streaming": return <Box gap={1}><Spinner /><Text color="yellow">streaming</Text></Box>;
		case "done":      return <Text color="green">done</Text>;
		case "error":     return <Text color="red">error</Text>;
	}
}

// ─── MAIN DEMO ────────────────────────────────────────────────────────────────

const PROMPTS = [
	"What is TypeScript in one sentence?",
	"Name three benefits of async/await.",
	"What is a discriminated union?",
	"Explain React's useReducer in 2 sentences.",
];

function StreamingDemo() {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	const client = apiKey ? new Anthropic({ apiKey }) : null;

	const [promptIndex, setPromptIndex] = useState(0);
	const [trigger, setTrigger] = useState(0);

	const prompt = PROMPTS[promptIndex % PROMPTS.length];

	// getStream is recreated only when prompt changes:
	const getStream = useCallback(
		(signal: AbortSignal) => {
			if (client) {
				return anthropicStream(client, [{ role: "user", content: prompt }], signal);
			}
			return simulatedStream(prompt, signal);
		},
		[prompt, client],
	);

	const { status, text, inputTokens, outputTokens, errorMessage, cancel } =
		useStreamingResponse(getStream, trigger);

	const cols = process.stdout.columns ?? 80;

	useInput((input, key) => {
		if (key.return || input === "s") {
			setTrigger((t) => t + 1); // fire the stream
		}
		if (input === "x") cancel();
		if (key.tab || input === "n") setPromptIndex((i) => i + 1);
	});

	return (
		<Box flexDirection="column" padding={1}>
			{/* Header */}
			<Box justifyContent="space-between" marginBottom={1}>
				<Text bold color="cyan">LLM Streaming</Text>
				{client ? <Text color="green">live API</Text> : <Text color="yellow">simulation mode</Text>}
			</Box>

			{/* Prompt selector */}
			<Box flexDirection="column" borderStyle="single" padding={1} marginBottom={1} width={cols - 4}>
				<Text dimColor>Prompt (Tab/n to cycle):</Text>
				<Text color="white">{prompt}</Text>
			</Box>

			{/* Response area */}
			<Box flexDirection="column" borderStyle="round" padding={1} width={cols - 4} minHeight={8}>
				<Box justifyContent="space-between" marginBottom={1}>
					<StatusBadge status={status} />
					{status === "done" && <TokenCount input={inputTokens} output={outputTokens} />}
				</Box>

				{status === "error" && <Text color="red">{errorMessage}</Text>}

				{(status === "streaming" || status === "done") && text && (
					<Box width={cols - 8}>
						<Text wrap="wrap">
							{text}
							{status === "streaming" && <Text color="cyan">▋</Text>}
						</Text>
					</Box>
				)}

				{status === "idle" && <Text dimColor>Press Enter or s to stream a response.</Text>}
			</Box>

			{/* Controls */}
			<Box marginTop={1} gap={3}>
				<Text dimColor>Enter/s: stream</Text>
				<Text dimColor>x: cancel</Text>
				<Text dimColor>Tab/n: next prompt</Text>
				<Text dimColor>Esc: exit</Text>
			</Box>
		</Box>
	);
}

function App() {
	const { exit } = useApp();
	useInput((_, key) => { if (key.escape) exit(); });
	return <StreamingDemo />;
}

render(<App />);

/**
 * TASK:
 *
 * 1. Add a "Copy to clipboard" action (c key) that writes `text` to clipboard
 *    using: child_process.execSync(`echo "${text}" | pbcopy`) on macOS.
 *    Show a "Copied!" notification for 1.5s then clear it.
 *
 * 2. Add a second provider: write a `simulatedSlowStream` that streams much
 *    slower (300ms per word). Add a toggle (p key) to switch between fast/slow.
 *    Notice: changing the stream function should cancel any in-flight stream.
 *
 * 3. Add a word-count display that updates live as tokens arrive.
 *    Derive it from `text` in the component: count spaces + 1.
 *    This is "derived state" — never store it in the reducer, compute it inline.
 *
 * 4. Add a "stream history": keep the last 3 responses in state (array).
 *    Show them above the current response, dimmed, with timestamps.
 *    This is the seed of a chat history — the next exercise.
 */
