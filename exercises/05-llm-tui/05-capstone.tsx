/**
 * Exercise 05-llm-tui/05-capstone.tsx
 *
 * STAGE 3 CAPSTONE: A minimal coding agent TUI
 *
 * Run with: ANTHROPIC_API_KEY=sk-... npm run ex exercises/05-llm-tui/05-capstone.tsx
 * Simulation: npm run ex exercises/05-llm-tui/05-capstone.tsx
 *
 * This is pi-mono distilled to its core:
 *   - Chat history with streaming (04-chat-ui)
 *   - Agent loop with tools (03-tool-loop)
 *   - Two-pane layout: sidebar + main (04-ink/04-layout)
 *   - State machine with useReducer (04-ink/05-reducer)
 *   - Cancellation with AbortController (02-async/04-abort-signal)
 *
 * Tools available:
 *   - read_file: read a file
 *   - list_dir: list directory contents
 *   - get_cwd: get current working directory
 *   - get_time: get current time
 *
 * Try asking: "What files are in the current directory?"
 *             "Read package.json and explain the dependencies"
 *             "What time is it?"
 */

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── TYPES ────────────────────────────────────────────────────────────────────

type Role = "user" | "assistant";

type ToolCall = { id: string; name: string; input: Record<string, unknown> };
type ToolResult = { toolCallId: string; toolName: string; content: string; isError: boolean };

type Message = {
	id: string;
	role: Role;
	content: string;
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
	tokenCount?: number;
	timestamp: Date;
};

type AgentPhase =
	| { name: "idle" }
	| { name: "streaming"; partialText: string; pendingTools: ToolCall[] }
	| { name: "running_tools"; tools: ToolCall[]; results: ToolResult[] }
	| { name: "error"; message: string };

type AppState = {
	messages: Message[];
	input: string;
	phase: AgentPhase;
	totalTokens: number;
	showTools: boolean;
	notification: string;
};

type AppAction =
	| { type: "type_char"; char: string }
	| { type: "backspace" }
	| { type: "submit" }
	| { type: "agent_stream_start" }
	| { type: "agent_text_delta"; text: string }
	| { type: "agent_tool_found"; tool: ToolCall }
	| { type: "agent_running_tools"; tools: ToolCall[] }
	| { type: "agent_tool_result"; result: ToolResult }
	| { type: "agent_done"; assistantMsg: Message; inputTokens: number; outputTokens: number }
	| { type: "agent_error"; message: string }
	| { type: "agent_cancel" }
	| { type: "toggle_tools" }
	| { type: "clear" }
	| { type: "notify"; message: string }
	| { type: "clear_notify" };

let _id = 0;
const uid = () => `m${++_id}`;

function reducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "type_char":
			return { ...state, input: state.input + action.char };
		case "backspace":
			return { ...state, input: state.input.slice(0, -1) };
		case "submit": {
			if (!state.input.trim() || state.phase.name !== "idle") return state;
			const msg: Message = { id: uid(), role: "user", content: state.input.trim(), timestamp: new Date() };
			return { ...state, messages: [...state.messages, msg], input: "" };
		}
		case "agent_stream_start":
			return { ...state, phase: { name: "streaming", partialText: "", pendingTools: [] } };
		case "agent_text_delta":
			if (state.phase.name !== "streaming") return state;
			return { ...state, phase: { ...state.phase, partialText: state.phase.partialText + action.text } };
		case "agent_tool_found":
			if (state.phase.name !== "streaming") return state;
			return { ...state, phase: { ...state.phase, pendingTools: [...state.phase.pendingTools, action.tool] } };
		case "agent_running_tools":
			return { ...state, phase: { name: "running_tools", tools: action.tools, results: [] } };
		case "agent_tool_result":
			if (state.phase.name !== "running_tools") return state;
			return { ...state, phase: { ...state.phase, results: [...state.phase.results, action.result] } };
		case "agent_done":
			return {
				...state,
				messages: [...state.messages, action.assistantMsg],
				phase: { name: "idle" },
				totalTokens: state.totalTokens + action.inputTokens + action.outputTokens,
			};
		case "agent_error":
			return { ...state, phase: { name: "error", message: action.message } };
		case "agent_cancel":
			return { ...state, phase: { name: "idle" }, notification: "Cancelled" };
		case "toggle_tools":
			return { ...state, showTools: !state.showTools };
		case "clear":
			return { ...state, messages: [], phase: { name: "idle" }, totalTokens: 0 };
		case "notify":
			return { ...state, notification: action.message };
		case "clear_notify":
			return { ...state, notification: "" };
		default:
			return state;
	}
}

