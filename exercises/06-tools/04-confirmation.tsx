/**
 * Exercise 06-tools/04-confirmation.tsx
 *
 * CONCEPTS: confirmation dialogs, modal overlays, blocking user actions in TUI
 *
 * Run with: npm run ex exercises/06-tools/04-confirmation.tsx
 *
 * Destructive tool actions (write_file, bash with side effects) must ask
 * before executing. This exercise shows the patterns for doing that in Ink.
 *
 * pi-mono handles this via its extension system's UI context:
 *   uiContext.confirm("Delete session?") → Promise<boolean>
 *
 * We'll build three confirmation patterns:
 *   1. Inline confirm (y/n in the same line)
 *   2. Modal dialog (overlay blocking the whole UI)
 *   3. Preview + confirm (show what will change before committing)
 */

import { useCallback, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── 1. INLINE CONFIRM ────────────────────────────────────────────────────────
// The simplest pattern: ask inline, wait for y/n.
// Used for low-stakes confirmations that don't need to show a preview.

type InlineConfirmState =
	| { phase: "idle" }
	| { phase: "confirming"; message: string; onConfirm: () => void; onCancel: () => void }
	| { phase: "result"; text: string; ok: boolean };

function useInlineConfirm() {
	const [state, setState] = useState<InlineConfirmState>({ phase: "idle" });

	// Returns a Promise<boolean>. Resolves when user presses y or n/Esc.
	const confirm = useCallback((message: string): Promise<boolean> => {
		return new Promise((resolve) => {
			setState({
				phase: "confirming",
				message,
				onConfirm: () => { setState({ phase: "result", text: "Confirmed!", ok: true }); resolve(true); },
				onCancel: () => { setState({ phase: "result", text: "Cancelled.", ok: false }); resolve(false); },
			});
		});
	}, []);

	const reset = useCallback(() => setState({ phase: "idle" }), []);

	return { state, confirm, reset };
}

function InlineConfirmDemo() {
	const { state, confirm, reset } = useInlineConfirm();
	const [log, setLog] = useState<string[]>([]);

	useInput((input, key) => {
		if (state.phase === "idle") {
			if (input === "d") {
				confirm("Delete session.json?").then((ok) => {
					setLog((prev) => [`delete: ${ok ? "done" : "skipped"}`, ...prev].slice(0, 5));
					setTimeout(reset, 800);
				});
			}
			if (input === "w") {
				confirm("Overwrite main.ts?").then((ok) => {
					setLog((prev) => [`write: ${ok ? "done" : "skipped"}`, ...prev].slice(0, 5));
					setTimeout(reset, 800);
				});
			}
		}
		if (state.phase === "confirming") {
			if (input === "y" || input === "Y") state.onConfirm();
			if (input === "n" || input === "N" || key.escape) state.onCancel();
		}
	});

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={40}>
			<Text bold>1. Inline Confirm</Text>
			<Box marginTop={1} flexDirection="column" minHeight={3}>
				{state.phase === "idle" && <Text dimColor>d: delete  w: write</Text>}
				{state.phase === "confirming" && (
					<Box gap={2}>
						<Text color="yellow">{state.message}</Text>
						<Text bold color="green">y</Text>
						<Text dimColor>/</Text>
						<Text bold color="red">n</Text>
					</Box>
				)}
				{state.phase === "result" && (
					<Text color={state.ok ? "green" : "gray"}>{state.text}</Text>
				)}
			</Box>
			{log.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					{log.map((l, i) => <Text key={`${l}-${i}`} dimColor>{l}</Text>)}
				</Box>
			)}
		</Box>
	);
}

// ─── 2. MODAL DIALOG ──────────────────────────────────────────────────────────
// A full modal that overlays the UI and blocks all other input.
// Used for high-stakes operations like clearing history or running a bash command.

type ModalState =
	| { open: false }
	| { open: true; title: string; body: string; onConfirm: () => void; onCancel: () => void };

