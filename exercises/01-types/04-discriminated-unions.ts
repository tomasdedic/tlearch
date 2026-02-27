/**
 * Exercise 01-types/04-discriminated-unions.ts
 *
 * CONCEPTS: discriminated unions, exhaustiveness checking, state machines
 *
 * Run with: npm run ex exercises/01-types/04-discriminated-unions.ts
 *
 * This is THE most important pattern in pi-mono.
 * Every message type, every streaming event, every agent state is modeled
 * as a discriminated union. It forces you to handle every case explicitly,
 * and TypeScript will error if you add a new variant and forget to update handlers.
 *
 * From packages/ai/src/types.ts:
 *   type Message = UserMessage | AssistantMessage | ToolResultMessage
 *
 * From the streaming pipeline:
 *   type AssistantMessageEvent =
 *     | { type: "start" }
 *     | { type: "text_delta"; text: string }
 *     | { type: "toolcall_start"; ... }
 *     | { type: "done"; ... }
 */

// --- 1. THE MESSAGE TYPE (mirroring pi-mono's core type) ---

type UserMessage = {
	role: "user";
	content: string;
};

type AssistantMessage = {
	role: "assistant";
	content: string;
	thinking?: string; // optional reasoning trace
	toolCalls?: ToolCall[];
};

type ToolResultMessage = {
	role: "tool";
	toolCallId: string;
	content: string;
	isError: boolean;
};

type ToolCall = {
	id: string;
	name: string;
	input: Record<string, unknown>;
};

// The union — `role` is the discriminant field:
type Message = UserMessage | AssistantMessage | ToolResultMessage;

// --- 2. EXHAUSTIVE SWITCH ---
// If you add a new Message variant and forget to handle it in renderMessage,
// TypeScript will produce a compile error. This is the superpower.

function renderMessage(message: Message): string {
	switch (message.role) {
		case "user":
			return `[User] ${message.content}`;
		case "assistant": {
			const toolInfo =
				message.toolCalls && message.toolCalls.length > 0
					? ` + ${message.toolCalls.length} tool call(s)`
					: "";
			return `[Assistant] ${message.content}${toolInfo}`;
		}
		case "tool":
			return `[Tool:${message.toolCallId}] ${message.isError ? "ERROR: " : ""}${message.content}`;
	}
	// Unreachable — TypeScript knows all cases are covered.
	// Trick: assign to `never` to get a compile error if a case is missing:
	// const _exhaustive: never = message;
}

// --- 3. STREAMING EVENTS (mirroring pi-mono's event pipeline) ---

type StreamEvent =
	| { type: "start" }
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; thinking: string }
	| { type: "toolcall_start"; id: string; name: string }
	| { type: "toolcall_input_delta"; id: string; partialInput: string }
	| { type: "toolcall_end"; id: string }
	| { type: "done"; stopReason: "stop" | "max_tokens" | "tool_use" }
	| { type: "error"; message: string };

// --- 4. ACCUMULATING A FULL MESSAGE FROM EVENTS ---
// This is exactly how pi-mono reconstructs the assistant message from a stream.

type InProgressMessage = {
	text: string;
	thinking: string;
	toolCalls: Map<string, { name: string; inputParts: string[] }>;
};

function createAccumulator(): InProgressMessage {
	return { text: "", thinking: "", toolCalls: new Map() };
}

function applyEvent(acc: InProgressMessage, event: StreamEvent): InProgressMessage {
	switch (event.type) {
		case "start":
			return createAccumulator(); // reset on each stream start

		case "text_delta":
			return { ...acc, text: acc.text + event.text };

		case "thinking_delta":
			return { ...acc, thinking: acc.thinking + event.thinking };

		case "toolcall_start": {
			const newMap = new Map(acc.toolCalls);
			newMap.set(event.id, { name: event.name, inputParts: [] });
			return { ...acc, toolCalls: newMap };
		}

		case "toolcall_input_delta": {
			const newMap = new Map(acc.toolCalls);
			const existing = newMap.get(event.id);
			if (existing) {
				newMap.set(event.id, { ...existing, inputParts: [...existing.inputParts, event.partialInput] });
			}
			return { ...acc, toolCalls: newMap };
		}

		case "toolcall_end":
		case "done":
		case "error":
			return acc; // no change to accumulator
	}
}

