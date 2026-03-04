/**
 * side-agents.ts — Pi extension for managing parallel background coding agents.
 *
 * High-level architecture:
 *   1. PARENT SESSION  — the Pi session where the user types /agent or calls agent-start.
 *      It allocates a git worktree, spawns a new tmux window, launches a child Pi process
 *      inside that window, and tracks the agent in a shared JSON registry.
 *   2. CHILD SESSION   — the Pi process running inside the tmux window.
 *      It reads the kickoff prompt written by the parent, performs work, then signals
 *      "waiting_user" when it needs review or is done.
 *   3. REGISTRY        — a single JSON file (.pi/side-agents/registry.json) shared by parent
 *      and child. Writes are serialized through a file lock so concurrent mutations are safe.
 *   4. RUNTIME DIR     — per-agent directory (.pi/side-agents/runtime/<id>/) holding the
 *      kickoff prompt, backlog log, exit marker, and launch script.
 *   5. STATUS POLLER   — a 2.5 s setInterval in the parent that refreshes the registry,
 *      updates the status-line widget, and emits toast messages on state transitions.
 *
 * Agent status state machine:
 *   allocating_worktree -> spawning_tmux -> running -> waiting_user  (happy path)
 *                                                   -> finishing -> (done, auto-pruned)
 *                                                   -> failed / crashed
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";


// ---------------------------------------------------------------------------
// Environment variable names
// The parent sets these before spawning the child's launch script so the child
// Pi process can locate the shared registry, identify itself, and find its own
// runtime directory without any command-line arguments.
// ---------------------------------------------------------------------------
const ENV_STATE_ROOT = "PI_SIDE_AGENTS_ROOT";      // path to git/state root
const ENV_AGENT_ID = "PI_SIDE_AGENT_ID";           // child's own agent id
const ENV_PARENT_SESSION = "PI_SIDE_PARENT_SESSION"; // parent's session file
const ENV_PARENT_REPO = "PI_SIDE_PARENT_REPO";     // parent's git repo root
const ENV_RUNTIME_DIR = "PI_SIDE_RUNTIME_DIR";     // child's runtime dir

// ---------------------------------------------------------------------------
// Registry / message-bus constants
// ---------------------------------------------------------------------------
const STATUS_KEY = "side-agents";           // key used for the Pi status-line widget
const REGISTRY_VERSION = 1;                 // bump if the registry schema changes
const CHILD_LINK_ENTRY_TYPE = "side-agent-link";     // session entry type the child appends
const STATUS_UPDATE_MESSAGE_TYPE = "side-agent-status"; // toast/follow-up message type
const PROMPT_UPDATE_MESSAGE_TYPE = "side-agent-prompt"; // kickoff prompt message type

// System prompt used when generating a context summary to prepend to the child's kickoff prompt.
// The LLM is asked to distil only what is relevant from the parent conversation; if nothing
// applies it must reply "NONE" so we can skip the summary entirely (see normalizeGeneratedSummary).
const SUMMARY_SYSTEM_PROMPT = `You are writing a minimal handoff summary for a background coding agent.

Use the parent conversation only as context. Include only details that are directly relevant to the child task.

If the parent conversation is unrelated to the child task, output exactly:
NONE

Preferred content (but only when relevant):
- objective/constraints already established
- decisions already made
- key files/components to inspect
- risks/caveats`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * All possible states an agent record can be in.
 * Transitions happen in two places:
 *   - Parent side: startAgent() drives allocating_worktree -> spawning_tmux -> running.
 *     The status poller detects tmux window gone -> crashed, or exit file present -> done/failed.
 *   - Child side: Pi event hooks (agent_start / agent_end) write running / waiting_user
 *     back into the shared registry via setChildRuntimeStatus().
 */
type AgentStatus =
  | "allocating_worktree"   // parent is setting up the git worktree
  | "spawning_tmux"         // parent is creating the tmux window
  | "starting"              // tmux window exists but child Pi hasn't emitted agent_start yet
  | "running"               // child Pi is actively processing a turn
  | "waiting_user"          // child Pi finished a turn and is waiting for user/parent input
  | "finishing"             // child is in the merge/finish flow
  | "waiting_merge_lock"    // child is waiting to acquire the merge lock
  | "retrying_reconcile"    // child is retrying a reconcile step after a conflict
  | "done"                  // child exited with code 0 (auto-pruned from registry)
  | "failed"                // child exited with non-zero code
  | "crashed";              // tmux window disappeared without an exit marker

// Used by normalizeWaitStates() to validate user-supplied status strings.
// "done" is intentionally excluded: done agents are immediately pruned from the registry,
// so polling for "done" would never match — use the agent's absence as the signal instead.
const ALL_AGENT_STATUSES: AgentStatus[] = [
  "allocating_worktree",
  "spawning_tmux",
  "starting",
  "running",
  "waiting_user",
  "finishing",
  "waiting_merge_lock",
  "retrying_reconcile",
  "failed",
  "crashed",
];

// Default states agent-wait-any polls for: the three states where the parent
// needs to act (review, debug, or clean up a crash).
const DEFAULT_WAIT_STATES: AgentStatus[] = ["waiting_user", "failed", "crashed"];

/**
 * A single agent's persisted record inside registry.json.
 * Fields are added incrementally during startup: the record is first written
 * with just id/task/status, then enriched with worktree/tmux details as each
 * step of startAgent() completes.  This allows the poller to surface partial
 * state even if the parent crashes mid-startup.
 */
type AgentRecord = {
  id: string;                    // kebab-case slug, also the branch name suffix
  parentSessionId?: string;      // session file of the parent Pi that spawned this agent
  childSessionId?: string;       // session file of the child Pi (set on agent_start)
  tmuxSession?: string;          // tmux session name (e.g. "main")
  tmuxWindowId?: string;         // stable tmux window id (e.g. "@3"), used for send/kill
  tmuxWindowIndex?: number;      // human-readable window number shown in status line
  worktreePath?: string;         // absolute path to the git worktree directory
  branch?: string;               // git branch name ("side-agent/<id>")
  model?: string;                // model spec passed to the child ("provider/modelId")
  task: string;                  // raw task description from the user
  status: AgentStatus;
  startedAt: string;             // ISO-8601 timestamp
  updatedAt: string;             // ISO-8601 timestamp of last status mutation
  finishedAt?: string;           // ISO-8601 timestamp when the exit file was observed
  runtimeDir?: string;           // absolute path to the per-agent runtime directory
  logPath?: string;              // path to the tmux pipe-pane backlog file
  promptPath?: string;           // path to the kickoff prompt file read by launch.sh
  exitFile?: string;             // path to exit.json written by launch.sh on completion
  exitCode?: number;             // numeric exit code from the child Pi process
  error?: string;                // human-readable error message for failed/crashed agents
  warnings?: string[];           // non-fatal warnings accumulated during startup
};

type RegistryFile = {
  version: 1;
  agents: Record<string, AgentRecord>;
};

type AllocateWorktreeResult = {
  worktreePath: string;
  slotIndex: number;
  branch: string;
  warnings: string[];
};

type StartAgentParams = {
  task: string;
  branchHint?: string;
  model?: string;
  includeSummary: boolean;
};

type StartAgentResult = {
  id: string;
  tmuxWindowId: string;
  tmuxWindowIndex: number;
  worktreePath: string;
  branch: string;
  warnings: string[];
  prompt: string;
};

type PrepareRuntimeDirResult = {
  runtimeDir: string;
  archivedRuntimeDir?: string;
  warning?: string;
};

type ExitMarker = {
  exitCode?: number;
  finishedAt?: string;
};

type CommandResult = {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type StatusTransitionNotice = {
  id: string;
  fromStatus: AgentStatus;
  toStatus: AgentStatus;
  tmuxWindowIndex?: number;
};

type AgentStatusSnapshot = {
  status: AgentStatus;
  tmuxWindowIndex?: number;
};

// ---------------------------------------------------------------------------
// Module-level status-poller state
// These are intentionally module-level (not per-call) because there is only
// ever one parent Pi process per repository, and the poller must survive across
// multiple command invocations within the same Pi session.
// ---------------------------------------------------------------------------
let statusPollTimer: NodeJS.Timeout | undefined;       // handle for clearInterval if ever needed
let statusPollContext: ExtensionContext | undefined;    // refreshed on every session_start/switch
let statusPollApi: ExtensionAPI | undefined;           // refreshed on every session_start/switch
let statusPollInFlight = false;                        // guard to prevent overlapping poll ticks
// Per-stateRoot snapshot of the last known status for each agent.
// Used by collectStatusTransitions() to diff current vs previous state and
// emit toast notifications only when something actually changed.
const statusSnapshotsByStateRoot = new Map<string, Map<string, AgentStatusSnapshot>>();
let lastRenderedStatusLine: string | undefined;  // skip setStatus() if the line hasn't changed

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveNow) => setTimeout(resolveNow, ms));
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function emptyRegistry(): RegistryFile {
  return {
    version: REGISTRY_VERSION,
    agents: {},
  };
}

function isTerminalStatus(status: AgentStatus): boolean {
  return status === "done" || status === "failed" || status === "crashed";
}

// ---------------------------------------------------------------------------
// Text-processing constants and regexes
// ---------------------------------------------------------------------------

const PROMPT_LOG_PREFIX = "[side-agent][prompt]";  // marker written into backlog.log for prompt lines

// Caps for backlog text returned to the LLM (agent-check / agent-wait-any).
// Keeping output small avoids inflating token counts when the parent polls frequently.
const TASK_PREVIEW_MAX_CHARS = 220;
const BACKLOG_LINE_MAX_CHARS = 240;
const BACKLOG_TOTAL_MAX_CHARS = 2400;
const TMUX_BACKLOG_CAPTURE_LINES = 300; // how many lines to ask tmux to capture from scrollback

// Lines that are purely decorative separators are filtered out of backlog output.
const BACKLOG_SEPARATOR_RE = /^[-─—_=]{5,}$/u;

// Strip terminal escape sequences before storing or returning backlog text.
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;  // CSI sequences (colors, cursor movement, etc.)
const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g; // OSC sequences (window title, hyperlinks, etc.)
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // non-printable control characters

// Caps applied to the LLM-generated context summary.
const SUMMARY_MAX_LINES = 10;
const SUMMARY_MAX_CHARS = 700;
// Patterns the LLM might use to say "nothing relevant" — all treated as empty summary.
const SUMMARY_NONE_RE = /^(?:none|n\/a|no relevant context(?: from parent session)?\.?|unrelated)\s*$/i;

// ---------------------------------------------------------------------------
// Backlog helpers — reading and writing the tmux pipe-pane log file
// ---------------------------------------------------------------------------

/**
 * Resolves the backlog log path for a record using the most specific available
 * field.  Falls back through: logPath -> runtimeDir -> computed path.
 * This three-tier fallback is needed because during startAgent() the record is
 * written to the registry before all fields are populated.
 */
function resolveBacklogPathForRecord(stateRoot: string, record: AgentRecord): string {
  if (record.logPath) return record.logPath;
  if (record.runtimeDir) return join(record.runtimeDir, "backlog.log");
  return join(getRuntimeDir(stateRoot, record.id), "backlog.log");
}

/**
 * Writes the kickoff prompt into the agent's backlog log file so that
 * agent-check can surface the initial task alongside live tmux output.
 *
 * Step 1: Resolve where to write (using the tiered fallback above).
 * Step 2: Wrap each line with a structured prefix so log parsers and humans
 *         can identify the prompt block even when mixed with tmux output.
 * Step 3: Append atomically (fs.appendFile is O_APPEND safe on POSIX).
 * Step 4: Back-fill logPath / runtimeDir on the record if they were missing,
 *         so subsequent calls can find the file without recomputing the path.
 * Errors are silently swallowed — prompt logging is best-effort and must never
 * block or fail the agent startup sequence.
 */
async function appendKickoffPromptToBacklog(
  stateRoot: string,
  record: AgentRecord,
  prompt: string,
  loggedAt = nowIso(),
): Promise<void> {
  const backlogPath = resolveBacklogPathForRecord(stateRoot, record);
  const promptLines = prompt.replace(/\r\n?/g, "\n").split("\n");
  const body = promptLines
    .map((line) => `${PROMPT_LOG_PREFIX} ${loggedAt} ${record.id}: ${line}`)
    .join("\n");
  const payload =
    `${PROMPT_LOG_PREFIX} ${loggedAt} ${record.id}: kickoff prompt begin\n` +
    `${body}\n` +
    `${PROMPT_LOG_PREFIX} ${loggedAt} ${record.id}: kickoff prompt end\n`;

  try {
    await ensureDir(dirname(backlogPath));
    await fs.appendFile(backlogPath, payload, "utf8");
    record.logPath = record.logPath ?? backlogPath;
    record.runtimeDir = record.runtimeDir ?? dirname(backlogPath);
  } catch {
    // Best effort only; prompt logging must not block agent startup.
  }
}

async function setRecordStatus(_stateRoot: string, record: AgentRecord, nextStatus: AgentStatus): Promise<boolean> {
  const previousStatus = record.status;
  if (previousStatus === nextStatus) return false;

  record.status = nextStatus;
  record.updatedAt = nowIso();
  return true;
}

