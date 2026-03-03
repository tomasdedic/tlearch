/**
 * context-search.ts — reusable hybrid context search library
 *
 * HOW IT WORKS (high level):
 *
 *   1. CHUNK  — split markdown files into small passages (~900 chars)
 *   2. EMBED  — convert each passage into a 384-number vector that captures meaning
 *   3. STORE  — save chunks + vectors + full-text index in SQLite
 *   4. SEARCH — for a query, run two searches in parallel:
 *               a) vector KNN  — finds chunks with similar *meaning*
 *               b) BM25 FTS    — finds chunks with matching *keywords*
 *              then combine both scores into a single hybrid ranking
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

// A Chunk is one passage extracted from a markdown file.
// Each heading section (or paragraph group) becomes its own chunk.
export type Chunk = {
	id: number;
	file: string;    // relative path to the source .md file
	heading: string; // the markdown heading above this passage (empty if none)
	content: string; // the actual text of the passage
};

// What hybridSearch returns for each match.
export type SearchResult = {
	chunk: Chunk;
	hybridScore: number; // 0–1, higher = better — the final combined score
	vecScore: number;    // 0–1 from vector similarity (semantic match)
	bm25Score: number;   // 0–1 from BM25 full-text rank (keyword match)
	distance: number;    // raw L2 distance from vec search (lower = closer)
};

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
//
// Three SQLite tables work together:
//
//   chunks      — plain rows with the text content (the source of truth)
//   chunks_fts  — FTS5 virtual table: a full-text inverted index for keyword search
//   chunks_vec  — vec0 virtual table: stores one 384-float vector per chunk
//
// All three share the same rowid so we can JOIN across them easily.
// "Virtual table" means SQLite manages it like a table but it's backed by
// a special extension (FTS5 or sqlite-vec) that handles the indexing logic.

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS chunks (
		id      INTEGER PRIMARY KEY AUTOINCREMENT,
		file    TEXT NOT NULL,
		heading TEXT NOT NULL DEFAULT '',
		content TEXT NOT NULL
	);

	-- FTS5 full-text search index. tokenize='unicode61' handles accents/unicode.
	-- We insert rows manually (no content= mirror) so we control the rowid.
	CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
		content,
		heading,
		tokenize = 'unicode61'
	);

	-- sqlite-vec vector table. FLOAT[384] = one 384-dim embedding per row.
	CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
		embedding FLOAT[384]
	);
`;

// ─── DB SETUP ─────────────────────────────────────────────────────────────────

/**
 * Open (or create) the SQLite database, load the sqlite-vec extension,
 * and apply the schema. Safe to call multiple times — all CREATE statements
 * are IF NOT EXISTS.
 *
 * WAL (Write-Ahead Logging) makes concurrent reads faster and is generally
 * the recommended journal mode for applications.
 */
export function openContextDb(dbPath: string): Database.Database {
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	sqliteVec.load(db); // registers the vec0 virtual table extension
	db.exec(SCHEMA);
	return db;
}

