/**
 * Exercise 05-llm-tui/03-tool-loop.tsx
 *
 * CONCEPTS: tool calling, agent loop, tool execution state in TUI
 *
 * Run with: ANTHROPIC_API_KEY=sk-... npm run ex exercises/05-llm-tui/03-tool-loop.tsx
 * Simulation: npm run ex exercises/05-llm-tui/03-tool-loop.tsx
 *
 * The agent loop (from packages/agent/src/agent-loop.ts):
 *   1. Send messages → stream response
 *   2. If stop_reason = "tool_use" → execute tools
 *   3. Append tool results → stream again
 *   4. Repeat until stop_reason = "stop"
 *
 * This is the CORE of any coding agent — everything else is UI around this loop.
 */

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── TYPES ────────────────────────────────────────────────────────────────────

type ToolCall = {
	id: string;
	name: string;
	input: Record<string, unknown>;
};

type ToolResult = {
	toolCallId: string;
	content: string;
	isError: boolean;
};

// Agent loop state — a discriminated union (pattern from 01-types/04):
type LoopState =
	| { phase: "idle" }
	| { phase: "streaming"; text: string; toolCalls: ToolCall[] }
	| { phase: "executing"; tool: ToolCall; resultsSoFar: ToolResult[] }
	| { phase: "done"; text: string; turns: number }
	| { phase: "error"; message: string };

type LoopAction =
	| { type: "start" }
	| { type: "text_delta"; text: string }
	| { type: "toolcall_found"; tool: ToolCall }
	| { type: "executing_tool"; tool: ToolCall; resultsSoFar: ToolResult[] }
	| { type: "finish"; text: string; turns: number }
	| { type: "error"; message: string }
	| { type: "reset" };

function loopReducer(state: LoopState, action: LoopAction): LoopState {
	switch (action.type) {
		case "start":
			return { phase: "streaming", text: "", toolCalls: [] };
		case "text_delta":
			if (state.phase !== "streaming") return state;
			return { ...state, text: state.text + action.text };
		case "toolcall_found":
			if (state.phase !== "streaming") return state;
			return { ...state, toolCalls: [...state.toolCalls, action.tool] };
		case "executing_tool":
			return { phase: "executing", tool: action.tool, resultsSoFar: action.resultsSoFar };
		case "finish":
			return { phase: "done", text: action.text, turns: action.turns };
		case "error":
			return { phase: "error", message: action.message };
		case "reset":
			return { phase: "idle" };
		default:
			return state;
	}
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────
// Tools are defined with JSON Schema for the LLM to understand their parameters.
// This mirrors packages/coding-agent/src/core/tools/

const TOOLS: Anthropic.Tool[] = [
	{
		name: "read_file",
		description: "Read the contents of a file at the given path.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "The file path to read" },
				max_lines: { type: "number", description: "Max lines to return (default 50)" },
			},
			required: ["path"],
		},
	},
	{
		name: "list_dir",
		description: "List files in a directory.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory path to list" },
			},
			required: ["path"],
		},
	},
	{
		name: "get_time",
		description: "Get the current date and time.",
		input_schema: { type: "object", properties: {} },
	},
];

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────
// Pure async functions — no side effects on UI state.
// In pi-mono these are in packages/coding-agent/src/core/tools/