function statusShort(status: AgentStatus): string {
  switch (status) {
    case "allocating_worktree":
      return "alloc";
    case "spawning_tmux":
      return "tmux";
    case "starting":
      return "start";
    case "running":
      return "run";
    case "waiting_user":
      return "wait";
    case "finishing":
      return "finish";
    case "waiting_merge_lock":
      return "lock";
    case "retrying_reconcile":
      return "retry";
    case "done":
      return "done";
    case "failed":
      return "fail";
    case "crashed":
      return "crash";
  }
}

function statusColorRole(status: AgentStatus): "warning" | "muted" | "accent" | "error" {
  switch (status) {
    // Rare/transient states: highlight so they stand out.
    case "allocating_worktree":
    case "spawning_tmux":
    case "starting":
    case "waiting_merge_lock":
    case "retrying_reconcile":
      return "warning";
    // Normal working states: keep low visual weight.
    case "running":
    case "finishing":
    case "done":
      return "muted";
    // Needs user attention.
    case "waiting_user":
      return "accent";
    // Terminal failure.
    case "failed":
    case "crashed":
      return "error";
  }
}

function stripTerminalNoise(text: string): string {
  return text.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "").replace(/\r/g, "").replace(CONTROL_RE, "");
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Cleans and validates the raw text returned by the LLM summary call.
 *
 * Step 1: Strip terminal noise (ANSI escapes) and trim whitespace.
 * Step 2: Unwrap optional markdown code fence the LLM may have added.
 * Step 3: Reject responses that mean "nothing relevant" (SUMMARY_NONE_RE).
 * Step 4: Collapse consecutive blank lines to single blanks and cap at
 *         SUMMARY_MAX_LINES to keep the summary tight.
 * Step 5: Truncate the final string to SUMMARY_MAX_CHARS and return.
 *         Returns "" if the summary is empty or a "none" variant.
 */
function normalizeGeneratedSummary(raw: string): string {
  const cleaned = stripTerminalNoise(raw).trim();
  if (!cleaned) return "";

  // Unwrap ```markdown ... ``` or ``` ... ``` fences if present.
  const fenced = cleaned.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i);
  const unfenced = (fenced ? fenced[1] : cleaned).trim();
  if (!unfenced) return "";
  if (SUMMARY_NONE_RE.test(unfenced)) return "";

  // Collapse consecutive blank lines and enforce line limit.
  const compactLines: string[] = [];
  let previousBlank = false;
  for (const rawLine of unfenced.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    const blank = line.trim().length === 0;
    if (blank) {
      if (previousBlank) continue;  // skip run of blanks after the first
      previousBlank = true;
    } else {
      previousBlank = false;
    }
    compactLines.push(line);
    if (compactLines.length >= SUMMARY_MAX_LINES) break;
  }

  const summary = compactLines.join("\n").trim();
  if (!summary || SUMMARY_NONE_RE.test(summary)) return "";
  return truncateWithEllipsis(summary, SUMMARY_MAX_CHARS);
}

function summarizeTask(task: string): string {
  const collapsed = stripTerminalNoise(task).replace(/\s+/g, " ").trim();
  return truncateWithEllipsis(collapsed, TASK_PREVIEW_MAX_CHARS);
}

function isBacklogSeparatorLine(line: string): boolean {
  return BACKLOG_SEPARATOR_RE.test(line.trim());
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line, i, arr) => !(i === arr.length - 1 && line.length === 0));
}

/**
 * Collects the most recent `minimumLines` non-blank, non-separator lines from
 * the tail of the array, then reverses them back to chronological order.
 *
 * Why scan backwards?  The backlog file may be very long (full tmux scrollback).
 * Walking from the end avoids reading the entire array when we only need the tail.
 */
function collectRecentBacklogLines(lines: string[], minimumLines: number): string[] {
  if (minimumLines <= 0) return [];

  const selected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cleaned = stripTerminalNoise(lines[i]).trimEnd();
    if (cleaned.length === 0) continue;         // skip blank lines
    if (isBacklogSeparatorLine(cleaned)) continue; // skip decorative separators
    selected.push(lines[i]);                    // keep original (with ANSI), sanitize later
    if (selected.length >= minimumLines) break;
  }

  return selected.reverse(); // restore chronological order
}

function selectBacklogTailLines(text: string, minimumLines: number): string[] {
  return collectRecentBacklogLines(splitLines(text), minimumLines);
}

/**
 * Sanitizes a list of raw backlog lines for safe LLM consumption:
 *
 * Step 1: Strip ANSI escapes and control characters from each line.
 * Step 2: Skip blank lines and decorative separators.
 * Step 3: Truncate each line to BACKLOG_LINE_MAX_CHARS to prevent any single
 *         long line from consuming the whole budget.
 * Step 4: Accumulate lines while the total character budget (BACKLOG_TOTAL_MAX_CHARS)
 *         allows.  When the budget is nearly exhausted, truncate the last line
 *         rather than dropping it entirely.
 */
function sanitizeBacklogLines(lines: string[]): string[] {
  const out: string[] = [];
  let remaining = BACKLOG_TOTAL_MAX_CHARS;

  for (const raw of lines) {
    if (remaining <= 0) break;
    const cleaned = stripTerminalNoise(raw).trimEnd();
    if (cleaned.length === 0) continue;
    if (isBacklogSeparatorLine(cleaned)) continue;

    const line = truncateWithEllipsis(cleaned, BACKLOG_LINE_MAX_CHARS);
    if (line.length <= remaining) {
      out.push(line);
      remaining -= line.length + 1; // +1 accounts for the newline when joined
      continue;
    }

    // Budget only covers a partial line — truncate and stop.
    out.push(truncateWithEllipsis(line, remaining));
    remaining = 0;
    break;
  }

  return out;
}

function normalizeWaitStates(input?: string[]): { values: AgentStatus[]; error?: string } {
  if (!input || input.length === 0) {
    return { values: DEFAULT_WAIT_STATES };
  }

  const trimmed = [...new Set(input.map((value) => value.trim()).filter(Boolean))];
  if (trimmed.length === 0) {
    return { values: DEFAULT_WAIT_STATES };
  }

  const known = new Set<AgentStatus>(ALL_AGENT_STATUSES);
  const invalid = trimmed.filter((value) => !known.has(value as AgentStatus));
  if (invalid.length > 0) {
    return {
      values: [],
      error: `Unknown status value(s): ${invalid.join(", ")}`,
    };
  }

  return {
    values: trimmed as AgentStatus[],
  };
}

function tailLines(text: string, count: number): string[] {
  return splitLines(text).slice(-count);
}

function run(command: string, args: string[], options?: { cwd?: string; input?: string }): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    input: options?.input,
    encoding: "utf8",
  });

  if (result.error) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error.message,
    };
  }

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runOrThrow(command: string, args: string[], options?: { cwd?: string; input?: string }): CommandResult {
  const result = run(command, args, options);
  if (!result.ok) {
    const reason = result.error ? `error=${result.error}` : `exit=${result.status}`;
    throw new Error(`Command failed: ${command} ${args.join(" ")} (${reason})\n${result.stderr || result.stdout}`.trim());
  }
  return result;
}

function resolveGitRoot(cwd: string): string {
  const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (result.ok) {
    const root = result.stdout.trim();
    if (root.length > 0) return resolve(root);
  }
  return resolve(cwd);
}

function getStateRoot(ctx: ExtensionContext): string {
  const fromEnv = process.env[ENV_STATE_ROOT];
  if (fromEnv) return resolve(fromEnv);
  return resolveGitRoot(ctx.cwd);
}

function getMetaDir(stateRoot: string): string {
  return join(stateRoot, ".pi", "side-agents");
}

function getRegistryPath(stateRoot: string): string {
  return join(getMetaDir(stateRoot), "registry.json");
}

function getRegistryLockPath(stateRoot: string): string {
  return join(getMetaDir(stateRoot), "registry.lock");
}

function getRuntimeDir(stateRoot: string, agentId: string): string {
  return join(getMetaDir(stateRoot), "runtime", agentId);
}

function getRuntimeArchiveBaseDir(stateRoot: string, agentId: string): string {
  return join(getMetaDir(stateRoot), "runtime-archive", agentId);
}

function runtimeArchiveStamp(): string {
  return nowIso().replace(/[:.]/g, "-");
}

async function prepareFreshRuntimeDir(stateRoot: string, agentId: string): Promise<PrepareRuntimeDirResult> {
  const runtimeDir = getRuntimeDir(stateRoot, agentId);
  if (!(await fileExists(runtimeDir))) {
    await ensureDir(runtimeDir);
    return { runtimeDir };
  }

  const archiveBaseDir = getRuntimeArchiveBaseDir(stateRoot, agentId);
  const archiveDir = join(
    archiveBaseDir,
    `${runtimeArchiveStamp()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
  );

  try {
    await ensureDir(archiveBaseDir);
    await fs.rename(runtimeDir, archiveDir);
    await ensureDir(runtimeDir);
    return {
      runtimeDir,
      archivedRuntimeDir: archiveDir,
    };
  } catch (archiveErr) {
    const archiveErrMessage = stringifyError(archiveErr);
    try {
      await fs.rm(runtimeDir, { recursive: true, force: true });
      await ensureDir(runtimeDir);
    } catch (cleanupErr) {
      throw new Error(
        `Failed to prepare runtime dir ${runtimeDir}: archive failed (${archiveErrMessage}); cleanup failed (${stringifyError(cleanupErr)})`,
      );
    }

    return {
      runtimeDir,
      warning: `Failed to archive existing runtime dir for ${agentId}: ${archiveErrMessage}. Removed stale runtime directory instead.`,
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, path);
}

/**
 * Acquires an exclusive file lock, runs `fn`, then releases the lock.
 * Used to serialize all registry mutations (reads + writes) so concurrent
 * parent and child processes don't corrupt the JSON file.
 *
 * Locking mechanism (O_EXCL atomic create):
 *   Step 1: Try to create the lock file with O_EXCL (exclusive + create).
 *           Only one process succeeds; all others get EEXIST.
 *   Step 2: Write our pid and timestamp into the lock file for debugging.
 *   Step 3: Execute the critical section fn().
 *   Step 4: In the finally block, close and delete the lock file.
 *
 * Contention handling:
 *   - On EEXIST, check the lock file mtime.  If it is older than 30 s the
 *     previous owner likely crashed; delete the stale lock and retry immediately.
 *   - Otherwise back off with random jitter (40–120 ms) to reduce thundering-herd.
 *   - Give up after 10 s total wait and throw a timeout error.
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await ensureDir(dirname(lockPath));

  const started = Date.now();
  while (true) {
    try {
      // O_EXCL: fail if file already exists — this is the atomic lock acquire step.
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: nowIso() }) + "\n", "utf8");
      } catch {
        // best effort — failure here doesn't affect correctness
      }

      try {
        return await fn(); // critical section
      } finally {
        await handle.close().catch(() => { });
        await fs.unlink(lockPath).catch(() => { }); // release the lock
      }
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err; // unexpected error — propagate immediately

      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > 30_000) {
          // Stale lock (>30 s old): previous owner crashed — reclaim and retry.
          await fs.unlink(lockPath).catch(() => { });
          continue;
        }
      } catch {
        // Lock disappeared between our open and stat — retry immediately.
      }

      if (Date.now() - started > 10_000) {
        throw new Error(`Timed out waiting for lock ${lockPath}`);
      }
      // Randomized back-off to avoid multiple processes retrying in lock-step.
      await sleep(40 + Math.random() * 80);
    }
  }
}

async function loadRegistry(stateRoot: string): Promise<RegistryFile> {
  const registryPath = getRegistryPath(stateRoot);
  const parsed = await readJsonFile<RegistryFile>(registryPath);
  if (!parsed || typeof parsed !== "object") return emptyRegistry();
  if (parsed.version !== REGISTRY_VERSION || typeof parsed.agents !== "object" || parsed.agents === null) {
    return emptyRegistry();
  }
  return parsed;
}

async function saveRegistry(stateRoot: string, registry: RegistryFile): Promise<void> {
  const registryPath = getRegistryPath(stateRoot);
  await atomicWrite(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

/**
 * The canonical way to update the registry.  All reads and writes go through
 * this function so every mutation is automatically locked and written atomically.
 *
 * Step 1: Acquire the registry file lock.
 * Step 2: Load the latest registry from disk (not a cached copy) to pick up
 *         any mutations made by other processes since we last read it.
 * Step 3: Snapshot the registry as JSON before calling the mutator.
 * Step 4: Let the caller mutate the in-memory registry object freely.
 * Step 5: Re-serialize and compare.  Write to disk only when something changed
 *         to avoid unnecessary I/O and filesystem noise.
 * Step 6: Return the (possibly mutated) registry so callers can inspect it.
 */
async function mutateRegistry(stateRoot: string, mutator: (registry: RegistryFile) => Promise<void> | void): Promise<RegistryFile> {
  const lockPath = getRegistryLockPath(stateRoot);
  return withFileLock(lockPath, async () => {
    const registry = await loadRegistry(stateRoot);
    const before = JSON.stringify(registry);
    await mutator(registry);
    const after = JSON.stringify(registry);
    if (after !== before) {
      await saveRegistry(stateRoot, registry); // atomic rename-into-place
    }
    return registry;
  });
}

/** Sanitize a raw string into a kebab-case slug suitable for branch names and agent IDs. */
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 3)
    .join("-");
}

/** Turn a task description into a slug by taking the first 3 meaningful words. */
function slugFromTask(task: string): string {
  const stopWords = new Set(["a", "an", "the", "to", "in", "on", "at", "of", "for", "and", "or", "is", "it", "be", "do", "with"]);
  const words = task
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0 && !stopWords.has(w));
  const slug = words.slice(0, 3).join("-");
  return slug || "agent";
}

/** Generate a slug via LLM, falling back to heuristic extraction from task text. */
/**
 * Generates a short kebab-case slug for the agent id / branch name.
 * A good slug makes branches and tmux windows human-readable at a glance.
 *
 * Step 1: If no model is configured, fall back immediately to the heuristic
 *         (take the first 3 meaningful words from the task text).
 * Step 2: Ask the model for a 2-3 word kebab slug with a tiny token budget (30).
 * Step 3: Pass the raw response through sanitizeSlug() to strip non-slug chars.
 * Step 4: If the cleaned slug is empty (e.g. the LLM returned garbage), fall
 *         back to the heuristic and attach a warning so the caller can surface it.
 * Step 5: On any API error, fall back gracefully with a warning.
 *
 * The slug is later deduplicated against existing agent ids by appending -2, -3, …
 */
async function generateSlug(ctx: ExtensionContext, task: string): Promise<{ slug: string; warning?: string }> {
  if (!ctx.model) {
    return { slug: slugFromTask(task), warning: "No model available for slug generation; used heuristic fallback." };
  }

  try {
    const userMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: task,
        },
      ],
      timestamp: Date.now(),
    };

    const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
    const response = await complete(
      ctx.model,
      {
        systemPrompt:
          "Generate a 2-3 word kebab-case slug summarizing the given task. Reply with ONLY the slug, nothing else. Examples: fix-auth-leak, add-retry-logic, update-readme",
        messages: [userMessage],
      },
      { apiKey, maxTokens: 30 },
    );

    const raw = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const slug = sanitizeSlug(raw);
    if (slug) return { slug };

    return { slug: slugFromTask(task), warning: "LLM returned empty slug; used heuristic fallback." };
  } catch (err) {
    return {
      slug: slugFromTask(task),
      warning: `Slug generation failed: ${stringifyError(err)}. Used heuristic fallback.`,
    };
  }
}

/** Collect all agent IDs currently known in the registry or checked out as side-agent branches. */
function existingAgentIds(registry: RegistryFile, repoRoot: string): Set<string> {
  const ids = new Set<string>(Object.keys(registry.agents));

  const listed = run("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
  if (listed.ok) {
    for (const line of listed.stdout.split(/\r?\n/)) {
      if (!line.startsWith("branch ")) continue;
      const branchRef = line.slice("branch ".length).trim();
      if (!branchRef || branchRef === "(detached)") continue;
      const branch = branchRef.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : branchRef;
      if (branch.startsWith("side-agent/")) {
        ids.add(branch.slice("side-agent/".length));
      }
    }
  }

  return ids;
}

/** Deduplicate a slug against existing IDs by appending -2, -3, etc. */
function deduplicateSlug(slug: string, existing: Set<string>): string {
  if (!existing.has(slug)) return slug;
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

async function writeWorktreeLock(worktreePath: string, payload: Record<string, unknown>): Promise<void> {
  const lockPath = join(worktreePath, ".pi", "active.lock");
  await ensureDir(dirname(lockPath));
  await atomicWrite(lockPath, JSON.stringify(payload, null, 2) + "\n");
}

async function updateWorktreeLock(worktreePath: string, patch: Record<string, unknown>): Promise<void> {
  const lockPath = join(worktreePath, ".pi", "active.lock");
  const current = (await readJsonFile<Record<string, unknown>>(lockPath)) ?? {};
  await writeWorktreeLock(worktreePath, { ...current, ...patch });
}

async function cleanupWorktreeLockBestEffort(worktreePath?: string): Promise<void> {
  if (!worktreePath) return;
  const lockPath = join(worktreePath, ".pi", "active.lock");
  await fs.unlink(lockPath).catch(() => { });
}

function listRegisteredWorktrees(repoRoot: string): Set<string> {
  const result = runOrThrow("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const set = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      set.add(resolve(line.slice("worktree ".length).trim()));
    }
  }
  return set;
}

type WorktreeSlot = {
  index: number;
  path: string;
};

type OrphanWorktreeLock = {
  worktreePath: string;
  lockPath: string;
  lockAgentId?: string;
  lockPid?: number;
  lockTmuxWindowId?: string;
  blockers: string[];
};

type OrphanWorktreeLockScan = {
  reclaimable: OrphanWorktreeLock[];
  blocked: OrphanWorktreeLock[];
};

async function listWorktreeSlots(repoRoot: string): Promise<WorktreeSlot[]> {
  const parent = dirname(repoRoot);
  const prefix = `${basename(repoRoot)}-agent-worktree-`;
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d{4})$`);

  const entries = await fs.readdir(parent, { withFileTypes: true });
  const slots: WorktreeSlot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(re);
    if (!match) continue;
    const index = Number(match[1]);
    if (!Number.isFinite(index)) continue;
    slots.push({
      index,
      path: join(parent, entry.name),
    });
  }
  slots.sort((a, b) => a.index - b.index);
  return slots;
}

