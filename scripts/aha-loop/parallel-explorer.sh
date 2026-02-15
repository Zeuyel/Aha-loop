#!/bin/bash
# Aha Loop Parallel Explorer - Git Worktree-based Parallel Exploration
# Enables multiple AI agents to explore different solutions simultaneously
#
# Usage:
#   ./parallel-explorer.sh explore "authentication strategy" --approaches "jwt,session,oauth"
#   ./parallel-explorer.sh status
#   ./parallel-explorer.sh evaluate "explore-auth"
#   ./parallel-explorer.sh cleanup [--all]
#   ./parallel-explorer.sh list
#   ./parallel-explorer.sh --workspace /path/to/project explore "task"

set -e

# Get script directory for sourcing lib
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source path resolution library
source "$SCRIPT_DIR/lib/paths.sh"

# Default settings
TOOL="claude"
MAX_CONCURRENT=10
EVALUATION_AGENTS=3
CLI_WORKSPACE=""
CODEX_SANDBOX="${AHA_CODEX_SANDBOX:-workspace-write}"
CODEX_APPROVAL="${AHA_CODEX_APPROVAL:-never}"
CODEX_PROFILE="${AHA_CODEX_PROFILE:-}"
CODEX_FLAGS="${AHA_CODEX_FLAGS:-}"

# Pre-parse workspace argument before command
ARGS=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --workspace)
      CLI_WORKSPACE="$2"
      shift 2
      ;;
    --workspace=*)
      CLI_WORKSPACE="${1#*=}"
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done
set -- "${ARGS[@]}"

# Initialize paths (handles workspace detection)
init_paths --workspace "$CLI_WORKSPACE"
export_paths

# Load config
if [ -f "$CONFIG_FILE" ]; then
  WORKTREE_BASE=$(jq -r '.parallelExploration.worktreePath // ".worktrees"' "$CONFIG_FILE")
  # Use WORKTREES_DIR from paths.sh instead of constructing it
  MAX_CONCURRENT=$(jq -r '.parallelExploration.maxConcurrent // 10' "$CONFIG_FILE")
  EVALUATION_AGENTS=$(jq -r '.parallelExploration.evaluationAgents // 3' "$CONFIG_FILE")
fi

# Use WORKTREES_DIR from paths.sh
WORKTREE_BASE="$WORKTREES_DIR"

# Ensure worktree directory exists
mkdir -p "$WORKTREE_BASE"

# Print usage
usage() {
  echo "Aha Loop Parallel Explorer - Git Worktree-based Parallel Exploration"
  echo ""
  echo "Usage:"
  echo "  $0 explore TASK [--approaches LIST] [--tool amp|claude|codex]"
  echo "  $0 status [TASK_ID]"
  echo "  $0 evaluate TASK_ID"
  echo "  $0 merge TASK_ID APPROACH"
  echo "  $0 cleanup [--all | TASK_ID]"
  echo "  $0 list"
  echo ""
  echo "Commands:"
  echo "  explore    Start parallel exploration of different approaches"
  echo "  status     Check status of explorations"
  echo "  evaluate   Evaluate completed explorations and pick best"
  echo "  merge      Merge chosen approach back to main branch"
  echo "  cleanup    Remove worktrees (specific task or all)"
  echo "  list       List all active worktrees"
  echo ""
  echo "Examples:"
  echo "  $0 explore \"authentication\" --approaches \"jwt,session,oauth\""
  echo "  $0 explore \"database layer\" --tool claude"
  echo "  $0 explore \"query cache\" --tool codex"
  echo "  $0 evaluate explore-auth-1234"
  echo "  $0 merge explore-auth-1234 jwt"
  echo "  $0 cleanup --all"
}

# Validate tool selection and availability
validate_tool() {
  local tool="$1"
  if [[ "$tool" != "amp" && "$tool" != "claude" && "$tool" != "codex" ]]; then
    echo "Error: Invalid tool '$tool'. Must be 'amp', 'claude', or 'codex'."
    exit 1
  fi
  if [[ "$tool" == "codex" ]]; then
    if ! command -v codex >/dev/null 2>&1; then
      echo "Error: codex CLI not found in PATH. Install Codex CLI or use --tool amp|claude."
      exit 1
    fi
  fi
}

