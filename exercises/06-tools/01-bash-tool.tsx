/**
 * Exercise 06-tools/01-bash-tool.tsx
 *
 * CONCEPTS: child_process.spawn, async queue pattern, streaming output in Ink
 *
 * Run with: npm run ex exercises/06-tools/01-bash-tool.tsx
 *
 * The bash tool is the most complex in pi-mono because its output is a stream,
 * not a single value. This requires bridging Node.js event emitters
 * (process.stdout.on('data')) into an async generator (for-await-of).
 *
 * The "async queue" pattern used here is general-purpose:
 * any EventEmitter can be converted to an AsyncIterable with this technique.
 *
 * From packages/coding-agent/src/core/tools/bash.ts
 */

import { spawn } from "node:child_process";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── THE ASYNC QUEUE PATTERN ──────────────────────────────────────────────────
// Problem: EventEmitter pushes data, async generator pulls data.
//          They work in opposite directions.
// Solution: a shared queue. The emitter pushes into it; the generator pops from it.
//           When the queue is empty the generator suspends, waiting for a resolver
//           that the emitter calls when new data arrives.

type BashOutput =
	| { type: "stdout"; text: string }
	| { type: "stderr"; text: string }
	| { type: "exit"; code: number };

async function* spawnCommand(
	command: string,
	signal: AbortSignal,
): AsyncGenerator<BashOutput> {
	// The queue holds items waiting to be consumed:
	const queue: (BashOutput | null)[] = []; // null = "stream ended" sentinel
	let resolver: (() => void) | null = null;

	// Pushing into the queue. If the generator is waiting, wake it up:
	function enqueue(item: BashOutput | null) {
		queue.push(item);
		resolver?.();
		resolver = null;
	}

	// Spawn the process. 'sh -c' lets us run full shell commands.
	const proc = spawn("sh", ["-c", command], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	// On abort: kill the process. The 'close' event will still fire.
	signal.addEventListener("abort", () => proc.kill("SIGTERM"));

	proc.stdout.on("data", (chunk: Buffer) => enqueue({ type: "stdout", text: chunk.toString() }));
	proc.stderr.on("data", (chunk: Buffer) => enqueue({ type: "stderr", text: chunk.toString() }));
	proc.on("close", (code: number | null) => {
		enqueue({ type: "exit", code: code ?? -1 });
		enqueue(null); // sentinel: generator should stop
	});

	// The generator loop: drain the queue, suspend when empty:
	while (true) {
		// Drain everything currently in the queue:
		while (queue.length > 0) {
			const item = queue.shift()!;
			if (item === null) return; // sentinel — we're done
			yield item;
		}
		// Queue is empty — suspend until the next enqueue() call:
		await new Promise<void>((resolve) => {
			resolver = resolve;
		});
	}
}

// ─── SAFETY LAYER ─────────────────────────────────────────────────────────────
// Never run arbitrary commands. Validate before executing.
// pi-mono's bash tool has a similar allow/block pattern.

const BLOCKED_PATTERNS = [
	/rm\s+-rf/i, // recursive delete
	/>\s*\//,    // redirect to absolute path
	/mkfs/i,     // format disk
	/dd\s+if=/i, // disk dump
	/:(){ :|:& };:/, // fork bomb
	/curl.*\|.*sh/i, // pipe URL to shell
	/wget.*-O.*\|/i, // pipe wget to shell
];

type SafetyResult = { ok: true } | { ok: false; reason: string };

function checkSafety(command: string): SafetyResult {
	for (const pattern of BLOCKED_PATTERNS) {
		if (pattern.test(command)) {
			return { ok: false, reason: `Blocked pattern: ${pattern}` };
		}
	}
	// Warn (but allow) commands that modify files:
	if (/\brm\b/.test(command) || /\bmv\b/.test(command) || />>/.test(command)) {
		return { ok: false, reason: "Potentially destructive command — add ! prefix to force" };
	}
	return { ok: true };
}

// ─── STATE ────────────────────────────────────────────────────────────────────

type OutputLine = { id: number; source: "stdout" | "stderr" | "system"; text: string };

type State = {
	input: string;
	output: OutputLine[];
	running: boolean;
	exitCode: number | null;
	history: string[];
	historyIdx: number;
};

type Action =
	| { type: "type"; char: string }
	| { type: "backspace" }
	| { type: "set_input"; value: string }
	| { type: "run" }
	| { type: "append_line"; line: OutputLine }
	| { type: "set_done"; code: number }
	| { type: "clear_output" }
	| { type: "history_up" }
	| { type: "history_down" };

let lineId = 0;

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case "type":        return { ...state, input: state.input + action.char };
		case "backspace":   return { ...state, input: state.input.slice(0, -1) };
		case "set_input":   return { ...state, input: action.value };
		case "run":
			if (!state.input.trim()) return state;
			return {
				...state,
				running: true,
				exitCode: null,
				output: [{ id: ++lineId, source: "system", text: `$ ${state.input}` }],
				history: [state.input, ...state.history.filter((h) => h !== state.input)].slice(0, 50),
				historyIdx: -1,
				input: "",
			};
		case "append_line":
			return { ...state, output: [...state.output, action.line].slice(-200) }; // keep last 200 lines
		case "set_done":
			return { ...state, running: false, exitCode: action.code };
		case "clear_output":
			return { ...state, output: [], exitCode: null };
		case "history_up": {
			const idx = Math.min(state.historyIdx + 1, state.history.length - 1);
			return { ...state, historyIdx: idx, input: state.history[idx] ?? "" };
		}
		case "history_down": {
			const idx = Math.max(state.historyIdx - 1, -1);
			return { ...state, historyIdx: idx, input: idx === -1 ? "" : state.history[idx] };
		}
		default: return state;
	}
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function Spinner() {
	const [f, setF] = useState(0);
	useEffect(() => { const t = setInterval(() => setF((n) => (n + 1) % FRAMES.length), 80); return () => clearInterval(t); }, []);
	return <Text color="cyan">{FRAMES[f]}</Text>;
}