// ─── TOOLS ────────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
	{
		name: "read_file",
		description: "Read a file's contents. Returns the text content.",
		input_schema: {
			type: "object",
			properties: { path: { type: "string", description: "File path to read" } },
			required: ["path"],
		},
	},
	{
		name: "list_dir",
		description: "List files and directories at a path.",
		input_schema: {
			type: "object",
			properties: { path: { type: "string", description: "Directory path (default: .)" } },
			required: [],
		},
	},
	{
		name: "get_cwd",
		description: "Get the current working directory.",
		input_schema: { type: "object", properties: {} },
	},
	{
		name: "get_time",
		description: "Get the current date and time.",
		input_schema: { type: "object", properties: {} },
	},
];

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
	switch (name) {
		case "read_file": {
			const path = (input.path as string) || ".";
			const content = await fs.readFile(path, "utf-8");
			const lines = content.split("\n");
			return lines.slice(0, 80).join("\n") + (lines.length > 80 ? `\n...(${lines.length - 80} more lines)` : "");
		}
		case "list_dir": {
			const path = (input.path as string) || ".";
			const entries = await fs.readdir(path, { withFileTypes: true });
			return entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`).join("\n");
		}
		case "get_cwd":
			return process.cwd();
		case "get_time":
			return new Date().toLocaleString();
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

// ─── AGENT LOOP ───────────────────────────────────────────────────────────────

async function runAgent(
	client: Anthropic,
	messages: Message[],
	dispatch: (a: AppAction) => void,
	signal: AbortSignal,
) {
	// Convert our Message type to Anthropic's format:
	let apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({
		role: m.role,
		content: m.content,
	}));

	let accumulatedText = "";
	let turn = 0;

	while (!signal.aborted) {
		turn++;
		dispatch({ type: "agent_stream_start" });
		accumulatedText = "";

		const stream = client.messages.stream(
			{ model: "claude-haiku-4-5-20251001", max_tokens: 1024, tools: TOOLS, messages: apiMessages },
			{ signal },
		);

		const toolCalls: ToolCall[] = [];

		for await (const event of stream) {
			if (signal.aborted) return;
			if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
				dispatch({ type: "agent_text_delta", text: event.delta.text });
				accumulatedText += event.delta.text;
			}
			if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
				const tool: ToolCall = { id: event.content_block.id, name: event.content_block.name, input: {} };
				toolCalls.push(tool);
				dispatch({ type: "agent_tool_found", tool });
			}
		}

		const finalMsg = await stream.finalMessage();

		if (finalMsg.stop_reason !== "tool_use" || signal.aborted) {
			// Done — finalize the assistant message:
			const toolUseBlocks = finalMsg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
			const assistantMsg: Message = {
				id: uid(),
				role: "assistant",
				content: accumulatedText,
				toolCalls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })),
				tokenCount: finalMsg.usage.output_tokens,
				timestamp: new Date(),
			};
			dispatch({ type: "agent_done", assistantMsg, inputTokens: finalMsg.usage.input_tokens, outputTokens: finalMsg.usage.output_tokens });
			return;
		}

		// Tool use turn — collect all tool call blocks:
		const toolUseBlocks = finalMsg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
		dispatch({ type: "agent_running_tools", tools: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })) });

		apiMessages.push({ role: "assistant", content: finalMsg.content });

		// Execute tools in parallel:
		const toolResultBlocks = await Promise.all(
			toolUseBlocks.map(async (block): Promise<Anthropic.ToolResultBlockParam> => {
				const result: ToolResult = { toolCallId: block.id, toolName: block.name, content: "", isError: false };
				try {
					result.content = await runTool(block.name, block.input as Record<string, unknown>);
				} catch (err) {
					result.content = err instanceof Error ? err.message : String(err);
					result.isError = true;
				}
				dispatch({ type: "agent_tool_result", result });
				return { type: "tool_result", tool_use_id: block.id, content: result.content, is_error: result.isError };
			}),
		);

		apiMessages.push({ role: "user", content: toolResultBlocks });
		// Loop continues
	}
}

// ─── SIMULATION ───────────────────────────────────────────────────────────────

async function runSimulation(
	messages: Message[],
	dispatch: (a: AppAction) => void,
	signal: AbortSignal,
) {
	const lastMsg = [...messages].reverse().find((m) => m.role === "user");
	const prompt = lastMsg?.content ?? "";

	async function delay(ms: number) {
		await new Promise<void>((r, rej) => {
			const t = setTimeout(r, ms);
			signal.addEventListener("abort", () => { clearTimeout(t); rej(); });
		});
	}

	dispatch({ type: "agent_stream_start" });

	// Simulate: decide to use a tool if prompt mentions files/directory:
	const usesTool = /file|dir|read|list|cwd|time/i.test(prompt);

	if (usesTool) {
		await delay(300);
		const tool: ToolCall = { id: "sim1", name: "list_dir", input: { path: "." } };
		dispatch({ type: "agent_tool_found", tool });
		await delay(200);
		dispatch({ type: "agent_running_tools", tools: [tool] });
		await delay(600);
		dispatch({ type: "agent_tool_result", result: { toolCallId: "sim1", toolName: "list_dir", content: "exercises/\npackage.json\ntsconfig.json\nbiome.json\ntooling.md", isError: false } });
		dispatch({ type: "agent_stream_start" });
		await delay(200);
	}

	const response = usesTool
		? `[simulated] I found these files in your project:\n- exercises/ (TypeScript learning exercises)\n- package.json (project config)\n- tsconfig.json (TypeScript config)\n\nThis is a learning project with Ink and Anthropic SDK installed.`
		: `[simulated] You asked: "${prompt}"\n\nI'm a simulated agent. Set ANTHROPIC_API_KEY to use the real Claude API.\n\nI can read files, list directories, get the current directory, and tell the time.`;

	for (const char of response) {
		if (signal.aborted) return;
		await delay(12);
		dispatch({ type: "agent_text_delta", text: char });
	}

	const msg: Message = { id: uid(), role: "assistant", content: response, timestamp: new Date(), tokenCount: response.length / 4 | 0 };
	dispatch({ type: "agent_done", assistantMsg: msg, inputTokens: 15, outputTokens: response.length / 4 | 0 });
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function Spinner({ color = "cyan" }: { color?: string }) {
	const [f, setF] = useState(0);
	useEffect(() => { const t = setInterval(() => setF((n) => (n + 1) % FRAMES.length), 80); return () => clearInterval(t); }, []);
	return <Text color={color}>{FRAMES[f]}</Text>;
}

function MessageView({ msg, cols, showTools }: { msg: Message; cols: number; showTools: boolean }) {
	const time = msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const isUser = msg.role === "user";

	return (
		<Box flexDirection="column" marginY={1}>
			<Box justifyContent="space-between" paddingX={1}>
				<Text bold color={isUser ? "cyan" : "green"}>{isUser ? "You" : "Agent"}</Text>
				<Box gap={2}>
					{msg.tokenCount && <Text dimColor>{msg.tokenCount}t</Text>}
					<Text dimColor>{time}</Text>
				</Box>
			</Box>
			{msg.content && (
				<Box paddingX={2}>
					<Text wrap="wrap">{msg.content}</Text>
				</Box>
			)}
			{showTools && msg.toolCalls && msg.toolCalls.length > 0 && (
				<Box flexDirection="column" paddingX={2} marginTop={1}>
					{msg.toolCalls.map((tc) => (
						<Box key={tc.id} gap={2}>
							<Text color="yellow"> tool</Text>
							<Text dimColor>{tc.name}({JSON.stringify(tc.input).slice(0, 30)})</Text>
						</Box>
					))}
				</Box>
			)}
		</Box>
	);
}

function PhaseIndicator({ phase }: { phase: AgentPhase }) {
	switch (phase.name) {
		case "idle": return null;
		case "streaming":
			return (
				<Box flexDirection="column" marginY={1}>
					<Box paddingX={1} gap={1}>
						<Spinner />
						<Text bold color="green">Agent</Text>
						{phase.pendingTools.length > 0 && (
							<Text color="yellow">→ {phase.pendingTools.map((t) => t.name).join(", ")}</Text>
						)}
					</Box>
					{phase.partialText && (
						<Box paddingX={2}>
							<Text wrap="wrap">{phase.partialText}<Text color="cyan">▋</Text></Text>
						</Box>
					)}
				</Box>
			);
		case "running_tools":
			return (
				<Box flexDirection="column" marginY={1} paddingX={1}>
					{phase.tools.map((tool) => {
						const isDone = phase.results.some((r) => r.toolCallId === tool.id);
						return (
							<Box key={tool.id} gap={2}>
								{isDone ? <Text color="green">✓</Text> : <Spinner />}
								<Text color="yellow">{tool.name}</Text>
								<Text dimColor>{JSON.stringify(tool.input).slice(0, 40)}</Text>
							</Box>
						);
					})}
				</Box>
			);
		case "error":
			return (
				<Box paddingX={1} marginY={1}>
					<Text color="red">Error: {phase.message}</Text>
				</Box>
			);
	}
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────

function Sidebar({ state }: { state: AppState }) {
	const userMsgs = state.messages.filter((m) => m.role === "user").length;
	const assistantMsgs = state.messages.filter((m) => m.role === "assistant").length;
	const toolCallCount = state.messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);

	return (
		<Box flexDirection="column" padding={1} gap={1}>
			<Text bold color="cyan">Mini Agent</Text>
			<Box flexDirection="column" marginTop={1} gap={1}>
				<Text dimColor>Messages</Text>
				<Text> {userMsgs} user</Text>
				<Text> {assistantMsgs} assistant</Text>
				<Text> {toolCallCount} tool calls</Text>
				<Text> {state.totalTokens} tokens</Text>
			</Box>
			<Box flexDirection="column" marginTop={1} gap={1}>
				<Text dimColor>Tools</Text>
				{TOOLS.map((t) => (
					<Text key={t.name} dimColor> {t.name}</Text>
				))}
			</Box>
			<Box flexDirection="column" marginTop={1} gap={1}>
				<Text dimColor>Keys</Text>
				<Text dimColor> t tools</Text>
				<Text dimColor> /clear</Text>
				<Text dimColor> Ctrl+C cancel</Text>
				<Text dimColor> Esc exit</Text>
			</Box>
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();
	const apiKey = process.env.ANTHROPIC_API_KEY;
	const client = apiKey ? new Anthropic({ apiKey }) : null;

	const [state, dispatch] = useReducer(reducer, {
		messages: [],
		input: "",
		phase: { name: "idle" },
		totalTokens: 0,
		showTools: true,
		notification: "",
	});

	const controllerRef = useRef<AbortController | null>(null);
	const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const notify = useCallback((msg: string) => {
		dispatch({ type: "notify", message: msg });
		if (notifyTimer.current) clearTimeout(notifyTimer.current);
		notifyTimer.current = setTimeout(() => dispatch({ type: "clear_notify" }), 2000);
	}, []);

	// Trigger agent when a new user message appears:
	useEffect(() => {
		const last = state.messages[state.messages.length - 1];
		if (!last || last.role !== "user") return;

		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;

		const run = client
			? runAgent(client, state.messages, dispatch, controller.signal)
			: runSimulation(state.messages, dispatch, controller.signal);

		run.catch((err) => {
			if (!controller.signal.aborted) dispatch({ type: "agent_error", message: String(err) });
		});

		return () => controller.abort();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state.messages.length]);

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			if (state.phase.name !== "idle") { controllerRef.current?.abort(); dispatch({ type: "agent_cancel" }); notify("Cancelled"); }
			else exit();
			return;
		}
		if (key.escape) { exit(); return; }

		if (key.return) {
			if (state.input === "/clear") { dispatch({ type: "clear" }); return; }
			dispatch({ type: "submit" });
			return;
		}
		if (key.backspace || key.delete) { dispatch({ type: "backspace" }); return; }
		if (input === "t" && state.phase.name === "idle" && !state.input) { dispatch({ type: "toggle_tools" }); return; }
		if (input && !key.ctrl && !key.meta) { dispatch({ type: "type_char", char: input }); }
	});

	const cols = process.stdout.columns ?? 80;
	const rows = process.stdout.rows ?? 24;
	const sidebarWidth = 18;
	const mainWidth = cols - sidebarWidth - 2;

	return (
		<Box flexDirection="column" height={rows}>
			{/* Main layout */}
			<Box flexGrow={1}>
				{/* Sidebar */}
				<Box width={sidebarWidth} borderStyle="single" borderRight flexDirection="column">
					<Sidebar state={state} />
				</Box>

				{/* Chat area */}
				<Box flexDirection="column" width={mainWidth} paddingX={1}>
					{/* Messages */}
					<Box flexDirection="column" flexGrow={1} overflow="hidden">
						{state.messages.length === 0 && (
							<Box marginTop={2} paddingX={1}>
								<Text dimColor>
									{client
										? "Ask me anything. I can read files, list directories, and more."
										: "Simulation mode — set ANTHROPIC_API_KEY for real responses."}
								</Text>
							</Box>
						)}
						{state.messages.slice(-6).map((msg) => (
							<MessageView key={msg.id} msg={msg} cols={mainWidth} showTools={state.showTools} />
						))}
						<PhaseIndicator phase={state.phase} />
					</Box>

					{/* Input */}
					<Box borderStyle="round" paddingX={1} borderColor={state.phase.name !== "idle" ? "gray" : "white"}>
						<Text dimColor>&gt; </Text>
						<Text color={state.phase.name !== "idle" ? "gray" : "white"} wrap="truncate-end">
							{state.input || (state.phase.name !== "idle" ? "running..." : "Type a message...")}
						</Text>
						{state.phase.name === "idle" && <Text>_</Text>}
					</Box>

					{/* Status */}
					<Box justifyContent="space-between">
						<Box gap={2}>
							{client ? <Text color="green" dimColor>live</Text> : <Text color="yellow" dimColor>sim</Text>}
							{state.notification && <Text color="yellow">{state.notification}</Text>}
						</Box>
						<Text dimColor>{state.totalTokens > 0 ? `${state.totalTokens} tokens` : ""}</Text>
					</Box>
				</Box>
			</Box>
		</Box>
	);
}

