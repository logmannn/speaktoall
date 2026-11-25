#!/usr/bin/env bash
# Mac/Linux: installs dependencies on first run, then opens Speak To All.
set -e
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is required. Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing (this takes a minute)..."
  npm install
fi
npm start
