#!/bin/bash
# Aha Loop Unattended Runner
# Keeps orchestrator execute loop running with retry/backoff until work is complete.
#
# Usage:
#   ./unattended-runner.sh --workspace /path/to/project --tool codex
#   ./unattended-runner.sh --workspace /path/to/project --once

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/paths.sh"

TOOL="codex"
PHASE="execute"
MAX_PRDS="all"
MAX_ITERATIONS=10
CLI_WORKSPACE=""
RETRY_LIMIT=0
BACKOFF_SECONDS=20
MAX_BACKOFF_SECONDS=600
MAX_CYCLES=0
ONCE=false
RUNNER_LOCK_HELD=false

usage() {
  echo "Aha Loop Unattended Runner"
  echo ""
  echo "Usage: $0 [options]"
  echo ""
  echo "Options:"
  echo "  --workspace PATH      Target workspace root (required for external projects)"
  echo "  --tool NAME           Tool for orchestrator (amp|claude|codex, default: codex)"
  echo "  --phase NAME          Orchestrator phase (default: execute)"
  echo "  --max-prds N|all      PRDs per orchestrator run (default: all)"
  echo "  --max-iterations N    Iterations per PRD run (default: 10)"
  echo "  --retry-limit N       Stop after N consecutive failures (0 = unlimited, default)"
  echo "  --backoff-seconds N   Initial retry backoff in seconds (default: 20)"
  echo "  --max-backoff N       Maximum retry backoff in seconds (default: 600)"
  echo "  --max-cycles N        Stop after N cycles even if unfinished (0 = unlimited)"
  echo "  --once                Run a single cycle only"
  echo "  --help                Show this help"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      CLI_WORKSPACE="$2"
      shift 2
      ;;
    --workspace=*)
      CLI_WORKSPACE="${1#*=}"
      shift
      ;;
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    --phase)
      PHASE="$2"
      shift 2
      ;;
    --phase=*)
      PHASE="${1#*=}"
      shift
      ;;
    --max-prds)
      MAX_PRDS="$2"
      shift 2
      ;;
    --max-prds=*)
      MAX_PRDS="${1#*=}"
      shift
      ;;
    --max-iterations)
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    --max-iterations=*)
      MAX_ITERATIONS="${1#*=}"
      shift
      ;;
    --retry-limit)
      RETRY_LIMIT="$2"
      shift 2
      ;;
    --retry-limit=*)
      RETRY_LIMIT="${1#*=}"
      shift
      ;;
    --backoff-seconds)
      BACKOFF_SECONDS="$2"
      shift 2
      ;;
    --backoff-seconds=*)
      BACKOFF_SECONDS="${1#*=}"
      shift
      ;;
    --max-backoff)
      MAX_BACKOFF_SECONDS="$2"
      shift 2
      ;;
    --max-backoff=*)
      MAX_BACKOFF_SECONDS="${1#*=}"
      shift
      ;;
    --max-cycles)
      MAX_CYCLES="$2"
      shift 2
      ;;
    --max-cycles=*)
      MAX_CYCLES="${1#*=}"
      shift
      ;;
    --once)
      ONCE=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ "$TOOL" != "amp" && "$TOOL" != "claude" && "$TOOL" != "codex" ]]; then
  echo "Error: --tool must be amp, claude, or codex"
  exit 1
fi

if [ "$MAX_PRDS" != "all" ] && ! [[ "$MAX_PRDS" =~ ^[0-9]+$ ]]; then
  echo "Error: --max-prds must be a number or 'all'"
  exit 1
fi

for n in "$MAX_ITERATIONS" "$RETRY_LIMIT" "$BACKOFF_SECONDS" "$MAX_BACKOFF_SECONDS" "$MAX_CYCLES"; do
  if ! [[ "$n" =~ ^[0-9]+$ ]]; then
    echo "Error: numeric options must be non-negative integers"
    exit 1
  fi
done

init_paths --workspace "$CLI_WORKSPACE"
export_paths
cd "$WORKSPACE_ROOT"

mkdir -p "$LOGS_DIR" "$AHA_LOOP_DIR/locks"
RUNNER_LOCK_PATH="$AHA_LOOP_DIR/locks/unattended-runner.lock"
RUNNER_HEARTBEAT_FILE="$LOGS_DIR/unattended-heartbeat.json"
RUNNER_LOG_FILE="$LOGS_DIR/unattended-runner.log"

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

