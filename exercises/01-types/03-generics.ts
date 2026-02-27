/**
 * Exercise 01-types/03-generics.ts
 *
 * CONCEPTS: generic functions, generic types, constraints, utility types
 *
 * Run with: npm run ex exercises/01-types/03-generics.ts
 *
 * pi-mono uses generics extensively — Model<TApi>, Agent<TTools>, etc.
 * Generics let you write reusable code that stays type-safe for any type.
 */

// --- 1. GENERIC FUNCTIONS ---
// The <T> declares a type parameter — a placeholder filled in at call time.

function first<T>(arr: T[]): T | undefined {
	return arr[0];
}

// TypeScript infers T from the argument — no need to specify explicitly.
const firstStr = first(["a", "b", "c"]); // T inferred as string
const firstNum = first([1, 2, 3]); // T inferred as number
// firstStr is `string | undefined`, firstNum is `number | undefined`

// You can also specify T explicitly:
const explicit = first<boolean>([true, false]);

// --- 2. GENERIC TYPES AND INTERFACES ---

// A Result type — either success with a value, or failure with an error.
// This pattern is used throughout pi-mono for tool execution results.
type Result<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

// A generic event with a typed payload:
type Event<TPayload> = {
	type: string;
	payload: TPayload;
	timestamp: number;
};

// --- 3. MULTIPLE TYPE PARAMETERS ---

function mapResult<TIn, TOut>(result: Result<TIn>, fn: (value: TIn) => TOut): Result<TOut> {
	if (result.ok) {
		return { ok: true, value: fn(result.value) };
	}
	return result; // pass the error through unchanged
}

// --- 4. CONSTRAINTS ---
// `extends` constrains which types are allowed for T.

// T must have at least an `id` field of type string.
function findById<T extends { id: string }>(items: T[], id: string): T | undefined {
	return items.find((item) => item.id === id);
}

// T must be an object (not primitive) — useful for Object.keys etc.
function keys<T extends object>(obj: T): (keyof T)[] {
	return Object.keys(obj) as (keyof T)[];
}

// --- 5. BUILT-IN UTILITY TYPES ---
// TypeScript ships many generic utility types. Know these well.

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	enabled: boolean;
}

// Partial<T>: all fields become optional (useful for updates/patches)
type ToolPatch = Partial<ToolDefinition>;

// Required<T>: all fields become required
type FullTool = Required<ToolDefinition>;

// Pick<T, K>: keep only the listed keys
type ToolSummary = Pick<ToolDefinition, "name" | "description">;

// Omit<T, K>: drop the listed keys
type ToolWithoutSchema = Omit<ToolDefinition, "inputSchema">;

// Readonly<T>: all fields become readonly
type FrozenTool = Readonly<ToolDefinition>;

// Record<K, V>: an object with keys of type K and values of type V
type ToolRegistry = Record<string, ToolDefinition>;

// ReturnType<F>: extract the return type of a function
function createTool(name: string): ToolDefinition {
	return { name, description: "", inputSchema: {}, enabled: true };
}
type CreateToolReturn = ReturnType<typeof createTool>; // = ToolDefinition

// Parameters<F>: extract the parameter tuple of a function
type CreateToolParams = Parameters<typeof createTool>; // = [string]

// --- 6. GENERIC CLASSES ---

class EventBus<TEvent extends { type: string }> {
	private listeners = new Map<string, ((event: TEvent) => void)[]>();

	on(type: TEvent["type"], handler: (event: TEvent) => void): void {
		const existing = this.listeners.get(type) ?? [];
		this.listeners.set(type, [...existing, handler]);
	}

	emit(event: TEvent): void {
		const handlers = this.listeners.get(event.type) ?? [];
		for (const handler of handlers) {
			handler(event);
		}
	}
}

// --- MAIN ---

type AgentEvent =
	| { type: "start"; sessionId: string }
	| { type: "message"; text: string }
	| { type: "end"; reason: string };

function main() {
	// Result<T> usage:
	const success: Result<number> = { ok: true, value: 42 };
	const failure: Result<number> = { ok: false, error: "connection refused" };

	const doubled = mapResult(success, (n) => n * 2);
	const passthrough = mapResult(failure, (n) => n * 2);
	console.log(doubled); // { ok: true, value: 84 }
	console.log(passthrough); // { ok: false, error: "connection refused" }

	// findById with constraint:
	const tools: ToolDefinition[] = [
		{ id: "read", name: "read_file", description: "Reads a file", inputSchema: {}, enabled: true } as any,
		{ id: "bash", name: "bash", description: "Runs a command", inputSchema: {}, enabled: true } as any,
	];
	// Note: ToolDefinition doesn't have `id`, but we cast to `any` above for demo.
	// In practice you'd add id to the interface.

	// EventBus with generic constraint:
	const bus = new EventBus<AgentEvent>();

	bus.on("message", (e) => {
		// TypeScript narrows e to { type: "message"; text: string } here
		console.log(`\nMessage received: ${e.text}`);
	});

	bus.on("end", (e) => {
		console.log(`Session ended: ${e.reason}`);
	});

	bus.emit({ type: "start", sessionId: "sess-001" });
	bus.emit({ type: "message", text: "Hello from agent!" });
	bus.emit({ type: "end", reason: "stop" });

	// Utility types:
	const patch: ToolPatch = { enabled: false }; // only enabled field, rest optional
	const summary: ToolSummary = { name: "read_file", description: "Reads a file" };
	console.log(`\nPatch: ${JSON.stringify(patch)}`);
	console.log(`Summary: ${JSON.stringify(summary)}`);
}

main();

/**
 * TASK:
 *
 * 1. Write a generic function `last<T>(arr: T[]): T | undefined` that returns
 *    the last element of an array.
 *
 * 2. Write a generic function `groupBy<T>(items: T[], key: keyof T): Map<T[keyof T], T[]>`
 *    that groups an array by a field value. Example:
 *    groupBy([{role:"user",...}, {role:"assistant",...}], "role")
 *    → Map { "user" => [...], "assistant" => [...] }
 *
 * 3. Write a type `DeepReadonly<T>` that recursively makes all nested objects readonly.
 *    Hint: use a conditional type — `T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T`
 *
 * 4. Add a `StreamResult<T>` type that wraps Result<T> with an additional
 *    `metadata: { durationMs: number; tokenCount: number }` field.
 *    Use intersection types.
 */