function parseOptionalPid(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function isPidAlive(pid?: number): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function summarizeOrphanLock(lock: OrphanWorktreeLock): string {
  const details: string[] = [];
  if (lock.lockAgentId) details.push(`agent:${lock.lockAgentId}`);
  if (lock.lockTmuxWindowId) details.push(`tmux:${lock.lockTmuxWindowId}`);
  if (lock.lockPid !== undefined) details.push(`pid:${lock.lockPid}`);
  if (details.length === 0) return lock.worktreePath;
  return `${lock.worktreePath} (${details.join(" ")})`;
}

async function scanOrphanWorktreeLocks(repoRoot: string, registry: RegistryFile): Promise<OrphanWorktreeLockScan> {
  const slots = await listWorktreeSlots(repoRoot);
  const reclaimable: OrphanWorktreeLock[] = [];
  const blocked: OrphanWorktreeLock[] = [];

  for (const slot of slots) {
    const lockPath = join(slot.path, ".pi", "active.lock");
    if (!(await fileExists(lockPath))) continue;

    const raw = (await readJsonFile<Record<string, unknown>>(lockPath)) ?? {};
    const lockAgentId = typeof raw.agentId === "string" ? raw.agentId : undefined;
    if (lockAgentId && registry.agents[lockAgentId]) {
      continue;
    }

    const lockPid = parseOptionalPid(raw.pid);
    const lockTmuxWindowId = typeof raw.tmuxWindowId === "string" ? raw.tmuxWindowId : undefined;

    const blockers: string[] = [];
    if (isPidAlive(lockPid)) {
      blockers.push(`pid ${lockPid} is still alive`);
    }
    if (lockTmuxWindowId && tmuxWindowExists(lockTmuxWindowId)) {
      blockers.push(`tmux window ${lockTmuxWindowId} is active`);
    }

    const candidate: OrphanWorktreeLock = {
      worktreePath: slot.path,
      lockPath,
      lockAgentId,
      lockPid,
      lockTmuxWindowId,
      blockers,
    };

    if (blockers.length > 0) {
      blocked.push(candidate);
    } else {
      reclaimable.push(candidate);
    }
  }

  return { reclaimable, blocked };
}

async function reclaimOrphanWorktreeLocks(locks: OrphanWorktreeLock[]): Promise<{
  removed: string[];
  failed: Array<{ lockPath: string; error: string }>;
}> {
  const removed: string[] = [];
  const failed: Array<{ lockPath: string; error: string }> = [];

  for (const lock of locks) {
    try {
      await fs.unlink(lock.lockPath);
      removed.push(lock.lockPath);
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      failed.push({ lockPath: lock.lockPath, error: stringifyError(err) });
    }
  }

  return { removed, failed };
}

async function syncParallelAgentPiFiles(parentRepoRoot: string, worktreePath: string): Promise<void> {
  const parentPiDir = join(parentRepoRoot, ".pi");
  if (!(await fileExists(parentPiDir))) return;

  const sourceEntries = await fs.readdir(parentPiDir, { withFileTypes: true });
  const names = sourceEntries
    .filter((entry) => entry.name.startsWith("side-agent-"))
    .map((entry) => entry.name);
  if (names.length === 0) return;

  const worktreePiDir = join(worktreePath, ".pi");
  await ensureDir(worktreePiDir);

  for (const name of names) {
    const source = join(parentPiDir, name);
    const target = join(worktreePiDir, name);

    let shouldLink = true;
    try {
      const st = await fs.lstat(target);
      if (st.isSymbolicLink()) {
        const existing = await fs.readlink(target);
        if (resolve(dirname(target), existing) === resolve(source)) {
          shouldLink = false;
        }
      }
      if (shouldLink) {
        await fs.rm(target, { recursive: true, force: true });
      }
    } catch {
      // missing target
    }

    if (shouldLink) {
      await fs.symlink(source, target);
    }
  }
}

/**
 * Finds or creates a git worktree for the new agent.
 *
 * Worktree slots are sibling directories next to the main repo named:
 *   <repo>-agent-worktree-0001, <repo>-agent-worktree-0002, …
 *
 * Step 1: Capture HEAD so the worktree starts from the exact same commit
 *         as the parent.  This ensures the agent always has a clean base.
 * Step 2: Scan existing slot directories in index order, looking for a slot
 *         that is free (no active.lock file, no uncommitted changes).
 *         - Locked slots: skip (another agent is using them).
 *         - Registered + dirty: skip with a warning (uncommitted work).
 *         - Registered + clean: reuse by resetting to HEAD and checking out
 *           the new branch.
 *         - Unregistered + empty: can be used immediately.
 * Step 3: If no existing slot is free, create the next numbered slot directory
 *         and register it as a new worktree with `git worktree add`.
 * Step 4: For a reused slot: abort any in-progress merge, hard-reset to HEAD,
 *         clean untracked files, then checkout the new branch.  Best-effort
 *         delete the old branch if it has been fully merged.
 * Step 5: Ensure the .pi directory exists in the worktree, symlink any
 *         side-agent-* files from the parent's .pi dir so both worktrees
 *         share the same extension configuration.
 * Step 6: Write the active.lock file to claim the slot.
 */
async function allocateWorktree(options: {
  repoRoot: string;
  stateRoot: string;
  agentId: string;
  parentSessionId?: string;
}): Promise<AllocateWorktreeResult> {
  const { repoRoot, stateRoot, agentId, parentSessionId } = options;

  const warnings: string[] = [];
  const branch = `side-agent/${agentId}`;
  // Capture HEAD once so every worktree operation in this call uses the same base commit.
  const mainHead = runOrThrow("git", ["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();

  const registry = await loadRegistry(stateRoot);
  const slots = await listWorktreeSlots(repoRoot);
  const registered = listRegisteredWorktrees(repoRoot);

  let chosen: WorktreeSlot | undefined;
  let maxIndex = 0;

  // --- Step 2: find a free slot ---
  for (const slot of slots) {
    maxIndex = Math.max(maxIndex, slot.index);
    const lockPath = join(slot.path, ".pi", "active.lock");

    if (await fileExists(lockPath)) {
      // Slot is locked — verify it belongs to a known agent, warn if orphaned.
      const lock = await readJsonFile<Record<string, unknown>>(lockPath);
      const lockAgentId = typeof lock?.agentId === "string" ? lock.agentId : undefined;
      if (!lockAgentId || !registry.agents[lockAgentId]) {
        warnings.push(`Locked worktree is not tracked in registry: ${slot.path}`);
      }
      continue; // in use, try next slot
    }

    const isRegistered = registered.has(resolve(slot.path));
    if (isRegistered) {
      // Slot is an existing git worktree — only reuse if it's clean.
      const status = run("git", ["-C", slot.path, "status", "--porcelain"]);
      if (!status.ok) {
        warnings.push(`Could not inspect unlocked worktree, skipping: ${slot.path}`);
        continue;
      }
      if (status.stdout.trim().length > 0) {
        warnings.push(`Unlocked worktree has local changes, skipping: ${slot.path}`);
        continue;
      }
    } else {
      // Slot directory exists but isn't a registered git worktree.
      // Only take it if empty (safety guard against unexpected files).
      const entries = await fs.readdir(slot.path).catch(() => []);
      if (entries.length > 0) {
        warnings.push(`Unlocked slot is not a registered worktree and not empty, skipping: ${slot.path}`);
        continue;
      }
    }

    chosen = slot; // found a usable slot
    break;
  }

  // --- Step 3: create a new slot if no existing one was free ---
  if (!chosen) {
    const next = maxIndex + 1 || 1;
    const parent = dirname(repoRoot);
    const name = `${basename(repoRoot)}-agent-worktree-${String(next).padStart(4, "0")}`;
    chosen = { index: next, path: join(parent, name) };
  }

  const chosenPath = chosen.path;
  const chosenRegistered = registered.has(resolve(chosenPath));

  if (chosenRegistered) {
    // --- Step 4a: recycle an existing worktree ---
    // Remember old branch so we can try to clean it up after switching away.
    const oldBranchResult = run("git", ["-C", chosenPath, "branch", "--show-current"]);
    const oldBranch = oldBranchResult.ok ? oldBranchResult.stdout.trim() : "";

    run("git", ["-C", chosenPath, "merge", "--abort"]);             // ignore error if no merge in progress
    runOrThrow("git", ["-C", chosenPath, "reset", "--hard", mainHead]); // discard any uncommitted changes
    runOrThrow("git", ["-C", chosenPath, "clean", "-fd"]);          // remove untracked files
    runOrThrow("git", ["-C", chosenPath, "checkout", "-B", branch, mainHead]); // create/reset branch

    // Best-effort cleanup: delete old branch if fully merged (-d, not -D).
    if (oldBranch && oldBranch !== branch) {
      run("git", ["-C", repoRoot, "branch", "-d", oldBranch]);
    }
  } else {
    // --- Step 4b: register a brand-new worktree ---
    if (await fileExists(chosenPath)) {
      const entries = await fs.readdir(chosenPath).catch(() => []);
      if (entries.length > 0) {
        throw new Error(`Cannot use worktree slot ${chosenPath}: directory exists and is not empty`);
      }
    }
    await ensureDir(dirname(chosenPath));
    runOrThrow("git", ["-C", repoRoot, "worktree", "add", "-B", branch, chosenPath, mainHead]);
  }

  // --- Steps 5 & 6: set up .pi dir, sync shared config, claim the lock ---
  await ensureDir(join(chosenPath, ".pi"));
  await syncParallelAgentPiFiles(repoRoot, chosenPath); // symlink side-agent-* config files
  await writeWorktreeLock(chosenPath, {
    agentId,
    sessionId: parentSessionId,
    parentSessionId,
    pid: process.pid,
    branch,
    startedAt: nowIso(),
  });

  return {
    worktreePath: chosenPath,
    slotIndex: chosen.index,
    branch,
    warnings,
  };
}

/**
 * Builds the kickoff prompt that will be written to kickoff.md and handed to
 * the child Pi process.
 *
 * Two modes:
 *   A) includeSummary = false  (used by the agent-start tool): return the raw
 *      task description as-is.  The caller is responsible for providing all
 *      context in the description parameter.
 *   B) includeSummary = true   (used by /agent command): augment the task with
 *      a condensed summary of the parent conversation so the child has context
 *      without receiving the entire (potentially huge) conversation history.
 *
 * Step 1: Early-exit if summary is disabled or no model is available.
 * Step 2: Extract only "message" entries from the current session branch
 *         (tool results, system events, etc. are excluded).
 * Step 3: Serialize the conversation into a flat text form suitable for the
 *         summarization prompt.
 * Step 4: Call the LLM with SUMMARY_SYSTEM_PROMPT to produce a terse handoff.
 * Step 5: Normalize and validate the response.  If the LLM says "NONE" or
 *         returns an empty string, fall back to the raw task.
 * Step 6: Assemble the final prompt: raw task + parent session path + summary.
 *         On any API error, fall back to the raw task with a warning.
 */
async function buildKickoffPrompt(ctx: ExtensionContext, task: string, includeSummary: boolean): Promise<{ prompt: string; warning?: string }> {
  const parentSession = ctx.sessionManager.getSessionFile();
  if (!includeSummary || !ctx.model) {
    return { prompt: task }; // mode A: no summary
  }

  // Step 2: collect parent conversation messages
  const branch = ctx.sessionManager.getBranch();
  const messages = branch
    .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
    .map((entry) => entry.message);

  if (messages.length === 0) {
    return { prompt: task }; // nothing to summarize
  }

  try {
    // Step 3: flatten conversation to text
    const llmMessages = convertToLlm(messages);
    const conversationText = serializeConversation(llmMessages);
    const userMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `## Parent conversation\n\n${conversationText}\n\n## Child task\n\n${task}`,
        },
      ],
      timestamp: Date.now(),
    };

    // Step 4: call the summarization model
    const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
    const response = await complete(
      ctx.model,
      { systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey },
    );

    // Step 5: clean and validate the summary
    const summary = normalizeGeneratedSummary(
      response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );

    if (!summary) {
      return { prompt: task }; // LLM said "NONE" or returned empty
    }

    // Step 6: assemble the enriched prompt
    const prompt = [
      task,
      "",
      "## Parent session",
      parentSession ? `- ${parentSession}` : "- (unknown)",
      "",
      "## Relevant parent context",
      summary,
    ].join("\n");

    return { prompt };
  } catch (err) {
    return {
      prompt: task,
      warning: `Failed to generate context summary: ${stringifyError(err)}. Started child with raw task only.`,
    };
  }
}

