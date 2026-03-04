#!/usr/bin/env bash
set -euo pipefail

AGENT_ID='greeting-response'
PARENT_SESSION='/Users/ext90981/.pi/agent/sessions/--Users-ext90981-GIT-ts-learning--/2026-03-03T15-32-04-230Z_57e13f5e-e0a2-4af6-a400-ff9ec2b7e830.jsonl'
PARENT_REPO='/Users/ext90981/GIT/ts/learning'
STATE_ROOT='/Users/ext90981/GIT/ts/learning'
WORKTREE='/Users/ext90981/GIT/ts/learning-agent-worktree-0001'
WINDOW_ID='@48'
PROMPT_FILE='/Users/ext90981/GIT/ts/learning/.pi/side-agents/runtime/greeting-response/kickoff.md'
EXIT_FILE='/Users/ext90981/GIT/ts/learning/.pi/side-agents/runtime/greeting-response/exit.json'
MODEL_SPEC='anthropic/claude-opus-4-6'
RUNTIME_DIR='/Users/ext90981/GIT/ts/learning/.pi/side-agents/runtime/greeting-response'
START_SCRIPT="$WORKTREE/.pi/side-agent-start.sh"
CHILD_SKILLS_DIR="$WORKTREE/.pi/side-agent-skills"

export PI_SIDE_AGENT_ID="$AGENT_ID"
export PI_SIDE_PARENT_SESSION="$PARENT_SESSION"
export PI_SIDE_PARENT_REPO="$PARENT_REPO"
export PI_SIDE_AGENTS_ROOT="$STATE_ROOT"
export PI_SIDE_RUNTIME_DIR="$RUNTIME_DIR"

write_exit() {
  local code="$1"
  printf '{"exitCode":%d,"finishedAt":"%s"}
' "$code" "$(date -Is)" > "$EXIT_FILE"
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
"${PI_CMD[@]}" "$(cat "$PROMPT_FILE")"
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