async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolResult & { toolCallId: string }> {
	// We don't have toolCallId here — caller adds it. Return partial.
	const run = async (): Promise<string> => {
		switch (name) {
			case "read_file": {
				const path = input.path as string;
				const maxLines = (input.max_lines as number) ?? 50;
				try {
					const content = await fs.readFile(path, "utf-8");
					const lines = content.split("\n").slice(0, maxLines);
					return lines.join("\n") + (content.split("\n").length > maxLines ? `\n... (${content.split("\n").length - maxLines} more lines)` : "");
				} catch (err) {
					throw new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			case "list_dir": {
				const path = input.path as string;
				try {
					const entries = await fs.readdir(path, { withFileTypes: true });
					return entries
						.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`)
						.join("\n");
				} catch (err) {
					throw new Error(`Cannot list ${path}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			case "get_time":
				return new Date().toLocaleString();
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	};

	try {
		const content = await run();
		return { toolCallId: "", content, isError: false };
	} catch (err) {
		return { toolCallId: "", content: err instanceof Error ? err.message : String(err), isError: true };
	}
}

// ─── THE AGENT LOOP ───────────────────────────────────────────────────────────
// This function IS the agent. It runs the LLM → tool → LLM cycle.
// It dispatches state updates as it progresses so the UI can react.

async function runAgentLoop(
	client: Anthropic,
	messages: Anthropic.MessageParam[],
	dispatch: (action: LoopAction) => void,
	signal: AbortSignal,
): Promise<{ finalText: string; turns: number }> {
	let currentMessages = [...messages];
	let turns = 0;
	let finalText = "";

	while (!signal.aborted) {
		turns++;
		dispatch({ type: "start" });

		// Stream LLM response:
		const stream = client.messages.stream(
			{ model: "claude-haiku-4-5-20251001", max_tokens: 1024, tools: TOOLS, messages: currentMessages },
			{ signal },
		);

		const collectedToolCalls: ToolCall[] = [];

		for await (const event of stream) {
			if (signal.aborted) return { finalText, turns };

			if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
				dispatch({ type: "text_delta", text: event.delta.text });
				finalText += event.delta.text;
			}

			// Collect tool calls as they stream in:
			if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
				const tool: ToolCall = { id: event.content_block.id, name: event.content_block.name, input: {} };
				collectedToolCalls.push(tool);
				dispatch({ type: "toolcall_found", tool });
			}
		}

		const finalMsg = await stream.finalMessage();

		// If no tools used, we're done:
		if (finalMsg.stop_reason !== "tool_use") {
			dispatch({ type: "finish", text: finalText, turns });
			return { finalText, turns };
		}

		// Extract full tool calls from the final message (inputs are complete here):
		const toolUseBlocks = finalMsg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

		// Append the assistant message (with tool use blocks):
		currentMessages.push({ role: "assistant", content: finalMsg.content });

		// Execute all tool calls:
		const toolResults: ToolResult[] = [];

		for (const block of toolUseBlocks) {
			const tool: ToolCall = { id: block.id, name: block.name, input: block.input as Record<string, unknown> };
			dispatch({ type: "executing_tool", tool, resultsSoFar: toolResults });

			const result = await executeTool(block.name, block.input as Record<string, unknown>);
			toolResults.push({ ...result, toolCallId: block.id });
		}

		// Append tool results as a user message:
		currentMessages.push({
			role: "user",
			content: toolResults.map((r) => ({
				type: "tool_result" as const,
				tool_use_id: r.toolCallId,
				content: r.content,
				is_error: r.isError,
			})),
		});

		// Loop continues — LLM will process the tool results.
		finalText = ""; // reset for next turn's text
	}

	return { finalText, turns };
}

// ─── SIMULATED AGENT LOOP (no API key) ────────────────────────────────────────

async function simulatedAgentLoop(
	prompt: string,
	dispatch: (action: LoopAction) => void,
	signal: AbortSignal,
): Promise<void> {
	async function delay(ms: number) {
		await new Promise<void>((r, rej) => {
			const t = setTimeout(r, ms);
			signal.addEventListener("abort", () => { clearTimeout(t); rej(); });
		});
	}

	dispatch({ type: "start" });
	await delay(200);

	// Simulate: LLM decides to call list_dir, then read a file
	const fakeTool1: ToolCall = { id: "t1", name: "list_dir", input: { path: "." } };
	dispatch({ type: "toolcall_found", tool: fakeTool1 });
	await delay(300);

	dispatch({ type: "executing_tool", tool: fakeTool1, resultsSoFar: [] });
	await delay(500);

	const fakeTool2: ToolCall = { id: "t2", name: "read_file", input: { path: "package.json" } };
	dispatch({ type: "start" });
	dispatch({ type: "toolcall_found", tool: fakeTool2 });
	dispatch({ type: "executing_tool", tool: fakeTool2, resultsSoFar: [{ toolCallId: "t1", content: "package.json\ntsconfig.json", isError: false }] });
	await delay(600);

	dispatch({ type: "start" });
	const response = `[simulated] Based on my analysis of "${prompt}":\n\nI read your project files. It's a TypeScript learning project with ink and @anthropic-ai/sdk installed. Ready to build a TUI agent!`;
	for (const char of response) {
		if (signal.aborted) return;
		await delay(12);
		dispatch({ type: "text_delta", text: char });
	}
	dispatch({ type: "finish", text: response, turns: 2 });
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function Spinner({ label }: { label?: string }) {
	const [f, setF] = useReducer((n: number) => (n + 1) % FRAMES.length, 0);
	useEffect(() => { const t = setInterval(() => setF(0), 80); return () => clearInterval(t); }, []);
	return <Text color="cyan">{FRAMES[f]}{label ? ` ${label}` : ""}</Text>;
}

function ToolCallDisplay({ tool, executing }: { tool: ToolCall; executing: boolean }) {
	return (
		<Box gap={2}>
			{executing ? <Spinner /> : <Text color="green">✓</Text>}
			<Text color="yellow">{tool.name}</Text>
			<Text dimColor>({JSON.stringify(tool.input).slice(0, 40)})</Text>
		</Box>
	);
}

function PhaseDisplay({ state }: { state: LoopState }) {
	switch (state.phase) {
		case "idle":
			return <Text dimColor>Press Enter to run the agent loop.</Text>;
		case "streaming":
			return (
				<Box flexDirection="column" gap={1}>
					<Box gap={1}><Spinner label="streaming..." /></Box>
					{state.toolCalls.map((t) => (
						<ToolCallDisplay key={t.id} tool={t} executing={false} />
					))}
					{state.text && (
						<Box marginTop={1}>
							<Text wrap="wrap">{state.text}<Text color="cyan">▋</Text></Text>
						</Box>
					)}
				</Box>
			);
		case "executing":
			return (
				<Box flexDirection="column" gap={1}>
					{state.resultsSoFar.map((r) => (
						<Box key={r.toolCallId} gap={2}>
							<Text color="green">✓</Text>
							<Text dimColor>tool done</Text>
						</Box>
					))}
					<ToolCallDisplay tool={state.tool} executing={true} />
				</Box>
			);
		case "done":
			return (
				<Box flexDirection="column" gap={1}>
					<Box gap={2}>
						<Text color="green">✓ done</Text>
						<Text dimColor>({state.turns} turn{state.turns !== 1 ? "s" : ""})</Text>
					</Box>
					<Box>
						<Text wrap="wrap">{state.text}</Text>
					</Box>
				</Box>
			);
		case "error":
			return <Text color="red">Error: {state.message}</Text>;
	}
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

const PROMPTS = [
	"List the files in the current directory and read package.json",
	"What time is it right now?",
	"Read the tsconfig.json file and explain the key settings",
];

function App() {
	const { exit } = useApp();
	const apiKey = process.env.ANTHROPIC_API_KEY;
	const client = apiKey ? new Anthropic({ apiKey }) : null;

	const [state, dispatch] = useReducer(loopReducer, { phase: "idle" });
	const [promptIdx, setPromptIdx] = useState(0);
	const controllerRef = useRef<AbortController | null>(null);

	const prompt = PROMPTS[promptIdx % PROMPTS.length];

	function run() {
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;

		if (client) {
			runAgentLoop(client, [{ role: "user", content: prompt }], dispatch, controller.signal).catch((err) => {
				if (!controller.signal.aborted) dispatch({ type: "error", message: String(err) });
			});
		} else {
			simulatedAgentLoop(prompt, dispatch, controller.signal).catch(() => {});
		}
	}

	useInput((input, key) => {
		if (key.escape || input === "q") { controllerRef.current?.abort(); exit(); return; }
		if (key.return || input === "s") run();
		if (input === "x") { controllerRef.current?.abort(); dispatch({ type: "reset" }); }
		if (key.tab || input === "n") { setPromptIdx((i) => i + 1); dispatch({ type: "reset" }); }
	});

	const cols = process.stdout.columns ?? 80;

	return (
		<Box flexDirection="column" padding={1}>
			<Box justifyContent="space-between" marginBottom={1}>
				<Text bold color="cyan">Agent Loop</Text>
				{client ? <Text color="green">live API</Text> : <Text color="yellow">simulation</Text>}
			</Box>

			<Box flexDirection="column" borderStyle="single" padding={1} marginBottom={1} width={cols - 4}>
				<Text dimColor>Prompt (Tab/n to cycle):</Text>
				<Text>{prompt}</Text>
			</Box>

			<Box flexDirection="column" borderStyle="round" padding={1} width={cols - 4} minHeight={10}>
				<PhaseDisplay state={state} />
			</Box>

			<Box marginTop={1} gap={3}>
				<Text dimColor>Enter/s: run</Text>
				<Text dimColor>x: cancel</Text>
				<Text dimColor>Tab/n: next prompt</Text>
				<Text dimColor>q/Esc: exit</Text>
			</Box>
		</Box>
	);
}

render(<App />);

/**
 * TASK:
 *
 * 1. Add a `bash` tool: { name: "bash", input: { command: string } }
 *    Execute it with child_process.execSync and return stdout.
 *    IMPORTANT: only allow safe read-only commands (ls, cat, echo, pwd, date).
 *    Block anything with rm, mv, >, |, ; to prevent accidents while learning.
 *
 * 2. Add a "tool results" panel: after all tools are executed, show a
 *    collapsible list of tool call → result pairs. Press t to toggle visibility.
 *
 * 3. Add turn tracking to the UI: show "Turn 1/3" as the loop progresses.
 *    Add a `maxTurns: number` prop and abort the loop if it exceeds it.
 *    This is the safety limit pi-mono uses to prevent infinite agent loops.
 *
 * 4. Add parallel tool execution: when the LLM returns multiple tool calls
 *    in one turn, execute them with Promise.all instead of sequentially.
 *    Show all tools running in parallel in the UI.
 *    This is what pi-mono does in packages/agent/src/agent-loop.ts.
 */