/**
 * Generates the bash launch script that runs inside the tmux window.
 *
 * The script is written to runtimeDir/launch.sh and executed via
 * `bash <path>` in the tmux pane.  It is self-contained (all variables
 * are embedded as shell-quoted literals) so it works even if the parent
 * process has exited.
 *
 * Script flow:
 *   Step 1: Set shell variables from the embedded constants.
 *   Step 2: Export environment variables so the child Pi process can locate
 *           the shared registry and identify itself (ENV_AGENT_ID, etc.).
 *   Step 3: Define write_exit() — writes a JSON exit marker to exitFile so
 *           the parent's status poller can detect completion and set the
 *           agent's final status to "done" or "failed".
 *   Step 4: cd into the worktree so all relative paths resolve correctly.
 *   Step 5: If .pi/side-agent-start.sh exists, run it first (setup hook).
 *           On non-zero exit: write the exit marker, pause for key press,
 *           then kill the tmux window.
 *   Step 6: Build the `pi` command, optionally adding --model and --skill flags.
 *   Step 7: Run `pi` with the kickoff prompt read from promptFile.
 *           set +e / set -e brackets capture the exit code without aborting
 *           the script on failure.
 *   Step 8: Write the exit marker with the actual exit code.
 *   Step 9: Print a human-readable status line, wait for key press (so the
 *           user can read any final output), then kill the tmux window.
 *
 * About exit codes:
 *   - 0  = success (agent completed its task cleanly)
 *   - Non-zero = the Pi process or start-hook failed
 *   The exit code is stored in exit.json and later read by refreshOneAgentRuntime()
 *   to set the registry record status to "done" (0) or "failed" (non-zero).
 */
