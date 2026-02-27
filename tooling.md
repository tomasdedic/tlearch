# TypeScript Tooling

## Runtime

| Tool | What it does | Used in pi-mono |
|------|-------------|-----------------|
| **tsx** | Runs `.ts` files directly — no build step. Uses esbuild internally. Dev only. | Yes — `./pi-test.sh` |
| **tsgo** | Faster TypeScript compiler (Go rewrite of tsc). Drop-in for `tsc`. | Yes — builds |
| **ts-node** | Older alternative to tsx. Slower, CommonJS-focused. | No |
| **bun** | JS runtime with built-in TS support + package manager. Faster than Node for scripts. | No |

## Compiling / Building

| Tool | What it does |
|------|-------------|
| **tsc** | Official TypeScript compiler. Slow but stable. |
| **tsgo** | ~10x faster `tsc` rewrite in Go (beta but used in pi-mono). |
| **esbuild** | Extremely fast bundler. Strips types, no type checking. |
| **swc** | Rust-based transpiler. Used by Next.js, Vite internally. |
| **tsup** | Wraps esbuild with good defaults for libraries (CJS + ESM output). |

## Linting / Formatting

| Tool | What it does | Used in pi-mono |
|------|-------------|-----------------|
| **Biome** | Linter + formatter in one, written in Rust. Replaces ESLint + Prettier. Very fast. | Yes — `biome.json` |
| **ESLint** | The classic JS/TS linter. Highly configurable but slow. | No |
| **Prettier** | The classic formatter. Often paired with ESLint. | No |

## Testing

| Tool | What it does | Used in pi-mono |
|------|-------------|-----------------|
| **Vitest** | Modern test runner. ES modules native. Same API as Jest. Fast. | Yes |
| **Jest** | Classic test runner. Needs config for ESM. | No |
| **node:test** | Built-in Node.js test runner (no install needed). | Yes (tui package) |

## Key tsconfig.json options

```jsonc
{
  "target": "ES2022",           // JS version to output — gives async iterators, structuredClone, etc.
  "module": "Node16",           // How imports work — Node16 enforces .js extensions in ESM
  "moduleResolution": "Node16", // How TypeScript finds modules — must match module
  "strict": true,               // Enables: noImplicitAny, strictNullChecks, etc. Always use this.
  "esModuleInterop": true,      // Allows default imports: import Anthropic from "@anthropic-ai/sdk"
  "skipLibCheck": true,         // Skips type-checking .d.ts in node_modules (speeds up tsc)
  "declarationMap": true,       // Lets IDEs jump to TS source instead of .d.ts
  "sourceMap": true,            // Maps compiled JS back to TS for debugger stack traces
}
```

## ESM and "module": "Node16"

With Node16/ESM, imports need explicit `.js` extensions even for TypeScript files:

```typescript
import { thing } from "./utils.js"; // NOT "./utils" or "./utils.ts"
// tsx and tsgo resolve this to the actual .ts file at dev time
```

This is why pi-mono uses `"type": "module"` in `package.json` and `.js` extensions in all imports.

## This project's setup

```
npm run ex <file>   run a TypeScript file with tsx
npm run check       lint with biome
npm run format      format with biome
```
