/**
 * Exercise 08-context-search/demo.ts
 *
 * Demonstrates the context-search library:
 *   - indexes all .md files in this project on first run
 *   - runs 4 demo queries showing hybrid scoring
 *   - shows how to wire it into an agent as a retrieval tool
 *
 * Run:
 *   npm run ex exercises/08-context-search/demo.ts
 *   npm run ex exercises/08-context-search/demo.ts -- --query "your question"
 *   npm run ex exercises/08-context-search/demo.ts -- --rebuild
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { buildIndex, chunkCount, hybridSearch, openContextDb } from "./context-search.js";

// ─── SETUP ────────────────────────────────────────────────────────────────────

const ROOT_DIR = ".";                               // directory to scan for .md files
const DB_PATH  = join(ROOT_DIR, ".context-search.db");

const args = process.argv.slice(2);
const queryFlag   = args.indexOf("--query");
const inlineQuery = queryFlag >= 0 ? args[queryFlag + 1] : null;
const rebuild     = args.includes("--rebuild");

if (rebuild && existsSync(DB_PATH)) {
	unlinkSync(DB_PATH);
	console.log("Removed existing index");
}

const db     = openContextDb(DB_PATH);
const exists = chunkCount(db) > 0;

if (!exists) {
	console.log(`Indexing markdown files in: ${ROOT_DIR}`);
	const n = await buildIndex(ROOT_DIR, db, console.log);
	console.log(`Done — ${n} chunks indexed\n`);
} else {
	console.log(`Loaded existing index: ${chunkCount(db)} chunks (--rebuild to refresh)\n`);
}

// ─── DEMO QUERIES ─────────────────────────────────────────────────────────────

function printResult(r: Awaited<ReturnType<typeof hybridSearch>>[number], rank: number) {
	const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
	console.log(
		`  #${rank}  hybrid=${pct(r.hybridScore)}  ` +
		`vec=${pct(r.vecScore)} d=${r.distance.toFixed(3)}  ` +
		`bm25=${pct(r.bm25Score)}`,
	);
	const loc = r.chunk.file + (r.chunk.heading ? ` › ${r.chunk.heading}` : "");
	console.log(`      ${loc}`);
	console.log(`      ${r.chunk.content.replace(/\n/g, " ").slice(0, 160)}…`);
}

const demoQueries = inlineQuery
	? [inlineQuery]
	: [
		"how does context compaction work",
		"RocketChat bot stop command",
		"async generator streaming pattern",
		"FTS5 full-text search BM25",
	];

for (const q of demoQueries) {
	console.log(`${"─".repeat(64)}`);
	console.log(`Query: "${q}"`);
	const results = await hybridSearch(db, q, { limit: 3 });
	if (results.length === 0) {
		console.log("  (no results)");
	} else {
		for (let i = 0; i < results.length; i++) printResult(results[i], i + 1);
	}
	console.log();
}

// ─── AGENT TOOL EXAMPLE ───────────────────────────────────────────────────────
//
// This is how you'd wire it into an agent from Stage 4:
//
//   import { type AgentTool } from "../06-tools/03-agent-class.js";
//   import { openContextDb, hybridSearch } from "./context-search.js";
//
//   const contextDb = openContextDb(".context-search.db");
//
//   const searchContextTool: AgentTool = {
//     name: "search_context",
//     description:
//       "Search the indexed markdown context files. " +
//       "Returns the most relevant passages ranked by hybrid vector + BM25 score.",
//     inputSchema: {
//       type: "object",
//       properties: {
//         query: { type: "string", description: "Natural language search query" },
//         limit: { type: "number", description: "Max results to return (default 4)" },
//       },
//       required: ["query"],
//     },
//     async execute(input) {
//       const results = await hybridSearch(contextDb, input.query as string, {
//         limit: (input.limit as number) ?? 4,
//       });
//       if (results.length === 0) return "No relevant context found.";
//       return results
//         .map((r, i) => {
//           const score = `${(r.hybridScore * 100).toFixed(0)}%`;
//           const loc   = `${r.chunk.file}${r.chunk.heading ? ` › ${r.chunk.heading}` : ""}`;
//           return `[${i + 1}] (${score}) ${loc}\n${r.chunk.content}`;
//         })
//         .join("\n\n---\n\n");
//     },
//   };
//
//   const agent = new Agent(apiKey, { systemPrompt: "..." })
//     .register(readFileTool)
//     .register(searchContextTool);   // <── injected here
//

// ─── INTERACTIVE SEARCH (optional) ───────────────────────────────────────────

if (!inlineQuery && process.stdin.isTTY) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = () =>
		rl.question('Search (empty to quit): ', async (q) => {
			if (!q.trim()) { rl.close(); db.close(); return; }
			const results = await hybridSearch(db, q, { limit: 5 });
			console.log();
			if (results.length === 0) {
				console.log("  (no results)");
			} else {
				for (let i = 0; i < results.length; i++) printResult(results[i], i + 1);
			}
			console.log();
			ask();
		});
	ask();
} else {
	db.close();
}
