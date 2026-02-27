/**
 * Exercise 04-ink/02-state.tsx
 *
 * CONCEPTS: useState, conditional rendering, useEffect, component lifecycle
 *
 * Run with: npm run ex exercises/04-ink/02-state.tsx
 *
 * React hooks in Ink work identically to React in the browser.
 * useState triggers a re-render (and thus a terminal redraw) when called.
 * Ink's differential renderer only redraws lines that changed.
 */

import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── 1. SIMPLE COUNTER ────────────────────────────────────────────────────────

function Counter() {
	const [count, setCount] = useState(0);

	useInput((input, key) => {
		if (key.upArrow || input === "+") setCount((c) => c + 1);
		if (key.downArrow || input === "-") setCount((c) => Math.max(0, c - 1));
		if (input === "r") setCount(0);
	});

	const color = count > 10 ? "red" : count > 5 ? "yellow" : "green";

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={30}>
			<Text bold>Counter</Text>
			<Box marginTop={1}>
				<Text>Count: </Text>
				<Text color={color} bold>
					{count}
				</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>up/+ inc  down/- dec  r reset</Text>
			</Box>
		</Box>
	);
}

// ─── 2. TOGGLE / BOOLEAN STATE ────────────────────────────────────────────────

type Theme = "dark" | "light";

function ThemeToggle() {
	const [theme, setTheme] = useState<Theme>("dark");
	const [notifications, setNotifications] = useState(true);
	const [autoSave, setAutoSave] = useState(false);

	const isDark = theme === "dark";

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={30} marginTop={1}>
			<Text bold>Settings</Text>
			<Box marginTop={1} flexDirection="column" gap={1}>
				{/* Each row: label + value + hint */}
				<SettingRow
					label="Theme"
					value={theme}
					color={isDark ? "blue" : "yellow"}
					hint="t"
					onToggle={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
				/>
				<SettingRow
					label="Notifications"
					value={notifications ? "on" : "off"}
					color={notifications ? "green" : "red"}
					hint="n"
					onToggle={() => setNotifications((v) => !v)}
				/>
				<SettingRow
					label="Auto-save"
					value={autoSave ? "on" : "off"}
					color={autoSave ? "green" : "red"}
					hint="a"
					onToggle={() => setAutoSave((v) => !v)}
				/>
			</Box>
		</Box>
	);
}

function SettingRow({
	label,
	value,
	color,
	hint,
	onToggle,
}: {
	label: string;
	value: string;
	color: string;
	hint: string;
	onToggle: () => void;
}) {
	// Each SettingRow listens for its own key:
	useInput((input) => {
		if (input === hint) onToggle();
	});

	return (
		<Box justifyContent="space-between" width={26}>
			<Text>{label}</Text>
			<Text color={color}>{value}</Text>
		</Box>
	);
}

// ─── 3. USEEFFECT — SIDE EFFECTS AND TIMERS ──────────────────────────────────
// useEffect runs after every render (by default).
// Passing [] as deps means "run once on mount".
// Return a cleanup function to run on unmount.

function Clock() {
	const [time, setTime] = useState(new Date().toLocaleTimeString());
	const [elapsed, setElapsed] = useState(0);

	// Timer: update every second.
	useEffect(() => {
		const interval = setInterval(() => {
			setTime(new Date().toLocaleTimeString());
			setElapsed((e) => e + 1);
		}, 1000);

		// Cleanup: clear the interval when the component unmounts.
		return () => clearInterval(interval);
	}, []); // empty deps = run once on mount

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={30} marginTop={1}>
			<Text bold>Clock</Text>
			<Box marginTop={1} gap={2}>
				<Text color="cyan">{time}</Text>
				<Text dimColor>{elapsed}s elapsed</Text>
			</Box>
		</Box>
	);
}

// ─── 4. CONDITIONAL RENDERING ─────────────────────────────────────────────────

type Status = "idle" | "loading" | "done" | "error";

function StatusDemo() {
	const [status, setStatus] = useState<Status>("idle");

	useInput((input) => {
		if (input === "l") setStatus("loading");
		if (input === "d") setStatus("done");
		if (input === "e") setStatus("error");
		if (input === "i") setStatus("idle");
	});

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={30} marginTop={1}>
			<Text bold>Status</Text>
			<Box marginTop={1}>{renderStatus(status)}</Box>
			<Box marginTop={1}>
				<Text dimColor>l load  d done  e error  i idle</Text>
			</Box>
		</Box>
	);
}

// Separate render function keeps the component clean — same pattern as pi-mono:
function renderStatus(status: Status) {
	switch (status) {
		case "idle":
			return <Text dimColor>waiting...</Text>;
		case "loading":
			return <Text color="yellow">loading...</Text>;
		case "done":
			return <Text color="green">done!</Text>;
		case "error":
			return <Text color="red">error!</Text>;
	}
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();

	useInput((_, key) => {
		if (key.escape) exit();
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box gap={2}>
				<Counter />
				<ThemeToggle />
			</Box>
			<Box gap={2}>
				<Clock />
				<StatusDemo />
			</Box>
			<Box marginTop={1}>
				<Text dimColor>Esc: exit</Text>
			</Box>
		</Box>
	);
}

render(<App />);

/**
 * TASK:
 *
 * 1. Add a <Stopwatch> component with start/stop/reset using useState and
 *    useEffect. Show elapsed time in mm:ss format.
 *    Keys: space = start/stop, r = reset.
 *
 * 2. Add a <TypedText text="..."> component that renders the text one character
 *    at a time using useEffect + setInterval + useState(index).
 *    It should show a blinking cursor (|) at the current position.
 *
 * 3. Make Counter remember its value between renders using a ref (useRef).
 *    Add a "max ever" display that tracks the highest value reached.
 *    Note: useRef does NOT trigger re-renders — perfect for tracking history.
 */
