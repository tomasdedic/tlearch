/**
 * Exercise 02-async/03-async-iterables.ts
 *
 * CONCEPTS: async generators, async iterables, for-await-of, Symbol.asyncIterator
 *
 * Run with: npm run ex exercises/02-async/03-async-iterables.ts
 *
 * This is THE key pattern for LLM streaming.
 * Every LLM API (Anthropic, OpenAI, etc.) returns an async iterable of events.
 * pi-mono models its entire streaming pipeline as AsyncIterable<StreamEvent>.
 *
 * From packages/ai/src/stream.ts:
 *   export async function* stream(...): AssistantMessageEventStream { ... }
 *   // where AssistantMessageEventStream = AsyncIterable<AssistantMessageEvent>
 */

// --- 1. ASYNC GENERATORS ---
// A function with `async function*` is an async generator.
// It produces values over time using `yield`.
// Each `yield` produces the next value in the sequence.
// The caller receives an AsyncGenerator<T> which is also AsyncIterable<T>.

async function* count(from: number, to: number, delayMs: number): AsyncGenerator<number> {
	for (let i = from; i <= to; i++) {
		await new Promise((r) => setTimeout(r, delayMs)); // simulate delay
		yield i; // pause here, send `i` to the consumer
	}
}

// Consuming with for-await-of:
async function demonstrateGenerator() {
	console.log("Counting with 20ms delay:");
	for await (const n of count(1, 5, 20)) {
		process.stdout.write(`${n} `);
	}
	console.log(); // newline
}

// --- 2. SIMULATING AN LLM STREAM ---
// This is the pattern you'll see when calling the Anthropic SDK.
// The real SDK's stream() returns an async iterable of events.

type StreamEvent =
	| { type: "start" }
	| { type: "text_delta"; text: string }
	| { type: "done"; stopReason: "stop" | "max_tokens" }
	| { type: "error"; message: string };

// Simulates what a real LLM API stream looks like:
async function* simulateLLMStream(prompt: string): AsyncGenerator<StreamEvent> {
	yield { type: "start" };
	await new Promise((r) => setTimeout(r, 30));

	const words = `Response to "${prompt}": TypeScript makes async code safe.`.split(" ");

	for (const word of words) {
		await new Promise((r) => setTimeout(r, 15)); // simulate token delay
		yield { type: "text_delta", text: word + " " };
	}

	yield { type: "done", stopReason: "stop" };
}

// Consuming and rendering the stream:
async function streamToTerminal(prompt: string): Promise<string> {
	let fullText = "";

	for await (const event of simulateLLMStream(prompt)) {
		switch (event.type) {
			case "start":
				process.stdout.write("[streaming] ");
				break;
			case "text_delta":
				process.stdout.write(event.text);
				fullText += event.text;
				break;
			case "done":
				console.log(`\n[done: ${event.stopReason}]`);
				break;
			case "error":
				console.error(`\n[error: ${event.message}]`);
				break;
		}
	}

	return fullText.trim();
}

// --- 3. TRANSFORMING ASYNC ITERABLES ---
// You can pipe one async iterable through a transform function.
// This is how pi-mono's stream pipeline works — events flow through stages.

async function* filterEvents<T extends { type: string }>(
	source: AsyncIterable<T>,
	types: T["type"][],
): AsyncGenerator<T> {
	for await (const event of source) {
		if (types.includes(event.type)) {
			yield event;
		}
	}
}

async function* mapStream<TIn, TOut>(
	source: AsyncIterable<TIn>,
	fn: (item: TIn) => TOut,
): AsyncGenerator<TOut> {
	for await (const item of source) {
		yield fn(item);
	}
}

// Collect all values from an async iterable into an array:
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const item of source) {
		results.push(item);
	}
	return results;
}

// --- 4. MAKING ANY OBJECT ASYNC ITERABLE ---
// Implement Symbol.asyncIterator to make a class iterable with for-await-of.

class MessageQueue {
	private queue: string[] = [];
	private closed = false;
	private resolver: (() => void) | null = null;

	push(message: string): void {
		this.queue.push(message);
		this.resolver?.(); // wake up the consumer if it's waiting
		this.resolver = null;
	}

	close(): void {
		this.closed = true;
		this.resolver?.();
		this.resolver = null;
	}

	// Implementing the async iterator protocol:
	[Symbol.asyncIterator](): AsyncIterator<string> {
		let index = 0;

		const next = async (): Promise<IteratorResult<string>> => {
			// If there's data available, return it immediately:
			if (index < this.queue.length) {
				return { value: this.queue[index++], done: false };
			}

			// If closed and no more data, signal completion:
			if (this.closed) {
				return { value: undefined as unknown as string, done: true };
			}

			// Otherwise, wait for new data:
			await new Promise<void>((resolve) => {
				this.resolver = resolve;
			});

			return next(); // recurse to check again
		};

		return { next };
	}
}

// --- 5. MULTIPLE CONSUMERS (BROADCASTING) ---
// An async iterable can only be consumed once.
// If you need multiple consumers, collect it first or implement a broadcast.

async function* broadcast<T>(source: AsyncIterable<T>): AsyncGenerator<T[]> {
	// Collect all then yield — simplest approach:
	const all = await collect(source);
	yield all;
}

// --- MAIN ---

async function main() {
	await demonstrateGenerator();

	console.log("\n=== LLM Stream Simulation ===");
	const text = await streamToTerminal("What is TypeScript?");
	console.log(`Collected: "${text.slice(0, 40)}..."`);

	console.log("\n=== Filter Stream ===");
	const source = simulateLLMStream("Hello");
	const textOnly = filterEvents(source, ["text_delta"]);
	let filtered = "";
	for await (const event of textOnly) {
		if (event.type === "text_delta") filtered += event.text;
	}
	console.log(`Text only: "${filtered.slice(0, 40)}..."`);

	console.log("\n=== MessageQueue (async iterable class) ===");
	const queue = new MessageQueue();

	// Producer runs in the background:
	const producer = (async () => {
		for (const msg of ["hello", "world", "done"]) {
			await new Promise((r) => setTimeout(r, 20));
			queue.push(msg);
		}
		queue.close();
	})();

	// Consumer:
	for await (const msg of queue) {
		console.log(`Received: ${msg}`);
	}
	await producer;
}

main();

/**
 * TASK:
 *
 * 1. Write `takeWhile<T>(source: AsyncIterable<T>, pred: (item: T) => boolean): AsyncGenerator<T>`
 *    that yields items until the predicate returns false, then stops.
 *    Use it to stop consuming a stream after seeing a "done" event.
 *
 * 2. Write `merge<T>(...sources: AsyncIterable<T>[]): AsyncGenerator<T>`
 *    that interleaves multiple async iterables (items arrive in arrival order).
 *    Hint: use Promise.race over the pending .next() calls.
 *
 * 3. Extend simulateLLMStream to support tool calls:
 *    Add a toolcall_start and toolcall_end event between the text events.
 *    Update the consumer (streamToTerminal) to log "[tool: name]" when seen.
 *
 * 4. Add a `withLogging<T extends {type: string}>(source: AsyncIterable<T>): AsyncGenerator<T>`
 *    transform that logs each event's type to stderr before passing it through.
 *    This is the "middleware" pattern used in pi-mono's stream pipeline.
 */
