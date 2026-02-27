/**
 * Exercise 06-tools/05-capstone.tsx
 *
 * STAGE 4 CAPSTONE: Full coding agent TUI using the Agent class
 *
 * Run with: ANTHROPIC_API_KEY=sk-... npm run ex exercises/06-tools/05-capstone.tsx
 * Simulation: npm run ex exercises/06-tools/05-capstone.tsx
 *
 * This is the architecture pi-mono uses:
 *   Agent class (pure TS) ← imported from 03-agent-class.ts
 *       ↓ emits AgentEvents
 *   Ink TUI (React) ← subscribes to events, updates useReducer state
 *
 * The Agent doesn't know about Ink. Ink doesn't run the agent loop.
 * This separation is what allows pi-mono to support CLI, web, and Slack modes
 * from a single agent core.
 *
 * Tools: read_file, list_dir, write_file, get_time, bash (read-only)
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// Import the Agent class from exercise 03:
import {
	Agent,
	type AgentEvent,
	type AgentTool,
	getTimeTool,
	listDirTool,
	readFileTool,
} from "./03-agent-class.js";

// ─── ADDITIONAL TOOLS ─────────────────────────────────────────────────────────

const writeFileTool: AgentTool = {
	name: "write_file",
	description: "Write content to a file. Creates the file if it doesn't exist.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path to write" },
			content: { type: "string", description: "Content to write" },
		},
		required: ["path", "content"],
	},
	async execute(input) {
		const path = input.path as string;
		const content = input.content as string;
		await fs.writeFile(path, content, "utf-8");
		const lines = content.split("\n").length;
		return `Wrote ${path} (${lines} lines)`;
	},
};

// Safe bash: read-only commands only
const SAFE_BASH_PATTERNS = /^(ls|cat|pwd|echo|date|which|whoami|uname|df|du\s+-sh|git\s+status|git\s+log|git\s+diff|find\s+\S+\s+-name|wc)\b/;

const bashTool: AgentTool = {
	name: "bash",
	description: "Run a read-only shell command (ls, cat, pwd, echo, date, git status, etc.).",
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", description: "The shell command to run" },
		},
		required: ["command"],
	},
	async execute(input, signal) {
		const command = input.command as string;

		if (!SAFE_BASH_PATTERNS.test(command.trim())) {
			throw new Error(`Command not allowed: "${command}". Only read-only commands are permitted.`);
		}

		return new Promise<string>((resolve, reject) => {
			const proc = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";

			signal.addEventListener("abort", () => proc.kill("SIGTERM"));
			proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
			proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
			proc.on("close", (code) => {
				if (code !== 0) reject(new Error(`Exit ${code}: ${stderr || stdout}`));
				else resolve(stdout.trim() || "(no output)");
			});
		});
	},
};

// ─── STATE ────────────────────────────────────────────────────────────────────

type ToolStatus = "running" | "done" | "error";

type ToolEvent = {
	id: string;
	turn: number;
	name: string;
	input: Record<string, unknown>;
	result?: string;
	status: ToolStatus;
};

type ChatMessage = {
	id: string;
	role: "user" | "assistant";
	content: string;
	tools: ToolEvent[];
	turns: number;
	tokens: number;
	timestamp: Date;
};

type AppState = {
	messages: ChatMessage[];
	input: string;
	phase: "idle" | "streaming" | "running_tools" | "error";
	currentText: string;
	currentTools: ToolEvent[];
	currentTurn: number;
	totalTokens: number;
	notification: string;
	showTools: boolean;
};

type AppAction =
	| { type: "input_char"; char: string }
	| { type: "backspace" }
	| { type: "submit" }
	| { type: "agent_event"; event: AgentEvent }
	| { type: "commit_message" }
	| { type: "clear" }
	| { type: "toggle_tools" }
	| { type: "notify"; msg: string }
	| { type: "clear_notify" };

let _id = 0;
const uid = () => `${++_id}`;

function appReducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "input_char":
			return { ...state, input: state.input + action.char };
		case "backspace":
			return { ...state, input: state.input.slice(0, -1) };
		case "submit": {
			if (!state.input.trim() || state.phase !== "idle") return state;
			const msg: ChatMessage = {
				id: uid(), role: "user", content: state.input.trim(),
				tools: [], turns: 0, tokens: 0, timestamp: new Date(),
			};
			return { ...state, messages: [...state.messages, msg], input: "" };
		}
		case "agent_event": {
			const ev = action.event;
			switch (ev.type) {
				case "turn_start":
					return { ...state, phase: "streaming", currentTurn: ev.turn, currentText: "" };
				case "text_delta":
					return { ...state, currentText: state.currentText + ev.text };
				case "tool_call_start":
					return {
						...state, phase: "running_tools",
						currentTools: [...state.currentTools, { id: ev.id, turn: state.currentTurn, name: ev.name, input: ev.input, status: "running" }],
					};
				case "tool_call_done": {
					const updated = state.currentTools.map((t) =>
						t.id === ev.id ? { ...t, result: ev.result, status: ev.isError ? "error" : "done" as ToolStatus } : t,
					);
					return { ...state, phase: "streaming", currentTools: updated };
				}
				case "turn_done":
					return { ...state, phase: ev.hadTools ? "running_tools" : "streaming" };
				case "done": {
					const msg: ChatMessage = {
						id: uid(), role: "assistant", content: state.currentText,
						tools: state.currentTools, turns: ev.turns, tokens: ev.outputTokens,
						timestamp: new Date(),
					};
					return {
						...state, messages: [...state.messages, msg],
						currentText: "", currentTools: [], currentTurn: 0,
						phase: "idle", totalTokens: state.totalTokens + ev.inputTokens + ev.outputTokens,
					};
				}
				case "error":
					return { ...state, phase: "error", notification: `Error: ${ev.message}` };
				case "cancelled":
					return { ...state, phase: "idle", currentText: "", currentTools: [], notification: "Cancelled" };
			}
			return state;
		}
		case "clear":
			return { ...state, messages: [], currentText: "", currentTools: [], phase: "idle", totalTokens: 0 };
		case "toggle_tools":
			return { ...state, showTools: !state.showTools };
		case "notify":
			return { ...state, notification: action.msg };
		case "clear_notify":
			return { ...state, notification: "" };
		default:
			return state;
	}
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function Spinner({ color = "cyan" }: { color?: string }) {
	const [f, setF] = useState(0);
	useEffect(() => { const t = setInterval(() => setF((n) => (n + 1) % FRAMES.length), 80); return () => clearInterval(t); }, []);
	return <Text color={color}>{FRAMES[f]}</Text>;
}

function ToolLine({ tool, expanded }: { tool: ToolEvent; expanded: boolean }) {
	const icon = tool.status === "running" ? <Spinner color="yellow" /> : tool.status === "error" ? <Text color="red">✗</Text> : <Text color="green">✓</Text>;
	const inputSummary = Object.entries(tool.input).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 20)}`).join(" ");

	return (
		<Box flexDirection="column">
			<Box gap={1} paddingLeft={2}>
				{icon}
				<Text color="yellow">{tool.name}</Text>
				{inputSummary && <Text dimColor>{inputSummary}</Text>}
			</Box>
			{expanded && tool.result && (
				<Box paddingLeft={4} width={50}>
					<Text dimColor wrap="truncate-end">{tool.result.split("\n")[0]}</Text>
				</Box>
			)}
		</Box>
	);
}

function MessageView({ msg, showTools, cols }: { msg: ChatMessage; showTools: boolean; cols: number }) {
	const isUser = msg.role === "user";
	const time = msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

	return (
		<Box flexDirection="column" marginY={1}>
			<Box justifyContent="space-between" paddingX={1}>
				<Box gap={2}>
					<Text bold color={isUser ? "cyan" : "green"}>
						{isUser ? "You" : "Agent"}
					</Text>
					{!isUser && msg.turns > 1 && <Text dimColor>{msg.turns} turns</Text>}
					{!isUser && msg.tokens > 0 && <Text dimColor>{msg.tokens}t</Text>}
				</Box>
				<Text dimColor>{time}</Text>
			</Box>
			{showTools && msg.tools.length > 0 && (
				<Box flexDirection="column" marginLeft={1}>
					{msg.tools.map((t) => <ToolLine key={t.id} tool={t} expanded={false} />)}
				</Box>
			)}
			{msg.content && (
				<Box paddingX={2} paddingLeft={3} borderLeft borderStyle="single"
					borderColor={isUser ? "cyan" : "green"}
					borderRight={false} borderTop={false} borderBottom={false}>
					<Text wrap="wrap">{msg.content}</Text>
				</Box>
			)}
		</Box>
	);
}

function StreamingView({ state, cols }: { state: AppState; cols: number }) {
	if (state.phase === "idle") return null;

	return (
		<Box flexDirection="column" marginY={1}>
			<Box paddingX={1} gap={2}>
				<Spinner />
				<Text bold color="green">Agent</Text>
				{state.phase === "running_tools" && <Text color="yellow">running tools...</Text>}
			</Box>
			{state.showTools && state.currentTools.length > 0 && (
				<Box flexDirection="column" marginLeft={1}>
					{state.currentTools.map((t) => <ToolLine key={t.id} tool={t} expanded={true} />)}
				</Box>
			)}
			{state.currentText && (
				<Box paddingX={2} paddingLeft={3} borderLeft borderStyle="single"
					borderColor="green" borderRight={false} borderTop={false} borderBottom={false}>
					<Text wrap="wrap">{state.currentText}<Text color="cyan">▋</Text></Text>
				</Box>
			)}
		</Box>
	);
}

function Sidebar({ state, isLive }: { state: AppState; isLive: boolean }) {
	const userCount = state.messages.filter((m) => m.role === "user").length;
	const toolCount = state.messages.reduce((n, m) => n + m.tools.length, 0) + state.currentTools.length;

	return (
		<Box flexDirection="column" padding={1} gap={1}>
			<Text bold color="cyan">Agent</Text>
			<Box marginTop={1}>
				{isLive ? <Text color="green">live</Text> : <Text color="yellow">simulation</Text>}
			</Box>
			<Box flexDirection="column" marginTop={1} gap={1}>
				<Text dimColor>Stats</Text>
				<Text> {userCount} turns</Text>
				<Text> {toolCount} tool calls</Text>
				<Text> {state.totalTokens}t total</Text>
			</Box>
			<Box flexDirection="column" marginTop={1} gap={1}>
				<Text dimColor>Tools</Text>
				{["read_file", "list_dir", "write_file", "bash", "get_time"].map((t) => (
					<Text key={t} dimColor> {t}</Text>
				))}
			</Box>
			<Box flexDirection="column" marginTop={1} gap={1}>
				<Text dimColor>Keys</Text>
				<Text dimColor> t  tools</Text>
				<Text dimColor> /clear</Text>
				<Text dimColor> Ctrl+C cancel</Text>
				<Text dimColor> Esc  exit</Text>
			</Box>
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();
	const apiKey = process.env.ANTHROPIC_API_KEY;
	const isLive = !!apiKey;

	// Build Agent once (ref so it survives re-renders):
	const agentRef = useRef<Agent | null>(null);
	if (!agentRef.current) {
		agentRef.current = new Agent(apiKey, {
			model: "claude-haiku-4-5-20251001",
			systemPrompt: "You are a helpful coding assistant. Be concise. When asked about files, use tools to read them.",
			maxTurns: 8,
		})
			.register(readFileTool)
			.register(listDirTool)
			.register(writeFileTool)
			.register(bashTool)
			.register(getTimeTool);
	}

	const [state, dispatch] = useReducer(appReducer, {
		messages: [],
		input: "",
		phase: "idle",
		currentText: "",
		currentTools: [],
		currentTurn: 0,
		totalTokens: 0,
		notification: "",
		showTools: true,
	});

	const controllerRef = useRef<AbortController | null>(null);
	const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
	const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const notify = useCallback((msg: string) => {
		dispatch({ type: "notify", msg });
		if (notifyTimer.current) clearTimeout(notifyTimer.current);
		notifyTimer.current = setTimeout(() => dispatch({ type: "clear_notify" }), 2500);
	}, []);

	// Subscribe to agent events (once):
	useEffect(() => {
		const agent = agentRef.current!;
		return agent.on("event", (event) => {
			dispatch({ type: "agent_event", event });

			// Maintain conversation history for multi-turn:
			if (event.type === "done") {
				const lastUser = historyRef.current[historyRef.current.length - 1];
				if (lastUser?.role === "user") {
					historyRef.current.push({ role: "assistant", content: event.text });
				}
			}
		});
	}, []);

	// Trigger agent when new user message appears:
	useEffect(() => {
		const last = state.messages[state.messages.length - 1];
		if (!last || last.role !== "user") return;

		historyRef.current.push({ role: "user", content: last.content });
		// Keep history to last 20 messages to avoid token overflow:
		if (historyRef.current.length > 20) {
			historyRef.current = historyRef.current.slice(-20);
		}

		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;

		agentRef.current!.run(
			last.content,
			historyRef.current.slice(0, -1), // history without the current message
			controller.signal,
		).catch(() => {}); // errors are emitted as events
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state.messages.length]);

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			if (state.phase !== "idle") {
				controllerRef.current?.abort();
				notify("Cancelled");
			} else {
				exit();
			}
			return;
		}
		if (key.escape) { exit(); return; }
		if (key.return) {
			if (state.input === "/clear") { dispatch({ type: "clear" }); historyRef.current = []; return; }
			dispatch({ type: "submit" });
			return;
		}
		if (key.backspace || key.delete) { dispatch({ type: "backspace" }); return; }
		if (input === "t" && state.phase === "idle" && !state.input) { dispatch({ type: "toggle_tools" }); return; }
		if (input && !key.ctrl && !key.meta) { dispatch({ type: "input_char", char: input }); }
	});

	const cols = process.stdout.columns ?? 80;
	const rows = process.stdout.rows ?? 24;
	const sidebarWidth = 16;
	const mainWidth = cols - sidebarWidth - 1;

	return (
		<Box flexDirection="column" height={rows}>
			<Box flexGrow={1}>
				{/* Sidebar */}
				<Box width={sidebarWidth} borderStyle="single" borderRight flexDirection="column">
					<Sidebar state={state} isLive={isLive} />
				</Box>

				{/* Chat */}
				<Box flexDirection="column" width={mainWidth} paddingX={1}>
					{/* Messages */}
					<Box flexDirection="column" flexGrow={1} overflow="hidden">
						{state.messages.length === 0 && (
							<Box marginTop={2} paddingX={1}>
								<Text dimColor>
									{isLive
										? 'Ask me anything. Try: "List the files here" or "Read package.json"'
										: "Simulation mode — set ANTHROPIC_API_KEY for real responses"}
								</Text>
							</Box>
						)}
						{state.messages.slice(-6).map((msg) => (
							<MessageView key={msg.id} msg={msg} showTools={state.showTools} cols={mainWidth} />
						))}
						<StreamingView state={state} cols={mainWidth} />
					</Box>

					{/* Input */}
					<Box borderStyle="round" paddingX={1}
						borderColor={state.phase !== "idle" ? "gray" : "white"}>
						<Text dimColor>&gt; </Text>
						<Text color={state.phase !== "idle" ? "gray" : "white"} wrap="truncate-end">
							{state.input || (state.phase !== "idle" ? "running..." : "Type a message...")}
						</Text>
						{state.phase === "idle" && <Text>_</Text>}
					</Box>

					{/* Status */}
					<Box justifyContent="space-between">
						<Text dimColor>{state.notification}</Text>
						<Text dimColor>{state.totalTokens > 0 ? `${state.totalTokens} tokens` : ""}</Text>
					</Box>
				</Box>
			</Box>
		</Box>
	);
}

render(<App />);

/**
 * STAGE 4 COMPLETE — you've built a coding agent with a clean architecture.
 *
 * The key pattern you've learned:
 *   Agent class (pure TS) emits events → Ink TUI subscribes → useReducer state
 *
 * This is exactly how pi-mono works at packages/agent + packages/coding-agent.
 *
 * NEXT STEPS (Stage 5 — Session Persistence):
 *
 * 1. Save state.messages to disk on every message:
 *    Write to .sessions/<sessionId>.json after each assistant turn.
 *    On startup, check for existing sessions and offer to resume.
 *
 * 2. Add a session browser: press Ctrl+S to open a session list,
 *    navigate with arrow keys, press Enter to load. This mirrors
 *    pi-mono's SessionSelectorComponent.
 *
 * 3. Add session compaction: when historyRef.current.length > 20,
 *    ask the LLM to summarize the oldest 10 messages into a single
 *    "context summary" message. This keeps the context window from overflowing.
 *    This is pi-mono's compaction system.
 *
 * 4. Add a system prompt editor: press Ctrl+P to open an editor panel
 *    where you can change the system prompt. The change takes effect on
 *    the next message. Store the system prompt in session JSON.
 */
