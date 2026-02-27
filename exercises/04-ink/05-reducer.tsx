/**
 * Exercise 04-ink/05-reducer.tsx
 *
 * CONCEPTS: useReducer, complex state, action creators, derived state
 *
 * Run with: npm run ex exercises/04-ink/05-reducer.tsx
 *
 * useReducer is useState for complex state.
 * Instead of multiple useState calls that can get out of sync,
 * all state lives in one object and changes through typed actions.
 *
 * This is exactly how pi-mono manages agent state:
 *   type AgentState = idle | streaming | executing_tool | error
 *   type AgentAction = start_stream | append_text | start_tool | ...
 *   function reduce(state, action): AgentState { switch(action.kind) { ... } }
 *
 * Pattern: (state, action) => newState — pure function, no side effects.
 */

import { useReducer } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── 1. FILE MANAGER STATE MACHINE ────────────────────────────────────────────
// A minimal file manager modeled as a state machine with useReducer.

type FileEntry = {
	name: string;
	type: "file" | "dir";
	size?: number;
};

type FileManagerState = {
	entries: FileEntry[];
	cursor: number;
	selected: Set<string>;
	mode: "browse" | "confirm-delete" | "rename";
	renameValue: string;
	statusMessage: string;
};

type FileManagerAction =
	| { type: "move_cursor"; delta: number }
	| { type: "toggle_select" }
	| { type: "select_all" }
	| { type: "clear_selection" }
	| { type: "start_rename" }
	| { type: "rename_input"; char: string }
	| { type: "rename_backspace" }
	| { type: "confirm_rename" }
	| { type: "start_delete" }
	| { type: "confirm_delete" }
	| { type: "cancel" };

const INITIAL_ENTRIES: FileEntry[] = [
	{ name: "src/", type: "dir" },
	{ name: "exercises/", type: "dir" },
	{ name: "package.json", type: "file", size: 512 },
	{ name: "tsconfig.json", type: "file", size: 256 },
	{ name: "biome.json", type: "file", size: 128 },
	{ name: "tooling.md", type: "file", size: 4096 },
	{ name: "README.md", type: "file", size: 1024 },
];

const initialState: FileManagerState = {
	entries: INITIAL_ENTRIES,
	cursor: 0,
	selected: new Set(),
	mode: "browse",
	renameValue: "",
	statusMessage: "j/k: move  Space: select  r: rename  d: delete",
};