function Modal({ state }: { state: ModalState }) {
	if (!state.open) return null;

	return (
		<Box
			position="absolute"
			// Ink doesn't have true absolute positioning, but we can simulate
			// a modal by rendering it last and it appears at the bottom:
			flexDirection="column"
			borderStyle="double"
			borderColor="yellow"
			padding={1}
			width={50}
		>
			<Text bold color="yellow">{state.title}</Text>
			<Box marginY={1}>
				<Text wrap="wrap">{state.body}</Text>
			</Box>
			<Box gap={4} marginTop={1}>
				<Box borderStyle="single" borderColor="green" paddingX={2}>
					<Text color="green" bold>Y  Confirm</Text>
				</Box>
				<Box borderStyle="single" borderColor="red" paddingX={2}>
					<Text color="red">N  Cancel</Text>
				</Box>
			</Box>
		</Box>
	);
}

function useModal() {
	const [state, setState] = useState<ModalState>({ open: false });

	const open = useCallback((title: string, body: string): Promise<boolean> => {
		return new Promise((resolve) => {
			setState({
				open: true,
				title,
				body,
				onConfirm: () => { setState({ open: false }); resolve(true); },
				onCancel: () => { setState({ open: false }); resolve(false); },
			});
		});
	}, []);

	return { state, open };
}

function ModalDemo() {
	const { state, open } = useModal();
	const [result, setResult] = useState<string>("");

	useInput((input, key) => {
		if (state.open) {
			if (input === "y" || input === "Y") state.onConfirm();
			if (input === "n" || input === "N" || key.escape) state.onCancel();
			return; // block all other input while modal is open
		}
		if (input === "b") {
			open(
				"Run bash command?",
				'About to run: rm -rf /tmp/test\n\nThis will permanently delete files.',
			).then((ok) => setResult(ok ? "Command executed" : "Cancelled by user"));
		}
		if (input === "c") {
			open(
				"Clear conversation history?",
				"This will permanently delete 12 messages from the current session.\nThis cannot be undone.",
			).then((ok) => setResult(ok ? "History cleared" : "Cancelled"));
		}
	});

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={50} marginTop={1}>
			<Text bold>2. Modal Dialog</Text>
			<Box marginTop={1} flexDirection="column" minHeight={3}>
				{!state.open && <Text dimColor>b: bash command  c: clear history</Text>}
				{result && <Text color="cyan">{result}</Text>}
			</Box>
			<Modal state={state} />
		</Box>
	);
}

// ─── 3. PREVIEW + CONFIRM ─────────────────────────────────────────────────────
// Show the user WHAT will change before asking to confirm.
// For file writes: show a diff. For bash: show the command and estimated impact.
// This is the most user-friendly pattern for destructive operations.

type DiffLine = { type: "context" | "added" | "removed"; text: string; lineNum: number };

function computeSimpleDiff(original: string, modified: string): DiffLine[] {
	const origLines = original.split("\n");
	const modLines = modified.split("\n");
	const result: DiffLine[] = [];

	// Very simple diff: find first difference, show context around it
	let firstDiff = -1;
	const maxLen = Math.max(origLines.length, modLines.length);
	for (let i = 0; i < maxLen; i++) {
		if (origLines[i] !== modLines[i]) { firstDiff = i; break; }
	}

	if (firstDiff === -1) return [{ type: "context", text: "(no changes)", lineNum: 0 }];

	const start = Math.max(0, firstDiff - 2);
	const end = Math.min(maxLen - 1, firstDiff + 5);

	for (let i = start; i <= end; i++) {
		const orig = origLines[i];
		const mod = modLines[i];
		if (orig === mod) {
			result.push({ type: "context", text: orig ?? "", lineNum: i + 1 });
		} else {
			if (orig !== undefined) result.push({ type: "removed", text: orig, lineNum: i + 1 });
			if (mod !== undefined) result.push({ type: "added", text: mod, lineNum: i + 1 });
		}
	}
	return result;
}

