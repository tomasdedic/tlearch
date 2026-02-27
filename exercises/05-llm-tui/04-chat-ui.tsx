/**
 * Exercise 05-llm-tui/04-chat-ui.tsx
 *
 * CONCEPTS: chat history, multi-turn conversations, scrolling, input composition
 *
 * Run with: ANTHROPIC_API_KEY=sk-... npm run ex exercises/05-llm-tui/04-chat-ui.tsx
 * Simulation: npm run ex exercises/05-llm-tui/04-chat-ui.tsx
 *
 * A full chat interface:
 *   - Message history (all previous turns)
 *   - Text input at the bottom
 *   - Streaming current response
 *   - Keyboard shortcuts
 *
 * Architecture: messages[] lives outside components (in a ref/state),
 * the UI derives its rendering entirely from that array + the current stream.
 * This is exactly how pi-mono's interactive mode works.
 */

import Anthropic from "@anthropic-ai/sdk";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── TYPES ────────────────────────────────────────────────────────────────────

type Role = "user" | "assistant" | "system";

type ChatMessage = {
	id: string;
	role: Role;
	content: string;
	timestamp: Date;
	tokenCount?: number;
};

type InputMode = "typing" | "navigating";

type AppState = {
	messages: ChatMessage[];
	input: string;
	inputMode: InputMode;
	streamingText: string;
	isStreaming: boolean;
	scrollOffset: number; // lines from bottom (0 = bottom)
	notification: string;
	totalTokens: number;
};

type AppAction =
	| { type: "set_input"; value: string }
	| { type: "input_char"; char: string }
	| { type: "input_backspace" }
	| { type: "submit" }
	| { type: "add_message"; message: ChatMessage }
	| { type: "stream_start" }
	| { type: "stream_delta"; text: string }
	| { type: "stream_done"; inputTokens: number; outputTokens: number }
	| { type: "stream_cancel" }
	| { type: "scroll"; delta: number }
	| { type: "scroll_bottom" }
	| { type: "set_mode"; mode: InputMode }
	| { type: "notify"; message: string }
	| { type: "clear_notify" }
	| { type: "clear_history" };

let msgIdCounter = 0;
function makeId() { return `msg-${++msgIdCounter}`; }

function appReducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "input_char":
			return { ...state, input: state.input + action.char };
		case "input_backspace":
			return { ...state, input: state.input.slice(0, -1) };
		case "set_input":
			return { ...state, input: action.value };
		case "submit": {
			if (!state.input.trim() || state.isStreaming) return state;
			const userMsg: ChatMessage = {
				id: makeId(),
				role: "user",
				content: state.input.trim(),
				timestamp: new Date(),
			};
			return { ...state, messages: [...state.messages, userMsg], input: "", scrollOffset: 0 };
		}
		case "add_message":
			return { ...state, messages: [...state.messages, action.message], scrollOffset: 0 };
		case "stream_start":
			return { ...state, isStreaming: true, streamingText: "", scrollOffset: 0 };
		case "stream_delta":
			return { ...state, streamingText: state.streamingText + action.text };
		case "stream_done": {
			const assistantMsg: ChatMessage = {
				id: makeId(),
				role: "assistant",
				content: state.streamingText,
				timestamp: new Date(),
				tokenCount: action.outputTokens,
			};
			return {
				...state,
				messages: [...state.messages, assistantMsg],
				streamingText: "",
				isStreaming: false,
				totalTokens: state.totalTokens + action.inputTokens + action.outputTokens,
			};
		}
		case "stream_cancel":
			return { ...state, isStreaming: false, streamingText: "", notification: "Cancelled" };
		case "scroll":
			return { ...state, scrollOffset: Math.max(0, state.scrollOffset + action.delta) };
		case "scroll_bottom":
			return { ...state, scrollOffset: 0 };
		case "set_mode":
			return { ...state, inputMode: action.mode };
		case "notify":
			return { ...state, notification: action.message };
		case "clear_notify":
			return { ...state, notification: "" };
		case "clear_history":
			return { ...state, messages: [], streamingText: "", isStreaming: false, totalTokens: 0 };
		default:
			return state;
	}
}

const initialState: AppState = {
	messages: [
		{
			id: "welcome",
			role: "system",
			content: "Chat ready. Type a message and press Enter.",
			timestamp: new Date(),
		},
	],
	input: "",
	inputMode: "typing",
	streamingText: "",
	isStreaming: false,
	scrollOffset: 0,
	notification: "",
	totalTokens: 0,
};

// ─── LLM STREAMING ────────────────────────────────────────────────────────────

