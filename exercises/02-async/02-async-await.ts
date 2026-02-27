/**
 * Exercise 02-async/02-async-await.ts
 *
 * CONCEPTS: async/await, error handling, sequential vs parallel, EventEmitter
 *
 * Run with: npm run ex exercises/02-async/02-async-await.ts
 *
 * async/await is syntactic sugar over Promises — it makes async code read
 * like synchronous code. Every `await` suspends the function until the
 * Promise settles, then resumes with the resolved value.
 */

import { EventEmitter } from "node:events";

// --- 1. ASYNC FUNCTIONS ---
// An `async` function always returns a Promise, even if you return a plain value.
// `await` can only be used inside `async` functions (or top-level in ESM).

async function loadConfig(path: string): Promise<{ path: string; data: string }> {
	// Simulate async file read:
	await new Promise((resolve) => setTimeout(resolve, 10));
	return { path, data: `contents of ${path}` };
}

// --- 2. SEQUENTIAL vs PARALLEL ---
// This is the most common async mistake: awaiting inside a loop = sequential.

async function loadSequential(paths: string[]): Promise<void> {
	const start = Date.now();
	for (const path of paths) {
		await loadConfig(path); // waits for each before starting next
	}
	console.log(`Sequential: ${Date.now() - start}ms`);
}

async function loadParallel(paths: string[]): Promise<void> {
	const start = Date.now();
	await Promise.all(paths.map((p) => loadConfig(p))); // all start at once
	console.log(`Parallel:   ${Date.now() - start}ms`);
}

// --- 3. ERROR HANDLING ---

// try/catch works naturally with await:
async function readOrDefault(path: string): Promise<string> {
	try {
		const config = await loadConfig(path);
		if (path.includes("missing")) {
			throw new Error(`File not found: ${path}`);
		}
		return config.data;
	} catch (err) {
		// Always check type — err is `unknown` in strict mode
		if (err instanceof Error) {
			console.log(`Warning: ${err.message}, using default`);
		}
		return "default config";
	} finally {
		// finally always runs — good for cleanup (close file handles, etc.)
		// console.log("Cleanup");
	}
}

// --- 4. RETURNING ASYNC FUNCTIONS AS VALUES ---
// Functions that return Promises are first-class values in TypeScript.
// pi-mono passes tool implementations around as async functions.

type ToolFn = (input: Record<string, unknown>) => Promise<string>;

const tools: Record<string, ToolFn> = {
	read_file: async (input) => {
		const path = input.path as string;
		await new Promise((r) => setTimeout(r, 5));
		return `contents of ${path}`;
	},
	list_dir: async (input) => {
		const path = input.path as string;
		await new Promise((r) => setTimeout(r, 5));
		return `files in ${path}: a.ts, b.ts`;
	},
};

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
	const fn = tools[name];
	if (!fn) throw new Error(`Unknown tool: ${name}`);
	return fn(input);
}

// --- 5. TYPED EVENTEMITTER ---
// EventEmitter is Node's built-in pub/sub. pi-mono uses it for agent events.
// TypeScript doesn't type EventEmitter by default, but we can wrap it.

type AgentEvents = {
	start: [sessionId: string];
	message: [role: string, text: string];
	end: [reason: string];
	error: [err: Error];
};

class TypedEventEmitter<TEvents extends Record<string, unknown[]>> {
	private emitter = new EventEmitter();

	on<K extends keyof TEvents & string>(event: K, listener: (...args: TEvents[K]) => void): this {
		this.emitter.on(event, listener as (...args: unknown[]) => void);
		return this;
	}

	emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K]): void {
		this.emitter.emit(event, ...args);
	}

	off<K extends keyof TEvents & string>(event: K, listener: (...args: TEvents[K]) => void): this {
		this.emitter.off(event, listener as (...args: unknown[]) => void);
		return this;
	}
}

class Agent extends TypedEventEmitter<AgentEvents> {
	async run(prompt: string): Promise<void> {
		this.emit("start", "sess-001");
		this.emit("message", "user", prompt);

		// Simulate async LLM call:
		await new Promise((r) => setTimeout(r, 20));

		this.emit("message", "assistant", `Response to: ${prompt}`);
		this.emit("end", "stop");
	}
}

// --- 6. ASYNC IN CLASSES ---

class SessionManager {
	private sessions = new Map<string, { id: string; messages: string[] }>();

	async createSession(id: string): Promise<string> {
		await new Promise((r) => setTimeout(r, 5)); // simulate DB write
		this.sessions.set(id, { id, messages: [] });
		return id;
	}

	async addMessage(sessionId: string, message: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`Session not found: ${sessionId}`);
		await new Promise((r) => setTimeout(r, 2)); // simulate write
		session.messages.push(message);
	}

	async getSession(id: string): Promise<{ id: string; messages: string[] } | undefined> {
		await new Promise((r) => setTimeout(r, 2));
		return this.sessions.get(id);
	}
}

// --- MAIN ---

async function main() {
	// Sequential vs parallel:
	const paths = ["/etc/a", "/etc/b", "/etc/c"];
	await loadSequential(paths);
	await loadParallel(paths);

	// Error handling:
	console.log("\n=== Error Handling ===");
	const result = await readOrDefault("/etc/config.json");
	console.log(`Config: ${result}`);
	const missing = await readOrDefault("/etc/missing/file");
	console.log(`Missing: ${missing}`);

	// Tool execution:
	console.log("\n=== Tool Execution ===");
	const output = await executeTool("read_file", { path: "/home/user/notes.md" });
	console.log(output);

	// Typed EventEmitter:
	console.log("\n=== Agent Events ===");
	const agent = new Agent();
	agent.on("start", (sessionId) => console.log(`Started session: ${sessionId}`));
	agent.on("message", (role, text) => console.log(`[${role}] ${text}`));
	agent.on("end", (reason) => console.log(`Done: ${reason}`));
	await agent.run("What is TypeScript?");

	// SessionManager:
	console.log("\n=== Session Manager ===");
	const sm = new SessionManager();
	const sid = await sm.createSession("sess-42");
	await sm.addMessage(sid, "Hello!");
	await sm.addMessage(sid, "How are you?");
	const session = await sm.getSession(sid);
	console.log(`Session ${sid} has ${session?.messages.length} messages`);
}

main();

/**
 * TASK:
 *
 * 1. Add a `timeout` parameter to `executeTool`. If the tool takes longer
 *    than `timeoutMs` milliseconds, throw a `new Error("Tool timed out")`.
 *    Use Promise.race (from exercise 01).
 *
 * 2. Add an `error` event to the Agent class. Wrap the LLM call in try/catch
 *    and emit the error event if it throws.
 *
 * 3. Add a `loadWithRetry(path: string, retries: number): Promise<string>`
 *    function that uses readOrDefault internally but retries on the "missing"
 *    error up to `retries` times with 10ms delay between attempts.
 *
 * 4. Extend SessionManager with a `compactSession(id: string): Promise<void>`
 *    that simulates summarizing messages — replaces all messages with a single
 *    "[compacted: N messages]" entry after an async delay.
 */