function DiffPreview({ original, modified, filename }: { original: string; modified: string; filename: string }) {
	const diff = computeSimpleDiff(original, modified);

	return (
		<Box flexDirection="column" borderStyle="single" padding={1} width={50}>
			<Text bold dimColor>Preview: {filename}</Text>
			<Box flexDirection="column" marginTop={1}>
				{diff.map((line, i) => (
					<Box key={i}>
						<Text
							color={line.type === "added" ? "green" : line.type === "removed" ? "red" : undefined}
							dimColor={line.type === "context"}
						>
							{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
							{String(line.lineNum).padStart(3)} | {line.text}
						</Text>
					</Box>
				))}
			</Box>
		</Box>
	);
}

function PreviewConfirmDemo() {
	type Phase = "idle" | "preview" | "done";
	const [phase, setPhase] = useState<Phase>("idle");
	const [result, setResult] = useState("");

	const original = `export const model = "claude-haiku-4-5";\nexport const maxTokens = 512;\nexport const temperature = 0.7;`;
	const modified = `export const model = "claude-sonnet-4-6";\nexport const maxTokens = 4096;\nexport const temperature = 0.7;`;

	useInput((input, key) => {
		if (phase === "idle" && input === "e") setPhase("preview");
		if (phase === "preview") {
			if (input === "y") { setPhase("done"); setResult("File written!"); }
			if (input === "n" || key.escape) { setPhase("idle"); setResult("Edit cancelled."); }
		}
		if (phase === "done" && input === "r") { setPhase("idle"); setResult(""); }
	});

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} width={54} marginTop={1}>
			<Text bold>3. Preview + Confirm (write_file)</Text>
			<Box marginTop={1} flexDirection="column">
				{phase === "idle" && <Text dimColor>e: edit config.ts</Text>}
				{phase === "preview" && (
					<Box flexDirection="column" gap={1}>
						<DiffPreview original={original} modified={modified} filename="config.ts" />
						<Box gap={2}>
							<Text>Apply changes?</Text>
							<Text bold color="green">y</Text>
							<Text dimColor>/</Text>
							<Text bold color="red">n</Text>
						</Box>
					</Box>
				)}
				{phase === "done" && (
					<Box gap={2}>
						<Text color="green">{result}</Text>
						<Text dimColor>(r: reset)</Text>
					</Box>
				)}
			</Box>
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();
	useInput((_, key) => { if (key.escape) exit(); });

	return (
		<Box flexDirection="column" padding={1}>
			<Box justifyContent="space-between" marginBottom={1}>
				<Text bold color="cyan">Confirmation Patterns</Text>
				<Text dimColor>Esc: exit</Text>
			</Box>
			<Box flexDirection="row" gap={2} alignItems="flex-start" flexWrap="wrap">
				<InlineConfirmDemo />
				<Box flexDirection="column">
					<ModalDemo />
					<PreviewConfirmDemo />
				</Box>
			</Box>
		</Box>
	);
}

render(<App />);

/**
 * TASK:
 *
 * 1. Build a `useConfirmQueue` hook: if multiple confirmations are requested
 *    at the same time (e.g., from parallel tool calls), queue them and show
 *    one at a time. When the user confirms/cancels, the next one appears.
 *
 * 2. Add a "3-second auto-cancel" to InlineConfirm: if the user doesn't
 *    respond in 3 seconds, automatically cancel. Show a countdown timer.
 *    This prevents the agent from stalling if the user walks away.
 *
 * 3. Build a `<SelectConfirm options={string[]} onSelect={fn}>` component
 *    that presents multiple choices (not just y/n). For example:
 *    "Overwrite?  [Y]es  [N]o  [A]ppend  [V]iew diff"
 *    This is the richer confirmation pattern pi-mono uses for some operations.
 *
 * 4. Implement a "trust list": after the user confirms the same tool+pattern
 *    twice, add it to a trust list and skip confirmation next time.
 *    Store the trust list in ~/.config/ts-agent/trusted.json.
 *    This is how pi-mono's permission system works for tool calls.
 */