# Run codex exec with safe defaults for automation.
# Note: global options (-a/-p/-c) must come before the `exec` subcommand.
run_codex_exec() {
  local prompt="$1"
  local workdir="${2:-$PWD}"

  local codex_cmd=(codex)

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

  codex_cmd+=(exec --sandbox "$CODEX_SANDBOX" -C "$workdir")

  if [ -n "$CODEX_FLAGS" ]; then
    # shellcheck disable=SC2206
    local extra_flags=($CODEX_FLAGS)
    codex_cmd+=("${extra_flags[@]}")
  fi

  echo "$prompt" | "${codex_cmd[@]}" -
}

# Generate unique task ID
generate_task_id() {
  local task_name="$1"
  local sanitized=$(echo "$task_name" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g')
  local timestamp=$(date +%s | tail -c 5)
  echo "explore-${sanitized}-${timestamp}"
}

# Create a worktree for exploration
create_worktree() {
  local task_id="$1"
  local approach="$2"
  local branch_name="${task_id}-${approach}"
  local worktree_path="${WORKTREE_BASE}/${task_id}/${approach}"
  
  # Keep stdout machine-readable for command substitution callers.
  echo "Creating worktree for approach: $approach" >&2
  
  # Create branch from current HEAD
  git branch "$branch_name" HEAD >/dev/null 2>&1 || true
  
  # Create worktree
  mkdir -p "$(dirname "$worktree_path")"
  git worktree add "$worktree_path" "$branch_name" >&2
  
  echo "$worktree_path"
}

# Remove a worktree
remove_worktree() {
  local worktree_path="$1"
  
  if [ -d "$worktree_path" ]; then
    echo "Removing worktree: $worktree_path"
    git worktree remove "$worktree_path" --force 2>/dev/null || true
    
    # Also remove the branch
    local branch_name=$(basename "$worktree_path")
    local parent_dir=$(basename "$(dirname "$worktree_path")")
    git branch -D "${parent_dir}-${branch_name}" 2>/dev/null || true
  fi
}

# Run exploration in a worktree
run_exploration() {
  local worktree_path="$1"
  local task_description="$2"
  local approach="$3"
  local tool="$4"
  
  local log_file="${worktree_path}/exploration.log"
  local status_file="${worktree_path}/exploration.status"
  
  echo "running" > "$status_file"
  echo "Started: $(date)" >> "$log_file"
  
  # Build the exploration prompt
  local prompt="You are exploring approach '$approach' for task: $task_description

Your goal is to implement this approach in this isolated worktree. 

Instructions:
1. Implement the '$approach' approach fully
2. Write tests to validate it works
3. Document pros and cons discovered during implementation
4. Create a file 'EXPLORATION_RESULT.md' with:
   - Summary of implementation
   - Pros discovered
   - Cons discovered
   - Code quality assessment
   - Recommendation (1-10 score)

Work entirely within this worktree. Make commits for your progress.
When done, the EXPLORATION_RESULT.md should be complete."

  # Run the AI in the worktree directory
  cd "$worktree_path"
  
  if [[ "$tool" == "amp" ]]; then
    echo "$prompt" | amp --dangerously-allow-all >> "$log_file" 2>&1
  elif [[ "$tool" == "codex" ]]; then
    run_codex_exec "$prompt" "$worktree_path" >> "$log_file" 2>&1
  else
    echo "$prompt" | claude --dangerously-skip-permissions >> "$log_file" 2>&1
  fi
  
  local exit_code=$?
  
  if [ $exit_code -eq 0 ] && [ -f "EXPLORATION_RESULT.md" ]; then
    echo "completed" > "$status_file"
  else
    echo "failed" > "$status_file"
  fi
  
  echo "Finished: $(date)" >> "$log_file"

  cd "$WORKSPACE_ROOT"
}

# Start parallel exploration
cmd_explore() {
  local task_description=""
  local approaches=""
  
  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case $1 in
      --approaches)
        approaches="$2"
        shift 2
        ;;
      --approaches=*)
        approaches="${1#*=}"
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
      *)
        if [ -z "$task_description" ]; then
          task_description="$1"
        fi
        shift
        ;;
    esac
  done
  
  if [ -z "$task_description" ]; then
    echo "Error: Task description required"
    usage
    exit 1
  fi

  validate_tool "$TOOL"
  
  # Generate task ID
  local task_id=$(generate_task_id "$task_description")
  echo "Task ID: $task_id"
  
  # If no approaches specified, ask AI to suggest them
  if [ -z "$approaches" ]; then
    echo "No approaches specified. Generating suggestions..."
    
    local suggest_prompt="Given this task: '$task_description'
    
