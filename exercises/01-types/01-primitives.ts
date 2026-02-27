/**
 * Exercise 01-types/01-primitives.ts
 *
 * CONCEPTS: primitive types, type aliases, interfaces, readonly, optional fields
 *
 * Run with: npm run ex exercises/01-types/01-primitives.ts
 *
 * pi-mono uses these everywhere — every message, tool definition, and config
 * object is a carefully typed interface.
 */

// --- 1. PRIMITIVE TYPES ---
// TypeScript adds static types on top of JavaScript primitives.

const name: string = "pi-agent";
const version: number = 1;
const isStreaming: boolean = false;

// `null` and `undefined` are distinct types in strict mode.
// You must explicitly opt in to allow them.
const maybeText: string | null = null;
const maybeCount: number | undefined = undefined;

// `unknown` is the safe alternative to `any`.
// You must narrow it before use (unlike `any` which skips checking).
function parseJson(raw: string): unknown {
	return JSON.parse(raw);
}

// `never` means a function never returns (throws or infinite loops).
function panic(message: string): never {
	throw new Error(message);
}

// --- 2. TYPE ALIASES ---
// `type` gives a name to any type expression.

type ModelId = string; // narrow alias — communicates intent
type TokenCount = number;
type ApiKey = string;

// Aliases can describe object shapes too.
type Dimensions = {
	width: number;
	height: number;
};

// --- 3. INTERFACES ---
// Interfaces define object contracts. Prefer them for object shapes.
// Key difference from `type`: interfaces can be extended/merged.

interface Model {
	readonly id: ModelId; // readonly — cannot be reassigned after creation
	name: string;
	contextWindow: TokenCount;
	description?: string; // optional — may be undefined
}

interface ModelWithCost extends Model {
	inputCostPerMillion: number;
	outputCostPerMillion: number;
}

// --- 4. WORKING WITH THESE TYPES ---

function describeModel(model: Model): string {
	// model.id = "other"; // ERROR: Cannot assign to 'id' because it is read-only
	const desc = model.description ?? "no description"; // ?? = nullish coalescing
	return `${model.name} (${model.id}) — ${model.contextWindow} tokens — ${desc}`;
}

function estimateCost(model: ModelWithCost, inputTokens: number, outputTokens: number): number {
	const inputCost = (inputTokens / 1_000_000) * model.inputCostPerMillion;
	const outputCost = (outputTokens / 1_000_000) * model.outputCostPerMillion;
	return inputCost + outputCost;
}

// --- 5. ARRAYS AND TUPLES ---

const modelIds: ModelId[] = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"];

// Tuple: fixed-length array with known types at each position.
type ProviderAndModel = [string, string]; // [provider, modelId]
const entry: ProviderAndModel = ["anthropic", "claude-opus-4-6"];
const [provider, modelId] = entry; // destructuring works the same

// --- MAIN ---

function main() {
	const haiku: ModelWithCost = {
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		contextWindow: 200_000,
		description: "Fast and affordable",
		inputCostPerMillion: 0.8,
		outputCostPerMillion: 4.0,
	};

	console.log(describeModel(haiku));
	console.log(`Cost for 10k in / 2k out: $${estimateCost(haiku, 10_000, 2_000).toFixed(4)}`);
	console.log(`Models: ${modelIds.join(", ")}`);
	console.log(`Provider: ${provider}, Model: ${modelId}`);

	// unknown must be narrowed before use
	const parsed = parseJson('{"role": "user"}');
	if (typeof parsed === "object" && parsed !== null && "role" in parsed) {
		console.log(`Parsed role: ${(parsed as { role: string }).role}`);
	}
}

main();

/**
 * TASK:
 *
 * 1. Add a `Provider` interface with fields: id, name, apiKeyEnvVar (string), baseUrl (optional string).
 *
 * 2. Add a `ProviderModel` type that combines `Provider` and `ModelWithCost`
 *    using an intersection type (&).
 *
 * 3. Write a function `formatProviderModel(pm: ProviderModel): string`
 *    that returns a string like: "anthropic / claude-haiku-4-5 ($0.80/M in)"
 *
 * 4. Create a ProviderModel object and log it.
 */
