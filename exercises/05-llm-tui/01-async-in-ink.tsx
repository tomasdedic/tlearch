/**
 * Exercise 05-llm-tui/01-async-in-ink.tsx
 *
 * CONCEPTS: useEffect + async, spinner, loading states, async generators in components
 *
 * Run with: npm run ex exercises/05-llm-tui/01-async-in-ink.tsx
 *
 * The bridge between Stage 1 (async) and Stage 2 (Ink):
 * React components are synchronous — but LLM calls are async.
 *
 * THE RULE: never make useEffect's callback async.
 * Instead, define an async function INSIDE the effect and call it.
 * Always return a cleanup that aborts/cancels the operation.
 *
 * This is the exact pattern used in pi-mono's interactive mode components
 * whenever they kick off a stream or load data.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── 1. SPINNER ───────────────────────────────────────────────────────────────
// A spinner is just a character cycling on a timer.
// useEffect + setInterval + cleanup = the pattern for any periodic UI.

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner({ label }: { label?: string }) {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
		}, 80);
		return () => clearInterval(timer); // cleanup on unmount
	}, []); // empty deps = run once on mount

	return (
		<Text color="cyan">
			{SPINNER_FRAMES[frame]}
			{label ? ` ${label}` : ""}
		</Text>
	);
}

// ─── 2. THE CORE PATTERN: useEffect + async ───────────────────────────────────
// Problem: you want to run async code and update state as results arrive.
// Solution: define async function inside useEffect, call it, return cleanup.

type LoadState<T> =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "done"; data: T }
	| { status: "error"; message: string };

function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
	const [state, setState] = useState<LoadState<T>>({ status: "idle" });

	useEffect(() => {
		const controller = new AbortController();
		setState({ status: "loading" });

		async function run() {
			try {
				const data = await fn(controller.signal);
				if (!controller.signal.aborted) {
					setState({ status: "done", data });
				}
			} catch (err) {
				if (!controller.signal.aborted) {
					setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
				}
			}
		}

		run();
		return () => controller.abort(); // cancel on unmount or dep change
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);

	return state;
}

// ─── 3. THE STREAMING PATTERN: async generator → state ────────────────────────
// For LLM streaming: each yielded item updates state.
// This is how pi-mono renders tokens as they arrive from the API.

function useStream<T>(
	gen: (signal: AbortSignal) => AsyncGenerator<T>,
	onItem: (item: T) => void,
	deps: unknown[],
): { running: boolean; cancel: () => void } {
	const [running, setRunning] = useState(false);
	const controllerRef = useRef<AbortController | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		controllerRef.current = controller;
		setRunning(true);

		async function run() {
			try {
				for await (const item of gen(controller.signal)) {
					if (controller.signal.aborted) break;
					onItem(item); // update state with each yielded item
				}
			} catch {
				// swallow abort errors
			} finally {
				if (!controller.signal.aborted) {
					setRunning(false);
				}
			}
		}

		run();
		return () => {
			controller.abort();
			setRunning(false);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);

	const cancel = useCallback(() => {
		controllerRef.current?.abort();
		setRunning(false);
	}, []);

	return { running, cancel };
}

// ─── DEMO 1: Simulated async data load ────────────────────────────────────────

async function fakeApiCall(signal: AbortSignal): Promise<string[]> {
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, 1200);
		signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
	});
	return ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
}

function AsyncDataDemo() {
	const [trigger, setTrigger] = useState(0);
	const state = useAsync(fakeApiCall, [trigger]);

	useInput((input) => {
		if (input === "f") setTrigger((t) => t + 1); // re-fetch
	});

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={40}>
			<Text bold>Async Data Load</Text>
			<Box marginTop={1}>
				{state.status === "idle" && <Text dimColor>press f to fetch</Text>}
				{state.status === "loading" && <Spinner label="loading models..." />}
				{state.status === "error" && <Text color="red">Error: {state.message}</Text>}
				{state.status === "done" && (
					<Box flexDirection="column">
						{state.data.map((m) => (
							<Text key={m} color="green"> {m}</Text>
						))}
					</Box>
				)}
			</Box>
			<Text dimColor marginTop={1}>f: re-fetch</Text>
		</Box>
	);
}

// ─── DEMO 2: Streaming tokens ─────────────────────────────────────────────────

async function* fakeTokenStream(signal: AbortSignal): AsyncGenerator<string> {
	const words = "TypeScript is a strongly typed programming language that builds on JavaScript.".split(" ");
	for (const word of words) {
		if (signal.aborted) return;
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(resolve, 80);
			signal.addEventListener("abort", () => { clearTimeout(t); reject(); });
		});
		yield word + " ";
	}
}

function StreamingDemo() {
	const [text, setText] = useState("");
	const [trigger, setTrigger] = useState(0);

	const { running, cancel } = useStream(
		fakeTokenStream,
		// onItem: called for each yielded token — updates state
		(token) => setText((prev) => prev + token),
		[trigger], // re-run when trigger changes
	);

	useInput((input) => {
		if (input === "s") {
			setText(""); // reset text before new stream
			setTrigger((t) => t + 1);
		}
		if (input === "x") cancel();
	});

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={50}>
			<Text bold>Streaming Text</Text>
			<Box marginTop={1} flexDirection="column">
				<Box>
					{running && <Spinner />}
					{!running && text && <Text color="green"> done</Text>}
					{!running && !text && <Text dimColor> press s to stream</Text>}
				</Box>
				{text && (
					<Box marginTop={1} width={46}>
						<Text wrap="wrap">{text}</Text>
						{running && <Text color="cyan">|</Text>}
					</Box>
				)}
			</Box>
			<Text dimColor marginTop={1}>s: start  x: cancel</Text>
		</Box>
	);
}

// ─── DEMO 3: Multiple concurrent async ops ────────────────────────────────────
// In pi-mono, the UI might run a spinner while both loading config AND
// checking API key validity in parallel.

type Step = { label: string; status: "pending" | "running" | "ok" | "error" };

const INIT_STEPS: Step[] = [
	{ label: "Load config", status: "pending" },
	{ label: "Validate API key", status: "pending" },
	{ label: "Fetch models", status: "pending" },
];

function InitSequence() {
	const [steps, setSteps] = useState<Step[]>(INIT_STEPS);
	const [started, setStarted] = useState(false);

	function setStep(index: number, update: Partial<Step>) {
		setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...update } : s)));
	}

	useEffect(() => {
		if (!started) return;

		const controller = new AbortController();

		async function runStep(index: number, ms: number, fail = false) {
			setStep(index, { status: "running" });
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(resolve, ms);
				controller.signal.addEventListener("abort", () => { clearTimeout(t); reject(); });
			});
			setStep(index, { status: fail ? "error" : "ok" });
		}

		async function run() {
			try {
				await runStep(0, 400); // sequential: config first
				await Promise.all([runStep(1, 600), runStep(2, 800)]); // then parallel
			} catch {
				// aborted
			}
		}

		run();
		return () => controller.abort();
	}, [started]);

	useInput((input) => {
		if (input === "i") {
			setSteps(INIT_STEPS);
			setStarted(false);
			setTimeout(() => setStarted(true), 50);
		}
	});

	function StepIcon({ status }: { status: Step["status"] }) {
		switch (status) {
			case "pending": return <Text dimColor>○</Text>;
			case "running": return <Spinner />;
			case "ok":      return <Text color="green">✓</Text>;
			case "error":   return <Text color="red">✗</Text>;
		}
	}

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={35}>
			<Text bold>Init Sequence</Text>
			<Box flexDirection="column" marginTop={1} gap={1}>
				{steps.map((step) => (
					<Box key={step.label} gap={2}>
						<StepIcon status={step.status} />
						<Text dimColor={step.status === "pending"}>{step.label}</Text>
					</Box>
				))}
			</Box>
			{!started && <Text dimColor marginTop={1}>i: run</Text>}
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();

	useInput((_, key) => {
		if (key.escape) exit();
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">Async in Ink</Text>
				<Text dimColor> — Esc to exit</Text>
			</Box>
			<Box gap={2} alignItems="flex-start">
				<Box flexDirection="column" gap={1}>
					<AsyncDataDemo />
					<InitSequence />
				</Box>
				<StreamingDemo />
			</Box>
		</Box>
	);
}

render(<App />);

/**
 * TASK:
 *
 * 1. Extract `useAsync` and `useStream` into a separate file `hooks.ts`
 *    and import them here. This is how pi-mono organises reusable hooks.
 *
 * 2. Add a `usePolling<T>(fn, intervalMs, deps)` hook that calls fn repeatedly
 *    on an interval and returns the latest value. Use it to show a live
 *    "system status" panel that updates every 2 seconds.
 *
 * 3. Add error retry to `useAsync`: if the call fails, show a "Retry (r)" hint
 *    and pressing r re-runs the effect. Track retry count in state.
 *
 * 4. Add a `<ProgressSequence steps={string[]} msPerStep={number}>` component
 *    that uses `useStream` to show each step completing one at a time.
 *    Each step shows a spinner while active, then a checkmark when done.
 */
