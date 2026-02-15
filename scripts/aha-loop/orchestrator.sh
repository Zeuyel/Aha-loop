#!/bin/bash
# Aha Loop Orchestrator - Autonomous Project Management
# Manages the full project lifecycle from vision to completion
#
# Usage:
#   ./orchestrator.sh [--tool amp|claude|codex] [--phase vision|architect|roadmap|execute|all]
#   ./orchestrator.sh --build-vision      Interactive vision building
#   ./orchestrator.sh --explore "task"    Start parallel exploration
#   ./orchestrator.sh --maintenance       Run maintenance tasks
#   ./orchestrator.sh --workspace /path   Operate on external workspace
#   ./orchestrator.sh --init-workspace /path  Initialize new workspace
#
# Phases:
#   vision    - Parse project.vision.md and create vision analysis
#   architect - Research and decide on technology stack
#   roadmap   - Create project roadmap with milestones and PRDs
#   execute   - Execute PRDs using aha-loop.sh
#   all       - Run all phases (default)

set -e

# Get script directory for sourcing lib
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source path resolution library
source "$SCRIPT_DIR/lib/paths.sh"

# Default settings
TOOL="claude"
PHASE="all"
MAX_PRDS=999
MAX_ITERATIONS=10
SINGLE_INSTANCE_LOCK=true
LOCK_STALE_SECONDS=7200
CODEX_PROFILE="${AHA_CODEX_PROFILE:-}"
CODEX_SANDBOX="${AHA_CODEX_SANDBOX:-workspace-write}"
CODEX_APPROVAL="${AHA_CODEX_APPROVAL:-never}"
CODEX_FLAGS="${AHA_CODEX_FLAGS:-}"
BUILD_VISION=false
EXPLORE_TASK=""
MAINTENANCE=false
INIT_WORKSPACE=""
CLI_WORKSPACE=""
ORCH_LOCK_HELD=false
ORCH_CURRENT_PHASE="init"
ORCH_CURRENT_PRD=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
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
    --max-iterations)
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    --max-iterations=*)
      MAX_ITERATIONS="${1#*=}"
      shift
      ;;
    --build-vision)
      BUILD_VISION=true
      shift
      ;;
    --explore)
      EXPLORE_TASK="$2"
      shift 2
      ;;
    --explore=*)
      EXPLORE_TASK="${1#*=}"
      shift
      ;;
    --maintenance)
      MAINTENANCE=true
      shift
      ;;
    --workspace)
      CLI_WORKSPACE="$2"
      shift 2
      ;;
    --workspace=*)
      CLI_WORKSPACE="${1#*=}"
      shift
      ;;
    --init-workspace)
      INIT_WORKSPACE="$2"
      shift 2
      ;;
    --init-workspace=*)
      INIT_WORKSPACE="${1#*=}"
      shift
      ;;
    --help|-h)
      echo "Aha Loop Orchestrator - Autonomous Project Management"
      echo ""
      echo "Usage: ./orchestrator.sh [options]"
      echo ""
      echo "Options:"
      echo "  --tool amp|claude|codex    AI tool to use (default: claude)"
      echo "  --phase PHASE        Phase to run (vision|architect|roadmap|execute|all)"
      echo "  --max-prds N|all     Maximum PRDs to execute per run (default: 999)"
      echo "  --max-iterations N   Maximum iterations per PRD (default: 10)"
      echo "  --build-vision       Interactive vision building"
      echo "  --explore TASK       Start parallel exploration for a task"
      echo "  --maintenance        Run maintenance tasks (doc cleanup, skill review)"
      echo "  --workspace PATH     Operate on external workspace directory"
      echo "  --init-workspace PATH  Initialize new workspace at PATH"
      echo "  --help               Show this help message"
      echo ""
      echo "Codex environment overrides:"
      echo "  AHA_CODEX_SANDBOX    Sandbox mode (default: workspace-write)"
      echo "  AHA_CODEX_APPROVAL   Approval policy (default: never)"
      echo "  AHA_CODEX_PROFILE    Codex profile name (optional)"
      echo "  AHA_CODEX_FLAGS      Extra codex exec flags (optional)"
      echo ""
      echo "Phases:"
      echo "  vision     Parse project.vision.md"
      echo "  architect  Design architecture and select tech stack"
      echo "  roadmap    Create project roadmap"
      echo "  execute    Execute PRDs with aha-loop.sh"
      echo "  all        Run all phases in sequence"
      echo ""
      echo "Workspace Mode:"
      echo "  Aha Loop can operate on external projects without copying files."
      echo "  All Aha Loop data is stored in .aha-loop/ within the workspace."
      echo ""
      echo "Examples:"
      echo "  ./orchestrator.sh                          # Run all phases"
      echo "  ./orchestrator.sh --build-vision           # Interactive vision building"
      echo "  ./orchestrator.sh --explore 'auth system'  # Parallel exploration"
      echo "  ./orchestrator.sh --maintenance            # Run maintenance"
      echo "  ./orchestrator.sh --init-workspace /path/to/project  # Initialize workspace"
      echo "  ./orchestrator.sh --workspace /path/to/project       # Use existing workspace"
      exit 0
      ;;
    *)
      shift
      ;;
  esac
done

# Preserve parsed CLI values so config can fill defaults only when not overridden.
MAX_PRDS_CLI="$MAX_PRDS"
MAX_ITERATIONS_CLI="$MAX_ITERATIONS"

