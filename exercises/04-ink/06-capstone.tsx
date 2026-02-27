/**
 * Exercise 04-ink/06-capstone.tsx
 *
 * STAGE 2 CAPSTONE: A multi-screen TUI app
 *
 * Run with: npm run ex exercises/04-ink/06-capstone.tsx
 *
 * This combines everything from Stage 2:
 *   - Discriminated union screen state (01-types/04 pattern)
 *   - useReducer for all state (05-reducer pattern)
 *   - useInput with mode-aware key handling (03-input pattern)
 *   - Two-pane layout with dynamic sizing (04-layout pattern)
 *   - useEffect for async data + timers (02-state pattern)
 *
 * App: a "Model Browser" — browse LLM models, view details, compare.
 * This mirrors the ModelSelectorComponent in pi-mono's coding-agent.
 */

import { useEffect, useReducer, useRef } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── DATA ─────────────────────────────────────────────────────────────────────

type Model = {
	id: string;
	provider: string;
	name: string;
	contextWindow: number;
	inputCost: number;  // $ per million tokens
	outputCost: number;
	tags: string[];
	description: string;
};

const MODELS: Model[] = [
	{
		id: "claude-opus-4-6",
		provider: "Anthropic",
		name: "Claude Opus 4.6",
		contextWindow: 200_000,
		inputCost: 15,
		outputCost: 75,
		tags: ["powerful", "reasoning"],
		description: "Most capable model. Best for complex reasoning and coding.",
	},
	{
		id: "claude-sonnet-4-6",
		provider: "Anthropic",
		name: "Claude Sonnet 4.6",
		contextWindow: 200_000,
		inputCost: 3,
		outputCost: 15,
		tags: ["balanced", "fast"],
		description: "Best balance of speed and intelligence for most tasks.",
	},
	{
		id: "claude-haiku-4-5",
		provider: "Anthropic",
		name: "Claude Haiku 4.5",
		contextWindow: 200_000,
		inputCost: 0.8,
		outputCost: 4,
		tags: ["fast", "cheap"],
		description: "Fastest and most affordable. Great for high-volume tasks.",
	},
	{
		id: "gpt-4o",
		provider: "OpenAI",
		name: "GPT-4o",
		contextWindow: 128_000,
		inputCost: 2.5,
		outputCost: 10,
		tags: ["multimodal", "fast"],
		description: "Multimodal model with vision and audio capabilities.",
	},
	{
		id: "gpt-4o-mini",
		provider: "OpenAI",
		name: "GPT-4o Mini",
		contextWindow: 128_000,
		inputCost: 0.15,
		outputCost: 0.6,
		tags: ["fast", "cheap"],
		description: "Small, fast, and affordable. Good for simple tasks.",
	},
	{
		id: "gemini-2-flash",
		provider: "Google",
		name: "Gemini 2.0 Flash",
		contextWindow: 1_000_000,
		inputCost: 0.1,
		outputCost: 0.4,
		tags: ["fast", "long-context"],
		description: "Very fast with 1M token context window.",
	},
];

// ─── STATE ────────────────────────────────────────────────────────────────────

type Screen =
	| { id: "list" }
	| { id: "detail"; modelId: string }
	| { id: "compare"; modelIds: [string, string] }
	| { id: "search"; query: string };

type AppState = {
	screen: Screen;
	cursor: number;
	pinned: Set<string>;
	filter: string; // active provider filter ("" = all)
	searchQuery: string;
	notification: string;
};

type AppAction =
	| { type: "move"; delta: number }
	| { type: "open_detail" }
	| { type: "back" }
	| { type: "toggle_pin" }
	| { type: "set_filter"; provider: string }
	| { type: "start_search" }
	| { type: "search_input"; char: string }
	| { type: "search_backspace" }
	| { type: "confirm_search" }
	| { type: "open_compare" }
	| { type: "notify"; message: string }
	| { type: "clear_notify" };

function getFilteredModels(models: Model[], filter: string, searchQuery: string): Model[] {
	return models.filter((m) => {
		if (filter && m.provider !== filter) return false;
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			return (
				m.name.toLowerCase().includes(q) ||
				m.id.toLowerCase().includes(q) ||
				m.tags.some((t) => t.includes(q))
			);
		}
		return true;
	});
}

