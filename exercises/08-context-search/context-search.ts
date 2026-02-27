/**
 * context-search.ts — reusable hybrid context search library
 *
 * Chunks markdown files, embeds them locally, stores in SQLite,
 * and retrieves with hybrid vector + BM25 scoring.
 *
 * Usage:
 *   import { openContextDb, buildIndex, hybridSearch } from "./context-search.js";
 *
 *   const db = openContextDb(".context-search.db");
 *   if (needsIndex) await buildIndex("./docs", db);
 *   const results = await hybridSearch(db, "how does compaction work");
 */

import Database from "better-sqlite3";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { pipeline } from "@xenova/transformers";

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type Chunk = {
	id: number;
	file: string;
	heading: string;
	content: string;
};

export type SearchResult = {
	chunk: Chunk;
	hybridScore: number; // 0–1, higher = better
	vecScore: number;    // 0–1 from vector similarity
	bm25Score: number;   // 0–1 from BM25 full-text rank
	distance: number;    // raw L2 distance from vec search
};

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
//
// chunks      — raw text, source of truth
// chunks_fts  — FTS5 inverted index (content= avoids duplicating text)
// chunks_vec  — vec0 virtual table, Float32[384] per chunk
//
// The trigger keeps FTS in sync with chunks on INSERT.

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS chunks (
		id      INTEGER PRIMARY KEY AUTOINCREMENT,
		file    TEXT NOT NULL,
		heading TEXT NOT NULL DEFAULT '',
		content TEXT NOT NULL
	);

	CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
		content,
		heading,
		tokenize = 'unicode61'
	);

	CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
		embedding FLOAT[384]
	);
