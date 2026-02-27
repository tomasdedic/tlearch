/**
 * Exercise 04-ink/03-input.tsx
 *
 * CONCEPTS: useInput in depth, key detection, text input, focus management
 *
 * Run with: npm run ex exercises/04-ink/03-input.tsx
 *
 * useInput(handler, options?) is Ink's primary keyboard API.
 * handler receives: (input: string, key: Key)
 *   - input: the character typed (empty string for special keys)
 *   - key: an object with boolean flags for each special key
 *
 * Key flags: upArrow, downArrow, leftArrow, rightArrow,
 *            return (Enter), escape, backspace, delete,
 *            tab, shift, ctrl, meta (Alt/Option), pageUp, pageDown
 */

import { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import type { Key } from "ink";

// ─── 1. KEY INSPECTOR — see every keypress ────────────────────────────────────

type KeyEvent = {
	input: string;
	key: Key;
	id: number;
};

function KeyInspector() {
	const [events, setEvents] = useState<KeyEvent[]>([]);
	const [idCounter, setIdCounter] = useState(0);

	useInput((input, key) => {
		// Don't log Escape — that exits the app
		if (key.escape) return;

		setEvents((prev) => {
			const next = [{ input, key, id: idCounter }, ...prev].slice(0, 6); // keep last 6
			return next;
		});
		setIdCounter((n) => n + 1);
	});

	function describeKey(input: string, key: Key): string {
		const parts: string[] = [];
		if (key.ctrl) parts.push("Ctrl");
		if (key.shift) parts.push("Shift");
		if (key.meta) parts.push("Meta");
		if (key.upArrow) parts.push("Up");
		else if (key.downArrow) parts.push("Down");
		else if (key.leftArrow) parts.push("Left");
		else if (key.rightArrow) parts.push("Right");
		else if (key.return) parts.push("Enter");
		else if (key.tab) parts.push("Tab");
		else if (key.backspace) parts.push("Backspace");
		else if (key.delete) parts.push("Delete");
		else if (key.pageUp) parts.push("PageUp");
		else if (key.pageDown) parts.push("PageDown");
		else if (input) parts.push(`'${input}'`);
		return parts.join("+") || "(unknown)";
	}

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={40}>
			<Text bold>Key Inspector</Text>
			<Text dimColor>Press any key (Esc to exit)</Text>
			<Box flexDirection="column" marginTop={1} height={6}>
				{events.length === 0 ? (
					<Text dimColor>waiting for input...</Text>
				) : (
					events.map((e, i) => (
						<Text key={e.id} dimColor={i > 0}>
							{describeKey(e.input, e.key)}
						</Text>
					))
				)}
			</Box>
		</Box>
	);
}

// ─── 2. MINIMAL TEXT INPUT ────────────────────────────────────────────────────
// Ink doesn't have a built-in TextInput. This shows how to build one.
// (In practice, use @inkjs/ui's TextInput for production.)

function TextInput({
	placeholder,
	onSubmit,
}: {
	placeholder: string;
	onSubmit: (value: string) => void;
}) {
	const [value, setValue] = useState("");

	useInput((input, key) => {
		if (key.return) {
			onSubmit(value);
			setValue("");
			return;
		}
		if (key.backspace || key.delete) {
			setValue((v) => v.slice(0, -1));
			return;
		}
		// Only add printable characters:
		if (input && !key.ctrl && !key.meta) {
			setValue((v) => v + input);
		}
	});

	const display = value || placeholder;
	const isPlaceholder = !value;

	return (
		<Box borderStyle="single" paddingX={1} width={30}>
			<Text color={isPlaceholder ? undefined : "white"} dimColor={isPlaceholder}>
				{display}
			</Text>
			{/* blinking cursor simulation */}
			{!isPlaceholder && <Text color="white">_</Text>}
		</Box>
	);
}

function InputDemo() {
	const [submitted, setSubmitted] = useState<string[]>([]);

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={40} marginTop={1}>
			<Text bold>Text Input</Text>
			<Box marginTop={1} flexDirection="column" gap={1}>
				<TextInput placeholder="type something... (Enter to submit)" onSubmit={(v) => setSubmitted((p) => [v, ...p].slice(0, 4))} />
				{submitted.length > 0 && (
					<Box flexDirection="column">
						<Text dimColor>Submitted:</Text>
						{submitted.map((s, i) => (
							<Text key={`${s}-${i}`} color="green">
								{" "}
								{s}
							</Text>
						))}
					</Box>
				)}
			</Box>
		</Box>
	);
}

// ─── 3. KEY COMBINATIONS ─────────────────────────────────────────────────────

type Action =
	| { type: "undo" }
	| { type: "redo" }
	| { type: "save" }
	| { type: "copy" }
	| { type: "paste" };

function KeyComboDemo() {
	const [lastAction, setLastAction] = useState<Action | null>(null);
	const [history, setHistory] = useState<string[]>([]);

	function dispatch(action: Action) {
		setLastAction(action);
		setHistory((h) => [`${action.type}`, ...h].slice(0, 5));
	}

	useInput((input, key) => {
		if (key.ctrl) {
			switch (input) {
				case "z":
					dispatch({ type: "undo" });
					break;
				case "y":
					dispatch({ type: "redo" });
					break;
				case "s":
					dispatch({ type: "save" });
					break;
				case "c":
					dispatch({ type: "copy" });
					break;
				case "v":
					dispatch({ type: "paste" });
					break;
			}
		}
	});

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={40} marginTop={1}>
			<Text bold>Key Combinations</Text>
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>Ctrl+Z undo  Ctrl+Y redo  Ctrl+S save</Text>
				<Text dimColor>Ctrl+C copy  Ctrl+V paste</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				{lastAction ? (
					<Text color="yellow">Last: {lastAction.type}</Text>
				) : (
					<Text dimColor>no action yet</Text>
				)}
				{history.map((h, i) => (
					<Text key={`${h}-${i}`} dimColor>
						{" "}
						{h}
					</Text>
				))}
			</Box>
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
			<Box gap={2} alignItems="flex-start">
				<KeyInspector />
				<Box flexDirection="column">
					<InputDemo />
					<KeyComboDemo />
				</Box>
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
 * 1. Extend TextInput to support cursor movement with left/right arrow keys.
 *    Track a cursor position (number) alongside the value string.
 *    Inserting a character should insert at cursor position, not always append.
 *
 * 2. Add a <NumberInput min={0} max={100} step={1}> component that:
 *    - Shows the current number
 *    - Up/down arrows increase/decrease by step
 *    - Left/right arrows change step (1, 10, 100)
 *    - Clamps to min/max
 *
 * 3. Add a <SearchInput items={string[]} onSelect={(item) => void}> component:
 *    - User types to filter items
 *    - Shows filtered list below the input
 *    - Up/down arrows move selection in the list
 *    - Enter confirms selection
 *    This is the foundation of pi-mono's autocomplete system.
 */