function buildLaunchScript(params: {
  agentId: string;
  parentSessionId?: string;
  parentRepoRoot: string;
  stateRoot: string;
  worktreePath: string;
  tmuxWindowId: string;
  promptPath: string;
  exitFile: string;
  modelSpec?: string;
  runtimeDir: string;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail

AGENT_ID=${shellQuote(params.agentId)}
PARENT_SESSION=${shellQuote(params.parentSessionId ?? "")}
PARENT_REPO=${shellQuote(params.parentRepoRoot)}
STATE_ROOT=${shellQuote(params.stateRoot)}
WORKTREE=${shellQuote(params.worktreePath)}
WINDOW_ID=${shellQuote(params.tmuxWindowId)}
PROMPT_FILE=${shellQuote(params.promptPath)}
EXIT_FILE=${shellQuote(params.exitFile)}
MODEL_SPEC=${shellQuote(params.modelSpec ?? "")}
RUNTIME_DIR=${shellQuote(params.runtimeDir)}
START_SCRIPT=\"$WORKTREE/.pi/side-agent-start.sh\"
CHILD_SKILLS_DIR=\"$WORKTREE/.pi/side-agent-skills\"

export ${ENV_AGENT_ID}=\"$AGENT_ID\"
export ${ENV_PARENT_SESSION}=\"$PARENT_SESSION\"
export ${ENV_PARENT_REPO}=\"$PARENT_REPO\"
export ${ENV_STATE_ROOT}=\"$STATE_ROOT\"
export ${ENV_RUNTIME_DIR}=\"$RUNTIME_DIR\"

write_exit() {
  local code="$1"
  printf '{"exitCode":%d,"finishedAt":"%s"}\n' "$code" "$(date -Is)" > "$EXIT_FILE"
}

cd "$WORKTREE"

if [[ -x "$START_SCRIPT" ]]; then
  set +e
  "$START_SCRIPT" "$PARENT_REPO" "$WORKTREE" "$AGENT_ID"
  start_exit=$?
  set -e
  if [[ "$start_exit" -ne 0 ]]; then
    echo "[side-agent] start script failed with code $start_exit"
    write_exit "$start_exit"
    read -n 1 -s -r -p "[side-agent] Press any key to close this tmux window..." || true
    echo
    tmux kill-window -t "$WINDOW_ID" || true
    exit "$start_exit"
  fi
fi

PI_CMD=(pi)
if [[ -n "$MODEL_SPEC" ]]; then
  PI_CMD+=(--model "$MODEL_SPEC")
fi
if [[ -d "$CHILD_SKILLS_DIR" ]]; then
  # agent-setup writes the child-only finish skill here; load it explicitly.
  PI_CMD+=(--skill "$CHILD_SKILLS_DIR")
fi

set +e
"\${PI_CMD[@]}" "$(cat "$PROMPT_FILE")"
exit_code=$?
set -e

write_exit "$exit_code"

if [[ "$exit_code" -eq 0 ]]; then
  echo "[side-agent] Agent finished."
else
  echo "[side-agent] Agent exited with code $exit_code."
fi

read -n 1 -s -r -p "[side-agent] Press any key to close this tmux window..." || true
echo

tmux kill-window -t "$WINDOW_ID" || true
`;
}

function ensureTmuxReady(): void {
  const version = run("tmux", ["-V"]);
  if (!version.ok) {
    throw new Error("tmux is required for /agent but was not found or is not working");
  }

  const session = run("tmux", ["display-message", "-p", "#S"]);
  if (!session.ok) {
    throw new Error("/agent must be run from inside tmux (current tmux session was not detected)");
  }
}

function getCurrentTmuxSession(): string {
  const result = runOrThrow("tmux", ["display-message", "-p", "#S"]);
  const value = result.stdout.trim();
  if (!value) throw new Error("Failed to determine current tmux session");
  return value;
}

function createTmuxWindow(tmuxSession: string, name: string): { windowId: string; windowIndex: number } {
  const result = runOrThrow("tmux", [
    "new-window",
    "-d",
    "-t",
    `${tmuxSession}:`,
    "-P",
    "-F",
    "#{window_id} #{window_index}",
    "-n",
    name,
  ]);
  const out = result.stdout.trim();
  const [windowId, indexRaw] = out.split(/\s+/);
  const windowIndex = Number(indexRaw);
  if (!windowId || !Number.isFinite(windowIndex)) {
    throw new Error(`Unable to parse tmux window identity: ${out}`);
  }
  return { windowId, windowIndex };
}

function tmuxWindowExists(windowId: string): boolean {
  const result = run("tmux", ["display-message", "-p", "-t", windowId, "#{window_id}"]);
  return result.ok && result.stdout.trim() === windowId;
}

function tmuxPipePaneToFile(windowId: string, logPath: string): void {
  runOrThrow("tmux", ["pipe-pane", "-t", windowId, "-o", `cat >> ${shellQuote(logPath)}`]);
}

function tmuxSendLine(windowId: string, line: string): void {
  runOrThrow("tmux", ["send-keys", "-t", windowId, line, "C-m"]);
}

function tmuxInterrupt(windowId: string): void {
  run("tmux", ["send-keys", "-t", windowId, "C-c"]);
}

function tmuxSendPrompt(windowId: string, prompt: string): void {
  const loaded = run("tmux", ["load-buffer", "-"], { input: prompt });
  if (!loaded.ok) {
    throw new Error(`Failed to send input to tmux window ${windowId}: ${loaded.stderr || loaded.error || "unknown error"}`);
  }
  runOrThrow("tmux", ["paste-buffer", "-d", "-t", windowId]);
  runOrThrow("tmux", ["send-keys", "-t", windowId, "C-m"]);
}

function tmuxCaptureTail(windowId: string, lines = 10): string[] {
  const captured = run("tmux", ["capture-pane", "-p", "-t", windowId, "-S", `-${TMUX_BACKLOG_CAPTURE_LINES}`]);
  if (!captured.ok) return [];
  return tailLines(captured.stdout, lines);
}

type RefreshRuntimeResult = {
  removeFromRegistry: boolean;
};

/**
 * Inspects one agent's live runtime state and updates its registry record.
 * Called by the status poller on every tick and by agent-check on demand.
 *
 * Returns { removeFromRegistry: true } when the agent has finished successfully
 * and can be pruned; false otherwise.
 *
 * Decision tree:
 *
 *   1. Already "done"?
 *      -> Clean up the worktree lock (best-effort) and signal removal.
 *         This handles the case where the poller sees a record that was already
 *         set to "done" by a previous tick but not yet pruned.
 *
 *   2. Exit file present and contains a numeric exitCode?
 *      -> The launch.sh script wrote exit.json after the child Pi exited.
 *         exitCode == 0  -> status = "done",  removeFromRegistry = true
 *         exitCode != 0  -> status = "failed", removeFromRegistry = false
 *         Either way, the worktree lock is released.
 *
 *   3. No tmuxWindowId recorded?
 *      -> Startup was interrupted before the tmux window was created.
 *         Leave the record as-is; the parent's error handler will mark it failed.
 *
 *   4. tmux window is still alive?
 *      -> Agent is running.  Advance early transient statuses to "running"
 *         (allocating_worktree / spawning_tmux / starting are internal-only
 *         states that should resolve quickly; if the window is live we know
 *         the child Pi is at least running).
 *
 *   5. tmux window is gone but no exit file?
 *      -> The process crashed (OOM, kill -9, tmux session closed, etc.).
 *         Mark as "crashed" with an explanatory error message.
 *
 * About async/await here:
 *   This is an `async` function because it performs I/O (file stat, JSON read,
 *   tmux query).  `await` suspends execution until each I/O operation completes,
 *   then resumes — no callback nesting required.  The caller `await`s this function
 *   too, chaining the suspension up the call stack.
 */
async function refreshOneAgentRuntime(stateRoot: string, record: AgentRecord): Promise<RefreshRuntimeResult> {
  // Branch 1: already done — just tidy up and prune.
  if (record.status === "done") {
    await cleanupWorktreeLockBestEffort(record.worktreePath);
    return { removeFromRegistry: true };
  }

  // Branch 2: exit file exists — agent has finished.
  if (record.exitFile && (await fileExists(record.exitFile))) {
    const exit = (await readJsonFile<ExitMarker>(record.exitFile)) ?? {};
    if (typeof exit.exitCode === "number") {
      record.exitCode = exit.exitCode;
      record.finishedAt = exit.finishedAt ?? record.finishedAt ?? nowIso();
      // exitCode 0 = success, any other value = failure.
      const changed = await setRecordStatus(stateRoot, record, exit.exitCode === 0 ? "done" : "failed");
      if (!changed) {
        record.updatedAt = nowIso(); // ensure updatedAt reflects this poll tick
      }
      await cleanupWorktreeLockBestEffort(record.worktreePath);
      if (exit.exitCode === 0) {
        return { removeFromRegistry: true }; // prune successful agents from registry
      }
      return { removeFromRegistry: false }; // keep failed agents for user inspection
    }
  }

  // Branch 3: no tmux window id — startup was interrupted early.
  if (!record.tmuxWindowId) {
    return { removeFromRegistry: false };
  }

  // Branch 4: check if the tmux window is still alive.
  const live = tmuxWindowExists(record.tmuxWindowId);
  if (live) {
    // Advance from early transient statuses once the window is confirmed live.
    if (record.status === "allocating_worktree" || record.status === "spawning_tmux" || record.status === "starting") {
      await setRecordStatus(stateRoot, record, "running");
    }
    return { removeFromRegistry: false };
  }

  // Branch 5: window gone, no exit file -> crashed.
  if (!isTerminalStatus(record.status)) {
    record.finishedAt = record.finishedAt ?? nowIso();
    await setRecordStatus(stateRoot, record, "crashed");
    if (!record.error) {
      record.error = "tmux window disappeared before an exit marker was recorded";
    }
    await cleanupWorktreeLockBestEffort(record.worktreePath);
  }

  return { removeFromRegistry: false };
}

async function refreshAgent(stateRoot: string, agentId: string): Promise<AgentRecord | undefined> {
  let snapshot: AgentRecord | undefined;
  await mutateRegistry(stateRoot, async (registry) => {
    const record = registry.agents[agentId];
    if (!record) return;
    const refreshed = await refreshOneAgentRuntime(stateRoot, record);
    if (refreshed.removeFromRegistry) {
      delete registry.agents[agentId];
      return;
    }
    snapshot = JSON.parse(JSON.stringify(record)) as AgentRecord;
  });
  return snapshot;
}

async function refreshAllAgents(stateRoot: string): Promise<RegistryFile> {
  return mutateRegistry(stateRoot, async (registry) => {
    for (const [agentId, record] of Object.entries(registry.agents)) {
      const refreshed = await refreshOneAgentRuntime(stateRoot, record);
      if (refreshed.removeFromRegistry) {
        delete registry.agents[agentId];
      }
    }
  });
}

async function getBacklogTail(record: AgentRecord, lines = 10): Promise<string[]> {
  if (record.logPath && (await fileExists(record.logPath))) {
    try {
      const raw = await fs.readFile(record.logPath, "utf8");
      const tailed = sanitizeBacklogLines(selectBacklogTailLines(raw, lines));
      if (tailed.length > 0) return tailed;
    } catch {
      // fall through
    }
  }

  if (record.tmuxWindowId && tmuxWindowExists(record.tmuxWindowId)) {
    const captured = tmuxCaptureTail(record.tmuxWindowId, TMUX_BACKLOG_CAPTURE_LINES);
    return sanitizeBacklogLines(collectRecentBacklogLines(captured, lines));
  }

  return [];
}

function renderInfoMessage(pi: ExtensionAPI, ctx: ExtensionContext, title: string, lines: string[]): void {
  const content = [title, "", ...lines].join("\n");
  if (ctx.hasUI) {
    pi.sendMessage({
      customType: "side-agents-report",
      content,
      display: true,
    });
  } else {
    console.log(content);
  }
}

function parseAgentCommandArgs(raw: string): { task: string; model?: string } {
  let rest = raw;
  let model: string | undefined;

  const modelMatch = rest.match(/(?:^|\s)-model\s+(\S+)/);
  if (modelMatch) {
    model = modelMatch[1];
    rest = rest.replace(modelMatch[0], " ");
  }

  return {
    task: rest.trim(),
    model,
  };
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function splitModelPatternAndThinking(raw: string): { pattern: string; thinking?: string } {
  const trimmed = raw.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) return { pattern: trimmed };

  const suffix = trimmed.slice(colon + 1);
  if (!THINKING_LEVELS.has(suffix)) return { pattern: trimmed };

  return {
    pattern: trimmed.slice(0, colon),
    thinking: suffix,
  };
}

function withThinking(modelSpec: string, thinking?: string): string {
  return thinking ? `${modelSpec}:${thinking}` : modelSpec;
}

async function resolveModelSpecForChild(
  ctx: ExtensionContext,
  requested?: string,
): Promise<{ modelSpec?: string; warning?: string }> {
  const currentModelSpec = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  if (!requested || requested.trim().length === 0) {
    return { modelSpec: currentModelSpec };
  }

  const trimmed = requested.trim();
  if (trimmed.includes("/")) {
    return { modelSpec: trimmed };
  }

  const { pattern, thinking } = splitModelPatternAndThinking(trimmed);

  if (ctx.model && pattern === ctx.model.id) {
    return {
      modelSpec: withThinking(`${ctx.model.provider}/${ctx.model.id}`, thinking),
    };
  }

  try {
    const available = (await ctx.modelRegistry.getAvailable()) as Array<{ provider: string; id: string }>;
    const exact = available.filter((model) => model.id === pattern);

    if (exact.length === 1) {
      const match = exact[0];
      return {
        modelSpec: withThinking(`${match.provider}/${match.id}`, thinking),
      };
    }

    if (exact.length > 1) {
      if (ctx.model) {
        const preferred = exact.find((model) => model.provider === ctx.model?.provider);
        if (preferred) {
          return {
            modelSpec: withThinking(`${preferred.provider}/${preferred.id}`, thinking),
          };
        }
      }

      const providers = [...new Set(exact.map((model) => model.provider))].sort();
      return {
        modelSpec: trimmed,
        warning: `Model '${pattern}' matches multiple providers (${providers.join(", ")}); child was started with raw pattern '${trimmed}'. Use provider/model to force a specific provider.`,
      };
    }
  } catch {
    // Best effort only; keep raw model pattern.
  }

  return { modelSpec: trimmed };
}

function normalizeAgentId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const firstToken = trimmed.split(/\s+/, 1)[0];
  return firstToken ?? "";
}

/**
 * Main agent startup orchestrator — the heart of the extension.
 * Returns a StartAgentResult describing what was created, or throws on failure.
 *
 * About async/await:
 *   Every `await` here suspends this function until an I/O or network operation
 *   finishes, then resumes where it left off.  The caller (the /agent command
 *   handler) also awaits this function, so the user sees a "Starting…" toast
 *   while the work is happening in the background.
 *
 * About the return type Promise<StartAgentResult>:
 *   `async` functions always return a Promise.  `StartAgentResult` is the
 *   resolved value — the data the caller receives when the Promise settles.
 *   If this function throws, the Promise is rejected and the caller's catch
 *   block handles it.
 *
 * Startup sequence (each step may throw; the catch block cleans up):
 *
 *   Step 1: Verify tmux is running and we're inside a tmux session.
 *           (Throws if not — the agent cannot be spawned without tmux.)
 *
 *   Step 2: Resolve the state root (git root or PI_SIDE_AGENTS_ROOT env var).
 *
 *   Step 3: Generate a unique kebab slug for the agent id / branch name.
 *           Uses LLM if available, otherwise falls back to heuristic extraction.
 *
 *   Step 4: Write a minimal placeholder record into the registry with status
 *           "allocating_worktree".  This makes the agent visible to /agents
 *           immediately, even before the worktree is ready.
 *
 *   Step 5: Allocate the git worktree (find a free slot or create a new one,
 *           reset it to HEAD, create the branch, write the lock file).
 *
 *   Step 6: Prepare the runtime directory (archive stale dir if present).
 *
 *   Step 7: Determine the file paths for kickoff.md, backlog.log, exit.json,
 *           launch.sh.  Create an empty backlog.log so tmux pipe-pane has a
 *           target immediately.
 *
 *   Step 8: Update the registry record with all paths; advance to "spawning_tmux".
 *
 *   Step 9: Build the kickoff prompt (optionally enriched with parent context
 *           summary) and write it to kickoff.md.  Also append it to backlog.log
 *           so agent-check can surface it.
 *
 *   Step 10: Resolve the model spec for the child (provider/model:thinking).
 *
 *   Step 11: Create the tmux window (background, -d flag).
 *
 *   Step 12: Update the worktree lock with the window id.
 *
 *   Step 13: Write and chmod the launch.sh script.
 *
 *   Step 14: Attach tmux pipe-pane to stream pane output to backlog.log.
 *            Then send `cd <worktree>` and `bash launch.sh` to the window.
 *
 *   Step 15: Write the fully-populated record to the registry; set to "running".
 *
 *   Step 16: Emit the kickoff-prompt message (stored in session, not displayed).
 *
 * Cleanup on error (catch block):
 *   - Kill the tmux window if one was created.
 *   - Mark the registry record as "failed" with the error message.
 *   - Re-throw so the caller's UI error handler fires.
 */
async function startAgent(pi: ExtensionAPI, ctx: ExtensionContext, params: StartAgentParams): Promise<StartAgentResult> {
  // Step 1: guard — tmux must be running
  ensureTmuxReady();

  // Step 2: resolve paths
  const stateRoot = getStateRoot(ctx);
  const repoRoot = resolveGitRoot(stateRoot);
  const parentSessionId = ctx.sessionManager.getSessionFile();
  const now = nowIso();

  // Variables declared outside try so the catch block can reference them.
  let agentId = "";
  let spawnedWindowId: string | undefined;
  let allocatedWorktreePath: string | undefined;
  let allocatedBranch: string | undefined;
  let aggregatedWarnings: string[] = [];

  try {
    await ensureDir(getMetaDir(stateRoot));

    // Step 3: generate slug (agent id / branch name suffix)
    let slug: string;
    if (params.branchHint) {
      // Caller-provided hint takes priority over LLM slug generation.
      slug = sanitizeSlug(params.branchHint);
      if (!slug) slug = slugFromTask(params.task); // fallback if hint sanitizes to empty
    } else {
      const generated = await generateSlug(ctx, params.task);
      slug = generated.slug;
      if (generated.warning) aggregatedWarnings.push(generated.warning);
    }

    // Step 4: register placeholder record so the agent is visible immediately
    await mutateRegistry(stateRoot, async (registry) => {
      const existing = existingAgentIds(registry, repoRoot);
      agentId = deduplicateSlug(slug, existing); // append -2, -3, … if slug already taken
      registry.agents[agentId] = {
        id: agentId,
        parentSessionId,
        task: params.task,
        model: params.model,
        status: "allocating_worktree",
        startedAt: now,
        updatedAt: now,
      };
    });

    // Step 5: allocate the git worktree
    const worktree = await allocateWorktree({
      repoRoot,
      stateRoot,
      agentId,
      parentSessionId,
    });
    allocatedWorktreePath = worktree.worktreePath;
    allocatedBranch = worktree.branch;
    aggregatedWarnings = [...worktree.warnings];

    // Step 6: prepare the runtime directory (archive stale data if present)
    const runtimePrep = await prepareFreshRuntimeDir(stateRoot, agentId);
    const runtimeDir = runtimePrep.runtimeDir;
    if (runtimePrep.archivedRuntimeDir) {
      aggregatedWarnings.push(`Archived existing runtime dir for ${agentId}: ${runtimePrep.archivedRuntimeDir}`);
    }
    if (runtimePrep.warning) {
      aggregatedWarnings.push(runtimePrep.warning);
    }

    // Step 7: define all runtime file paths
    const promptPath = join(runtimeDir, "kickoff.md");
    const logPath = join(runtimeDir, "backlog.log");
    const exitFile = join(runtimeDir, "exit.json");
    const launchScriptPath = join(runtimeDir, "launch.sh");
    await atomicWrite(logPath, ""); // create empty log so pipe-pane can append immediately

    // Step 8: update registry with paths and advance to "spawning_tmux"
    await mutateRegistry(stateRoot, async (registry) => {
      const record = registry.agents[agentId];
      if (!record) return;
      record.worktreePath = worktree.worktreePath;
      record.branch = worktree.branch;
      record.runtimeDir = runtimeDir;
      record.promptPath = promptPath;
      record.logPath = logPath;
      record.exitFile = exitFile;
      await setRecordStatus(stateRoot, record, "spawning_tmux");
      record.warnings = [...(record.warnings ?? []), ...worktree.warnings];
    });

    // Step 9: build and write the kickoff prompt
    const kickoff = await buildKickoffPrompt(ctx, params.task, params.includeSummary);
    if (kickoff.warning) aggregatedWarnings.push(kickoff.warning);

    await atomicWrite(promptPath, kickoff.prompt + "\n");
    try {
      // Also echo the prompt into backlog.log for agent-check visibility.
      await mutateRegistry(stateRoot, async (registry) => {
        const record = registry.agents[agentId];
        if (!record) return;
        await appendKickoffPromptToBacklog(stateRoot, record, kickoff.prompt);
      });
    } catch {
      // Best effort fallback when registry lock/update fails; write directly
      // to the known backlog path without requiring registry mutation.
      await appendKickoffPromptToBacklog(
        stateRoot,
        {
          id: agentId,
          task: params.task,
          status: "spawning_tmux",
          startedAt: now,
          updatedAt: nowIso(),
          runtimeDir,
          logPath,
        },
        kickoff.prompt,
      );
    }

    // Step 10: resolve model spec for child (may differ from parent's model)
    const resolvedModel = await resolveModelSpecForChild(ctx, params.model);
    const modelSpec = resolvedModel.modelSpec;
    if (resolvedModel.warning) aggregatedWarnings.push(resolvedModel.warning);

    // Step 11: create the tmux window (background, keeps parent window active)
    const tmuxSession = getCurrentTmuxSession();
    const { windowId, windowIndex } = createTmuxWindow(tmuxSession, `agent-${agentId}`);
    spawnedWindowId = windowId; // save so catch block can kill it on error

    // Step 12: update worktree lock with the window id (used by orphan detection)
    await updateWorktreeLock(worktree.worktreePath, {
      tmuxWindowId: windowId,
      tmuxWindowIndex: windowIndex,
    });

    // Step 13: write and make launch.sh executable (chmod 755)
    const launchScript = buildLaunchScript({
      agentId,
      parentSessionId,
      parentRepoRoot: repoRoot,
      stateRoot,
      worktreePath: worktree.worktreePath,
      tmuxWindowId: windowId,
      promptPath,
      exitFile,
      modelSpec,
      runtimeDir,
    });
    await atomicWrite(launchScriptPath, launchScript);
    await fs.chmod(launchScriptPath, 0o755); // make executable: owner=rwx, group+other=r-x

    // Step 14: start streaming pane output to backlog.log, then launch the script
    tmuxPipePaneToFile(windowId, logPath);
    // Run cd in the interactive pane shell first so Ctrl+Z in child Pi drops
    // back to the child worktree prompt (not the parent worktree).
    tmuxSendLine(windowId, `cd ${shellQuote(worktree.worktreePath)}`);
    tmuxSendLine(windowId, `bash ${shellQuote(launchScriptPath)}`);

    // Step 15: write the fully-populated record and advance to "running"
    await mutateRegistry(stateRoot, async (registry) => {
      const record = registry.agents[agentId];
      if (!record) return;
      record.tmuxSession = tmuxSession;
      record.tmuxWindowId = windowId;
      record.tmuxWindowIndex = windowIndex;
      record.worktreePath = worktree.worktreePath;
      record.branch = worktree.branch;
      record.runtimeDir = runtimeDir;
      record.promptPath = promptPath;
      record.logPath = logPath;
      record.exitFile = exitFile;
      record.model = modelSpec;
      await setRecordStatus(stateRoot, record, "running");
      record.warnings = [...(record.warnings ?? []), ...aggregatedWarnings];
    });

    // Step 16: emit kickoff-prompt message (stored in session history, not shown in UI)
    const started: StartAgentResult = {
      id: agentId,
      tmuxWindowId: windowId,
      tmuxWindowIndex: windowIndex,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      warnings: aggregatedWarnings,
      prompt: kickoff.prompt,
    };
    emitKickoffPromptMessage(pi, started);

    return started; // <-- Promise resolves with this value
  } catch (err) {
    // Cleanup: kill the tmux window if one was created before the error.
    if (spawnedWindowId) {
      run("tmux", ["kill-window", "-t", spawnedWindowId]);
    }

    // Mark the registry record as "failed" so /agents shows the error.
    if (agentId) {
      await mutateRegistry(stateRoot, async (registry) => {
        const record = registry.agents[agentId];
        if (!record) return;
        record.error = stringifyError(err);
        record.finishedAt = nowIso();
        const changed = await setRecordStatus(stateRoot, record, "failed");
        if (!changed) {
          record.updatedAt = nowIso();
        }
        if (allocatedWorktreePath) record.worktreePath = allocatedWorktreePath;
        if (allocatedBranch) record.branch = allocatedBranch;
        record.warnings = [...(record.warnings ?? []), ...aggregatedWarnings];
      });
    }

    throw err; // re-throw so the caller's UI error handler fires
  }
}

async function agentCheckPayload(stateRoot: string, agentId: string): Promise<Record<string, unknown>> {
  const normalizedId = normalizeAgentId(agentId);
  if (!normalizedId) {
    return {
      ok: false,
      error: "No agent id was provided",
    };
  }

  const record = await refreshAgent(stateRoot, normalizedId);
  if (!record) {
    return {
      ok: false,
      error: `Unknown agent id: ${normalizedId}`,
    };
  }

  const backlog = await getBacklogTail(record, 10);

  return {
    ok: true,
    agent: {
      id: record.id,
      status: record.status,
      tmuxWindowId: record.tmuxWindowId,
      tmuxWindowIndex: record.tmuxWindowIndex,
      worktreePath: record.worktreePath,
      branch: record.branch,
      task: summarizeTask(record.task),
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      exitCode: record.exitCode,
      error: record.error,
      warnings: record.warnings ?? [],
    },
    backlog,
  };
}

async function sendToAgent(stateRoot: string, agentId: string, prompt: string): Promise<{ ok: boolean; message: string }> {
  const normalizedId = normalizeAgentId(agentId);
  if (!normalizedId) {
    return { ok: false, message: "No agent id was provided" };
  }

  const record = await refreshAgent(stateRoot, normalizedId);
  if (!record) {
    return { ok: false, message: `Unknown agent id: ${normalizedId}` };
  }
  if (!record.tmuxWindowId) {
    return { ok: false, message: `Agent ${normalizedId} has no tmux window id recorded` };
  }
  if (!tmuxWindowExists(record.tmuxWindowId)) {
    return { ok: false, message: `Agent ${normalizedId} tmux window is not active` };
  }

  let payload = prompt;
  if (payload.startsWith("!")) {
    tmuxInterrupt(record.tmuxWindowId);
    payload = payload.slice(1).trimStart();
    if (payload.length > 0) {
      // Brief pause so Pi can finish handling the interrupt and return to an
      // interactive prompt before the follow-up text lands in the pane.
      await sleep(300);
    }
  }
  if (payload.length > 0) {
    tmuxSendPrompt(record.tmuxWindowId, payload);
  }

  await mutateRegistry(stateRoot, async (registry) => {
    const current = registry.agents[normalizedId];
    if (!current) return;
    if (!isTerminalStatus(current.status)) {
      const changed = await setRecordStatus(stateRoot, current, "running");
      if (!changed) {
        current.updatedAt = nowIso();
      }
    }
  });

  return { ok: true, message: `Sent prompt to ${normalizedId}` };
}

async function setChildRuntimeStatus(ctx: ExtensionContext, nextStatus: AgentStatus): Promise<void> {
  const agentId = process.env[ENV_AGENT_ID];
  if (!agentId) return;

  const stateRoot = getStateRoot(ctx);
  await mutateRegistry(stateRoot, async (registry) => {
    const record = registry.agents[agentId];
    if (!record) return;
    if (isTerminalStatus(record.status)) return;
    if (
      nextStatus === "waiting_user" &&
      (record.status === "finishing" || record.status === "waiting_merge_lock" || record.status === "retrying_reconcile")
    ) {
      return;
    }

    const changed = await setRecordStatus(stateRoot, record, nextStatus);
    if (!changed) {
      record.updatedAt = nowIso();
    }
  });
}

/**
 * Polls the registry until one of the given agents reaches a target state,
 * then returns that agent's full check payload (same shape as agentCheckPayload).
 *
 * About async/await + the infinite loop pattern:
 *   This function uses `while (true)` with `await sleep(1000)` inside.
 *   Each iteration suspends for ~1 second, yielding control back to the Node.js
 *   event loop so other work (status poller, incoming messages) can run.
 *   The caller gets a Promise that won't resolve until a target state is found.
 *   The AbortSignal allows the Pi framework to cancel the wait when the user
 *   interrupts or the tool call times out.
 *
 * Return value:  Promise<Record<string, unknown>>
 *   The resolved value is always a plain object with `ok: boolean`.
 *   `ok: true`  -> also contains `agent` and `backlog` (same as agent-check).
 *   `ok: false` -> also contains `error` (human-readable reason string).
 *   Using Record<string, unknown> (a JSON-like object) lets the tool executor
 *   serialise the result directly to JSON without extra transformation.
 *
 * Step 1: Deduplicate and normalise the provided ids.
 * Step 2: Validate the desired wait states against the known status enum.
 * Step 3: Poll loop — on each tick:
 *   a. Check abort signal.
 *   b. Call agentCheckPayload() for each id (refreshes the record).
 *   c. If any id is unknown on the FIRST pass, fail immediately
 *      (unknown ids will never become known — no point polling).
 *   d. If the agent's status is in waitStateSet, return immediately.
 *   e. If ALL ids have disappeared from the registry after the first pass,
 *      they likely exited with code 0 and were auto-pruned — return an error
 *      rather than polling forever.
 *   f. Sleep 1 second and repeat.
 */
async function waitForAny(
  stateRoot: string,
  ids: string[],
  signal?: AbortSignal,
  waitStatesInput?: string[],
): Promise<Record<string, unknown>> {
  // Step 1: deduplicate ids
  const uniqueIds = [...new Set(ids.map((id) => normalizeAgentId(id)).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { ok: false, error: "No agent ids were provided" };
  }

  // Step 2: validate wait states
  const waitStates = normalizeWaitStates(waitStatesInput);
  if (waitStates.error) {
    return { ok: false, error: waitStates.error };
  }
  const waitStateSet = new Set<AgentStatus>(waitStates.values);

  let firstPass = true;

  // Step 3: poll loop
  while (true) {
    // Step 3a: respect cancellation (e.g. user pressed Ctrl+C in Pi)
    if (signal?.aborted) {
      return { ok: false, error: "agent-wait-any aborted" };
    }

    const unknownOnFirstPass: string[] = [];
    let knownCount = 0;

    for (const id of uniqueIds) {
      const checked = await agentCheckPayload(stateRoot, id); // refresh from disk
      const ok = checked.ok === true;
      if (!ok) {
        // Step 3c: track unknown ids on the first pass
        if (firstPass) unknownOnFirstPass.push(id);
        continue;
      }

      knownCount += 1;
      const status = (checked.agent as any)?.status as AgentStatus | undefined;
      if (!status) continue;
      // Step 3d: found a match — return the full payload
      if (waitStateSet.has(status)) {
        return checked;
      }
    }

    // Fail immediately if any provided ID was unrecognised on the very first
    // poll — unknown agents will never become known, so waiting is pointless.
    if (firstPass && unknownOnFirstPass.length > 0) {
      return {
        ok: false,
        error: `Unknown agent id(s): ${unknownOnFirstPass.join(", ")}`,
      };
    }

    // Step 3e: Successful agents are auto-pruned from registry.
    // If all tracked IDs disappeared after polling started, we can no longer
    // observe state changes — return an informative error.
    if (!firstPass && knownCount === 0) {
      return {
        ok: false,
        error:
          `Agent id(s) disappeared from registry: ${uniqueIds.join(", ")}. ` +
          "They may have exited successfully and been cleaned up.",
      };
    }

    firstPass = false;
    // Step 3f: wait 1 second before next poll to avoid hammering the registry.
    await sleep(1000);
  }
}

/**
 * Called by the child Pi process on session_start and session_switch events.
 * Links the child's session file path into the shared registry so the parent
 * can open or inspect the child's conversation history.
 *
 * Also appends a CHILD_LINK_ENTRY_TYPE entry into the child's session so there
 * is a record of which agent id this session belongs to.  This entry is written
 * at most once per session (guarded by the hasLinkEntry check).
 *
 * Return type Promise<void>:
 *   `void` means the Promise carries no meaningful value — it just signals
 *   completion (or rejection on error).  The caller uses `await` purely to
 *   ensure the operation finishes before proceeding.
 */
async function ensureChildSessionLinked(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const agentId = process.env[ENV_AGENT_ID];
  if (!agentId) return; // not running inside a child agent — do nothing

  const stateRoot = getStateRoot(ctx);
  const childSession = ctx.sessionManager.getSessionFile();
  const parentSession = process.env[ENV_PARENT_SESSION];

  await mutateRegistry(stateRoot, async (registry) => {
    const existing = registry.agents[agentId];
    if (!existing) {
      registry.agents[agentId] = {
        id: agentId,
        parentSessionId: parentSession,
        childSessionId: childSession,
        task: "(child session linked without parent registry record)",
        status: "running",
        startedAt: nowIso(),
        updatedAt: nowIso(),
      };
      return;
    }

    existing.childSessionId = childSession;
    existing.parentSessionId = existing.parentSessionId ?? parentSession;
    let statusChanged = false;
    if (!isTerminalStatus(existing.status)) {
      statusChanged = await setRecordStatus(stateRoot, existing, "running");
    }
    if (!statusChanged) {
      existing.updatedAt = nowIso();
    }
  });

  const lockPath = join(ctx.cwd, ".pi", "active.lock");
  if (await fileExists(lockPath)) {
    const lock = (await readJsonFile<Record<string, unknown>>(lockPath)) ?? {};
    lock.sessionId = childSession;
    lock.agentId = agentId;
    await atomicWrite(lockPath, JSON.stringify(lock, null, 2) + "\n");
  }

  const hasLinkEntry = ctx.sessionManager.getEntries().some((entry) => {
    if (entry.type !== "custom") return false;
    const customEntry = entry as { customType?: string };
    return customEntry.customType === CHILD_LINK_ENTRY_TYPE;
  });

  if (!hasLinkEntry) {
    pi.appendEntry(CHILD_LINK_ENTRY_TYPE, {
      agentId,
      parentSession,
      linkedAt: Date.now(),
    });
  }
}

function isChildRuntime(): boolean {
  return Boolean(process.env[ENV_AGENT_ID]);
}

/**
 * Computes status transitions by diffing the current agent list against the
 * previously observed snapshot.  This is how the status poller knows when to
 * emit toast messages ("side-agent foo: running -> waiting_user").
 *
 * Step 1: Build a new snapshot map from the current agent list.
 * Step 2: For each agent in the current list, compare its status to the
 *         previous snapshot.  If changed, record a transition notice.
 * Step 3: For any agent that was in the previous snapshot but is no longer in
 *         the current list (pruned from registry), synthesize a -> "done"
 *         transition (unless the previous status was already terminal, which
 *         would mean it was failed/crashed and the user cleaned it up manually).
 * Step 4: Persist the new snapshot for the next poll tick.
 * Step 5: Return early (empty array) on the very first call — there is no
 *         previous snapshot to compare against, so nothing has "changed" yet.
 */
function collectStatusTransitions(stateRoot: string, agents: AgentRecord[]): StatusTransitionNotice[] {
  const previous = statusSnapshotsByStateRoot.get(stateRoot);
  const next = new Map<string, AgentStatusSnapshot>();
  const transitions: StatusTransitionNotice[] = [];

  // Step 1 & 2: build next snapshot and detect changes
  for (const record of agents) {
    const currentSnapshot: AgentStatusSnapshot = {
      status: record.status,
      tmuxWindowIndex: record.tmuxWindowIndex,
    };
    next.set(record.id, currentSnapshot);

    const previousSnapshot = previous?.get(record.id);
    if (!previousSnapshot || previousSnapshot.status === record.status) continue; // no change
    transitions.push({
      id: record.id,
      fromStatus: previousSnapshot.status,
      toStatus: record.status,
      // Prefer the current window index but fall back to the previous one in case
      // the record was partially updated and tmuxWindowIndex is temporarily missing.
      tmuxWindowIndex: record.tmuxWindowIndex ?? previousSnapshot.tmuxWindowIndex,
    });
  }

  // Step 3: detect agents that disappeared from the registry (pruned after success)
  if (previous) {
    for (const [agentId, previousSnapshot] of previous.entries()) {
      if (next.has(agentId)) continue; // still present — handled above
      if (isTerminalStatus(previousSnapshot.status)) continue; // already at a terminal state
      // Agent was pruned from registry without a prior terminal status -> it finished (done).
      transitions.push({
        id: agentId,
        fromStatus: previousSnapshot.status,
        toStatus: "done",
        tmuxWindowIndex: previousSnapshot.tmuxWindowIndex,
      });
    }
  }

  // Step 4: persist the snapshot
  statusSnapshotsByStateRoot.set(stateRoot, next);
  // Step 5: skip transitions on the very first call (no previous to compare)
  if (!previous) return [];
  return transitions.sort((a, b) => a.id.localeCompare(b.id));
}

type ThemeForeground = { fg: (role: "warning" | "muted" | "accent" | "error", text: string) => string };

function formatStatusWord(status: AgentStatus, theme?: ThemeForeground): string {
  if (!theme) return status;
  return theme.fg(statusColorRole(status), status);
}

function formatLabelPrefix(prefix: string, theme?: ThemeForeground): string {
  if (!theme) return prefix;
  return theme.fg("muted", prefix);
}

function formatStatusTransitionMessage(transition: StatusTransitionNotice, theme?: ThemeForeground): string {
  const win = transition.tmuxWindowIndex !== undefined ? ` (tmux #${transition.tmuxWindowIndex})` : "";
  const from = formatStatusWord(transition.fromStatus, theme);
  const to = formatStatusWord(transition.toStatus, theme);
  return `side-agent ${transition.id}: ${from} -> ${to}${win}`;
}

function emitStatusTransitions(pi: ExtensionAPI, ctx: ExtensionContext, transitions: StatusTransitionNotice[]): void {
  if (isChildRuntime()) return;

  for (const transition of transitions) {
    const message = formatStatusTransitionMessage(transition, ctx.hasUI ? ctx.ui.theme : undefined);
    pi.sendMessage(
      {
        customType: STATUS_UPDATE_MESSAGE_TYPE,
        content: message,
        display: true,
        details: {
          agentId: transition.id,
          fromStatus: transition.fromStatus,
          toStatus: transition.toStatus,
          tmuxWindowIndex: transition.tmuxWindowIndex,
          emittedAt: Date.now(),
        },
      },
      {
        triggerTurn: false,
        deliverAs: "followUp",
      },
    );

    if (ctx.hasUI && (transition.toStatus === "failed" || transition.toStatus === "crashed")) {
      ctx.ui.notify(message, "error");
    }
  }
}

function emitKickoffPromptMessage(pi: ExtensionAPI, started: StartAgentResult): void {
  const win = started.tmuxWindowIndex !== undefined ? ` (tmux #${started.tmuxWindowIndex})` : "";
  const content = `side-agent ${started.id}: kickoff prompt${win}\n\n${started.prompt}`;
  pi.sendMessage(
    {
      customType: PROMPT_UPDATE_MESSAGE_TYPE,
      content,
      display: false,
      details: {
        agentId: started.id,
        tmuxWindowId: started.tmuxWindowId,
        tmuxWindowIndex: started.tmuxWindowIndex,
        worktreePath: started.worktreePath,
        branch: started.branch,
        prompt: started.prompt,
        emittedAt: Date.now(),
      },
    },
    { triggerTurn: false },
  );
}

/**
 * Refreshes the registry and updates the Pi status-line widget.
 *
 * Called from two places:
 *   a) The 2.5 s setInterval poller (emitTransitions = true, default).
 *   b) before_agent_start hook (emitTransitions = false) — just initialise
 *      the snapshot without firing toast messages for pre-existing agents.
 *
 * About Pi's ExtensionAPI / ctx (pi-coding-agent framework):
 *   - `ctx.hasUI`  — true when Pi is running with its interactive UI (false in
 *     headless/scripted mode).  Status-line and notify() are UI-only features.
 *   - `ctx.ui.setStatus(key, text)` — updates a named slot in the status bar.
 *     Passing `undefined` clears the slot.
 *   - `ctx.ui.theme.fg(role, text)` — wraps text in ANSI color codes based on
 *     a semantic role ("muted", "accent", "error", "warning") so the status bar
 *     adapts to the user's terminal color scheme.
 *   - `ctx.ui.notify(msg, level)` — shows a transient toast notification.
 *
 * Step 1: Skip if no UI (headless mode).
 * Step 2: Refresh all agent records from disk.
 * Step 3: Compute and optionally emit status transitions.
 * Step 4: If no agents, clear the status widget (remove it from the bar).
 * Step 5: Build a compact one-line summary: "id:status@window id2:status@window …"
 *         Each token is colorised by statusColorRole().
 * Step 6: Skip setStatus() if the rendered line is identical to the last one
 *         (avoids unnecessary redraws).
 */
async function renderStatusLine(pi: ExtensionAPI, ctx: ExtensionContext, options?: { emitTransitions?: boolean }): Promise<void> {
  if (!ctx.hasUI) return; // Step 1: no UI — nothing to render

  const stateRoot = getStateRoot(ctx);
  // Step 2: refresh all records (detects crashes, exits, status changes)
  const refreshed = await refreshAllAgents(stateRoot);
  const agents = Object.values(refreshed.agents).sort((a, b) => a.id.localeCompare(b.id));

  // Step 3: compute transitions and optionally emit toast messages
  if (options?.emitTransitions ?? true) {
    const transitions = collectStatusTransitions(stateRoot, agents);
    if (transitions.length > 0) {
      emitStatusTransitions(pi, ctx, transitions);
    }
  } else if (!statusSnapshotsByStateRoot.has(stateRoot)) {
    // before_agent_start: seed the snapshot so the next poll has a baseline.
    collectStatusTransitions(stateRoot, agents);
  }

  // Step 4: clear the widget if no agents are running
  if (agents.length === 0) {
    if (lastRenderedStatusLine !== undefined) {
      ctx.ui.setStatus(STATUS_KEY, undefined); // remove from status bar
      lastRenderedStatusLine = undefined;
    }
    return;
  }

  // Step 5: build the status line text
  const theme = ctx.ui.theme;
  const line = agents
    .map((record) => {
      const win = record.tmuxWindowIndex !== undefined ? `@${record.tmuxWindowIndex}` : "";
      const entry = `${record.id}:${statusShort(record.status)}${win}`; // e.g. "fix-bug:run@3"
      return theme.fg(statusColorRole(record.status), entry); // wrap with ANSI colors
    })
    .join(" "); // agents separated by spaces

  // Step 6: skip re-render if nothing changed
  if (line === lastRenderedStatusLine) return;
  ctx.ui.setStatus(STATUS_KEY, line);
  lastRenderedStatusLine = line;
}

/**
 * Ensures the background status poller is running.  Safe to call multiple times;
 * the `if (!statusPollTimer)` guard makes it idempotent.
 *
 * About setInterval / unref():
 *   `setInterval(fn, 2500)` schedules `fn` to run every 2.5 seconds.
 *   `.unref()` tells Node.js: "don't keep the process alive just for this timer."
 *   Without unref(), Node would refuse to exit even if the user closes Pi,
 *   because there would be a pending timer keeping the event loop open.
 *
 * About the statusPollInFlight guard:
 *   If a poll tick takes longer than 2.5 s (e.g. slow filesystem, lots of agents),
 *   the guard prevents the next tick from starting a second concurrent poll.
 *   `void` discards the Promise — errors are swallowed by `.catch(() => {})`.
 *
 * Finally, an immediate render is triggered on first call so the status bar
 * populates without waiting for the first 2.5 s tick.
 */
function ensureStatusPoller(pi: ExtensionAPI, ctx: ExtensionContext): void {
  statusPollContext = ctx; // update references so the poller always uses the latest context
  statusPollApi = pi;
  if (!ctx.hasUI) return; // no status bar in headless mode

  if (!statusPollTimer) {
    statusPollTimer = setInterval(() => {
      if (statusPollInFlight || !statusPollContext || !statusPollApi) return; // skip if still running
      statusPollInFlight = true;
      void renderStatusLine(statusPollApi, statusPollContext)
        .catch(() => { })   // swallow errors — poller must never crash the Pi process
        .finally(() => {
          statusPollInFlight = false; // allow next tick to run
        });
    }, 2500);
    statusPollTimer.unref(); // don't keep Node.js alive just for this timer
  }

  // Render immediately (don't wait 2.5 s for the first update)
  void renderStatusLine(pi, ctx).catch(() => { });
}


/**
 * Extension entry point — Pi calls this function when the extension is loaded.
 *
 * About the Pi / pi-coding-agent framework:
 *   Pi is an interactive coding assistant (similar in spirit to Claude Code).
 *   Extensions augment Pi with custom slash commands, tools, and event listeners.
 *
 *   `ExtensionAPI` (the `pi` parameter) exposes:
 *     - `pi.registerCommand(name, { description, handler })` — adds a /name slash command.
 *       `handler(args: string, ctx: ExtensionContext)` receives everything typed after /name.
 *     - `pi.registerTool({ name, label, description, parameters, execute })` — adds a tool
 *       callable by the LLM during a conversation turn.
 *     - `pi.on(eventName, handler)` — subscribes to lifecycle events (session_start, etc.).
 *     - `pi.sendMessage({ customType, content, display, details }, options)` — injects a
 *       message into the session.  `display: false` stores it silently; `display: true`
 *       renders it in the UI.
 *     - `pi.appendEntry(type, data)` — appends a custom entry to the session history file.
 *
 *   `ExtensionContext` (the `ctx` parameter in handlers) exposes:
 *     - `ctx.cwd`              — current working directory
 *     - `ctx.model`            — active model descriptor
 *     - `ctx.modelRegistry`    — access to API keys and available models
 *     - `ctx.sessionManager`   — read the current session file path and history
 *     - `ctx.hasUI`            — whether the interactive UI is active
 *     - `ctx.ui.notify/confirm/setStatus/theme` — UI interaction helpers
 *
 * About TypeBox (`Type` from `@sinclair/typebox`):
 *   TypeBox is a JSON Schema builder for TypeScript.  Pi uses it to define and
 *   validate tool parameters before calling execute().  Each `Type.Object({ … })`
 *   call produces both a TypeScript type AND a JSON Schema object at runtime:
 *     - `Type.String()` → { type: "string" }
 *     - `Type.Optional(Type.String())` → { type: "string" } + marks the field optional
 *     - `Type.Array(Type.String())` → { type: "array", items: { type: "string" } }
 *   Pi validates the LLM's tool call arguments against this schema before
 *   invoking execute(), so the handler can trust the types without manual checks.
 *
 * This function registers:
 *   Commands (slash commands for human use):
 *     /agent   — spawn a new background agent
 *     /agents  — list tracked agents, offer cleanup of failed/orphaned ones
 *
 *   Tools (callable by the LLM during a turn):
 *     agent-start    — start a background agent (no auto context summary)
 *     agent-check    — poll one agent's status and recent output
 *     agent-wait-any — block until one of several agents reaches a target state
 *     agent-send     — send a steering prompt (or interrupt) to a running agent
 *
 *   Event listeners:
 *     session_start / session_switch — link child session, ensure poller is running
 *     agent_start / agent_end        — update status to "running" / "waiting_user"
 *     before_agent_start             — seed snapshot for transition detection
 */
export default function sideAgentsExtension(pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // /agent command — human-facing; generates context summary automatically
  // -------------------------------------------------------------------------
  pi.registerCommand("agent", {
    description: "Spawn a background child agent in its own tmux window/worktree: /agent [-model <provider/id>] <task>",
    handler: async (args, ctx) => {
      const parsed = parseAgentCommandArgs(args);
      if (!parsed.task) {
        ctx.hasUI && ctx.ui.notify("Usage: /agent [-model <provider/id>] <task>", "error");
        return;
      }

      try {
        ctx.hasUI && ctx.ui.notify("Starting side-agent…", "info");
        // includeSummary: true -> buildKickoffPrompt() will call the LLM to
        // condense the parent conversation into a handoff summary for the child.
        const started = await startAgent(pi, ctx, {
          task: parsed.task,
          model: parsed.model,
          includeSummary: true,
        });

        const lines = [
          `id: ${started.id}`,
          `tmux window: ${started.tmuxWindowId} (#${started.tmuxWindowIndex})`,
          `worktree: ${started.worktreePath}`,
          `branch: ${started.branch}`,
        ];
        for (const warning of started.warnings) {
          lines.push(`warning: ${warning}`);
        }
        lines.push("", "prompt:");
        for (const line of started.prompt.split(/\r?\n/)) {
          lines.push(`  ${line}`);
        }
        renderInfoMessage(pi, ctx, "side-agent started", lines);
        await renderStatusLine(pi, ctx).catch(() => { });
      } catch (err) {
        ctx.hasUI && ctx.ui.notify(`Failed to start agent: ${stringifyError(err)}`, "error");
      }
    },
  });

  // -------------------------------------------------------------------------
  // /agents command — lists all tracked agents; offers to clean up failed ones
  // -------------------------------------------------------------------------
  pi.registerCommand("agents", {
    description: "List tracked side agents",
    handler: async (_args, ctx) => {
      const stateRoot = getStateRoot(ctx);
      const repoRoot = resolveGitRoot(stateRoot);
      let registry = await refreshAllAgents(stateRoot);
      const records = Object.values(registry.agents).sort((a, b) => a.id.localeCompare(b.id));
      let orphanLocks = await scanOrphanWorktreeLocks(repoRoot, registry);

      if (records.length === 0 && orphanLocks.reclaimable.length === 0 && orphanLocks.blocked.length === 0) {
        ctx.hasUI && ctx.ui.notify("No tracked side agents yet.", "info");
        return;
      }

      const lines: string[] = [];
      const failedIds: string[] = [];

      if (records.length === 0) {
        lines.push("(no tracked agents)");
      } else {
        const theme = ctx.hasUI ? ctx.ui.theme : undefined;
        for (const [index, record] of records.entries()) {
          const win = record.tmuxWindowIndex !== undefined ? `#${record.tmuxWindowIndex}` : "-";
          const worktreeName = record.worktreePath ? basename(record.worktreePath) || record.worktreePath : "-";
          const statusWord = formatStatusWord(record.status, theme);
          const winPrefix = formatLabelPrefix("win:", theme);
          const worktreePrefix = formatLabelPrefix("worktree:", theme);
          const taskPrefix = formatLabelPrefix("task:", theme);
          lines.push(`${record.id}  ${statusWord}  ${winPrefix}${win}  ${worktreePrefix}${worktreeName}`);
          lines.push(`  ${taskPrefix} ${summarizeTask(record.task)}`);
          if (record.error) lines.push(`  error: ${record.error}`);
          if (record.status === "failed" || record.status === "crashed") {
            failedIds.push(record.id);
          }
          if (index < records.length - 1) {
            lines.push("");
          }
        }
      }

      if (orphanLocks.reclaimable.length > 0 || orphanLocks.blocked.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("orphan worktree locks:");
        for (const lock of orphanLocks.reclaimable) {
          lines.push(`  reclaimable: ${summarizeOrphanLock(lock)}`);
        }
        for (const lock of orphanLocks.blocked) {
          lines.push(`  blocked: ${summarizeOrphanLock(lock)} (${lock.blockers.join("; ")})`);
        }
      }

      renderInfoMessage(pi, ctx, "side-agents", lines);

      if (failedIds.length > 0 && ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          "Clean up failed agents?",
          `Remove ${failedIds.length} failed/crashed agent(s) from registry: ${failedIds.join(", ")}`,
        );
        if (confirmed) {
          registry = await mutateRegistry(stateRoot, async (next) => {
            for (const id of failedIds) {
              delete next.agents[id];
            }
          });
          ctx.ui.notify(`Removed ${failedIds.length} agent(s): ${failedIds.join(", ")}`, "info");
        }
      }

      orphanLocks = await scanOrphanWorktreeLocks(repoRoot, registry);

      if (orphanLocks.reclaimable.length > 0 && ctx.hasUI) {
        const preview = orphanLocks.reclaimable.slice(0, 6).map((lock) => `- ${summarizeOrphanLock(lock)}`);
        if (orphanLocks.reclaimable.length > preview.length) {
          preview.push(`- ... and ${orphanLocks.reclaimable.length - preview.length} more`);
        }

        const confirmed = await ctx.ui.confirm(
          "Reclaim orphan worktree locks?",
          [
            `Remove ${orphanLocks.reclaimable.length} orphan worktree lock(s)?`,
            "Only lock files with no tracked registry agent and no live pid/tmux signal are included.",
            "",
            ...preview,
          ].join("\n"),
        );
        if (confirmed) {
          const reclaimed = await reclaimOrphanWorktreeLocks(orphanLocks.reclaimable);
          if (reclaimed.failed.length === 0) {
            ctx.ui.notify(`Reclaimed ${reclaimed.removed.length} orphan worktree lock(s).`, "info");
          } else {
            ctx.ui.notify(
              `Reclaimed ${reclaimed.removed.length} orphan lock(s); failed ${reclaimed.failed.length}.`,
              "warning",
            );
          }
        }
      }

      if (orphanLocks.blocked.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `Found ${orphanLocks.blocked.length} orphan lock(s) that look live; leaving them untouched.`,
          "warning",
        );
      }
    },
  });

  // -------------------------------------------------------------------------
  // agent-start tool — LLM-callable; no auto context summary (caller provides it)
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "agent-start",
    label: "Agent Start",
    description:
      "Start a background side agent in tmux/worktree. Lifecycle: child should implement the change, then yield for review (do not auto-/quit); parent/user inspects, asks child to wrap up (finish flow), then quits. The description is sent verbatim (no automatic context summary), so include all necessary context. Provide a short kebab-case branchHint (max 3 words) for the agent's branch name. Returns { ok: true, id, tmuxWindowId, tmuxWindowIndex, worktreePath, branch, warnings[] } on success, or { ok: false, error } on failure.",
    // TypeBox schema: Pi validates the LLM's arguments against this before calling execute().
    // Type.Object({ … }) produces a JSON Schema object at runtime.
    // Type.Optional(…) makes a field optional (it may be absent from the LLM's call).
    parameters: Type.Object({
      description: Type.String({ description: "Task description for child agent kickoff prompt (include all necessary context)" }),
      branchHint: Type.String({ description: "Short kebab-case branch slug, max 3 words (e.g. fix-auth-leak)" }),
      model: Type.Optional(Type.String({ description: "Model as provider/modelId (optional)" })),
    }),
    // execute() return type: { content: Array<{ type: "text", text: string }> }
    // Tools must return content blocks — Pi serialises the text as the tool result.
    // Errors are returned as { ok: false, error } JSON rather than throwing, because
    // the LLM needs to read the error message to decide how to proceed.
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        // includeSummary: false — the LLM caller is responsible for providing context.
        const started = await startAgent(pi, ctx, {
          task: params.description,
          branchHint: params.branchHint,
          model: params.model,
          includeSummary: false,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  id: started.id,
                  tmuxWindowId: started.tmuxWindowId,
                  tmuxWindowIndex: started.tmuxWindowIndex,
                  worktreePath: started.worktreePath,
                  branch: started.branch,
                  warnings: started.warnings,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        // Return structured error so the LLM can read it and decide next steps.
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: stringifyError(err) }, null, 2) }],
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // agent-check tool — refresh one agent's status and return recent backlog output
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "agent-check",
    label: "Agent Check",
    description:
      "Check a given side agent status and return compact recent output. Returns { ok: true, agent: { id, status, tmuxWindowId, tmuxWindowIndex, worktreePath, branch, task, startedAt, finishedAt?, exitCode?, error?, warnings[] }, backlog: string[] }, or { ok: false, error } if the agent id is unknown or a registry error occurs. backlog is sanitized/truncated for LLM safety; task is a compact preview. Statuses: allocating_worktree | spawning_tmux | starting | running | waiting_user | finishing | waiting_merge_lock | retrying_reconcile | failed | crashed. Agents that exit with code 0 are auto-removed from registry.",
    parameters: Type.Object({
      id: Type.String({ description: "Agent id" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const payload = await agentCheckPayload(getStateRoot(ctx), params.id);
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: stringifyError(err) }, null, 2) }],
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // agent-wait-any tool — blocking poll until any agent reaches a target state
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "agent-wait-any",
    label: "Agent Wait Any",
    description:
      "Poll until one of the provided agent ids reaches a target state, then return that agent's check payload (same shape as agent-check). Default wait states: waiting_user | failed | crashed. Optionally pass states[] to override. Returns { ok: false, error } immediately if any id is unknown on first pass. Successful exitCode 0 agents are auto-pruned from registry; if all tracked ids disappear, this tool returns an error instead of polling forever. The tool's abort signal is respected between poll cycles (roughly every 1 s).",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ description: "Agent id" }), { description: "Agent ids to wait for" }),
      states: Type.Optional(
        Type.Array(Type.String({ description: "Agent status value" }), {
          description: "Optional target states to wait for. Default: waiting_user, failed, crashed",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const payload = await waitForAny(getStateRoot(ctx), params.ids, signal, params.states);
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: stringifyError(err) }, null, 2) }],
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // agent-send tool — send a steering prompt or interrupt to a running agent
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "agent-send",
    label: "Agent Send",
    description:
      "Send a steering/follow-up prompt to a child agent's tmux pane. Prefix rules: '!' — send C-c interrupt first; if there is additional text after '!', a 300 ms pause is inserted before sending it so Pi can return to interactive prompt. '/' — forwarded as-is; Pi treats lines beginning with '/' as slash commands. Send '!' alone to interrupt without a follow-up. Returns { ok: boolean, message: string }.",
    parameters: Type.Object({
      id: Type.String({ description: "Agent id" }),
      prompt: Type.String({ description: "Prompt text to send (prefix with '!' to interrupt first, '/' for slash commands)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const payload = await sendToAgent(getStateRoot(ctx), params.id, params.prompt);
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: stringifyError(err) }, null, 2) }],
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Pi lifecycle event listeners
  // -------------------------------------------------------------------------

  // session_start: fired when Pi starts a new session (or the extension is loaded).
  // - In child runtime: links the child session into the registry.
  // - In parent runtime: starts (or refreshes) the background status poller.
  pi.on("session_start", async (_event, ctx) => {
    await ensureChildSessionLinked(pi, ctx).catch(() => { });
    ensureStatusPoller(pi, ctx);
  });

  // session_switch: fired when the user switches to a different session branch.
  // Same actions as session_start — the context may have changed.
  pi.on("session_switch", async (_event, ctx) => {
    await ensureChildSessionLinked(pi, ctx).catch(() => { });
    ensureStatusPoller(pi, ctx);
  });

  // agent_start: fired at the beginning of each LLM turn (when Pi starts processing).
  // The child uses this to set its status to "running" in the shared registry,
  // which the parent's poller will pick up and surface in the status bar.
  pi.on("agent_start", async (_event, ctx) => {
    await setChildRuntimeStatus(ctx, "running").catch(() => { });
  });

  // agent_end: fired at the end of each LLM turn (when Pi finishes processing).
  // The child sets status to "waiting_user" so the parent knows it can be reviewed
  // or sent a follow-up prompt.
  pi.on("agent_end", async (_event, ctx) => {
    await setChildRuntimeStatus(ctx, "waiting_user").catch(() => { });
  });

  // before_agent_start: fired just before an LLM turn begins (in the parent runtime).
  // Seeds the status snapshot without emitting transitions — prevents false
  // "status changed" toasts for agents that were already running before this turn.
  pi.on("before_agent_start", async (_event, ctx) => {
    statusPollContext = ctx;
    statusPollApi = pi;
    await renderStatusLine(pi, ctx, { emitTransitions: false }).catch(() => { });
  });
}