`;

// ─── DB SETUP ─────────────────────────────────────────────────────────────────

/**
 * Open (or create) the SQLite database, load the sqlite-vec extension,
 * and apply the schema. Safe to call multiple times — all CREATE statements
 * are IF NOT EXISTS.
 */
export function openContextDb(dbPath: string): Database.Database {
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	sqliteVec.load(db);
	db.exec(SCHEMA);
	return db;
}

/** How many chunks are currently indexed. */
export function chunkCount(db: Database.Database): number {
	return (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
}

// ─── CHUNKING ─────────────────────────────────────────────────────────────────

const MAX_CHUNK_CHARS = 900;

/**
 * Split a markdown string into chunks at heading boundaries,
 * further splitting large sections by paragraph.
 */
export function chunkMarkdown(content: string, file: string): Omit<Chunk, "id">[] {
	const parts = content.split(/(?=^#{1,4} )/m);
	const chunks: Omit<Chunk, "id">[] = [];

	for (const part of parts) {
		const lines = part.split("\n");
		const heading = /^#{1,4} /.test(lines[0])
			? lines[0].replace(/^#{1,4} /, "").trim()
			: "";
		const body = (heading ? lines.slice(1).join("\n") : part).trim();

		if (body.length < 30) continue;

		if (body.length <= MAX_CHUNK_CHARS) {
			chunks.push({ file, heading, content: body });
		} else {
			// Split at paragraph boundaries
			const paras = body.split(/\n{2,}/);
			let acc = "";
			for (const para of paras) {
				const next = acc ? `${acc}\n\n${para}` : para;
				if (acc && next.length > MAX_CHUNK_CHARS) {
					if (acc.trim().length >= 30) chunks.push({ file, heading, content: acc.trim() });
					acc = para;
				} else {
					acc = next;
				}
			}
			if (acc.trim().length >= 30) chunks.push({ file, heading, content: acc.trim() });
		}
	}

	return chunks;
}

// ─── EMBEDDING ────────────────────────────────────────────────────────────────
//
// all-MiniLM-L6-v2: 384-dimensional sentence embeddings, quantized ~23MB.
// Downloads once to ~/.cache/huggingface/hub/, then cached locally.
// Output vectors are L2-normalised → cosine_similarity = 1 - L2_distance/2.

const EMBEDDING_DIMS = 384;
const BATCH_SIZE = 32;

// biome-ignore lint/suspicious/noExplicitAny: xenova pipeline types are loose
let _extractor: any = null;

async function loadExtractor() {
	if (_extractor) return _extractor;
	process.stdout.write("Loading embedding model (first run: ~23MB download)...");
	_extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
		quantized: true,
	});
	process.stdout.write(" ready\n");
	return _extractor;
}

/**
 * Embed a batch of strings.
 * Returns one Float32Array of length 384 per input string.
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
	const model = await loadExtractor();
	const results: Float32Array[] = [];
	for (let i = 0; i < texts.length; i += BATCH_SIZE) {
		const batch = texts.slice(i, i + BATCH_SIZE);
		const out = await model(batch, { pooling: "mean", normalize: true });
		for (let j = 0; j < batch.length; j++) {
			results.push(
				new Float32Array(out.data.slice(j * EMBEDDING_DIMS, (j + 1) * EMBEDDING_DIMS)),
			);
		}
	}
	return results;
}

// ─── INDEX BUILDING ───────────────────────────────────────────────────────────

async function findMarkdownFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const e of entries) {
		if (e.name === "node_modules" || e.name.startsWith(".")) continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) files.push(...(await findMarkdownFiles(full)));
		else if (e.name.endsWith(".md")) files.push(full);
	}
	return files;
}

/**
 * Scan rootDir for .md files, chunk them, embed, and insert into db.
 * Skips files already present in the index (by relative path).
 * Returns the number of new chunks added.
 */
export async function buildIndex(
	rootDir: string,
	db: Database.Database,
	onProgress?: (msg: string) => void,
): Promise<number> {
	const log = onProgress ?? console.log;

	const files = await findMarkdownFiles(rootDir);
	log(`Found ${files.length} markdown files`);

	// Skip files already indexed
	const indexed = new Set(
		(db.prepare("SELECT DISTINCT file FROM chunks").all() as { file: string }[]).map(
			(r) => r.file,
		),
	);

	const allChunks: Omit<Chunk, "id">[] = [];
	for (const file of files) {
		const rel = relative(rootDir, file);
		if (indexed.has(rel)) continue;
		const content = await readFile(file, "utf-8");
		allChunks.push(...chunkMarkdown(content, rel));
	}

	if (allChunks.length === 0) {
		log("Nothing new to index");
		return 0;
	}
	log(`Chunking produced ${allChunks.length} new chunks`);

	// Embed: prepend heading to give the model more context
	const texts = allChunks.map((c) =>
		`${c.heading ? `${c.heading}: ` : ""}${c.content}`.slice(0, 512),
	);
	log(`Embedding ${allChunks.length} chunks…`);
	const embeddings = await embedTexts(texts);
	log("Embedding done");

	const insertChunk = db.prepare(
		"INSERT INTO chunks (file, heading, content) VALUES (?, ?, ?)",
	);
	// sqlite-vec: insert via rowid. Must use BigInt so better-sqlite3 binds it as
	// SQLITE_INTEGER (not REAL) — sqlite-vec rejects float primary keys.
	const insertVec = db.prepare(
		"INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
	);
	// FTS5: insert with explicit rowid matching chunk.id
	const insertFts = db.prepare(
		"INSERT INTO chunks_fts (rowid, content, heading) VALUES (?, ?, ?)",
	);

	db.transaction(() => {
		for (let i = 0; i < allChunks.length; i++) {
			const c = allChunks[i];
			const { lastInsertRowid } = insertChunk.run(c.file, c.heading, c.content);
			const rowid = typeof lastInsertRowid === "bigint" ? lastInsertRowid : BigInt(lastInsertRowid);
			insertVec.run(rowid, Buffer.from(embeddings[i].buffer));
			insertFts.run(rowid, c.content, c.heading);
		}
	})();

	return allChunks.length;
}

// ─── HYBRID SEARCH ────────────────────────────────────────────────────────────
//
// Score normalization:
//
//   vec_score  = 1 - distance/2
//     all-MiniLM L2-normalises its outputs, so L2 distance ∈ [0, 2].
//     Mapping: identical → 1.0, orthogonal → 0.5, opposite → 0.0.
//
//   bm25_score = -bm25() / max(-bm25())
//     FTS5's bm25() returns negative values (lower = better).
//     Negate, then divide by the best score in the candidate set → [0, 1].
//
//   hybrid = 0.7 × vec_score + 0.3 × bm25_score
//     Chunks found by only one method score 0 for the missing component.

export const DEFAULT_VEC_WEIGHT = 0.7;
export const DEFAULT_BM25_WEIGHT = 0.3;
export const DEFAULT_CANDIDATES = 20;

// Strip FTS5 special characters and join with OR for better recall.
// Vector search handles semantic precision; BM25 rewards exact token matches.
function toFtsQuery(raw: string): string {
	const words = raw
		.replace(/[^\w\s]/g, " ")
		.trim()
		.split(/\s+/)
		.filter((w) => w.length > 1);
	return words.length ? words.join(" OR ") : '""';
}

export type HybridSearchOptions = {
	limit?: number;
	vecWeight?: number;
	bm25Weight?: number;
	candidates?: number;
};

/**
 * Search the index with hybrid vector + BM25 scoring.
 *
 * @param db       - database returned by openContextDb()
 * @param query    - natural language query string
 * @param options  - limit (default 5), weights, candidates
 */
export async function hybridSearch(
	db: Database.Database,
	query: string,
	options: HybridSearchOptions = {},
): Promise<SearchResult[]> {
	const {
		limit = 5,
		vecWeight = DEFAULT_VEC_WEIGHT,
		bm25Weight = DEFAULT_BM25_WEIGHT,
		candidates = DEFAULT_CANDIDATES,
	} = options;

	// 1. Embed query with the same model used to build the index
	const [queryVec] = await embedTexts([query]);
	const queryBuf = Buffer.from(queryVec.buffer);

	// 2. Vector KNN search — returns L2 distance (lower = more similar)
	const vecRows = db
		.prepare(
			`SELECT rowid AS chunk_id, distance
			 FROM   chunks_vec
			 WHERE  embedding MATCH ?
			 ORDER  BY distance
			 LIMIT  ?`,
		)
		.all(queryBuf, candidates) as { chunk_id: number; distance: number }[];

	// 3. BM25 full-text search — bm25() returns negative values
	// rowid in chunks_fts == id in chunks (set explicitly on insert)
	const bm25Rows = db
		.prepare(
			`SELECT f.rowid AS id, c.file, c.heading, c.content, bm25(chunks_fts) AS rank
			 FROM   chunks_fts f
			 JOIN   chunks c ON c.id = f.rowid
			 WHERE  chunks_fts MATCH ?
			 ORDER  BY rank
			 LIMIT  ?`,
		)
		.all(toFtsQuery(query), candidates) as (Chunk & { rank: number })[];

	// 4. Normalize: max positive BM25 score across results
	const maxBm25 = Math.max(...bm25Rows.map((r) => -r.rank), 1e-9);

	// 5. Merge into a unified map
	const map = new Map<
		number,
		{ vecScore: number; bm25Score: number; distance: number; chunk?: Chunk }
	>();

	for (const v of vecRows) {
		map.set(v.chunk_id, {
			vecScore: Math.max(0, 1 - v.distance / 2),
			bm25Score: 0,
			distance: v.distance,
		});
	}

	for (const b of bm25Rows) {
		const entry = map.get(b.id);
		const bm25Score = -b.rank / maxBm25;
		if (entry) {
			entry.bm25Score = bm25Score;
			entry.chunk = b;
		} else {
			map.set(b.id, { vecScore: 0, bm25Score, distance: 2, chunk: b });
		}
	}

	// 6. Hydrate chunks that only appeared in the vec results
	const getChunk = db.prepare(
		"SELECT id, file, heading, content FROM chunks WHERE id = ?",
	);
	for (const [id, e] of map) {
		if (!e.chunk) e.chunk = getChunk.get(id) as Chunk;
	}

	// 7. Combine, rank, slice
	return [...map.values()]
		.filter((e) => e.chunk != null)
		.map((e) => ({
			chunk: e.chunk!,
			vecScore: e.vecScore,
			bm25Score: e.bm25Score,
			distance: e.distance,
			hybridScore: vecWeight * e.vecScore + bm25Weight * e.bm25Score,
		}))
		.sort((a, b) => b.hybridScore - a.hybridScore)
		.slice(0, limit);
}
