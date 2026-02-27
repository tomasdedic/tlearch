/**
 * Exercise 02-async/01-promises.ts
 *
 * CONCEPTS: Promise basics, chaining, Promise.all/race/allSettled, error handling
 *
 * Run with: npm run ex exercises/02-async/01-promises.ts
 *
 * Promises are the foundation of everything async in Node.js.
 * LLM API calls, file I/O, tool execution — all return Promises.
 */

// --- 1. CREATING PROMISES ---
// A Promise<T> represents a value that will be available in the future.

// Wrapping a callback-based API in a Promise (common pattern):
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// A promise that may fail:
function fetchModel(id: string): Promise<{ id: string; name: string }> {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			if (id === "unknown") {
				reject(new Error(`Model not found: ${id}`));
			} else {
				resolve({ id, name: `Model ${id}` });
			}
		}, 50);
	});
}

// --- 2. PROMISE CHAINING ---
// .then() transforms the resolved value. .catch() handles errors.

function demonstrateChaining(): Promise<void> {
	return fetchModel("claude-haiku")
		.then((model) => {
			console.log(`Fetched: ${model.name}`);
			return model.id.toUpperCase(); // .then() can return a new value
		})
		.then((upperId) => {
			console.log(`Upper ID: ${upperId}`);
		})
		.catch((err) => {
			console.error(`Error: ${err.message}`);
		});
}

// --- 3. PROMISE.ALL — run in parallel, wait for all ---
// Resolves when ALL promises resolve, rejects if ANY rejects.

async function fetchMultipleModels(ids: string[]): Promise<{ id: string; name: string }[]> {
	// All fetches start at the same time (parallel), not sequentially.
	return Promise.all(ids.map((id) => fetchModel(id)));
}

// --- 4. PROMISE.ALLSETTLED — run in parallel, always get all results ---
// Unlike Promise.all, it never rejects — you get each result or reason.

async function tryFetchModels(ids: string[]): Promise<void> {
	const results = await Promise.allSettled(ids.map((id) => fetchModel(id)));

	for (const result of results) {
		if (result.status === "fulfilled") {
			console.log(`  OK: ${result.value.name}`);
		} else {
			console.log(`  FAIL: ${result.reason.message}`);
		}
	}
}

// --- 5. PROMISE.RACE — first one wins ---
// Resolves or rejects with whichever promise settles first.

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
	);
	return Promise.race([promise, timeout]);
}

// --- 6. TYPED PROMISE ERRORS ---
// Promises always reject with `unknown` in strict TypeScript.
// Always check before accessing properties.

async function safeResolve<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
	try {
		const value = await promise;
		return { ok: true, value };
	} catch (err) {
		// err is `unknown` — must check before using
		const error = err instanceof Error ? err : new Error(String(err));
		return { ok: false, error };
	}
}

// --- MAIN ---

async function main() {
	// 1. Basic chaining:
	console.log("=== Chaining ===");
	await demonstrateChaining();

	// 2. Parallel fetch:
	console.log("\n=== Parallel Fetch (Promise.all) ===");
	const start = Date.now();
	const models = await fetchMultipleModels(["haiku", "sonnet", "opus"]);
	console.log(`Fetched ${models.length} models in ${Date.now() - start}ms (parallel)`);
	// Without Promise.all (sequential) it would take 3x as long.

	// 3. allSettled — some may fail:
	console.log("\n=== Mixed Results (Promise.allSettled) ===");
	await tryFetchModels(["haiku", "unknown", "opus"]);

	// 4. Timeout:
	console.log("\n=== Timeout (Promise.race) ===");
	const slow = sleep(200).then(() => "slow result");
	const result = await safeResolve(withTimeout(slow, 100));
	if (!result.ok) {
		console.log(`Got expected timeout: ${result.error.message}`);
	}

	// 5. Safe error handling:
	console.log("\n=== Safe Error Handling ===");
	const bad = await safeResolve(fetchModel("unknown"));
	if (!bad.ok) {
		console.log(`Caught safely: ${bad.error.message}`);
	}
}

main();

/**
 * TASK:
 *
 * 1. Write a function `retry<T>(fn: () => Promise<T>, times: number): Promise<T>`
 *    that retries a failing promise up to `times` times before giving up.
 *    Use await inside a loop — do NOT chain .then() calls.
 *
 * 2. Write a function `parallel<T>(fns: (() => Promise<T>)[], concurrency: number): Promise<T[]>`
 *    that runs at most `concurrency` promises at a time.
 *    Hint: use a queue and Promise.race to refill slots as they free up.
 *
 * 3. Model pi-mono's `Result<T>` pattern and write
 *    `resultAll<T>(results: Result<T>[]): Result<T[]>`
 *    that returns ok only if ALL results are ok, otherwise the first error.
 */
