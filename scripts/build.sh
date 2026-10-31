#!/bin/bash
# Build the Desktop copy's host entry (src/ → lib/) with the project's own
# TypeScript, against the published 0.2.0-rc.2 dsh packages (never a local
# checkout — see scripts/ensure-links.mjs for why).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/ensure-links.mjs
"$ROOT/node_modules/.bin/tsc" -p tsconfig.json
echo "=== Build complete ==="