render(<App />);

/**
 * STAGE 3 COMPLETE — you've built a working coding agent TUI.
 *
 * What you've built mirrors pi-mono at its core:
 *   - Streaming LLM responses     → packages/ai/src/stream.ts
 *   - Tool calling loop            → packages/agent/src/agent-loop.ts
 *   - Tool implementations         → packages/coding-agent/src/core/tools/
 *   - TUI components               → packages/tui/src/components/
 *   - State machine with reducer   → packages/coding-agent/src/modes/interactive/
 *
 * NEXT STEPS (Stage 4 — Tool Calling Agent):
 *
 * 1. Add a `bash` tool that runs shell commands (read-only: ls, cat, pwd, echo).
 *    Show streaming stdout in the tool result panel as it arrives.
 *
 * 2. Add a `write_file` tool: write content to a file path.
 *    Show a confirmation prompt before writing (press y/n).
 *    This adds the concept of "destructive tool confirmation" from pi-mono.
 *
 * 3. Add a `search_files` tool: grep for a pattern across files.
 *    Use child_process to run `grep -r pattern dir` and return results.
 *
 * 4. Add session persistence: on exit, save state.messages to
 *    .sessions/<timestamp>.json. On startup, offer to resume the last session.
 *    This is the beginning of pi-mono's session manager (Stage 5).
 *
 * 5. Swap claude-haiku for claude-sonnet-4-6 and give it a system prompt
 *    that tells it to be a helpful coding assistant for your specific project.
 *    You now have a personalised coding agent.
 */