# Handle --init-workspace first (before path initialization)
if [[ -n "$INIT_WORKSPACE" ]]; then
  # Resolve to absolute path
  if [[ "$INIT_WORKSPACE" == "." ]]; then
    INIT_WORKSPACE="$(pwd)"
  elif [[ "$INIT_WORKSPACE" = /* ]]; then
    # Already absolute path, keep as is
    :
  else
    # Relative path - convert to absolute
    INIT_WORKSPACE="$(pwd)/$INIT_WORKSPACE"
  fi

  # Create directory if it doesn't exist
  mkdir -p "$INIT_WORKSPACE"

  # Resolve AHA_LOOP_HOME for resource copying
  AHA_LOOP_HOME=$(resolve_aha_loop_home)

  # Initialize workspace with resource copying
  init_workspace "$INIT_WORKSPACE" "$AHA_LOOP_HOME"
  exit 0
fi

# Keep skill provider aligned with selected tool
# Initialize paths (handles workspace detection)
export AHA_SKILL_PROVIDER="$TOOL"
init_paths --workspace "$CLI_WORKSPACE"
export_paths

# Ensure all git operations and AI tool runs happen in the target workspace.
cd "$WORKSPACE_ROOT"

# Ensure directories exist
mkdir -p "$LOGS_DIR"
mkdir -p "$RESEARCH_DIR"
mkdir -p "$EXPLORATION_DIR"
mkdir -p "$ARCHIVE_DIR"
mkdir -p "$TASKS_DIR"
mkdir -p "$AHA_LOOP_DIR/locks"

LOCKS_DIR="$AHA_LOOP_DIR/locks"
ORCH_LOCK_PATH="$LOCKS_DIR/orchestrator.lock"
ORCH_HEARTBEAT_FILE="$LOGS_DIR/orchestrator-heartbeat.json"

# Validate tool
if [[ "$TOOL" != "amp" && "$TOOL" != "claude" && "$TOOL" != "codex" ]]; then
  echo "Error: Invalid tool '$TOOL'. Must be 'amp', 'claude', or 'codex'."
  exit 1
fi

if [[ "$TOOL" == "codex" ]]; then
  if ! command -v codex >/dev/null 2>&1; then
    echo "Error: codex CLI not found in PATH. Install Codex CLI or use --tool amp|claude."
    exit 1
  fi
fi

# Validate phase
VALID_PHASES="vision architect roadmap execute all"
if [[ ! " $VALID_PHASES " =~ " $PHASE " ]]; then
  echo "Error: Invalid phase '$PHASE'."
  echo "Valid phases: $VALID_PHASES"
  exit 1
fi

# Load config if exists (only use config values if not overridden by command line)
CONFIG_MAX_PRDS=999
CONFIG_MAX_ITERATIONS=10
if [ -f "$CONFIG_FILE" ]; then
  CONFIG_MAX_PRDS=$(jq -r '.orchestrator.maxPRDsPerRun // 999' "$CONFIG_FILE")
  CONFIG_MAX_ITERATIONS=$(jq -r '.safeguards.maxIterationsPerStory // 10' "$CONFIG_FILE")
  SINGLE_INSTANCE_LOCK=$(jq -r '.orchestrator.singleInstanceLock // true' "$CONFIG_FILE")
  LOCK_STALE_SECONDS=$(jq -r '.orchestrator.lockStaleSeconds // 7200' "$CONFIG_FILE")
  OBSERVABILITY_ENABLED=$(jq -r '.observability.enabled // true' "$CONFIG_FILE")
  PARALLEL_ENABLED=$(jq -r '.parallelExploration.enabled // true' "$CONFIG_FILE")
  DOC_MAINTENANCE_ENABLED=$(jq -r '.docMaintenance.enabled // true' "$CONFIG_FILE")
else
  OBSERVABILITY_ENABLED=true
  PARALLEL_ENABLED=true
  DOC_MAINTENANCE_ENABLED=true
fi

# Apply config values only if not overridden by command line (still at default)
if [ "$MAX_PRDS_CLI" = "999" ] && [ "$CONFIG_MAX_PRDS" != "999" ] && [ "$CONFIG_MAX_PRDS" != "10" ]; then
  MAX_PRDS="$CONFIG_MAX_PRDS"
fi
if [ "$MAX_ITERATIONS_CLI" = "10" ] && [ "$CONFIG_MAX_ITERATIONS" != "10" ]; then
  MAX_ITERATIONS="$CONFIG_MAX_ITERATIONS"
fi

if [ "$MAX_PRDS" = "all" ]; then
  MAX_PRDS=2147483647
fi

if ! [[ "$MAX_PRDS" =~ ^[0-9]+$ ]]; then
  echo "Error: --max-prds must be a number or 'all' (got: $MAX_PRDS)"
  exit 1
fi

if ! [[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Error: --max-iterations must be a number (got: $MAX_ITERATIONS)"
  exit 1
fi

# Helper: Check for critical directives from God Committee
check_critical_directives() {
  if [ ! -f "$DIRECTIVES_FILE" ]; then
    return 1
  fi
  
  local critical_count=$(jq '[.directives[] | select(.status == "active" and .priority == "critical")] | length' "$DIRECTIVES_FILE" 2>/dev/null || echo "0")
  
  if [ "$critical_count" -gt 0 ]; then
    return 0
  fi
  return 1
}

# Helper: Get active directives for display
get_directives_summary() {
  if [ ! -f "$DIRECTIVES_FILE" ]; then
    echo "No directives"
    return
  fi
  
  local active=$(jq '[.directives[] | select(.status == "active")] | length' "$DIRECTIVES_FILE" 2>/dev/null || echo "0")
  local critical=$(jq '[.directives[] | select(.status == "active" and .priority == "critical")] | length' "$DIRECTIVES_FILE" 2>/dev/null || echo "0")
  local guidance=$(jq '.guidance | length' "$DIRECTIVES_FILE" 2>/dev/null || echo "0")
  
  echo "Directives: $active active ($critical critical), Guidance: $guidance"
}

# Helper: Build directives context for AI
build_directives_context() {
  local target_prd="${1:-}"
  
  if [ ! -f "$DIRECTIVES_FILE" ]; then
    echo ""
    return
  fi
  
  local context=""
  
  # Get active directives
  local directives
  if [ -n "$target_prd" ]; then
    directives=$(jq -r --arg prd "$target_prd" '
      [.directives[] | select(.status == "active" and (.targetPrd == null or .targetPrd == $prd))] |
      if length > 0 then
        "## God Committee Directives\n\n" +
        (map("- [\(.priority | ascii_upcase)] \(.content)") | join("\n"))
      else ""
      end
    ' "$DIRECTIVES_FILE" 2>/dev/null)
  else
    directives=$(jq -r '
      [.directives[] | select(.status == "active")] |
      if length > 0 then
        "## God Committee Directives\n\n" +
        (map("- [\(.priority | ascii_upcase)] \(.content)") | join("\n"))
      else ""
      end
    ' "$DIRECTIVES_FILE" 2>/dev/null)
  fi
  
  if [ -n "$directives" ] && [ "$directives" != "" ]; then
    context="$directives\n\n"
  fi
  
  # Get guidance
  local guidance
  if [ -n "$target_prd" ]; then
    guidance=$(jq -r --arg prd "$target_prd" '
      [.guidance[] | select(.targetPrd == null or .targetPrd == $prd)] |
      if length > 0 then
        "## Committee Guidance\n\n" +
        (map("- \(.content)") | join("\n"))
      else ""
      end
    ' "$DIRECTIVES_FILE" 2>/dev/null)
  else
    guidance=$(jq -r '
      .guidance |
      if length > 0 then
        "## Committee Guidance\n\n" +
        (map("- \(.content)") | join("\n"))
      else ""
      end
    ' "$DIRECTIVES_FILE" 2>/dev/null)
  fi
  
  if [ -n "$guidance" ] && [ "$guidance" != "" ]; then
    context="${context}${guidance}\n\n"
  fi
  
  # Get recent summaries
  local summaries=$(jq -r '
    .summaries[-3:] |
    if length > 0 then
      "## Recent Committee Discussions\n\n" +
      (map("- \(.content | .[0:200])...") | join("\n"))
    else ""
    end
  ' "$DIRECTIVES_FILE" 2>/dev/null)
  
  if [ -n "$summaries" ] && [ "$summaries" != "" ]; then
    context="${context}${summaries}\n\n"
  fi
  
  echo -e "$context"
}

# Helper: Write a heartbeat JSON snapshot for unattended monitoring.
write_orchestrator_heartbeat() {
  local status="$1"
  local message="${2:-}"
  local exit_code="${3:-0}"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local pending_prds="null"
  if [ -f "$ROADMAP_FILE" ]; then
    pending_prds=$(jq '[.milestones[].prds[] | select(.status == "pending" or .status == "in_progress")] | length' "$ROADMAP_FILE" 2>/dev/null || echo "null")
    if ! [[ "$pending_prds" =~ ^[0-9]+$ ]]; then
      pending_prds="null"
    fi
  fi

  jq -n \
    --arg ts "$ts" \
    --arg status "$status" \
    --arg phase "$ORCH_CURRENT_PHASE" \
    --arg prd "$ORCH_CURRENT_PRD" \
    --arg workspace "$WORKSPACE_ROOT" \
    --arg message "$message" \
    --arg tool "$TOOL" \
    --argjson pid "$$" \
    --argjson exitCode "$exit_code" \
    --argjson pendingPrds "$pending_prds" \
    '{
      timestamp: $ts,
      status: $status,
      phase: $phase,
      currentPrd: (if $prd == "" then null else $prd end),
      tool: $tool,
      workspace: $workspace,
      pid: $pid,
      pendingPrds: $pendingPrds,
      exitCode: $exitCode,
      message: $message
    }' > "${ORCH_HEARTBEAT_FILE}.tmp" 2>/dev/null && mv "${ORCH_HEARTBEAT_FILE}.tmp" "$ORCH_HEARTBEAT_FILE" || true
}

# Helper: Acquire single-instance lock for orchestrator.
acquire_orchestrator_lock() {
  if [ "$SINGLE_INSTANCE_LOCK" != "true" ]; then
    return 0
  fi

  local now
  now=$(date +%s)

  if mkdir "$ORCH_LOCK_PATH" 2>/dev/null; then
    echo "$$" > "$ORCH_LOCK_PATH/pid"
    echo "$now" > "$ORCH_LOCK_PATH/started_at_epoch"
    ORCH_LOCK_HELD=true
    return 0
  fi

  local existing_pid=""
  local started_at=""
  if [ -f "$ORCH_LOCK_PATH/pid" ]; then
    existing_pid=$(cat "$ORCH_LOCK_PATH/pid" 2>/dev/null || true)
  fi
  if [ -f "$ORCH_LOCK_PATH/started_at_epoch" ]; then
    started_at=$(cat "$ORCH_LOCK_PATH/started_at_epoch" 2>/dev/null || true)
  fi

  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "Another orchestrator instance is already running (pid=$existing_pid)."
    return 1
  fi

  if [ -z "$existing_pid" ] && [[ "$started_at" =~ ^[0-9]+$ ]]; then
    local age=$((now - started_at))
    if [ "$age" -lt "$LOCK_STALE_SECONDS" ]; then
      echo "Orchestrator lock exists without pid and is not stale yet (${age}s < ${LOCK_STALE_SECONDS}s)."
      return 1
    fi
  fi

  echo "Reclaiming stale orchestrator lock..."
  rm -rf "$ORCH_LOCK_PATH" 2>/dev/null || true
  if mkdir "$ORCH_LOCK_PATH" 2>/dev/null; then
    echo "$$" > "$ORCH_LOCK_PATH/pid"
    echo "$now" > "$ORCH_LOCK_PATH/started_at_epoch"
    ORCH_LOCK_HELD=true
    return 0
  fi

  echo "Failed to acquire orchestrator lock."
  return 1
}

release_orchestrator_lock() {
  if [ "$ORCH_LOCK_HELD" = "true" ] && [ -d "$ORCH_LOCK_PATH" ]; then
    rm -rf "$ORCH_LOCK_PATH" 2>/dev/null || true
    ORCH_LOCK_HELD=false
  fi
}

on_orchestrator_signal() {
  ORCH_CURRENT_PHASE="signal"
  write_orchestrator_heartbeat "interrupted" "Orchestrator interrupted by signal" 130
  release_orchestrator_lock
  trap - EXIT
  exit 130
}

on_orchestrator_exit() {
  local exit_code="$1"
  if [ "$exit_code" -eq 0 ]; then
    write_orchestrator_heartbeat "complete" "Orchestrator finished successfully" "$exit_code"
  else
    write_orchestrator_heartbeat "failed" "Orchestrator exited with error" "$exit_code"
  fi
  release_orchestrator_lock
}

if ! acquire_orchestrator_lock; then
  exit 0
fi

trap on_orchestrator_signal INT TERM
trap 'on_orchestrator_exit $?' EXIT
ORCH_CURRENT_PHASE="startup"
write_orchestrator_heartbeat "running" "Orchestrator starting" 0

# Print header
echo "========================================"
echo "  Aha Loop Orchestrator"
echo "  Autonomous Project Management"
echo "========================================"
echo "Tool: $TOOL"
if [[ "$TOOL" == "codex" ]]; then
  echo "Codex Sandbox: $CODEX_SANDBOX"
  echo "Codex Approval: $CODEX_APPROVAL"
  if [ -n "$CODEX_PROFILE" ]; then
    echo "Codex Profile: $CODEX_PROFILE"
  fi
fi
echo "Phase: $PHASE"
if [[ "$WORKSPACE_MODE" == "true" ]]; then
  echo "Mode: Workspace"
  echo "Workspace: $WORKSPACE_ROOT"
  echo "Aha Loop: $AHA_LOOP_HOME"
else
  echo "Mode: Standalone"
  echo "Project: $WORKSPACE_ROOT"
fi
echo "$(get_directives_summary)"
echo "========================================"
echo ""

# Check for critical directives before proceeding
if check_critical_directives; then
  echo "!!! CRITICAL DIRECTIVES FROM GOD COMMITTEE !!!"
  echo ""
  jq -r '.directives[] | select(.status == "active" and .priority == "critical") | "[\(.author)] \(.content)"' "$DIRECTIVES_FILE" 2>/dev/null
  echo ""
  echo "Execution is paused due to critical directives."
  echo "Please address these issues before continuing."
  echo ""
  echo "To view all directives: ./scripts/god/council.sh directives"
  echo "To mark resolved: ./scripts/god/council.sh complete DIRECTIVE_ID"
  echo ""
  exit 1
fi

# Helper: Log to observability file
log_thought() {
  if [ "$OBSERVABILITY_ENABLED" != "true" ]; then
    return
  fi
  
  local task="$1"
  local phase="$2"
  local content="$3"
  
  local timestamp=$(date +"%Y-%m-%d %H:%M:%S")
  
  cat >> "$LOG_FILE" << EOF

## $timestamp | Task: $task | Phase: $phase

$content

---
EOF
}

# Helper: Record skill usage for maintenance metrics
record_skill_usage() {
  local skill_name="$1"
  if [ -z "$skill_name" ]; then
    return
  fi
  AHA_SKILL_PROVIDER="$TOOL" "$SCRIPT_DIR/skill-manager.sh" use "$skill_name" >/dev/null 2>&1 || true
}

# Helper: Return first pending/in-progress PRD across all milestones
get_next_pending_prd() {
  jq -r '
    [.milestones[].prds[] | select(.status == "pending" or .status == "in_progress")][0].id // empty
  ' "$ROADMAP_FILE" 2>/dev/null
}

# Helper: True if roadmap still has any pending/in-progress PRD
has_pending_prds() {
  local count
  count=$(jq '[.milestones[].prds[] | select(.status == "pending" or .status == "in_progress")] | length' "$ROADMAP_FILE" 2>/dev/null || echo "0")
  [ "$count" -gt 0 ]
}

# Helper: True if task markdown files still declare pending work
has_pending_task_docs() {
  if [ ! -d "$TASKS_DIR" ]; then
    return 1
  fi

  local file
  shopt -s nullglob
  for file in "$TASKS_DIR"/prd-*.md; do
    if grep -Eiq '^(Status:|\\*\\*Status:\\*\\*)[[:space:]]*(Pending|In Progress)' "$file"; then
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

# Helper: Update PRD task markdown Status line (supports "Status:" and "**Status:**")
update_prd_task_doc_status() {
  local file="$1"
  local status="$2" # Pending | In Progress | Completed

  if [ -z "$file" ] || [ ! -f "$file" ] || [ -z "$status" ]; then
    return 0
  fi

  if grep -Eq '^\*\*Status:\*\*' "$file"; then
    sed -i "s/^\\*\\*Status:\\*\\* .*/\\*\\*Status:\\*\\* ${status}/" "$file"
  elif grep -Eq '^Status:' "$file"; then
    sed -i "s/^Status: .*/Status: ${status}/" "$file"
  fi
}

# Helper: Mark PRD completed in roadmap + task doc (idempotent reconciliation path)
mark_prd_completed_in_roadmap() {
  local prd_id="$1"
  local prd_task_file="$2"
  local reason="${3:-PRD completed successfully}"

  if [ -z "$prd_id" ] || [ ! -f "$ROADMAP_FILE" ]; then
    return 1
  fi

  update_prd_task_doc_status "$prd_task_file" "Completed"

  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  jq --arg id "$prd_id" --arg ts "$timestamp" --arg reason "$reason" '
    (.milestones[].prds[] | select(.id == $id)).status = "completed" |
    (.milestones[].prds[] | select(.id == $id)).completedAt = $ts |
    .currentPRD = null |
    .changelog += [{
      "timestamp": $ts,
      "action": "prd_completed",
      "prdId": $id,
      "description": $reason
    }]
  ' "$ROADMAP_FILE" > "$ROADMAP_FILE.tmp" && mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"

  log_thought "$prd_id" "Complete" "### PRD Completed

PRD $prd_id marked completed. Reason: $reason"
}

# Helper: Merge stateful fields from previous prd.json into a newly regenerated one (same prdId)
merge_prd_json_state() {
  local old_file="$1"
  local new_file="$2"
  local out_file="$3"

  if [ -z "$old_file" ] || [ -z "$new_file" ] || [ -z "$out_file" ]; then
    return 1
  fi

  jq -s '
    .[0] as $old
    | .[1] as $new
    | ($old.prdId // "") as $oldId
    | ($new.prdId // "") as $newId
    | if $oldId == "" or $newId == "" or $oldId != $newId then
        $new
      else
        $new
        | .changeLog = ($old.changeLog // .changeLog // [])
        | .userStories |= (
            map(
              . as $s
              | ($old.userStories[]? | select(.id == $s.id)) as $o
              | if $o then
                  $s
                  | .passes = ($o.passes // $s.passes)
                  | .researchCompleted = ($o.researchCompleted // $s.researchCompleted)
                  | .explorationCompleted = ($o.explorationCompleted // $s.explorationCompleted)
                  | .explorationResult = ($o.explorationResult // $s.explorationResult)
                  | .learnings = ($o.learnings // $s.learnings)
                  | .implementationNotes = ($o.implementationNotes // $s.implementationNotes)
                  | .notes = ($o.notes // $s.notes)
                else
                  $s
                end
            )
          )
      end
  ' "$old_file" "$new_file" > "$out_file"
}

# Helper: Get normalized status from a PRD task markdown file.
# Returns: pending | in_progress | completed | "" (unknown)
get_prd_task_doc_status() {
  local file="$1"

  if [ -z "$file" ] || [ ! -f "$file" ]; then
    echo ""
    return 0
  fi

  local line=""
  line=$(grep -Ei '^(Status:|\\*\\*Status:\\*\\*)' "$file" | head -1 | tr -d '\r' 2>/dev/null || true)
  if [ -z "$line" ]; then
    echo ""
    return 0
  fi

  local raw=""
  raw=$(echo "$line" | sed -E 's/^(Status:|\\*\\*Status:\\*\\*)[[:space:]]*//I' | tr '[:upper:]' '[:lower:]')
  case "$raw" in
    pending*) echo "pending" ;;
    in\ progress*|in_progress*|in-progress*) echo "in_progress" ;;
    completed*|done*) echo "completed" ;;
    *) echo "" ;;
  esac
}

# Helper: Reconcile roadmap statuses from task markdown Status lines.
# This prevents "fake completion" when project.roadmap.json status drifts from tasks/*.md.
reconcile_roadmap_from_task_docs() {
  if [ ! -f "$ROADMAP_FILE" ] || [ ! -d "$TASKS_DIR" ]; then
    return 0
  fi

  local changed=0
  local prd_id=""
  local prd_rel=""
  local full_prd_path=""
  local doc_status=""
  local roadmap_status=""

  while IFS=$'\t' read -r prd_id prd_rel; do
    if [ -z "$prd_id" ] || [ -z "$prd_rel" ]; then
      continue
    fi

    if [[ "$WORKSPACE_MODE" == "true" ]]; then
      full_prd_path="$AHA_LOOP_DIR/$prd_rel"
    else
      full_prd_path="$WORKSPACE_ROOT/$prd_rel"
    fi

    doc_status=$(get_prd_task_doc_status "$full_prd_path")
    if [ -z "$doc_status" ]; then
      continue
    fi

    roadmap_status=$(jq -r --arg id "$prd_id" '
      [.milestones[].prds[] | select(.id == $id)][0].status // ""
    ' "$ROADMAP_FILE" 2>/dev/null || echo "")

    if [ -n "$roadmap_status" ] && [ "$roadmap_status" != "$doc_status" ]; then
      jq --arg id "$prd_id" --arg s "$doc_status" '
        (.milestones[].prds[] | select(.id == $id)).status = $s
      ' "$ROADMAP_FILE" > "$ROADMAP_FILE.tmp" && mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"
      changed=1
    fi
  done < <(jq -r '.milestones[].prds[] | "\(.id)\t\(.prdFile)"' "$ROADMAP_FILE" 2>/dev/null || true)

  if [ "$changed" -eq 1 ]; then
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq --arg ts "$ts" '
      .updatedAt = $ts |
      (.milestones[].prds[] |= (if .status != "completed" then del(.completedAt) else . end)) |
      (.milestones[] |= (
        .status = (
          if (.prds | all(.status == "completed")) then "completed"
          elif (.prds | any(.status == "in_progress")) then "in_progress"
          else "pending"
          end
        ) |
        if .status != "completed" then del(.completedAt) else . end
      )) |
      .status = (if (.milestones | all(.status == "completed")) then "completed" else "in_progress" end) |
      .currentMilestone = ([.milestones[] | select(.status != "completed")][0].id // null) |
      .currentPRD = ([.milestones[].prds[] | select(.status == "pending" or .status == "in_progress")][0].id // null)
    ' "$ROADMAP_FILE" > "$ROADMAP_FILE.tmp" && mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"
  fi
}

# Helper: Run AI with a prompt
run_ai() {
  local prompt="$1"
  local skill_name="${2:-}"

  if [ -n "$skill_name" ]; then
    record_skill_usage "$skill_name"
  fi
  
  if [[ "$TOOL" == "amp" ]]; then
    echo "$prompt" | amp --dangerously-allow-all 2>&1
  elif [[ "$TOOL" == "codex" ]]; then
    local codex_cmd=(codex)

    # Global options must come before the subcommand.
    if [ -n "$CODEX_APPROVAL" ]; then
      codex_cmd+=(-a "$CODEX_APPROVAL")
    fi
    if [ -n "$CODEX_PROFILE" ]; then
      codex_cmd+=(-p "$CODEX_PROFILE")
    fi

    # Windows note (codex-cli 0.99.0): workspace-write sandbox currently requires
    # enabling experimental windows sandboxing.
    local uname_s=""
    uname_s=$(uname -s 2>/dev/null || echo "")
    case "$uname_s" in
      MINGW*|MSYS*|CYGWIN*)
        if [ "$CODEX_SANDBOX" = "workspace-write" ]; then
          codex_cmd+=(-c "features.experimental_windows_sandbox=true")
          codex_cmd+=(-c "suppress_unstable_features_warning=true")
        fi
        ;;
    esac

    codex_cmd+=(exec --sandbox "$CODEX_SANDBOX" -C "$WORKSPACE_ROOT")

    if [ -n "$CODEX_FLAGS" ]; then
      # shellcheck disable=SC2206
      local extra_flags=($CODEX_FLAGS)
      codex_cmd+=("${extra_flags[@]}")
    fi

    echo "$prompt" | "${codex_cmd[@]}" - 2>&1
  else
    echo "$prompt" | claude --dangerously-skip-permissions --print 2>&1
  fi
}

# Helper: detect default branch (main/master/origin HEAD)
detect_default_branch() {
  local upstream
  upstream=$(git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null || true)
  if [ -n "$upstream" ] && [ "$upstream" != "@{u}" ]; then
    echo "${upstream##*/}"
    return 0
  fi

  local origin_head
  origin_head=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  if [ -n "$origin_head" ]; then
    echo "${origin_head#origin/}"
    return 0
  fi

  if git show-ref --verify --quiet refs/heads/main; then
    echo "main"
    return 0
  fi

  if git show-ref --verify --quiet refs/heads/master; then
    echo "master"
    return 0
  fi

  echo ""
}

# Helper: Check if file exists and is recent
file_exists_and_recent() {
  local file="$1"
  local max_age_hours="${2:-24}"
  
  if [ ! -f "$file" ]; then
    return 1
  fi
  
  # Check if file was modified within max_age_hours
  local file_age=$(( ($(date +%s) - $(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file")) / 3600 ))
  if [ "$file_age" -gt "$max_age_hours" ]; then
    return 1
  fi
  
  return 0
}

# Interactive Vision Building
run_vision_builder() {
  echo "=== Interactive Vision Builder ==="
  echo ""

  log_thought "Vision" "Building" "Starting interactive vision building session."

  local workspace_ctx=$(generate_workspace_context)
  local prompt="Load the vision-builder skill from $SKILLS_DIR/vision-builder/SKILL.md.

${workspace_ctx}

Help the user build a complete project vision through guided conversation.
Ask concise structured questions interactively as needed.
After gathering all information, generate a complete project.vision.md file at $VISION_FILE.

Start by introducing yourself and asking about the project type."

  run_ai "$prompt" "vision-builder"

  if [ -f "$VISION_FILE" ]; then
    echo ""
    echo "Vision document created: $VISION_FILE"
    log_thought "Vision" "Complete" "Vision document created successfully."
  fi
}

# Parallel Exploration
run_parallel_exploration() {
  local task="$1"

  echo "=== Parallel Exploration ==="
  echo "Task: $task"
  echo ""

  if [ "$PARALLEL_ENABLED" != "true" ]; then
    echo "Parallel exploration is disabled in config."
    exit 1
  fi

  log_thought "Exploration" "Starting" "### Parallel Exploration

**Task:** $task

Starting parallel exploration to find the best approach."
  record_skill_usage "parallel-explore"

  # Delegate to parallel-explorer.sh with workspace if set
  local workspace_arg=""
  if [[ "$WORKSPACE_MODE" == "true" ]]; then
    workspace_arg="--workspace $WORKSPACE_ROOT"
  fi
  "$SCRIPT_DIR/parallel-explorer.sh" explore "$task" --tool "$TOOL" $workspace_arg
}

# Maintenance Tasks
run_maintenance() {
  echo "=== Maintenance Tasks ==="
  echo ""
  ORCH_CURRENT_PHASE="maintenance"
  write_orchestrator_heartbeat "running" "Running maintenance tasks" 0
  
  log_thought "Maintenance" "Starting" "Running scheduled maintenance tasks."
  
  # Document cleanup
  if [ "$DOC_MAINTENANCE_ENABLED" = "true" ]; then
    echo "Running documentation review..."
    "$SCRIPT_DIR/doc-cleaner.sh" --report
    echo ""
  fi
  
  # Skill review
  echo "Running skill review..."
  AHA_SKILL_PROVIDER="$TOOL" "$SCRIPT_DIR/skill-manager.sh" review
  echo ""
  
  # Worktree cleanup
  if [ "$PARALLEL_ENABLED" = "true" ]; then
    echo "Checking for stale worktrees..."
    local stale_count=$(git worktree list --porcelain | grep -c "^worktree" || echo "0")
    if [ "$stale_count" -gt 5 ]; then
      echo "Found $stale_count worktrees. Consider running: ./parallel-explorer.sh cleanup --all"
    else
      echo "Worktree count is healthy: $stale_count"
    fi
  fi
  
  log_thought "Maintenance" "Complete" "Maintenance tasks completed."
  
  echo ""
  echo "Maintenance complete."
}

# Phase 1: Vision Analysis
run_vision_phase() {
  echo "=== Phase 1: Vision Analysis ==="
  echo ""
  ORCH_CURRENT_PHASE="vision"
  write_orchestrator_heartbeat "running" "Running vision phase" 0
  
  # Check for vision file
  if [ ! -f "$VISION_FILE" ]; then
    echo "project.vision.md not found."
    echo ""
    
    # Offer to build vision interactively
    local use_builder=$(jq -r '.vision.useVisionBuilder // true' "$CONFIG_FILE" 2>/dev/null)
    
    if [ "$use_builder" = "true" ]; then
      echo "Would you like to build a vision interactively? (Y/n)"
      read -r response
      if [[ ! "$response" =~ ^[Nn] ]]; then
        run_vision_builder
      else
        echo "Please create project.vision.md manually."
        echo "See: scripts/aha-loop/templates/project.vision.template.md"
        exit 1
      fi
    else
      echo "Please create a project.vision.md file with your project goals."
      echo "See scripts/aha-loop/templates/project.vision.template.md for format."
      exit 1
    fi
  fi
  
  echo "Found: $VISION_FILE"
  
  log_thought "Vision" "Analysis" "### Starting Vision Analysis

Found vision file, beginning analysis."
  
  # Skip only if analysis is newer than the vision and still recent.
  if [ -f "$VISION_ANALYSIS" ] && [ "$VISION_ANALYSIS" -nt "$VISION_FILE" ] && file_exists_and_recent "$VISION_ANALYSIS" 168; then  # 1 week
    echo "Vision analysis exists and is up-to-date. Skipping."
    return 0
  fi
  
  echo "Analyzing project vision..."

  local workspace_ctx=$(generate_workspace_context)
  local prompt="Load the vision skill from $SKILLS_DIR/vision/SKILL.md and analyze the project vision in $VISION_FILE. Save the analysis to $VISION_ANALYSIS.

${workspace_ctx}

Also load the observability skill and log your thoughts to $LOG_FILE."

  run_ai "$prompt" "vision"
  
  if [ -f "$VISION_ANALYSIS" ]; then
    echo "Vision analysis complete: $VISION_ANALYSIS"
    log_thought "Vision" "Complete" "Vision analysis completed successfully."
  else
    echo "Warning: Vision analysis file not created"
    log_thought "Vision" "Warning" "Vision analysis file was not created."
  fi
}

# Phase 2: Architecture Design
run_architect_phase() {
  echo ""
  echo "=== Phase 2: Architecture Design ==="
  echo ""
  ORCH_CURRENT_PHASE="architect"
  write_orchestrator_heartbeat "running" "Running architect phase" 0
  
  # Check prerequisites
  if [ ! -f "$VISION_ANALYSIS" ]; then
    echo "Error: Vision analysis not found. Run vision phase first."
    exit 1
  fi
  
  log_thought "Architect" "Starting" "### Architecture Design Phase

Beginning technology research and architecture design."
  
  # Skip only if architecture is newer than the vision analysis and still recent.
  if [ -f "$ARCHITECTURE_FILE" ] && [ "$ARCHITECTURE_FILE" -nt "$VISION_ANALYSIS" ] && file_exists_and_recent "$ARCHITECTURE_FILE" 168; then
    echo "Architecture document exists and is up-to-date. Skipping."
    return 0
  fi
  
  echo "Designing system architecture..."

  local workspace_ctx=$(generate_workspace_context)
  local prompt="Load the architect skill from $SKILLS_DIR/architect/SKILL.md. Read $VISION_ANALYSIS and design the system architecture.

${workspace_ctx}

IMPORTANT: Research and select the LATEST STABLE VERSIONS of all technologies.
Check crates.io, npm, or relevant package registries for current versions.

Save to $ARCHITECTURE_FILE and log your decision process to $LOG_FILE."

  run_ai "$prompt" "architect"
  
  if [ -f "$ARCHITECTURE_FILE" ]; then
    echo "Architecture design complete: $ARCHITECTURE_FILE"
    log_thought "Architect" "Complete" "Architecture design completed."
  else
    echo "Warning: Architecture file not created"
  fi
}

# Phase 3: Roadmap Planning
run_roadmap_phase() {
  echo ""
  echo "=== Phase 3: Roadmap Planning ==="
  echo ""
  ORCH_CURRENT_PHASE="roadmap"
  write_orchestrator_heartbeat "running" "Running roadmap phase" 0
  
  # Check prerequisites
  if [ ! -f "$ARCHITECTURE_FILE" ]; then
    echo "Error: Architecture document not found. Run architect phase first."
    exit 1
  fi
  
  log_thought "Roadmap" "Starting" "### Roadmap Planning Phase

Creating project milestones and PRD queue."
  
  # Check if roadmap already exists
  if [ -f "$ROADMAP_FILE" ]; then
    local status=$(jq -r '.status' "$ROADMAP_FILE" 2>/dev/null)
    if [ "$status" = "completed" ]; then
      if has_pending_prds || has_pending_task_docs; then
        echo "Roadmap marked completed but pending work was detected. Reopening roadmap..."
        jq '.status = "in_progress"' "$ROADMAP_FILE" > "$ROADMAP_FILE.tmp" && mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"
      else
        echo "Project already completed!"
        return 0
      fi
    fi
    echo "Roadmap exists. Checking for updates needed..."

    # Skip only if roadmap is newer than its inputs and still recent.
    if [ "$ROADMAP_FILE" -nt "$ARCHITECTURE_FILE" ] && [ "$ROADMAP_FILE" -nt "$VISION_ANALYSIS" ] && file_exists_and_recent "$ROADMAP_FILE" 168; then
      echo "Roadmap exists and is up-to-date. Skipping."
      return 0
    fi
  else
    echo "Creating project roadmap..."
  fi

  local workspace_ctx=$(generate_workspace_context)
  local prompt="Load the roadmap skill from $SKILLS_DIR/roadmap/SKILL.md. Read $VISION_ANALYSIS and $ARCHITECTURE_FILE. Create or update $ROADMAP_FILE with milestones and PRDs. Generate PRD stub files in $TASKS_DIR directory.

${workspace_ctx}"

  run_ai "$prompt" "roadmap"
  
  if [ -f "$ROADMAP_FILE" ]; then
    echo "Roadmap planning complete: $ROADMAP_FILE"
    echo ""
    echo "Milestones:"
    jq -r '.milestones[] | "  \(.id): \(.title) [\(.status)]"' "$ROADMAP_FILE"
    log_thought "Roadmap" "Complete" "Roadmap created with milestones."
  else
    echo "Warning: Roadmap file not created"
  fi
}

# Phase 4: Execute PRDs
run_execute_phase() {
  echo ""
  echo "=== Phase 4: PRD Execution ==="
  echo ""
  ORCH_CURRENT_PHASE="execute"
  write_orchestrator_heartbeat "running" "Running execute phase" 0
  
  # Check prerequisites
  if [ ! -f "$ROADMAP_FILE" ]; then
    echo "Error: Roadmap not found. Run roadmap phase first."
    exit 1
  fi

  # Keep roadmap status in sync with task docs (prevents stale "completed" states).
  reconcile_roadmap_from_task_docs
  
  local prds_executed=0
  
  while [ $prds_executed -lt $MAX_PRDS ]; do
    # Get current PRD from roadmap
    local current_prd=$(jq -r '.currentPRD // empty' "$ROADMAP_FILE")

    # Ignore stale currentPRD pointers
    if [ -n "$current_prd" ]; then
      local current_prd_status=$(jq -r --arg id "$current_prd" '
        [.milestones[].prds[] | select(.id == $id)][0].status // empty
      ' "$ROADMAP_FILE")
      if [ "$current_prd_status" != "pending" ] && [ "$current_prd_status" != "in_progress" ]; then
        current_prd=""
      fi
    fi

    if [ -z "$current_prd" ]; then
      current_prd=$(get_next_pending_prd)
    fi

    if [ -z "$current_prd" ]; then
      ORCH_CURRENT_PRD=""
      write_orchestrator_heartbeat "running" "Checking for next pending PRD" 0
      if has_pending_task_docs; then
        echo "Roadmap has no pending PRDs, but task docs still show pending work."
        echo "Run roadmap phase to reconcile .md task status with project.roadmap.json."
        jq '.status = "in_progress"' "$ROADMAP_FILE" > "$ROADMAP_FILE.tmp" && mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"
        exit 1
      fi

      local unresolved_prd=$(jq -r '
        [.milestones[].prds[] | select(.status != "completed")][0].id // empty
      ' "$ROADMAP_FILE" 2>/dev/null)

      if [ -n "$unresolved_prd" ]; then
        echo "No runnable PRDs found, but unresolved PRD status remains: $unresolved_prd"
        echo "Skipping project completion; update roadmap status first."
        exit 1
      fi

      if [ -f "$PRD_FILE" ]; then
        local pending_in_prd_json
        pending_in_prd_json=$(jq '[.userStories[]? | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null || echo "-1")
        if [ "$pending_in_prd_json" -lt 0 ]; then
          echo "Error: failed to parse pending story count from $PRD_FILE."
          exit 1
        fi
        if [ "$pending_in_prd_json" -gt 0 ]; then
          echo "Roadmap has no pending PRDs, but prd.json still has $pending_in_prd_json incomplete stories."
          echo "Skipping project completion; rerun execute after PRD state is reconciled."
          jq '.status = "in_progress"' "$ROADMAP_FILE" > "$ROADMAP_FILE.tmp" && mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"
          exit 1
        fi
      fi

      echo "No pending PRDs found. Project may be complete!"
      write_orchestrator_heartbeat "running" "No pending PRDs found; finalizing project status" 0
      echo ""
      echo "=========================================="
      echo "  PROJECT COMPLETE!"
      echo "=========================================="
      jq '
        .status = "completed" |
        (.milestones[]).status = "completed"
      ' "$ROADMAP_FILE" > "$ROADMAP_FILE.tmp" && mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"

      log_thought "Project" "Complete" "### Project Completed!

All milestones and PRDs have been completed successfully."

      # Run maintenance after project completion
      if [ "$DOC_MAINTENANCE_ENABLED" = "true" ]; then
        echo ""
        echo "Running post-project maintenance..."
        run_maintenance
      fi
      break
    fi
    
    echo "Executing PRD: $current_prd"
    echo ""
    ORCH_CURRENT_PRD="$current_prd"
    write_orchestrator_heartbeat "running" "Executing PRD $current_prd" 0
    
    log_thought "$current_prd" "Starting" "### PRD Execution Starting

Beginning work on PRD: $current_prd"
    
    # Get PRD file path
    local prd_file=$(jq -r --arg id "$current_prd" '
      .milestones[].prds[] |
      select(.id == $id) |
      .prdFile
    ' "$ROADMAP_FILE")

    # Resolve prd_file path relative to workspace
    local full_prd_file
    if [[ "$WORKSPACE_MODE" == "true" ]]; then
      full_prd_file="$AHA_LOOP_DIR/$prd_file"
    else
      full_prd_file="$WORKSPACE_ROOT/$prd_file"
    fi

    if [ -z "$prd_file" ] || [ ! -f "$full_prd_file" ]; then
      echo "Error: PRD file not found: $prd_file"
      echo "Generating PRD content..."

      local directives_ctx=$(build_directives_context "$current_prd")
      local workspace_ctx=$(generate_workspace_context)
      local prompt="Load the prd skill from $SKILLS_DIR/prd/SKILL.md. Read the roadmap entry for $current_prd in $ROADMAP_FILE and generate the full PRD content. Save to $full_prd_file.

${workspace_ctx}
${directives_ctx}"
      run_ai "$prompt" "prd"
    fi

    # Fast-path reconciliation: if current prd.json already represents this PRD
    # and all stories are complete, avoid reconversion/reset loops and mark roadmap done.
    if [ -f "$PRD_FILE" ]; then
      local existing_prd_id
      existing_prd_id=$(jq -r '.prdId // empty' "$PRD_FILE" 2>/dev/null || echo "")
      if [ "$existing_prd_id" = "$current_prd" ]; then
        local existing_story_count existing_pending
        existing_story_count=$(jq '[.userStories[]?] | length' "$PRD_FILE" 2>/dev/null || echo "0")
        existing_pending=$(jq '[.userStories[]? | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null || echo "-1")
        if [ "$existing_story_count" -gt 0 ] && [ "$existing_pending" -eq 0 ]; then
          echo "PRD $current_prd already complete in prd.json; reconciling roadmap/task status."
          mark_prd_completed_in_roadmap "$current_prd" "$full_prd_file" "Reconciled from already-complete prd.json state"
          prds_executed=$((prds_executed + 1))
          ORCH_CURRENT_PRD=""
          write_orchestrator_heartbeat "running" "Reconciled already-complete PRD $current_prd" 0
          echo ""
          continue
        fi
      fi
    fi

    local skip_conversion=false
    if [ -f "$PRD_FILE" ]; then
      local existing_prd_id existing_story_count existing_pending
      existing_prd_id=$(jq -r '.prdId // empty' "$PRD_FILE" 2>/dev/null || echo "")
      existing_story_count=$(jq '[.userStories[]?] | length' "$PRD_FILE" 2>/dev/null || echo "0")
      existing_pending=$(jq '[.userStories[]? | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null || echo "-1")
      if [ "$existing_prd_id" = "$current_prd" ] && [ "$existing_story_count" -gt 0 ] && [ "$existing_pending" -gt 0 ]; then
        skip_conversion=true
      fi
    fi

    # Convert PRD to prd.json unless we are resuming an in-progress PRD.
    if [ "$skip_conversion" = true ]; then
      echo "Reusing existing in-progress prd.json for $current_prd (skip reconversion)."
    else
      echo "Converting PRD to executable format..."
      local old_prd_state=""
      if [ -f "$PRD_FILE" ]; then
        local existing_prd_id=""
        existing_prd_id=$(jq -r '.prdId // empty' "$PRD_FILE" 2>/dev/null || echo "")
        if [ "$existing_prd_id" = "$current_prd" ]; then
          old_prd_state=$(mktemp)
          cp "$PRD_FILE" "$old_prd_state"
        fi
      fi
      local directives_ctx=$(build_directives_context "$current_prd")
      local workspace_ctx=$(generate_workspace_context)
      local prompt="Load the prd-converter skill from $SKILLS_DIR/prd-converter/SKILL.md. Convert $full_prd_file to $PRD_FILE format.

${workspace_ctx}
${directives_ctx}"
      run_ai "$prompt" "prd-converter"

      if [ ! -f "$PRD_FILE" ]; then
        echo "Error: prd.json was not generated at $PRD_FILE"
        exit 1
      fi

      # Preserve story state when regenerating prd.json for the same PRD (resume-friendly).
      if [ -n "$old_prd_state" ] && [ -f "$old_prd_state" ]; then
        if jq -e . "$old_prd_state" >/dev/null 2>&1 && jq -e . "$PRD_FILE" >/dev/null 2>&1; then
          local merged_prd_tmp
          merged_prd_tmp=$(mktemp)
          if merge_prd_json_state "$old_prd_state" "$PRD_FILE" "$merged_prd_tmp"; then
            mv "$merged_prd_tmp" "$PRD_FILE"
          else
            rm -f "$merged_prd_tmp" 2>/dev/null || true
          fi
        fi
        rm -f "$old_prd_state" 2>/dev/null || true
      fi
    fi

    local prd_json_id
    prd_json_id=$(jq -r '.prdId // empty' "$PRD_FILE" 2>/dev/null || echo "")
    if [ "$prd_json_id" != "$current_prd" ]; then
      echo "Error: prd.json PRD ID mismatch. expected=$current_prd actual=${prd_json_id:-<empty>}"
      exit 1
    fi

    local pending_before
    pending_before=$(jq '[.userStories[]? | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null || echo "-1")
    if [ "$pending_before" -lt 1 ]; then
      echo "Error: prd.json has no pending stories before execution (pending=$pending_before)."
      echo "Refusing to auto-complete PRD without executable work items."
      exit 1
    fi
    
    # Update roadmap to mark PRD as in_progress
    jq --arg id "$current_prd" '
      .currentPRD = $id |
      (.milestones[].prds[] | select(.id == $id)).status = "in_progress"
    ' "$ROADMAP_FILE" > "$ROADMAP_FILE.tmp" && mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"
    update_prd_task_doc_status "$full_prd_file" "In Progress"
    
    # Execute the PRD with aha-loop.sh
    echo "Running Aha Loop for $current_prd..."
    local workspace_arg=""
    if [[ "$WORKSPACE_MODE" == "true" ]]; then
      workspace_arg="--workspace $WORKSPACE_ROOT"
    fi
    set +e
    "$SCRIPT_DIR/aha-loop.sh" --tool "$TOOL" --max-iterations "$MAX_ITERATIONS" $workspace_arg
    local aha_loop_exit=$?
    set -e
    
    if [ $aha_loop_exit -eq 0 ]; then
      local pending_after
      pending_after=$(jq '[.userStories[]? | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null || echo "-1")
      if [ "$pending_after" -ne 0 ]; then
        echo "PRD $current_prd returned success but still has $pending_after incomplete stories."
        echo "Keeping roadmap status in_progress for manual or automatic retry."
        log_thought "$current_prd" "Validation Failed" "PRD reported success, but prd.json still has $pending_after stories where passes=false."
        exit 1
      fi

      echo "PRD $current_prd completed successfully!"
      mark_prd_completed_in_roadmap "$current_prd" "$full_prd_file" "PRD completed successfully"
      ORCH_CURRENT_PRD=""
      write_orchestrator_heartbeat "running" "PRD $current_prd completed" 0

      # Merge completed PRD branch back to default branch
      if [ -f "$PRD_FILE" ]; then
        local prd_branch=$(jq -r '.branchName // empty' "$PRD_FILE")
        if [ -n "$prd_branch" ]; then
          local current_branch=$(git branch --show-current)
          if [ "$current_branch" = "$prd_branch" ]; then
            local target_branch
            target_branch=$(detect_default_branch)
            if [ -z "$target_branch" ]; then
              echo "Warning: Could not detect default branch. Skipping auto-merge for $prd_branch."
            else
              echo "Merging $prd_branch into $target_branch..."
              if git checkout "$target_branch"; then
                if git merge "$prd_branch" --no-ff -m "feat: Complete $current_prd - merge $prd_branch"; then
                  echo "Successfully merged $prd_branch into $target_branch"
                  log_thought "$current_prd" "Merge" "### Branch Merged

Merged $prd_branch into $target_branch after PRD completion."
                else
                  echo "Warning: Failed to merge $prd_branch into $target_branch. Manual merge may be required."
                  git checkout "$prd_branch" || true
                fi
              else
                echo "Warning: Failed to checkout $target_branch. Manual merge may be required."
                git checkout "$prd_branch" || true
              fi
            fi
          fi
        fi
      fi

      # Check if milestone is complete
      local milestone_id=$(jq -r --arg id "$current_prd" '
        .milestones[] | 
        select(.prds[].id == $id) | 
        .id
      ' "$ROADMAP_FILE")
      
      local pending_in_milestone=$(jq -r --arg mid "$milestone_id" '
        .milestones[] | 
        select(.id == $mid) | 
        .prds[] | 
        select(.status != "completed") | 
        .id
      ' "$ROADMAP_FILE" | head -1)
      
      if [ -z "$pending_in_milestone" ]; then
        echo "Milestone $milestone_id completed!"
        jq --arg mid "$milestone_id" --arg ts "$timestamp" '
          (.milestones[] | select(.id == $mid)).status = "completed" |
          (.milestones[] | select(.id == $mid)).completedAt = $ts |
          .changelog += [{
            "timestamp": $ts,
            "action": "milestone_completed",
            "milestoneId": $mid,
            "description": "Milestone completed"
          }]
        ' "$ROADMAP_FILE" > "$ROADMAP_FILE.tmp" && mv "$ROADMAP_FILE.tmp" "$ROADMAP_FILE"
        
        log_thought "$milestone_id" "Milestone Complete" "### Milestone Completed!

Milestone $milestone_id has been completed."
        
        # Trigger roadmap review after milestone completion
        echo "Reviewing roadmap after milestone completion..."
        local workspace_ctx=$(generate_workspace_context)
        local prompt="Load the roadmap skill from $SKILLS_DIR/roadmap/SKILL.md. Review $ROADMAP_FILE after completing milestone $milestone_id. Update if new PRDs are needed based on learnings.

${workspace_ctx}"
        run_ai "$prompt" "roadmap"
        
        # Run doc maintenance after milestone
        if [ "$DOC_MAINTENANCE_ENABLED" = "true" ]; then
          echo "Running post-milestone maintenance..."
          "$SCRIPT_DIR/doc-cleaner.sh" --report 2>/dev/null || true
        fi
      fi
      
      prds_executed=$((prds_executed + 1))
    else
      echo "PRD $current_prd did not complete. Check $PROGRESS_FILE for details."
      log_thought "$current_prd" "Failed" "### PRD Execution Failed

PRD $current_prd did not complete successfully. Check $PROGRESS_FILE for details."
      write_orchestrator_heartbeat "failed" "PRD $current_prd failed" "$aha_loop_exit"
      exit 1
    fi
    
    echo ""
  done
  
  echo ""
  echo "Executed $prds_executed PRDs in this run."
}

# Handle special modes first
if [ "$BUILD_VISION" = true ]; then
  run_vision_builder
  exit 0
fi

if [ -n "$EXPLORE_TASK" ]; then
  run_parallel_exploration "$EXPLORE_TASK"
  exit 0
fi

if [ "$MAINTENANCE" = true ]; then
  run_maintenance
  exit 0
fi

# Main execution
case $PHASE in
  vision)
    run_vision_phase
    ;;
  architect)
    run_architect_phase
    ;;
  roadmap)
    run_roadmap_phase
    ;;
  execute)
    run_execute_phase
    ;;
  all)
    run_vision_phase
    run_architect_phase
    run_roadmap_phase
    run_execute_phase
    ;;
esac

echo ""
echo "Orchestrator finished."