function fileManagerReducer(state: FileManagerState, action: FileManagerAction): FileManagerState {
	const currentEntry = state.entries[state.cursor];

	switch (action.type) {
		case "move_cursor":
			return {
				...state,
				cursor: Math.max(0, Math.min(state.entries.length - 1, state.cursor + action.delta)),
			};

		case "toggle_select": {
			if (!currentEntry) return state;
			const next = new Set(state.selected);
			if (next.has(currentEntry.name)) {
				next.delete(currentEntry.name);
			} else {
				next.add(currentEntry.name);
			}
			return { ...state, selected: next };
		}

		case "select_all":
			return { ...state, selected: new Set(state.entries.map((e) => e.name)) };

		case "clear_selection":
			return { ...state, selected: new Set() };

		case "start_rename":
			if (!currentEntry || state.mode !== "browse") return state;
			return { ...state, mode: "rename", renameValue: currentEntry.name };

		case "rename_input":
			if (state.mode !== "rename") return state;
			return { ...state, renameValue: state.renameValue + action.char };

		case "rename_backspace":
			if (state.mode !== "rename") return state;
			return { ...state, renameValue: state.renameValue.slice(0, -1) };

		case "confirm_rename": {
			if (state.mode !== "rename" || !state.renameValue.trim()) return state;
			const newEntries = state.entries.map((e, i) =>
				i === state.cursor ? { ...e, name: state.renameValue } : e,
			);
			return {
				...state,
				entries: newEntries,
				mode: "browse",
				renameValue: "",
				statusMessage: `Renamed to: ${state.renameValue}`,
			};
		}

		case "start_delete":
			if (state.mode !== "browse") return state;
			return { ...state, mode: "confirm-delete", statusMessage: "Delete? Press y to confirm, Esc to cancel." };

		case "confirm_delete": {
			const toDelete = state.selected.size > 0 ? state.selected : new Set([currentEntry?.name]);
			const newEntries = state.entries.filter((e) => !toDelete.has(e.name));
			const newCursor = Math.min(state.cursor, newEntries.length - 1);
			return {
				...state,
				entries: newEntries,
				selected: new Set(),
				cursor: Math.max(0, newCursor),
				mode: "browse",
				statusMessage: `Deleted ${toDelete.size} item(s)`,
			};
		}

		case "cancel":
			return { ...state, mode: "browse", renameValue: "", statusMessage: initialState.statusMessage };

		default:
			return state;
	}
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function FileList({ state }: { state: FileManagerState }) {
	return (
		<Box flexDirection="column">
			{state.entries.map((entry, i) => {
				const isCursor = i === state.cursor;
				const isSelected = state.selected.has(entry.name);
				const icon = entry.type === "dir" ? "d" : "-";
				const size = entry.size ? `${entry.size}B`.padStart(6) : "      ";
				const nameColor = entry.type === "dir" ? "blue" : "white";

				return (
					<Box key={entry.name}>
						<Text color={isSelected ? "yellow" : undefined}>{isSelected ? ">" : " "}</Text>
						<Text dimColor>{icon} {size} </Text>
						<Text
							color={isCursor ? "black" : nameColor}
							backgroundColor={isCursor ? "cyan" : undefined}
						>
							{entry.name}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

function RenameInput({ value }: { value: string }) {
	return (
		<Box borderStyle="round" padding={1} marginTop={1}>
			<Text>Rename: </Text>
			<Text color="yellow">{value}</Text>
			<Text>_</Text>
		</Box>
	);
}

function StatusBar({ state }: { state: FileManagerState }) {
	const selCount = state.selected.size;
	return (
		<Box marginTop={1} justifyContent="space-between">
			<Text dimColor>{state.statusMessage}</Text>
			{selCount > 0 && <Text color="yellow">{selCount} selected</Text>}
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();
	const [state, dispatch] = useReducer(fileManagerReducer, initialState);

	useInput((input, key) => {
		if (key.escape || input === "q") {
			if (state.mode !== "browse") {
				dispatch({ type: "cancel" });
			} else {
				exit();
			}
			return;
		}

		// Mode-specific input:
		if (state.mode === "rename") {
			if (key.return) {
				dispatch({ type: "confirm_rename" });
			} else if (key.backspace || key.delete) {
				dispatch({ type: "rename_backspace" });
			} else if (input && !key.ctrl && !key.meta) {
				dispatch({ type: "rename_input", char: input });
			}
			return;
		}

		if (state.mode === "confirm-delete") {
			if (input === "y") dispatch({ type: "confirm_delete" });
			else dispatch({ type: "cancel" });
			return;
		}

		// Browse mode keys:
		if (key.downArrow || input === "j") dispatch({ type: "move_cursor", delta: 1 });
		if (key.upArrow || input === "k") dispatch({ type: "move_cursor", delta: -1 });
		if (input === " ") dispatch({ type: "toggle_select" });
		if (input === "a") dispatch({ type: "select_all" });
		if (input === "A") dispatch({ type: "clear_selection" });
		if (input === "r") dispatch({ type: "start_rename" });
		if (input === "d") dispatch({ type: "start_delete" });
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold>File Manager </Text>
				<Text dimColor>({state.entries.length} items)</Text>
			</Box>
			<Box borderStyle="single" padding={1} flexDirection="column">
				<FileList state={state} />
			</Box>
			{state.mode === "rename" && <RenameInput value={state.renameValue} />}
			<StatusBar state={state} />
			<Box marginTop={1}>
				<Text dimColor>q/Esc: quit/cancel  a: select all  A: clear</Text>
			</Box>
		</Box>
	);
}

render(<App />);

/**
 * TASK:
 *
 * 1. Add a "sort" feature:
 *    - New action: { type: "set_sort"; by: "name" | "size" | "type" }
 *    - New state field: sort: { by: "name" | "size" | "type"; asc: boolean }
 *    - s key cycles through sort modes, S reverses direction
 *    - Derived state: compute sortedEntries in the component, not the reducer
 *      (reducers should stay pure; derived data belongs in the component)
 *
 * 2. Add a "copy" feature that tracks a clipboard in state:
 *    - c copies selected (or current) entries to state.clipboard
 *    - p pastes (duplicates entries with " (copy)" suffix)
 *    - Actions: { type: "copy" }, { type: "paste" }
 *
 * 3. Add undo/redo:
 *    - Wrap FileManagerState in: { past: State[], present: State, future: State[] }
 *    - Every action pushes present to past (up to 20 entries)
 *    - Ctrl+Z pops from past into present (pushing present to future)
 *    - Ctrl+Y pops from future
 *    This is the standard "undo stack" pattern used in text editors.
 */