Suggest 3-5 different approaches to solve this problem.
Output ONLY a comma-separated list of short approach names (1-2 words each).
Example: jwt,session,oauth"

    if [[ "$TOOL" == "amp" ]]; then
      approaches=$(echo "$suggest_prompt" | amp --dangerously-allow-all 2>/dev/null | tail -1)
    elif [[ "$TOOL" == "codex" ]]; then
      approaches=$(run_codex_exec "$suggest_prompt" "$WORKSPACE_ROOT" 2>/dev/null | tail -1)
    else
      approaches=$(echo "$suggest_prompt" | claude --dangerously-skip-permissions --print 2>/dev/null | tail -1)
    fi
    
    echo "Suggested approaches: $approaches"
  fi
  
  # Create task directory
  local task_dir="${WORKTREE_BASE}/${task_id}"
  mkdir -p "$task_dir"
  
  # Save task metadata
  cat > "${task_dir}/task.json" << EOF
{
  "id": "$task_id",
  "description": "$task_description",
  "tool": "$TOOL",
  "approaches": "$(echo $approaches | tr ',' '\n' | jq -R . | jq -s .)",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "status": "running"
}
EOF
  
  # Convert approaches to array
  IFS=',' read -ra approach_array <<< "$approaches"
  
  echo ""
  echo "Starting parallel exploration with ${#approach_array[@]} approaches..."
  echo ""
  
  # Create worktrees and start explorations in parallel
  local pids=()
  
  for approach in "${approach_array[@]}"; do
    approach=$(echo "$approach" | xargs)  # Trim whitespace
    
    echo "Starting exploration: $approach"
    
    # Create worktree
    local worktree_path=$(create_worktree "$task_id" "$approach")
    
    # Run exploration in background
    (run_exploration "$worktree_path" "$task_description" "$approach" "$TOOL") &
    pids+=($!)
    
    # Respect max concurrent limit
    if [ ${#pids[@]} -ge $MAX_CONCURRENT ]; then
      # Wait for any one to finish
      wait -n
      pids=($(jobs -rp))
    fi
  done
  
  echo ""
  echo "All explorations started. Task ID: $task_id"
  echo ""
  echo "Monitor progress with: $0 status $task_id"
  echo "Evaluate results with: $0 evaluate $task_id"
}

# Check exploration status
cmd_status() {
  local task_id="${1:-}"
  
  if [ -n "$task_id" ]; then
    local task_dir="${WORKTREE_BASE}/${task_id}"
    
    if [ ! -d "$task_dir" ]; then
      echo "Task not found: $task_id"
      exit 1
    fi
    
    echo "Task: $task_id"
    echo ""
    
    for approach_dir in "$task_dir"/*/; do
      if [ -d "$approach_dir" ]; then
        local approach=$(basename "$approach_dir")
        local status_file="${approach_dir}/exploration.status"
        local status="unknown"
        
        if [ -f "$status_file" ]; then
          status=$(cat "$status_file")
        fi
        
        local indicator="?"
        case $status in
          running) indicator="..." ;;
          completed) indicator="OK" ;;
          failed) indicator="FAIL" ;;
        esac
        
        printf "  %-20s [%s]\n" "$approach" "$indicator"
      fi
    done
  else
    # List all tasks
    echo "Active Explorations:"
    echo ""
    
    for task_dir in "$WORKTREE_BASE"/explore-*/; do
      if [ -d "$task_dir" ]; then
        local task_id=$(basename "$task_dir")
        local task_json="${task_dir}/task.json"
        
        if [ -f "$task_json" ]; then
          local description=$(jq -r '.description' "$task_json")
          printf "  %-30s %s\n" "$task_id" "$description"
        fi
      fi
    done
  fi
}

# Evaluate completed explorations
cmd_evaluate() {
  local task_id="$1"
  
  if [ -z "$task_id" ]; then
    echo "Error: Task ID required"
    usage
    exit 1
  fi
  
  local task_dir="${WORKTREE_BASE}/${task_id}"
  
  if [ ! -d "$task_dir" ]; then
    echo "Task not found: $task_id"
    exit 1
  fi
  
  echo "Evaluating explorations for: $task_id"
  echo ""
  
  local eval_tool="$TOOL"
  if [ -f "${task_dir}/task.json" ]; then
    local stored_tool
    stored_tool=$(jq -r '.tool // empty' "${task_dir}/task.json" 2>/dev/null || true)
    if [ -n "$stored_tool" ] && [ "$stored_tool" != "null" ]; then
      eval_tool="$stored_tool"
    fi
  fi

  validate_tool "$eval_tool"

  # Collect all exploration results
  local results=""
  
  for approach_dir in "$task_dir"/*/; do
    if [ -d "$approach_dir" ]; then
      local approach=$(basename "$approach_dir")
      local result_file="${approach_dir}/EXPLORATION_RESULT.md"
      
      if [ -f "$result_file" ]; then
        results+="

=== APPROACH: $approach ===
$(cat "$result_file")
"
      fi
    fi
  done
  
  if [ -z "$results" ]; then
    echo "No completed explorations found."
    exit 1
  fi
  
  # Have multiple agents evaluate
  echo "Running evaluation with $EVALUATION_AGENTS agents..."
  
  local eval_prompt="You are evaluating different implementation approaches for a software task.

Here are the results from different approaches:
$results

Please evaluate each approach and provide:
1. Summary of each approach's strengths and weaknesses
2. Comparison table
3. Final recommendation with reasoning
4. If appropriate, suggest combining elements from multiple approaches

Output your evaluation as a structured report."

  local eval_dir="${task_dir}/evaluation"
  mkdir -p "$eval_dir"
  
  for i in $(seq 1 $EVALUATION_AGENTS); do
    echo "Agent $i evaluating..."
    
    if [[ "$eval_tool" == "amp" ]]; then
      echo "$eval_prompt" | amp --dangerously-allow-all > "${eval_dir}/agent-${i}.md" 2>/dev/null
    elif [[ "$eval_tool" == "codex" ]]; then
      run_codex_exec "$eval_prompt" "$task_dir" > "${eval_dir}/agent-${i}.md" 2>/dev/null
    else
      echo "$eval_prompt" | claude --dangerously-skip-permissions --print > "${eval_dir}/agent-${i}.md" 2>/dev/null
    fi
  done
  
  # Synthesize final recommendation
  echo ""
  echo "Synthesizing final recommendation..."
  
  local synth_prompt="You have evaluations from $EVALUATION_AGENTS different AI agents reviewing implementation approaches.

$(for f in "$eval_dir"/agent-*.md; do echo "=== $(basename $f) ==="; cat "$f"; echo ""; done)

Synthesize these evaluations into a final recommendation:
1. Areas of consensus
2. Areas of disagreement
3. Final recommended approach (or combination)
4. Specific merge strategy if combining approaches"

  if [[ "$eval_tool" == "amp" ]]; then
    echo "$synth_prompt" | amp --dangerously-allow-all > "${eval_dir}/FINAL_RECOMMENDATION.md" 2>/dev/null
  elif [[ "$eval_tool" == "codex" ]]; then
    run_codex_exec "$synth_prompt" "$task_dir" > "${eval_dir}/FINAL_RECOMMENDATION.md" 2>/dev/null
  else
    echo "$synth_prompt" | claude --dangerously-skip-permissions --print > "${eval_dir}/FINAL_RECOMMENDATION.md" 2>/dev/null
  fi
  
  echo ""
  echo "Evaluation complete!"
  echo "See: ${eval_dir}/FINAL_RECOMMENDATION.md"
  echo ""
  cat "${eval_dir}/FINAL_RECOMMENDATION.md"
}

# Merge chosen approach back to main
cmd_merge() {
  local task_id="$1"
  local approach="$2"
  
  if [ -z "$task_id" ] || [ -z "$approach" ]; then
    echo "Error: Task ID and approach required"
    usage
    exit 1
  fi
  
  local worktree_path="${WORKTREE_BASE}/${task_id}/${approach}"
  local branch_name="${task_id}-${approach}"
  
  if [ ! -d "$worktree_path" ]; then
    echo "Worktree not found: $worktree_path"
    exit 1
  fi
  
  echo "Merging approach '$approach' from task '$task_id'..."
  
  # Get current branch
  local current_branch=$(git branch --show-current)
  
  # Merge the exploration branch
  git merge "$branch_name" --no-ff -m "Merge exploration: $task_id approach $approach"
  
  echo "Merged successfully!"
  echo ""
  echo "You may want to run: $0 cleanup $task_id"
}

# Cleanup worktrees
cmd_cleanup() {
  local target="${1:-}"
  
  if [ "$target" == "--all" ]; then
    echo "Cleaning up all worktrees..."
    
    for task_dir in "$WORKTREE_BASE"/explore-*/; do
      if [ -d "$task_dir" ]; then
        for worktree in "$task_dir"/*/; do
          if [ -d "$worktree" ] && [ -f "${worktree}/.git" ]; then
            remove_worktree "$worktree"
          fi
        done
        rm -rf "$task_dir"
      fi
    done
    
    # Prune stale worktree references
    git worktree prune
    
    echo "Cleanup complete."
    
  elif [ -n "$target" ]; then
    local task_dir="${WORKTREE_BASE}/${target}"
    
    if [ ! -d "$task_dir" ]; then
      echo "Task not found: $target"
      exit 1
    fi
    
    echo "Cleaning up task: $target"
    
    for worktree in "$task_dir"/*/; do
      if [ -d "$worktree" ] && [ -f "${worktree}/.git" ]; then
        remove_worktree "$worktree"
      fi
    done
    
    rm -rf "$task_dir"
    git worktree prune
    
    echo "Cleanup complete."
    
  else
    echo "Error: Specify task ID or --all"
    usage
    exit 1
  fi
}

# List all worktrees
cmd_list() {
  echo "Active Worktrees:"
  echo ""
  git worktree list
  echo ""
  
  echo "Exploration Tasks:"
  echo ""
  
  for task_dir in "$WORKTREE_BASE"/explore-*/; do
    if [ -d "$task_dir" ]; then
      echo "  $(basename "$task_dir")/"
      for approach_dir in "$task_dir"/*/; do
        if [ -d "$approach_dir" ]; then
          echo "    - $(basename "$approach_dir")"
        fi
      done
    fi
  done
}

# Main command dispatch
case "${1:-}" in
  explore)
    shift
    cmd_explore "$@"
    ;;
  status)
    shift
    cmd_status "$@"
    ;;
  evaluate)
    shift
    cmd_evaluate "$@"
    ;;
  merge)
    shift
    cmd_merge "$@"
    ;;
  cleanup)
    shift
    cmd_cleanup "$@"
    ;;
  list)
    cmd_list
    ;;
  --help|-h|"")
    usage
    ;;
  *)
    echo "Unknown command: $1"
    usage
    exit 1
    ;;
esac