// --- 5. AGENT STATE MACHINE ---
// TUIs are state machines. Model states as discriminated unions.

type AgentState =
	| { status: "idle" }
	| { status: "streaming"; text: string; startedAt: number }
	| { status: "executing_tool"; toolName: string; callId: string }
	| { status: "error"; message: string; retryable: boolean };

type AgentAction =
	| { kind: "start_stream" }
	| { kind: "append_text"; text: string }
	| { kind: "start_tool"; toolName: string; callId: string }
	| { kind: "finish_tool" }
	| { kind: "stream_done" }
	| { kind: "set_error"; message: string; retryable: boolean }
	| { kind: "reset" };

// Pure reducer — given a state and action, returns next state.
function reduce(state: AgentState, action: AgentAction): AgentState {
	switch (action.kind) {
		case "start_stream":
			return { status: "streaming", text: "", startedAt: Date.now() };

		case "append_text":
			if (state.status !== "streaming") return state;
			return { ...state, text: state.text + action.text };

		case "start_tool":
			return { status: "executing_tool", toolName: action.toolName, callId: action.callId };

		case "finish_tool":
		case "stream_done":
			return { status: "idle" };

		case "set_error":
			return { status: "error", message: action.message, retryable: action.retryable };

		case "reset":
			return { status: "idle" };
	}
}

// --- MAIN ---

function main() {
	// 1. Message rendering:
	const messages: Message[] = [
		{ role: "user", content: "Read the file package.json" },
		{
			role: "assistant",
			content: "I'll read that file for you.",
			toolCalls: [{ id: "call_1", name: "read_file", input: { path: "package.json" } }],
		},
		{ role: "tool", toolCallId: "call_1", content: '{"name": "ts-learning"}', isError: false },
		{ role: "assistant", content: "The package name is ts-learning." },
	];

	console.log("=== Messages ===");
	for (const msg of messages) {
		console.log(renderMessage(msg));
	}

	// 2. Stream accumulation:
	const events: StreamEvent[] = [
		{ type: "start" },
		{ type: "text_delta", text: "I'll " },
		{ type: "text_delta", text: "help you." },
		{ type: "toolcall_start", id: "c1", name: "read_file" },
		{ type: "toolcall_input_delta", id: "c1", partialInput: '{"path":' },
		{ type: "toolcall_input_delta", id: "c1", partialInput: '"package.json"}' },
		{ type: "toolcall_end", id: "c1" },
		{ type: "done", stopReason: "tool_use" },
	];

	console.log("\n=== Stream Accumulation ===");
	let acc = createAccumulator();
	for (const event of events) {
		acc = applyEvent(acc, event);
		if (event.type === "text_delta") {
			process.stdout.write(event.text);
		}
	}
	console.log(`\nFinal text: "${acc.text}"`);
	console.log(`Tool calls: ${acc.toolCalls.size}`);
	for (const [id, call] of acc.toolCalls) {
		console.log(`  [${id}] ${call.name}(${call.inputParts.join("")})`);
	}

	// 3. State machine:
	console.log("\n=== Agent State Machine ===");
	let state: AgentState = { status: "idle" };
	const actions: AgentAction[] = [
		{ kind: "start_stream" },
		{ kind: "append_text", text: "Hello " },
		{ kind: "append_text", text: "world" },
		{ kind: "start_tool", toolName: "bash", callId: "c2" },
		{ kind: "finish_tool" },
		{ kind: "stream_done" },
	];

	for (const action of actions) {
		state = reduce(state, action);
		console.log(`After ${action.kind}: ${JSON.stringify(state)}`);
	}
}

main();

/**
 * TASK:
 *
 * 1. Add a new message type: SystemMessage { role: "system"; content: string }
 *    Add it to the Message union and update renderMessage to handle it.
 *    Notice: TypeScript will NOT error until you add it to the union —
 *    then it forces you to handle it in the switch. That's the superpower.
 *
 * 2. Add a new StreamEvent: { type: "usage"; inputTokens: number; outputTokens: number }
 *    Update applyEvent to track token counts in the accumulator.
 *    You'll need to add inputTokens and outputTokens fields to InProgressMessage.
 *
 * 3. Add a new AgentState: { status: "compacting"; progress: number }
 *    and a corresponding AgentAction: { kind: "start_compact" }
 *    Update the reducer to handle it.
 *    Notice how the reducer stays clean — one place to update.
 */
