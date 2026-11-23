#!/bin/bash
# Runs every ORM and driver pair on Node, Bun, or both. Each pair runs in its own process, so one
# ORM's warm-up, heap and connection pool never carry into another's numbers.
set -euo pipefail

# Defaults
iterations=2
size=50
runtimes="node bun"
targets=""
label=""

# Parse command-line arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    -i|--iterations) iterations="$2"; shift ;;
    -s|--size) size="$2"; shift ;;
    -d|--database-url) database_url="$2"; shift ;;
    -r|--runtime) runtimes="${2//,/ }"; [[ "$runtimes" == "both" ]] && runtimes="node bun"; shift ;;
    -t|--targets) targets="$2"; shift ;;
    -l|--label) label="$2"; shift ;;
    *) echo "Unknown parameter passed: $1"; exit 1 ;;
  esac
  shift
done

echo "Running benchmarks"
echo "Iterations: $iterations"
echo "Size: $size"
echo "Runtimes: $runtimes"

export ITERATIONS=$iterations
export SIZE=$size
export LABEL=$label
if [ -n "${database_url:-}" ]; then
  echo "Database URL: $database_url"
  export DATABASE_URL=$database_url
else
  echo "No database URL provided via command line, reading from .env ..."
fi

export RESULTS_DIR="results/postgresql-${size}-${iterations}-$(date +%s)${label:+-$label}"
mkdir -p "$RESULTS_DIR"

start_time=$(date +%s)

# A failed build or target is recorded and the run goes on, so one failure does not lose the
# other targets' results. The script exits non-zero at the end if anything failed.
failed=""
record_failure() {
  echo "!! $1 failed"
  failed="${failed}  $1"$'\n'
}

for runtime in $runtimes; do
  case $runtime in
    node)
      if ! npm run --silent build; then
        record_failure "node build"
        continue
      fi
      run=(node --max-old-space-size=4096 dist/main.js) ;;
    bun) run=(bun src/main.ts) ;;
    *) echo "Unknown runtime: $runtime"; exit 1 ;;
  esac
  if [ -n "$targets" ]; then
    list="${targets//,/ }"
  elif ! list=$("${run[@]}" --list); then
    record_failure "target list on $runtime"
    continue
  fi
  for target in $list; do
    # A target such as `drizzle:bun-sql` only exists on Bun. Skip what this runtime cannot run.
    if [[ "$target" == *bun-sql* && "$runtime" != "bun" ]]; then continue; fi
    echo "== $target on $runtime"
    if ! TARGETS="$target" "${run[@]}"; then
      record_failure "$target on $runtime"
    fi
  done
done

# One comparison across every target and runtime that finished.
if command -v bun >/dev/null; then
  bun src/summary.ts "$RESULTS_DIR" || record_failure "summary"
elif [ -f dist/summary.js ]; then
  node dist/summary.js "$RESULTS_DIR" || record_failure "summary"
else
  record_failure "summary (no Bun and no Node build)"
fi

end_time=$(date +%s)
elapsed_time=$((end_time - start_time))
echo "Benchmark completed in $((elapsed_time / 60)) minutes and $((elapsed_time % 60)) seconds."
echo "Results: $RESULTS_DIR/comparison.md"

if [ -n "$failed" ]; then
  printf 'Failed:\n%s' "$failed"
  exit 1
fi
