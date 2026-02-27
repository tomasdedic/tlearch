/**
 * Exercise 06-tools/02-file-tools.ts
 *
 * CONCEPTS: read/write/edit tool implementations, atomic writes, smart truncation
 *
 * Run with: npm run ex exercises/06-tools/02-file-tools.ts
 *
 * These are the three fundamental file tools in every coding agent.
 * pi-mono implements them in packages/coding-agent/src/core/tools/:
 *   read.ts   — file reading with line/byte limits
 *   write.ts  — file creation/replacement
 *   edit.ts   — string-based surgical edits (old_str → new_str)
 *
 * This file is pure TypeScript — no Ink. Each tool is a function that returns
 * a Result<string>. The agent calls these and passes the string to the LLM.
 */

import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ─── RESULT TYPE ──────────────────────────────────────────────────────────────
// All tools return Result<string>. The agent checks ok before using the value.

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): Result<T> { return { ok: true, value }; }
function err<T>(error: string): Result<T> { return { ok: false, error }; }

// ─── 1. READ TOOL ─────────────────────────────────────────────────────────────
// Reads a file with configurable limits. Never returns more than the LLM needs.
// Strategy: if the file is small, return everything.
// If large, return head + tail with a "truncated" notice in the middle.
//
// pi-mono's read.ts uses similar head/tail logic.

type ReadOptions = {
	maxLines?: number;    // default 200
	maxBytes?: number;    // default 50_000 (50KB)
	offset?: number;      // start at line N (1-indexed)
	lineNumbers?: boolean; // prefix each line with its number
};

