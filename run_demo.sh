#!/usr/bin/env bash
# Runs the synthetic harness, exports whatever real trading evidence
# currently exists (or an honest "no data yet" placeholder if it
# doesn't), and serves the dashboard. From the project root:
#   ./run_demo.sh
#
# This does NOT require Bitget credentials - the real-trading export
# step degrades gracefully to an honest empty state if no real trade
# log/report exists yet. It never fabricates real data to fill the gap.
set -euo pipefail
cd "$(dirname "$0")"

echo "Running synthetic crash-test generation (AGENT_MODE=${AGENT_MODE:-simulated})..."
(cd backend && python3 main.py)

echo ""
echo "Exporting real trading evidence for the dashboard (if any exists yet)..."
python3 -m polygraph_ingestion.export_for_dashboard

PORT="${PORT:-8000}"
echo ""
echo "Serving dashboard at http://localhost:${PORT}"
echo "(Ctrl+C to stop)"
cd frontend
python3 -m http.server "${PORT}"