function OutputPanel({ lines, running, exitCode, cols }: {
	lines: OutputLine[];
	running: boolean;
	exitCode: number | null;
	cols: number;
}) {
	return (
		<Box flexDirection="column" borderStyle="single" padding={1} width={cols - 2} flexGrow={1} minHeight={12}>
			{lines.length === 0 && !running && (
				<Text dimColor>Run a command to see output here.</Text>
			)}
			{lines.map((line) => (
				<Text
					key={line.id}
					color={line.source === "stderr" ? "red" : line.source === "system" ? "cyan" : undefined}
					dimColor={line.source === "system"}
					wrap="truncate-end"
				>
					{line.text}
				</Text>
			))}
			{running && (
				<Box gap={1}>
					<Spinner />
					<Text dimColor>running...</Text>
				</Box>
			)}
			{!running && exitCode !== null && (
				<Text color={exitCode === 0 ? "green" : "red"} dimColor>
					[exit {exitCode}]
				</Text>
			)}
		</Box>
	);
}

function InputBar({ value, running, cols }: { value: string; running: boolean; cols: number }) {
	const safety = value.trim() ? checkSafety(value) : null;
	const borderColor = running ? "gray" : safety?.ok === false ? "red" : "white";

	return (
		<Box flexDirection="column">
			<Box borderStyle="round" paddingX={1} width={cols - 2} borderColor={borderColor}>
				<Text color={running ? "gray" : "cyan"}>$ </Text>
				<Text color={running ? "gray" : "white"} wrap="truncate-end">
					{value || (running ? "(running...)" : "type a command...")}
				</Text>
				{!running && <Text>_</Text>}
			</Box>
			{safety?.ok === false && (
				<Box paddingX={2}>
					<Text color="red">! {safety.reason}</Text>
				</Box>
			)}
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();
	const [state, dispatch] = useReducer(reducer, {
		input: "",
		output: [],
		running: false,
		exitCode: null,
		history: ["ls -la", "cat package.json", "pwd", "date", "echo Hello TypeScript"],
		historyIdx: -1,
	});

	const controllerRef = useRef<AbortController | null>(null);

	// Run a command: fire-and-forget from useCallback, cancel previous
	const runCommand = useCallback((command: string) => {
		const safety = checkSafety(command);
		if (!safety.ok) {
			dispatch({ type: "append_line", line: { id: ++lineId, source: "stderr", text: `Blocked: ${safety.reason}` } });
			return;
		}

		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;

		dispatch({ type: "run" });

		async function run() {
			try {
				for await (const chunk of spawnCommand(command, controller.signal)) {
					if (controller.signal.aborted) break;
					if (chunk.type === "stdout") {
						// Split on newlines so each line gets its own entry:
						for (const line of chunk.text.split("\n").filter(Boolean)) {
							dispatch({ type: "append_line", line: { id: ++lineId, source: "stdout", text: line } });
						}
					} else if (chunk.type === "stderr") {
						for (const line of chunk.text.split("\n").filter(Boolean)) {
							dispatch({ type: "append_line", line: { id: ++lineId, source: "stderr", text: line } });
						}
					} else if (chunk.type === "exit") {
						dispatch({ type: "set_done", code: chunk.code });
					}
				}
			} catch {
				dispatch({ type: "set_done", code: -1 });
			}
		}

		run();
	}, []);

	useInput((input, key) => {
		if (key.escape) { controllerRef.current?.abort(); exit(); return; }
		if (key.ctrl && input === "c") { controllerRef.current?.abort(); dispatch({ type: "set_done", code: -1 }); return; }
		if (key.ctrl && input === "l") { dispatch({ type: "clear_output" }); return; }
		if (key.upArrow) { dispatch({ type: "history_up" }); return; }
		if (key.downArrow) { dispatch({ type: "history_down" }); return; }
		if (key.return) {
			if (state.running) return;
			if (state.input.trim()) runCommand(state.input.trim());
			return;
		}
		if (key.backspace || key.delete) { dispatch({ type: "backspace" }); return; }
		if (input && !key.ctrl && !key.meta) { dispatch({ type: "type", char: input }); }
	});

	const cols = process.stdout.columns ?? 80;

	return (
		<Box flexDirection="column" padding={1} height={process.stdout.rows ?? 24}>
			<Box justifyContent="space-between" marginBottom={1}>
				<Text bold color="cyan">Bash Tool</Text>
				<Text dimColor>Up/Down: history  Ctrl+C: kill  Ctrl+L: clear  Esc: exit</Text>
			</Box>
			<OutputPanel lines={state.output} running={state.running} exitCode={state.exitCode} cols={cols} />
			<Box marginTop={1}>
				<InputBar value={state.input} running={state.running} cols={cols} />
			</Box>
		</Box>
	);
}

render(<App />);

/**
 * TASK:
 *
 * 1. Add a working directory selector: a `cwd` state field, a `cd <path>` built-in
 *    command (don't spawn a process — just update state.cwd and verify the path exists).
 *    Pass `cwd` option to spawn(). Show it in the input bar prompt: "~/src $".
 *
 * 2. Add timeout support: if a command runs longer than 10s, kill it and show
 *    "[timeout]". Use AbortSignal.timeout(10_000) combined with anySignal()
 *    from exercise 02-async/04-abort-signal.ts.
 *
 * 3. Add output search: press / to enter search mode, type to filter output lines.
 *    Matching lines are highlighted. Esc returns to normal mode.
 *    This teaches the "secondary input mode" pattern common in TUIs.
 *
 * 4. Implement `! prefix to force`: if the command starts with '!', skip safety
 *    checks and run anyway. Show a red "FORCED" badge in the output panel.
 *    This is the override pattern pi-mono uses for potentially dangerous operations.
 */