async function readFileTool(
	path: string,
	options: ReadOptions = {},
): Promise<Result<string>> {
	const {
		maxLines = 200,
		maxBytes = 50_000,
		offset = 1,
		lineNumbers = false,
	} = options;

	const absPath = resolve(path);

	try {
		const fileStat = await stat(absPath);
		if (!fileStat.isFile()) return err(`Not a file: ${path}`);
	} catch {
		return err(`File not found: ${path}`);
	}

	try {
		const raw = await readFile(absPath, "utf-8");
		const allLines = raw.split("\n");
		const totalLines = allLines.length;

		// Apply offset (1-indexed):
		const fromLine = Math.max(0, offset - 1);
		const slicedLines = allLines.slice(fromLine);

		if (slicedLines.length <= maxLines) {
			// Small enough: return everything from offset
			const content = formatLines(slicedLines, lineNumbers, fromLine + 1);
			const byteCount = Buffer.byteLength(content, "utf-8");
			if (byteCount <= maxBytes) {
				return ok(addFileHeader(absPath, totalLines, content));
			}
		}

		// Large file: return head + tail with gap notice
		const headCount = Math.floor(maxLines * 0.6); // 60% from top
		const tailCount = maxLines - headCount;       // 40% from bottom

		const headLines = slicedLines.slice(0, headCount);
		const tailLines = slicedLines.slice(-tailCount);
		const skipped = slicedLines.length - headCount - tailCount;

		const head = formatLines(headLines, lineNumbers, fromLine + 1);
		const tail = formatLines(tailLines, lineNumbers, fromLine + headCount + skipped + 1);
		const notice = `\n... [${skipped} lines omitted — use offset=${fromLine + headCount + 1} to read more] ...\n\n`;

		const content = head + notice + tail;
		return ok(addFileHeader(absPath, totalLines, content));
	} catch (e) {
		return err(`Read failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function formatLines(lines: string[], numbered: boolean, startLine: number): string {
	if (!numbered) return lines.join("\n");
	return lines
		.map((line, i) => `${String(startLine + i).padStart(4)} | ${line}`)
		.join("\n");
}

function addFileHeader(path: string, totalLines: number, content: string): string {
	return `File: ${path} (${totalLines} lines)\n${"─".repeat(40)}\n${content}`;
}

// ─── 2. WRITE TOOL ────────────────────────────────────────────────────────────
// Atomically writes a file: write to a temp file, then rename.
// This prevents partial writes if the process is killed mid-write.
// Also creates parent directories if they don't exist.

type WriteOptions = {
	createDirs?: boolean; // create parent directories (default true)
};

async function writeFileTool(
	path: string,
	content: string,
	options: WriteOptions = {},
): Promise<Result<string>> {
	const { createDirs = true } = options;
	const absPath = resolve(path);
	const dir = dirname(absPath);

	try {
		// Create parent directories if needed:
		if (createDirs) {
			await mkdir(dir, { recursive: true });
		}

		// Check if file already exists (for the return message):
		let existed = false;
		try {
			await stat(absPath);
			existed = true;
		} catch {
			// doesn't exist — that's fine
		}

		// Atomic write: write to temp file in same directory, then rename.
		// rename() is atomic on POSIX — if it fails, the original is intact.
		const tmpPath = join(tmpdir(), `ts-learning-write-${Date.now()}-${basename(absPath)}`);
		await writeFile(tmpPath, content, "utf-8");
		await rename(tmpPath, absPath);

		const lines = content.split("\n").length;
		const bytes = Buffer.byteLength(content, "utf-8");
		const action = existed ? "Updated" : "Created";
		return ok(`${action} ${path} (${lines} lines, ${bytes} bytes)`);
	} catch (e) {
		return err(`Write failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ─── 3. EDIT TOOL ─────────────────────────────────────────────────────────────
// Find `oldStr` in a file and replace it with `newStr`.
// This is the model pi-mono's edit.ts uses — and it's the same as Claude Code's
// Edit tool. It's surgical: only the specified string changes.
//
// Key rules (from pi-mono and Claude Code):
//   - oldStr must be unique in the file (otherwise it's ambiguous)
//   - oldStr must match exactly (whitespace and all)
//   - If not found or not unique, return an error

async function editFileTool(
	path: string,
	oldStr: string,
	newStr: string,
): Promise<Result<string>> {
	const absPath = resolve(path);

	let content: string;
	try {
		content = await readFile(absPath, "utf-8");
	} catch {
		return err(`File not found: ${path}`);
	}

	// Count occurrences:
	const occurrences = countOccurrences(content, oldStr);

	if (occurrences === 0) {
		// Give a helpful diff hint when the string isn't found:
		const hint = findNearMatch(content, oldStr);
		return err(`old_str not found in ${path}.${hint ? `\nDid you mean:\n${hint}` : ""}`);
	}

	if (occurrences > 1) {
		return err(
			`old_str matches ${occurrences} locations in ${path}. ` +
			`Make old_str more specific by including surrounding context.`,
		);
	}

	// Exactly one match — apply the edit:
	const newContent = content.replace(oldStr, newStr);
	const writeResult = await writeFileTool(path, newContent, { createDirs: false });

	if (!writeResult.ok) return writeResult;

	// Return a summary of what changed:
	const removed = oldStr.split("\n").length;
	const added = newStr.split("\n").length;
	return ok(`Edited ${path}: -${removed} lines, +${added} lines`);
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		count++;
		idx += needle.length;
	}
	return count;
}

function findNearMatch(content: string, target: string): string | null {
	// Find the first line of target in content and show surrounding context:
	const firstLine = target.split("\n")[0].trim();
	if (!firstLine) return null;
	const contentLines = content.split("\n");
	const matchIdx = contentLines.findIndex((l) => l.includes(firstLine));
	if (matchIdx === -1) return null;
	const start = Math.max(0, matchIdx - 1);
	const end = Math.min(contentLines.length - 1, matchIdx + 2);
	return contentLines.slice(start, end + 1).join("\n");
}

// ─── 4. GREP TOOL (BONUS) ─────────────────────────────────────────────────────
// Search for a pattern across files. Returns matching lines with context.
// pi-mono has this in packages/coding-agent/src/core/tools/grep.ts

type GrepOptions = {
	pattern: string;
	path?: string;
	recursive?: boolean;
	caseSensitive?: boolean;
	contextLines?: number; // lines before and after match
	maxResults?: number;
};

async function grepTool(options: GrepOptions): Promise<Result<string>> {
	const {
		pattern,
		path: searchPath = ".",
		caseSensitive = false,
		contextLines = 0,
		maxResults = 50,
	} = options;

	try {
		const regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
		const results: string[] = [];
		let totalMatches = 0;

		async function searchFile(filePath: string) {
			try {
				const content = await readFile(filePath, "utf-8");
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (regex.test(lines[i])) {
						totalMatches++;
						if (results.length >= maxResults) continue;
						const start = Math.max(0, i - contextLines);
						const end = Math.min(lines.length - 1, i + contextLines);
						const block = lines.slice(start, end + 1)
							.map((l, idx) => `${filePath}:${start + idx + 1}: ${l}`)
							.join("\n");
						results.push(block);
						regex.lastIndex = 0; // reset regex for next line
					}
				}
			} catch {
				// skip unreadable files
			}
		}

		const pathStat = await stat(resolve(searchPath));
		if (pathStat.isFile()) {
			await searchFile(resolve(searchPath));
		} else {
			// Walk directory (simple non-recursive for now):
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(resolve(searchPath), { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isFile() && /\.(ts|tsx|js|json|md|txt)$/.test(entry.name)) {
					await searchFile(join(resolve(searchPath), entry.name));
				}
			}
		}

		if (results.length === 0) return ok(`No matches for "${pattern}" in ${searchPath}`);
		const header = `${totalMatches} match(es) for "${pattern}"${totalMatches > maxResults ? ` (showing first ${maxResults})` : ""}:`;
		return ok([header, ...results].join("\n\n"));
	} catch (e) {
		return err(`Grep failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ─── DEMO ─────────────────────────────────────────────────────────────────────

function printResult(label: string, result: Result<string>) {
	if (result.ok) {
		console.log(`\n\x1b[32m✓\x1b[0m ${label}`);
		console.log(result.value);
	} else {
		console.log(`\n\x1b[31m✗\x1b[0m ${label}`);
		console.log(`  Error: ${result.error}`);
	}
}

async function main() {
	console.log("\x1b[1m=== File Tools Demo ===\x1b[0m\n");

	// 1. Read with line numbers:
	printResult("read package.json (with line numbers)", await readFileTool("package.json", { lineNumbers: true, maxLines: 10 }));

	// 2. Read large file with truncation:
	printResult("read tsconfig.json", await readFileTool("tsconfig.json"));

	// 3. Read non-existent:
	printResult("read missing.json", await readFileTool("missing.json"));

	// 4. Write a new file:
	printResult("write /tmp/test-agent.ts", await writeFileTool(
		"/tmp/test-agent.ts",
		`// Generated by ts-learning agent\nexport const hello = "world";\n`,
	));

	// 5. Read it back:
	printResult("read /tmp/test-agent.ts", await readFileTool("/tmp/test-agent.ts", { lineNumbers: true }));

	// 6. Edit the file:
	printResult('edit: "world" → "TypeScript"', await editFileTool(
		"/tmp/test-agent.ts",
		`"world"`,
		`"TypeScript"`,
	));

	// 7. Read the edited file:
	printResult("read /tmp/test-agent.ts after edit", await readFileTool("/tmp/test-agent.ts", { lineNumbers: true }));

	// 8. Edit: string not found:
	printResult("edit: non-existent string", await editFileTool(
		"/tmp/test-agent.ts",
		`"does not exist"`,
		`"something"`,
	));

	// 9. Grep:
	printResult('grep "exercise" in exercises/', await grepTool({
		pattern: "TASK",
		path: "exercises/06-tools",
		maxResults: 5,
	}));
}

main().catch(console.error);

/**
 * TASK:
 *
 * 1. Add a `readDirectory` tool that returns a formatted tree:
 *      exercises/
 *        01-types/
 *          01-primitives.ts
 *          02-unions.ts
 *        02-async/
 *    Respect a maxDepth parameter (default 3). Mark dirs with / suffix.
 *
 * 2. Add line-range support to readFileTool: `startLine` and `endLine` options
 *    that return only those lines (instead of head/tail truncation).
 *    This is useful when the LLM asks to "read lines 50-80".
 *
 * 3. Add a `patchFileTool` that applies a unified diff (output from diff -u):
 *    Parse the +/- lines from the patch and apply them to the file.
 *    This is how pi-mono's "apply patch" feature works.
 *
 * 4. Add `undoEditTool`: before every write, save the original content to
 *    a Map<path, string>. `undoEditTool(path)` restores the original.
 *    This is the foundation of pi-mono's revert functionality.
 */
