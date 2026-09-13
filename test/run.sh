#!/usr/bin/env bash
# Rules tests, then the whole game played in headless Chrome.
cd "$(dirname "$0")/.."
node test/engine.test.js || exit 1
python3 -m http.server 8767 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER; curl -s http://127.0.0.1:9342/json/close >/dev/null; pkill -f "remote-debugging-port=9342" 2>/dev/null' EXIT
sleep 1
node test/e2e.js
