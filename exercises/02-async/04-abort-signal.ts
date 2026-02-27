/**
 * Exercise 02-async/04-abort-signal.ts
 *
 * CONCEPTS: AbortController, AbortSignal, cancellable async operations
 *
 * Run with: npm run ex exercises/02-async/04-abort-signal.ts
 *
 * LLM streams can take a long time. Users press Ctrl+C. You need cancellation.
 * pi-mono passes AbortSignal through its entire streaming pipeline so any
 * layer can cancel the in-flight request.
 *
 * From packages/ai/src/stream.ts — every provider accepts: { signal?: AbortSignal }
 */

// --- 1. ABORTSIGNAL BASICS ---
// AbortController holds a signal. Calling .abort() fires the signal.
// You pass the signal to async operations; they check it and stop.

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);

		// If the signal fires before the timer, cancel:
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Aborted")); // or: signal.reason
		});
	});
}

// --- 2. ABORT-AWARE ASYNC GENERATOR ---
// Check the signal at each yield point to stop early.

async function* streamWithCancel(
	words: string[],
	delayMs: number,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	for (const word of words) {
		// Check before each word — stop cleanly if aborted:
		if (signal?.aborted) {
			console.log("\n[stream: aborted before word]");
			return;
		}

		try {
			await sleep(delayMs, signal);
		} catch {
			console.log("\n[stream: cancelled mid-delay]");
			return; // stop the generator
		}

		yield word;
	}
}

// --- 3. ABORT AFTER TIMEOUT (COMMON PATTERN) ---

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${ms}ms`)), ms);

	return promise.finally(() => clearTimeout(timer));
}

// AbortSignal.timeout() is a built-in shorthand (Node 18+):
async function fetchWithTimeout(url: string, ms: number): Promise<string> {
	const signal = AbortSignal.timeout(ms);
	// fetch() natively accepts AbortSignal:
	// const res = await fetch(url, { signal });
	// For this exercise we simulate it:
	await sleep(50, signal);
	return `response from ${url}`;
}

// --- 4. COMBINING SIGNALS ---
// Sometimes you have multiple abort sources (user cancel + timeout).

function anySignal(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();

	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			return controller.signal;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason));
	}

	return controller.signal;
}

// --- 5. CANCELLABLE AGENT LOOP ---
// This mirrors how pi-mono cancels a streaming LLM call when the user presses Ctrl+C.

type StreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "done" };

async function* simulateStream(signal?: AbortSignal): AsyncGenerator<StreamEvent> {
	const response = "The quick brown fox jumps over the lazy dog.";
	const words = response.split(" ");

	for (const word of words) {
		if (signal?.aborted) return;
		await sleep(30, signal).catch(() => null); // swallow abort error
		if (signal?.aborted) return;
		yield { type: "text_delta", text: word + " " };
	}
	yield { type: "done" };
}

class CancellableAgent {
	private controller: AbortController | null = null;

	async stream(prompt: string): Promise<string> {
		// Cancel any in-flight stream first:
		this.cancel();

		this.controller = new AbortController();
		const { signal } = this.controller;

		let text = "";
		console.log(`[agent] streaming: "${prompt}"`);

		for await (const event of simulateStream(signal)) {
			if (event.type === "text_delta") {
				process.stdout.write(event.text);
				text += event.text;
			} else if (event.type === "done") {
				console.log("\n[agent] done");
			}
		}

		this.controller = null;
		return text;
	}

	cancel(): void {
		if (this.controller) {
			console.log("[agent] cancelling...");
			this.controller.abort();
			this.controller = null;
		}
	}
}

// --- 6. LISTENING FOR PROCESS SIGNALS ---
// In a real TUI, Ctrl+C sends SIGINT. You handle it to cancel the current stream.

function installCtrlCHandler(onCancel: () => void): () => void {
	const handler = () => {
		onCancel();
		// Don't process.exit() — let the app decide what to do next.
	};
	process.on("SIGINT", handler);
	// Return cleanup function:
	return () => process.off("SIGINT", handler);
}

// --- MAIN ---

async function main() {
	// 1. Basic abort:
	console.log("=== Basic Abort ===");
	const ctrl = new AbortController();
	setTimeout(() => ctrl.abort(), 60); // abort after 60ms

	const words = ["Hello", "world", "this", "is", "TypeScript"];
	const output: string[] = [];

	for await (const word of streamWithCancel(words, 30, ctrl.signal)) {
		output.push(word);
	}
	console.log(`Got words before cancel: [${output.join(", ")}]`);

	// 2. Combined signals:
	console.log("\n=== Combined Signals ===");
	const userCancel = new AbortController();
	const timeoutSignal = AbortSignal.timeout(1000);
	const combined = anySignal([userCancel.signal, timeoutSignal]);
	console.log(`Combined aborted: ${combined.aborted}`);

	// 3. Cancellable agent:
	console.log("\n=== Cancellable Agent ===");
	const agent = new CancellableAgent();

	// Start streaming, then cancel halfway:
	const streamPromise = agent.stream("tell me about typescript");
	setTimeout(() => agent.cancel(), 150); // cancel after 150ms

	await streamPromise;

	// 4. Full stream (no cancel):
	console.log("\n=== Full Stream ===");
	await agent.stream("short");
}

main();

/**
 * TASK:
 *
 * 1. Add a `onAbort(signal: AbortSignal, fn: () => void): void` helper that
 *    calls fn when the signal fires, OR immediately if it's already aborted.
 *
 * 2. Write a `raceUntilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal): Promise<T[]>`
 *    that collects all items until the signal fires, then returns what was collected.
 *
 * 3. Extend CancellableAgent to emit events (start, token, cancel, done) using
 *    the TypedEventEmitter from exercise 02-async-await.ts.
 *
 * 4. Wire up the SIGINT handler: when the user presses Ctrl+C during streaming,
 *    cancel the stream (don't exit). A second Ctrl+C should exit the process.
 *    Hint: use the `installCtrlCHandler` function above and track press count.
 */