pending_prds_count() {
  if [ ! -f "$ROADMAP_FILE" ]; then
    echo "-1"
    return 0
  fi
  jq '[.milestones[].prds[] | select(.status == "pending" or .status == "in_progress")] | length' "$ROADMAP_FILE" 2>/dev/null || echo "-1"
}

pending_stories_count() {
  if [ ! -f "$PRD_FILE" ]; then
    echo "-1"
    return 0
  fi
  jq '[.userStories[]? | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null || echo "-1"
}

write_runner_heartbeat() {
  local status="$1"
  local cycle="$2"
  local consecutive_failures="$3"
  local last_exit="$4"
  local message="$5"
  local p_prds
  local p_stories
  p_prds="$(pending_prds_count)"
  p_stories="$(pending_stories_count)"

  if ! [[ "$p_prds" =~ ^-?[0-9]+$ ]]; then
    p_prds="-1"
  fi
  if ! [[ "$p_stories" =~ ^-?[0-9]+$ ]]; then
    p_stories="-1"
  fi

  jq -n \
    --arg ts "$(timestamp_utc)" \
    --arg status "$status" \
    --arg workspace "$WORKSPACE_ROOT" \
    --arg tool "$TOOL" \
    --arg phase "$PHASE" \
    --arg message "$message" \
    --argjson pid "$$" \
    --argjson cycle "$cycle" \
    --argjson consecutiveFailures "$consecutive_failures" \
    --argjson lastExitCode "$last_exit" \
    --argjson pendingPrds "$p_prds" \
    --argjson pendingStories "$p_stories" \
    '{
      timestamp: $ts,
      status: $status,
      workspace: $workspace,
      tool: $tool,
      phase: $phase,
      pid: $pid,
      cycle: $cycle,
      consecutiveFailures: $consecutiveFailures,
      lastExitCode: $lastExitCode,
      pendingPrds: $pendingPrds,
      pendingStories: $pendingStories,
      message: $message
    }' > "${RUNNER_HEARTBEAT_FILE}.tmp" 2>/dev/null && mv "${RUNNER_HEARTBEAT_FILE}.tmp" "$RUNNER_HEARTBEAT_FILE" || true
}

acquire_runner_lock() {
  if mkdir "$RUNNER_LOCK_PATH" 2>/dev/null; then
    echo "$$" > "$RUNNER_LOCK_PATH/pid"
    echo "$(date +%s)" > "$RUNNER_LOCK_PATH/started_at_epoch"
    RUNNER_LOCK_HELD=true
    return 0
  fi

  local existing_pid=""
  if [ -f "$RUNNER_LOCK_PATH/pid" ]; then
    existing_pid=$(cat "$RUNNER_LOCK_PATH/pid" 2>/dev/null || true)
  fi

  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "Another unattended runner is already active (pid=$existing_pid)."
    return 1
  fi

  rm -rf "$RUNNER_LOCK_PATH" 2>/dev/null || true
  if mkdir "$RUNNER_LOCK_PATH" 2>/dev/null; then
    echo "$$" > "$RUNNER_LOCK_PATH/pid"
    echo "$(date +%s)" > "$RUNNER_LOCK_PATH/started_at_epoch"
    RUNNER_LOCK_HELD=true
    return 0
  fi

  return 1
}

release_runner_lock() {
  if [ "$RUNNER_LOCK_HELD" = "true" ] && [ -d "$RUNNER_LOCK_PATH" ]; then
    rm -rf "$RUNNER_LOCK_PATH" 2>/dev/null || true
    RUNNER_LOCK_HELD=false
  fi
}

on_runner_exit() {
  local ec="$1"
  if [ "$ec" -eq 0 ]; then
    write_runner_heartbeat "stopped" "${CYCLE:-0}" "${CONSECUTIVE_FAILURES:-0}" "${LAST_EXIT_CODE:-0}" "Unattended runner exited"
  else
    write_runner_heartbeat "failed" "${CYCLE:-0}" "${CONSECUTIVE_FAILURES:-0}" "${LAST_EXIT_CODE:-$ec}" "Unattended runner exited with failure"
  fi
  release_runner_lock
}

if ! acquire_runner_lock; then
  exit 0
fi
trap 'on_runner_exit $?' EXIT
trap 'write_runner_heartbeat "interrupted" "${CYCLE:-0}" "${CONSECUTIVE_FAILURES:-0}" "${LAST_EXIT_CODE:-130}" "Interrupted by signal"; release_runner_lock; trap - EXIT; exit 130' INT TERM

