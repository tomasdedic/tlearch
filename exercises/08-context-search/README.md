# 08 — Context Search

Hybrid search library combining vector (KNN) and BM25 full-text scoring over
markdown files, stored in SQLite via `sqlite-vec` and `FTS5`.

## Files

- `context-search.ts` — reusable library (`openContextDb`, `buildIndex`, `hybridSearch`)
- `demo.ts` — runnable demo with preset queries and interactive search

## Running

**Default demo — runs 4 preset queries:**
```bash
npm run ex exercises/08-context-search/demo.ts
```

**Single custom query:**
```bash
npm run ex exercises/08-context-search/demo.ts -- --query "how does compaction work"
```

**Force full re-index (delete DB and rebuild):**
```bash
npm run ex exercises/08-context-search/demo.ts -- --rebuild
```

## First run

1. The embedding model (`all-MiniLM-L6-v2`, ~23MB) downloads to `~/.cache/huggingface/hub/` once
2. All `.md` files under the current directory are chunked and embedded
3. A `.context-search.db` SQLite file is created in the working directory

Subsequent runs reuse the existing DB. After the demo queries, an interactive
search prompt is available when stdin is a TTY.

> Run from the project root so `ROOT_DIR = "."` scans the full repo.

## Output format

```
#1  hybrid=87%  vec=91% d=0.181  bm25=76%
    exercises/08-context-search/context-search.ts > Hybrid Search
    Score normalization: vec_score = 1 - distance/2 ...
```

- `hybrid` — weighted score: `0.7 * vec + 0.3 * bm25`
- `vec` — cosine similarity from L2-normalised embeddings
- `d` — raw L2 distance (lower = more similar)
- `bm25` — normalised BM25 full-text rank

## Using as an agent tool

See the commented `searchContextTool` example at the bottom of `demo.ts` for
how to wire this into an agent registered tool.