async function* streamResponse(
	client: Anthropic,
	messages: ChatMessage[],
	signal: AbortSignal,
): AsyncGenerator<{ type: "delta"; text: string } | { type: "done"; inputTokens: number; outputTokens: number }> {
	const apiMessages: Anthropic.MessageParam[] = messages
		.filter((m) => m.role !== "system")
		.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

	const stream = client.messages.stream(
		{ model: "claude-haiku-4-5-20251001", max_tokens: 1024, messages: apiMessages },
		{ signal },
	);

	for await (const event of stream) {
		if (signal.aborted) return;
		if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
			yield { type: "delta", text: event.delta.text };
		}
	}

	const msg = await stream.finalMessage();
	yield { type: "done", inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
}

async function* simulatedResponse(
	messages: ChatMessage[],
	signal: AbortSignal,
): AsyncGenerator<{ type: "delta"; text: string } | { type: "done"; inputTokens: number; outputTokens: number }> {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const responses: Record<string, string> = {
		default: "I'm a simulated response. Set ANTHROPIC_API_KEY to use the real Claude API.",
	};
	const text = responses.default + `\n\nYou said: "${lastUser?.content ?? "(nothing)"}"`;

	for (const char of text) {
		if (signal.aborted) return;
		await new Promise<void>((r, rej) => {
			const t = setTimeout(r, 18);
			signal.addEventListener("abort", () => { clearTimeout(t); rej(); });
		});
		yield { type: "delta", text: char };
	}
	yield { type: "done", inputTokens: 20, outputTokens: text.length / 4 | 0 };
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function Spinner() {
	const [f, setF] = useState(0);
	useEffect(() => { const t = setInterval(() => setF((n) => (n + 1) % FRAMES.length), 80); return () => clearInterval(t); }, []);
	return <Text color="cyan">{FRAMES[f]}</Text>;
}

function MessageBubble({ msg, cols }: { msg: ChatMessage; cols: number }) {
	const width = cols - 6;
	const time = msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

	switch (msg.role) {
		case "system":
			return (
				<Box marginY={1} paddingX={2}>
					<Text dimColor italic>{msg.content}</Text>
				</Box>
			);
		case "user":
			return (
				<Box flexDirection="column" marginY={1} paddingX={1}>
					<Box justifyContent="space-between" width={width}>
						<Text bold color="cyan">You</Text>
						<Text dimColor>{time}</Text>
					</Box>
					<Box paddingLeft={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor="cyan">
						<Text wrap="wrap">{msg.content}</Text>
					</Box>
				</Box>
			);
		case "assistant":
			return (
				<Box flexDirection="column" marginY={1} paddingX={1}>
					<Box justifyContent="space-between" width={width}>
						<Text bold color="green">Assistant</Text>
						<Box gap={2}>
							{msg.tokenCount && <Text dimColor>{msg.tokenCount} tokens</Text>}
							<Text dimColor>{time}</Text>
						</Box>
					</Box>
					<Box paddingLeft={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor="green">
						<Text wrap="wrap">{msg.content}</Text>
					</Box>
				</Box>
			);
	}
}

function StreamingBubble({ text, cols }: { text: string; cols: number }) {
	const width = cols - 6;
	return (
		<Box flexDirection="column" marginY={1} paddingX={1}>
			<Box gap={2} width={width}>
				<Spinner />
				<Text bold color="green">Assistant</Text>
			</Box>
			<Box paddingLeft={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor="green">
				<Text wrap="wrap">{text}<Text color="cyan">▋</Text></Text>
			</Box>
		</Box>
	);
}

function InputBar({ value, disabled, cols }: { value: string; disabled: boolean; cols: number }) {
	const width = cols - 6;
	return (
		<Box borderStyle="round" paddingX={1} width={cols - 2} borderColor={disabled ? "gray" : "white"}>
			<Text dimColor color={disabled ? "gray" : "white"}>&gt; </Text>
			<Box width={width - 2}>
				<Text color={disabled ? "gray" : "white"} wrap="truncate-end">
					{value || (disabled ? "(streaming...)" : "Type a message...")}
				</Text>
				{!disabled && <Text color="white">_</Text>}
			</Box>
		</Box>
	);
}

function StatusBar({ state, isLive, cols }: { state: AppState; isLive: boolean; cols: number }) {
	return (
		<Box justifyContent="space-between" width={cols - 2} paddingX={1}>
			<Box gap={2}>
				{isLive ? <Text color="green">live</Text> : <Text color="yellow">sim</Text>}
				<Text dimColor>{state.messages.filter((m) => m.role !== "system").length} messages</Text>
				{state.totalTokens > 0 && <Text dimColor>{state.totalTokens} tokens</Text>}
			</Box>
			<Box gap={2}>
				{state.scrollOffset > 0 && <Text color="yellow">scroll:{state.scrollOffset}</Text>}
				{state.notification && <Text color="yellow">{state.notification}</Text>}
				<Text dimColor>Ctrl+C: cancel  /clear  Esc: exit</Text>
			</Box>
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();
	const apiKey = process.env.ANTHROPIC_API_KEY;
	const client = apiKey ? new Anthropic({ apiKey }) : null;

	const [state, dispatch] = useReducer(appReducer, initialState);
	const controllerRef = useRef<AbortController | null>(null);
	const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const notify = useCallback((msg: string) => {
		dispatch({ type: "notify", message: msg });
		if (notifyTimer.current) clearTimeout(notifyTimer.current);
		notifyTimer.current = setTimeout(() => dispatch({ type: "clear_notify" }), 2000);
	}, []);

	// When a new user message is added to history, kick off a stream:
	useEffect(() => {
		const lastMsg = state.messages[state.messages.length - 1];
		if (!lastMsg || lastMsg.role !== "user") return;

		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;

		dispatch({ type: "stream_start" });

		async function run() {
			try {
				const gen = client
					? streamResponse(client, state.messages, controller.signal)
					: simulatedResponse(state.messages, controller.signal);

				for await (const event of gen) {
					if (controller.signal.aborted) return;
					if (event.type === "delta") dispatch({ type: "stream_delta", text: event.text });
					if (event.type === "done") dispatch({ type: "stream_done", inputTokens: event.inputTokens, outputTokens: event.outputTokens });
				}
			} catch {
				if (!controller.signal.aborted) {
					dispatch({ type: "stream_cancel" });
				}
			}
		}

		run();
		return () => controller.abort();
	// Only run when a new user message arrives (compare message count):
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state.messages.length]);

	useInput((input, key) => {
		// Ctrl+C cancels stream:
		if (key.ctrl && input === "c") {
			if (state.isStreaming) { controllerRef.current?.abort(); dispatch({ type: "stream_cancel" }); }
			else exit();
			return;
		}
		if (key.escape) { exit(); return; }

		// Scroll:
		if (key.pageUp) { dispatch({ type: "scroll", delta: 5 }); return; }
		if (key.pageDown) { dispatch({ type: "scroll", delta: -5 }); return; }
		if (key.ctrl && input === "u") { dispatch({ type: "scroll", delta: 5 }); return; }
		if (key.ctrl && input === "d") { dispatch({ type: "scroll", delta: -5 }); return; }

		// Input:
		if (key.return) {
			if (state.input === "/clear") { dispatch({ type: "clear_history" }); return; }
			dispatch({ type: "submit" });
			return;
		}
		if (key.backspace || key.delete) { dispatch({ type: "input_backspace" }); return; }
		if (input && !key.ctrl && !key.meta) { dispatch({ type: "input_char", char: input }); }
	});

	const cols = process.stdout.columns ?? 80;
	const rows = process.stdout.rows ?? 24;
	const historyHeight = rows - 6; // leave room for input + status

	// Compute visible messages (simple scroll: show last N lines worth):
	const allMessages = [...state.messages];
	const visibleMessages = state.scrollOffset === 0
		? allMessages.slice(-8)
		: allMessages.slice(-8 - state.scrollOffset, -state.scrollOffset || undefined);

	return (
		<Box flexDirection="column" height={rows}>
			{/* Message history */}
			<Box flexDirection="column" flexGrow={1} minHeight={historyHeight} paddingX={1} overflow="hidden">
				{visibleMessages.map((msg) => (
					<MessageBubble key={msg.id} msg={msg} cols={cols} />
				))}
				{state.isStreaming && <StreamingBubble text={state.streamingText} cols={cols} />}
			</Box>

			{/* Input bar */}
			<Box paddingX={1}>
				<InputBar value={state.input} disabled={state.isStreaming} cols={cols} />
			</Box>

			{/* Status bar */}
			<StatusBar state={state} isLive={!!client} cols={cols} />
		</Box>
	);
}

render(<App />);

/**
 * TASK:
 *
 * 1. Add message editing: pressing Up when input is empty loads the last user
 *    message into the input for editing. Pressing Down returns to fresh input.
 *    This is the "history navigation" pattern from shells and pi-mono's editor.
 *
 * 2. Add a system prompt: before the first user message, prepend a "system"
 *    message that shapes the assistant's behavior. Add a /system <text>
 *    command to set it. Show it dimmed at the top of the history.
 *
 * 3. Add /save <filename>: serialize state.messages to JSON and write to disk.
 *    Add /load <filename>: deserialize and restore. This is session persistence
 *    from Stage 5 distilled to its simplest form.
 *
 * 4. Add proper scrolling: right now we use a simple slice. Implement
 *    proper virtual scrolling by tracking the total height of each message
 *    and scrolling by pixel-equivalent (character rows). Show a scroll
 *    indicator on the right side.
 */