/** How many chunks are currently indexed. */
export function chunkCount(db: Database.Database): number {
	return (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
}

// ─── CHUNKING ─────────────────────────────────────────────────────────────────
//
// Why chunk at all? Embedding models have an input length limit (~512 tokens).
// Smaller chunks also give more precise search results — a 100-word passage
// is a better match than a 5000-word document.
//
// Strategy:
//   1. Split on markdown headings (# / ## / ### / ####) — each section = one chunk
//   2. If a section is still too long, split it further at blank lines (paragraphs)
//   3. Accumulate paragraphs greedily: keep adding until the next one would exceed
//      MAX_CHUNK_CHARS, then flush and start a new chunk

const MAX_CHUNK_CHARS = 900;

/**
 * Split a markdown string into chunks at heading boundaries,
 * further splitting large sections by paragraph.
 */
export function chunkMarkdown(content: string, file: string): Omit<Chunk, "id">[] {
	// Lookahead split: keep the heading line at the start of each part.
	// e.g. "# Intro\ntext\n## Section\nmore" → ["# Intro\ntext\n", "## Section\nmore"]
	const parts = content.split(/(?=^#{1,4} )/m);
	const chunks: Omit<Chunk, "id">[] = [];

	for (const part of parts) {
		const lines = part.split("\n");

		// Extract the heading text (strip the # characters), or empty string if none
		const heading = /^#{1,4} /.test(lines[0])
			? lines[0].replace(/^#{1,4} /, "").trim()
			: "";

		// The body is everything after the heading line
		const body = (heading ? lines.slice(1).join("\n") : part).trim();

		if (body.length < 30) continue; // skip trivially short sections

		if (body.length <= MAX_CHUNK_CHARS) {
			// Section fits in one chunk — keep it whole
			chunks.push({ file, heading, content: body });
		} else {
			// Section is too large — split by blank lines and accumulate greedily
			const paras = body.split(/\n{2,}/);
			let acc = "";
			for (const para of paras) {
				const next = acc ? `${acc}\n\n${para}` : para;
				if (acc && next.length > MAX_CHUNK_CHARS) {
					// Adding this paragraph would exceed the limit — flush current acc
					if (acc.trim().length >= 30) chunks.push({ file, heading, content: acc.trim() });
					acc = para; // start fresh with the current paragraph
				} else {
					acc = next; // keep accumulating
				}
			}
			if (acc.trim().length >= 30) chunks.push({ file, heading, content: acc.trim() });
		}
	}

	return chunks;
}

// ─── EMBEDDING ────────────────────────────────────────────────────────────────
//
// An embedding turns text into a list of numbers (a vector) that encodes meaning.
// Texts with similar meaning end up with vectors that are close together in space.
//
// Model: all-MiniLM-L6-v2
//   - Produces 384-dimensional vectors (384 numbers per text)
//   - Quantized version is ~23MB — small enough to run locally
//   - Downloaded once to ~/.cache/huggingface/hub/, then cached
//   - Outputs are L2-normalised: all vectors have length 1.
//     This means: cosine_similarity = 1 - L2_distance / 2
//     (identical → distance 0 → score 1.0; opposite → distance 2 → score 0.0)

const EMBEDDING_DIMS = 384;
const BATCH_SIZE = 32; // process 32 texts at a time to manage memory

// Module-level cache so we only load the model once per process
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
 *
 * pooling="mean" averages the token vectors into one vector per sentence.
 * normalize=true makes all vectors unit length (required for L2 → cosine math).
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
	const model = await loadExtractor();
	const results: Float32Array[] = [];
	for (let i = 0; i < texts.length; i += BATCH_SIZE) {
		const batch = texts.slice(i, i + BATCH_SIZE);
		const out = await model(batch, { pooling: "mean", normalize: true });
		// out.data is a flat Float32Array: [vec0[0..383], vec1[0..383], ...]
		// We slice it into individual 384-element arrays, one per input text
		for (let j = 0; j < batch.length; j++) {
			results.push(
				new Float32Array(out.data.slice(j * EMBEDDING_DIMS, (j + 1) * EMBEDDING_DIMS)),
			);
		}
	}
	return results;
}

// ─── INDEX BUILDING ───────────────────────────────────────────────────────────

// Recursively find all .md files under dir, skipping node_modules and dotfiles
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
 *
 * For each chunk we insert a row in all three tables with the same rowid:
 *   chunks     — the text
 *   chunks_vec — the embedding vector (as raw bytes)
 *   chunks_fts — the text again, for keyword search
 *
 * Everything is wrapped in a transaction so either all chunks land or none do.
 */
export async function buildIndex(
	rootDir: string,
	db: Database.Database,
	onProgress?: (msg: string) => void,
): Promise<number> {
	const log = onProgress ?? console.log;

	const files = await findMarkdownFiles(rootDir);
	log(`Found ${files.length} markdown files`);

	// Load the set of already-indexed file paths so we can skip them
	const indexed = new Set(
		(db.prepare("SELECT DISTINCT file FROM chunks").all() as { file: string }[]).map(
			(r) => r.file,
		),
	);

	const allChunks: Omit<Chunk, "id">[] = [];
	for (const file of files) {
		const rel = relative(rootDir, file); // store relative path so the db is portable
		if (indexed.has(rel)) continue;
		const content = await readFile(file, "utf-8");
		allChunks.push(...chunkMarkdown(content, rel));
	}

	if (allChunks.length === 0) {
		log("Nothing new to index");
		return 0;
	}
	log(`Chunking produced ${allChunks.length} new chunks`);

	// Prepend the heading before embedding so the model sees the section title.
	// Truncate to 512 chars — the model's effective input limit.
	const texts = allChunks.map((c) =>
		`${c.heading ? `${c.heading}: ` : ""}${c.content}`.slice(0, 512),
	);
	log(`Embedding ${allChunks.length} chunks…`);
	const embeddings = await embedTexts(texts);
	log("Embedding done");

	const insertChunk = db.prepare(
		"INSERT INTO chunks (file, heading, content) VALUES (?, ?, ?)",
	);
	// sqlite-vec requires the rowid to be bound as a BigInt — better-sqlite3
	// would otherwise pass it as a JS number (float), which sqlite-vec rejects.
	const insertVec = db.prepare(
		"INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
	);
	// FTS5 insert uses the same rowid so we can JOIN chunks_fts ↔ chunks by id
	const insertFts = db.prepare(
		"INSERT INTO chunks_fts (rowid, content, heading) VALUES (?, ?, ?)",
	);

	// Wrap in a transaction: ~10x faster than individual inserts, and atomic
	db.transaction(() => {
		for (let i = 0; i < allChunks.length; i++) {
			const c = allChunks[i];
			const { lastInsertRowid } = insertChunk.run(c.file, c.heading, c.content);
			const rowid = typeof lastInsertRowid === "bigint" ? lastInsertRowid : BigInt(lastInsertRowid);
			// Float32Array must be passed as a Buffer (raw bytes) for sqlite-vec
			insertVec.run(rowid, Buffer.from(embeddings[i].buffer));
			insertFts.run(rowid, c.content, c.heading);
		}
	})();

	return allChunks.length;
}

// ─── HYBRID SEARCH ────────────────────────────────────────────────────────────
//
// Why hybrid? Each method has blind spots:
//   - Vector search finds semantically related text even without exact words,
//     but can miss important keyword matches (e.g. function names, error codes).
//   - BM25 keyword search is great for exact terms but fails on paraphrases.
//   Combining them gives the best of both worlds.
//
// Score normalization — both scores are scaled to [0, 1] before blending:
//
//   vec_score  = 1 - distance/2
//     all-MiniLM L2-normalises its outputs so L2 distance ∈ [0, 2].
//     distance 0 → identical (score 1.0), distance 2 → opposite (score 0.0).
//
//   bm25_score = -bm25() / max(-bm25())
//     FTS5's bm25() returns negative values (more negative = better match).
//     We negate it, then divide by the best score in this result set → [0, 1].
//
//   hybrid = 0.7 × vec_score + 0.3 × bm25_score
//     Chunks only found by one method get 0 for the missing component.
//     Weights lean toward vector (semantic) search by default.

export const DEFAULT_VEC_WEIGHT = 0.7;
export const DEFAULT_BM25_WEIGHT = 0.3;
export const DEFAULT_CANDIDATES = 20; // how many results to fetch from each method before merging

/**
 * Convert a natural language query to an FTS5 MATCH expression.
 *
 * FTS5 has its own query syntax with special chars (", *, :, etc.).
 * We strip those and join individual words with OR so any matching word
 * counts as a hit — this maximises BM25 recall before the hybrid merge
 * applies precision via the vector score.
 *
 * Example: 'how does "compaction" work?' → 'how OR does OR compaction OR work'
 */
function toFtsQuery(raw: string): string {
	const words = raw
		.replace(/[^\w\s]/g, " ")
		.trim()
		.split(/\s+/)
		.filter((w) => w.length > 1);
	return words.length ? words.join(" OR ") : '""';
}

export type HybridSearchOptions = {
	limit?: number;      // max results to return (default 5)
	vecWeight?: number;  // weight for vector score (default 0.7)
	bm25Weight?: number; // weight for BM25 score  (default 0.3)
	candidates?: number; // how many candidates each method fetches (default 20)
};

/**
 * Search the index with hybrid vector + BM25 scoring.
 *
 * Steps:
 *   1. Embed the query using the same model as the index
 *   2. Run vector KNN search  → top-N by embedding distance
 *   3. Run BM25 keyword search → top-N by full-text rank
 *   4. Merge both result sets into a map keyed by chunk id
 *   5. Normalise scores and compute hybrid = vecWeight*vec + bm25Weight*bm25
 *   6. Sort descending and return the top `limit` results
 *
 * @param db      - database returned by openContextDb()
 * @param query   - natural language query string
 * @param options - limit (default 5), weights, candidates
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

	// Step 1: embed the query — same model, same space as the stored embeddings
	const [queryVec] = await embedTexts([query]);
	const queryBuf = Buffer.from(queryVec.buffer);

	// Step 2: vector KNN search
	// sqlite-vec's MATCH operator finds the nearest neighbours by L2 distance.
	// Lower distance = more similar. We fetch more candidates than we'll return
	// so the merge step has a larger pool to work with.
	const vecRows = db
		.prepare(
			`SELECT rowid AS chunk_id, distance
			 FROM   chunks_vec
			 WHERE  embedding MATCH ?
			 ORDER  BY distance
			 LIMIT  ?`,
		)
		.all(queryBuf, candidates) as { chunk_id: number; distance: number }[];

	// Step 3: BM25 full-text search
	// bm25() is a built-in FTS5 function — it returns more negative values for
	// better matches, which is why we negate it when normalising.
	// We JOIN to chunks so we get the text content in the same query.
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

	// Step 4: normalise BM25 scores to [0, 1]
	// maxBm25 is the best (highest negated) score; all others are divided by it.
	// 1e-9 prevents division by zero if bm25Rows is empty.
	const maxBm25 = Math.max(...bm25Rows.map((r) => -r.rank), 1e-9);

	// Step 5: merge into a map keyed by chunk id
	// Start by populating from vector results, then layer in BM25 results.
	// A chunk found only by vectors gets bm25Score=0 and vice versa.
	const map = new Map<
		number,
		{ vecScore: number; bm25Score: number; distance: number; chunk?: Chunk }
	>();

	for (const v of vecRows) {
		map.set(v.chunk_id, {
			vecScore: Math.max(0, 1 - v.distance / 2), // convert L2 distance → [0,1]
			bm25Score: 0,
			distance: v.distance,
		});
	}

	for (const b of bm25Rows) {
		const entry = map.get(b.id);
		const bm25Score = -b.rank / maxBm25; // negate and normalise
		if (entry) {
			// Chunk appeared in both searches — add BM25 score to existing entry
			entry.bm25Score = bm25Score;
			entry.chunk = b; // BM25 query already JOINed the chunk text
		} else {
			// Chunk only appeared in BM25 — add a new entry with vecScore=0
			map.set(b.id, { vecScore: 0, bm25Score, distance: 2, chunk: b });
		}
	}

	// Step 5b: load chunk text for entries that only appeared in vector results
	// (they weren't hydrated by the BM25 JOIN above)
	const getChunk = db.prepare(
		"SELECT id, file, heading, content FROM chunks WHERE id = ?",
	);
	for (const [id, e] of map) {
		if (!e.chunk) e.chunk = getChunk.get(id) as Chunk;
	}

	// Step 6: compute hybrid score, sort, and return top `limit` results
	return [...map.values()]
		.filter((e) => e.chunk != null)
		.map((e) => ({
			chunk: e.chunk!,
			vecScore: e.vecScore,
			bm25Score: e.bm25Score,
			distance: e.distance,
			hybridScore: vecWeight * e.vecScore + bm25Weight * e.bm25Score,
		}))
		.sort((a, b) => b.hybridScore - a.hybridScore) // descending
		.slice(0, limit);
}