echo "[$(timestamp_utc)] unattended-runner start: workspace=$WORKSPACE_ROOT tool=$TOOL phase=$PHASE" | tee -a "$RUNNER_LOG_FILE"

CYCLE=0
CONSECUTIVE_FAILURES=0
LAST_EXIT_CODE=0
BACKOFF_CURRENT="$BACKOFF_SECONDS"

while true; do
  CYCLE=$((CYCLE + 1))
  write_runner_heartbeat "running" "$CYCLE" "$CONSECUTIVE_FAILURES" "$LAST_EXIT_CODE" "Starting orchestrator cycle"

  echo "[$(timestamp_utc)] cycle=$CYCLE running orchestrator..." | tee -a "$RUNNER_LOG_FILE"

  cmd=("$SCRIPT_DIR/orchestrator.sh" "--tool" "$TOOL" "--phase" "$PHASE" "--max-prds" "$MAX_PRDS" "--max-iterations" "$MAX_ITERATIONS")
  if [[ "$WORKSPACE_MODE" == "true" ]]; then
    cmd+=("--workspace" "$WORKSPACE_ROOT")
  fi

  set +e
  "${cmd[@]}" >> "$RUNNER_LOG_FILE" 2>&1
  LAST_EXIT_CODE=$?
  set -e

  local_pending_prds="$(pending_prds_count)"
  local_pending_stories="$(pending_stories_count)"

  if [ "$LAST_EXIT_CODE" -eq 0 ]; then
    CONSECUTIVE_FAILURES=0
    BACKOFF_CURRENT="$BACKOFF_SECONDS"
    write_runner_heartbeat "running" "$CYCLE" "$CONSECUTIVE_FAILURES" "$LAST_EXIT_CODE" "Cycle completed successfully"
    echo "[$(timestamp_utc)] cycle=$CYCLE success pendingPrds=$local_pending_prds pendingStories=$local_pending_stories" | tee -a "$RUNNER_LOG_FILE"

    if [ "$ONCE" = "true" ]; then
      break
    fi

    if [[ "$local_pending_prds" =~ ^[0-9]+$ ]] && [ "$local_pending_prds" -eq 0 ]; then
      if [[ "$local_pending_stories" =~ ^-?[0-9]+$ ]] && { [ "$local_pending_stories" -eq 0 ] || [ "$local_pending_stories" -eq -1 ]; }; then
        write_runner_heartbeat "complete" "$CYCLE" "$CONSECUTIVE_FAILURES" "$LAST_EXIT_CODE" "No pending PRDs/stories remain"
        echo "[$(timestamp_utc)] unattended-runner complete: no pending work remains." | tee -a "$RUNNER_LOG_FILE"
        break
      fi
    fi

    sleep 5
  else
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    write_runner_heartbeat "retrying" "$CYCLE" "$CONSECUTIVE_FAILURES" "$LAST_EXIT_CODE" "Cycle failed; scheduling retry"
    echo "[$(timestamp_utc)] cycle=$CYCLE failed exit=$LAST_EXIT_CODE consecutiveFailures=$CONSECUTIVE_FAILURES retryIn=${BACKOFF_CURRENT}s" | tee -a "$RUNNER_LOG_FILE"

    if [ "$ONCE" = "true" ]; then
      exit "$LAST_EXIT_CODE"
    fi

    if [ "$RETRY_LIMIT" -gt 0 ] && [ "$CONSECUTIVE_FAILURES" -ge "$RETRY_LIMIT" ]; then
      echo "[$(timestamp_utc)] retry limit reached ($RETRY_LIMIT). stopping." | tee -a "$RUNNER_LOG_FILE"
      exit 1
    fi

    sleep "$BACKOFF_CURRENT"
    if [ "$BACKOFF_CURRENT" -lt "$MAX_BACKOFF_SECONDS" ]; then
      BACKOFF_CURRENT=$((BACKOFF_CURRENT * 2))
      if [ "$BACKOFF_CURRENT" -gt "$MAX_BACKOFF_SECONDS" ]; then
        BACKOFF_CURRENT="$MAX_BACKOFF_SECONDS"
      fi
    fi
  fi

  if [ "$MAX_CYCLES" -gt 0 ] && [ "$CYCLE" -ge "$MAX_CYCLES" ]; then
    echo "[$(timestamp_utc)] max cycles reached ($MAX_CYCLES). stopping." | tee -a "$RUNNER_LOG_FILE"
    break
  fi
done

exit 0