function appReducer(state: AppState, action: AppAction): AppState {
	const filtered = getFilteredModels(MODELS, state.filter, state.searchQuery);
	const currentModel = filtered[state.cursor];

	switch (action.type) {
		case "move":
			return { ...state, cursor: Math.max(0, Math.min(filtered.length - 1, state.cursor + action.delta)) };

		case "open_detail":
			if (!currentModel) return state;
			return { ...state, screen: { id: "detail", modelId: currentModel.id } };

		case "back":
			return { ...state, screen: { id: "list" } };

		case "toggle_pin": {
			if (!currentModel) return state;
			const next = new Set(state.pinned);
			const msg = next.has(currentModel.id)
				? (next.delete(currentModel.id), `Unpinned ${currentModel.name}`)
				: (next.add(currentModel.id), `Pinned ${currentModel.name}`);
			return { ...state, pinned: next, notification: msg };
		}

		case "set_filter":
			return { ...state, filter: state.filter === action.provider ? "" : action.provider, cursor: 0 };

		case "start_search":
			return { ...state, screen: { id: "search", query: "" }, searchQuery: "" };

		case "search_input":
			if (state.screen.id !== "search") return state;
			return { ...state, screen: { id: "search", query: state.screen.query + action.char }, searchQuery: state.screen.query + action.char };

		case "search_backspace":
			if (state.screen.id !== "search") return state;
			return { ...state, screen: { id: "search", query: state.screen.query.slice(0, -1) }, searchQuery: state.screen.query.slice(0, -1) };

		case "confirm_search":
			return { ...state, screen: { id: "list" } };

		case "open_compare": {
			if (!currentModel) return state;
			const pinned = [...state.pinned];
			if (pinned.length > 0 && pinned[0] !== currentModel.id) {
				return { ...state, screen: { id: "compare", modelIds: [pinned[0], currentModel.id] } };
			}
			return { ...state, notification: "Pin another model first (p), then press c to compare" };
		}

		case "notify":
			return { ...state, notification: action.message };

		case "clear_notify":
			return { ...state, notification: "" };

		default:
			return state;
	}
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function ProviderBadge({ provider }: { provider: string }) {
	const colors: Record<string, string> = {
		Anthropic: "magenta",
		OpenAI: "green",
		Google: "blue",
	};
	return <Text color={colors[provider] ?? "white"}>[{provider}]</Text>;
}

function CostBadge({ cost, label }: { cost: number; label: string }) {
	const color = cost < 1 ? "green" : cost < 10 ? "yellow" : "red";
	return (
		<Text>
			<Text dimColor>{label}: </Text>
			<Text color={color}>${cost}/M</Text>
		</Text>
	);
}

// ─── SCREENS ──────────────────────────────────────────────────────────────────

function ModelList({ state, cols }: { state: AppState; cols: number }) {
	const filtered = getFilteredModels(MODELS, state.filter, state.searchQuery);
	const providers = [...new Set(MODELS.map((m) => m.provider))];

	return (
		<Box flexDirection="column" width={cols}>
			{/* Filter bar */}
			<Box gap={2} marginBottom={1}>
				<Text dimColor>Filter:</Text>
				<Text dimColor={!state.filter} color={!state.filter ? "cyan" : undefined} bold={!state.filter}>All</Text>
				{providers.map((p) => (
					<Text key={p} dimColor={state.filter !== p} color={state.filter === p ? "cyan" : undefined} bold={state.filter === p}>
						{p}
					</Text>
				))}
			</Box>

			{/* Model rows */}
			<Box flexDirection="column">
				{filtered.length === 0 && <Text dimColor>No models match filter.</Text>}
				{filtered.map((model, i) => {
					const isCursor = i === state.cursor;
					const isPinned = state.pinned.has(model.id);

					return (
						<Box
							key={model.id}
							paddingX={1}
							backgroundColor={isCursor ? "blue" : undefined}
						>
							<Text color={isPinned ? "yellow" : "white"}>{isPinned ? "* " : "  "}</Text>
							<ProviderBadge provider={model.provider} />
							<Text> </Text>
							<Text bold={isCursor} color={isCursor ? "white" : undefined}>
								{model.name.padEnd(22)}
							</Text>
							<Text dimColor>{(model.contextWindow / 1000).toFixed(0)}k ctx  </Text>
							<Text color="green">${model.inputCost}/M in  </Text>
							<Text color="red">${model.outputCost}/M out</Text>
						</Box>
					);
				})}
			</Box>

			{/* Hint bar */}
			<Box marginTop={1} gap={2}>
				<Text dimColor>Enter: detail</Text>
				<Text dimColor>p: pin</Text>
				<Text dimColor>c: compare</Text>
				<Text dimColor>/: search</Text>
				<Text dimColor>1-3: filter</Text>
			</Box>
		</Box>
	);
}

function ModelDetail({ modelId, pinned }: { modelId: string; pinned: Set<string> }) {
	const model = MODELS.find((m) => m.id === modelId);
	if (!model) return <Text color="red">Model not found: {modelId}</Text>;

	const isPinned = pinned.has(modelId);

	return (
		<Box flexDirection="column">
			<Box marginBottom={1}>
				<ProviderBadge provider={model.provider} />
				<Text bold> {model.name} </Text>
				{isPinned && <Text color="yellow">*pinned*</Text>}
			</Box>

			<Box flexDirection="column" gap={1}>
				<Box gap={2}>
					<Text dimColor>ID:</Text>
					<Text color="cyan">{model.id}</Text>
				</Box>
				<Box gap={2}>
					<Text dimColor>Context window:</Text>
					<Text>{(model.contextWindow / 1000).toFixed(0)}k tokens</Text>
				</Box>
				<Box gap={2}>
					<CostBadge cost={model.inputCost} label="Input" />
					<CostBadge cost={model.outputCost} label="Output" />
				</Box>
				<Box gap={1}>
					<Text dimColor>Tags:</Text>
					{model.tags.map((tag) => (
						<Text key={tag} color="magenta">[{tag}]</Text>
					))}
				</Box>
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>Description:</Text>
					<Text>{model.description}</Text>
				</Box>
			</Box>

			<Box marginTop={2}>
				<Text dimColor>Esc: back  p: pin/unpin</Text>
			</Box>
		</Box>
	);
}

function ModelCompare({ modelIds }: { modelIds: [string, string] }) {
	const [a, b] = modelIds.map((id) => MODELS.find((m) => m.id === id));
	if (!a || !b) return <Text color="red">Model not found</Text>;

	function Row({ label, va, vb, betterFn }: {
		label: string;
		va: string;
		vb: string;
		betterFn?: (a: string, b: string) => "a" | "b" | "equal";
	}) {
		const better = betterFn?.(va, vb);
		return (
			<Box gap={2}>
				<Text dimColor>{label.padEnd(18)}</Text>
				<Text color={better === "a" ? "green" : undefined} bold={better === "a"}>{va.padEnd(16)}</Text>
				<Text color={better === "b" ? "green" : undefined} bold={better === "b"}>{vb}</Text>
			</Box>
		);
	}

	const cheaper = (av: string, bv: string) => {
		const an = Number.parseFloat(av);
		const bn = Number.parseFloat(bv);
		return an < bn ? "a" : bn < an ? "b" : "equal";
	};
	const larger = (av: string, bv: string) => {
		const an = Number.parseFloat(av);
		const bn = Number.parseFloat(bv);
		return an > bn ? "a" : bn > an ? "b" : "equal";
	};

	return (
		<Box flexDirection="column">
			<Box gap={2} marginBottom={1}>
				<Text dimColor>{"".padEnd(18)}</Text>
				<Text bold color="cyan">{a.name.padEnd(16)}</Text>
				<Text bold color="magenta">{b.name}</Text>
			</Box>
			<Box flexDirection="column" gap={1}>
				<Row label="Provider" va={a.provider} vb={b.provider} />
				<Row label="Context window" va={`${(a.contextWindow / 1000).toFixed(0)}k`} vb={`${(b.contextWindow / 1000).toFixed(0)}k`} betterFn={larger} />
				<Row label="Input cost" va={`$${a.inputCost}/M`} vb={`$${b.inputCost}/M`} betterFn={cheaper} />
				<Row label="Output cost" va={`$${a.outputCost}/M`} vb={`$${b.outputCost}/M`} betterFn={cheaper} />
				<Row label="Tags" va={a.tags.join(", ")} vb={b.tags.join(", ")} />
			</Box>
			<Box marginTop={2}><Text dimColor>Esc: back</Text></Box>
		</Box>
	);
}

function SearchScreen({ query }: { query: string }) {
	const results = getFilteredModels(MODELS, "", query);
	return (
		<Box flexDirection="column">
			<Box borderStyle="single" paddingX={1} marginBottom={1}>
				<Text>Search: </Text>
				<Text color="yellow">{query}</Text>
				<Text>_</Text>
			</Box>
			<Text dimColor>{results.length} result(s) — Enter to confirm, Esc to cancel</Text>
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();
	const notifyTimer = useRef<NodeJS.Timeout | null>(null);
	const [state, dispatch] = useReducer(appReducer, {
		screen: { id: "list" },
		cursor: 0,
		pinned: new Set(),
		filter: "",
		searchQuery: "",
		notification: "",
	});

	// Auto-clear notifications:
	useEffect(() => {
		if (state.notification) {
			if (notifyTimer.current) clearTimeout(notifyTimer.current);
			notifyTimer.current = setTimeout(() => dispatch({ type: "clear_notify" }), 2000);
		}
		return () => { if (notifyTimer.current) clearTimeout(notifyTimer.current); };
	}, [state.notification]);

	useInput((input, key) => {
		const screen = state.screen;

		if (screen.id === "search") {
			if (key.escape) { dispatch({ type: "back" }); return; }
			if (key.return) { dispatch({ type: "confirm_search" }); return; }
			if (key.backspace || key.delete) { dispatch({ type: "search_backspace" }); return; }
			if (input && !key.ctrl) { dispatch({ type: "search_input", char: input }); }
			return;
		}

		if (key.escape || input === "q") {
			if (screen.id !== "list") dispatch({ type: "back" });
			else exit();
			return;
		}

		if (screen.id === "list") {
			if (key.downArrow || input === "j") dispatch({ type: "move", delta: 1 });
			if (key.upArrow || input === "k") dispatch({ type: "move", delta: -1 });
			if (key.return) dispatch({ type: "open_detail" });
			if (input === "p") dispatch({ type: "toggle_pin" });
			if (input === "c") dispatch({ type: "open_compare" });
			if (input === "/") dispatch({ type: "start_search" });
			if (input === "1") dispatch({ type: "set_filter", provider: "Anthropic" });
			if (input === "2") dispatch({ type: "set_filter", provider: "OpenAI" });
			if (input === "3") dispatch({ type: "set_filter", provider: "Google" });
		}

		if (screen.id === "detail") {
			if (input === "p") dispatch({ type: "toggle_pin" });
		}
	});

	const cols = process.stdout.columns ?? 80;
	const screen = state.screen;

	return (
		<Box flexDirection="column" padding={1}>
			{/* Header */}
			<Box justifyContent="space-between" marginBottom={1} width={cols - 2}>
				<Text bold color="cyan">Model Browser</Text>
				<Text dimColor>{state.pinned.size} pinned  q: quit</Text>
			</Box>

			{/* Main content */}
			<Box borderStyle="round" padding={1} width={cols - 2} flexDirection="column">
				{screen.id === "list" && <ModelList state={state} cols={cols - 6} />}
				{screen.id === "detail" && <ModelDetail modelId={screen.modelId} pinned={state.pinned} />}
				{screen.id === "compare" && <ModelCompare modelIds={screen.modelIds} />}
				{screen.id === "search" && <SearchScreen query={screen.query} />}
			</Box>

			{/* Notification bar */}
			{state.notification && (
				<Box marginTop={1}>
					<Text color="yellow">{state.notification}</Text>
				</Box>
			)}
		</Box>
	);
}

render(<App />);

/**
 * TASK — extend this into Stage 3 territory:
 *
 * 1. Add a "cost calculator" screen: enter input/output token counts and see
 *    estimated cost for each model side-by-side (sorted cheapest first).
 *    Keys: number input for tokens, Tab to switch between input/output fields.
 *
 * 2. Add a loading state: when entering the detail screen, simulate an
 *    async API call (setTimeout 500ms) that fetches "live" pricing.
 *    Show a spinner while loading. (Hint: useEffect + useState in ModelDetail)
 *
 * 3. Connect the capstone from Stage 1 (exercises/03-llm-cli/main.ts):
 *    Add a "Chat" screen that takes the selected model ID and streams a
 *    response from the Anthropic API — displayed token by token in this TUI.
 *    This is Stage 3: LLM integration.
 */
