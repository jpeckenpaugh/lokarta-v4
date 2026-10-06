#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/html"
PORT="${PORT:-3000}"

if [ ! -d "$APP_DIR" ]; then
    echo "[-] Error: App directory not found at $APP_DIR"
    exit 1
fi

# Generate a per-run build id so restarting the server (a "redeploy" locally)
# busts browser caches and resets stale client state on the next load.
if command -v node >/dev/null 2>&1; then
    if ! node "$SCRIPT_DIR/tools/write-build-id.mjs"; then
        echo "[!] Could not generate build id; serving without cache-flush metadata."
    fi
else
    echo "[!] node not found; skipping build id generation (cache-flush disabled)."
fi

SERVER_PID=""

cleanup() {
    echo ""
    echo "=== Shutting down Lokarta ==="
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "[+] Stopping static server (PID $SERVER_PID)..."
        kill "$SERVER_PID" 2>/dev/null || true
    fi
    wait 2>/dev/null || true
    echo "[+] Server stopped."
}

trap cleanup INT TERM EXIT

echo "=========================================================="
echo "         🏰 Lokarta: Come Into The Light                "
echo "=========================================================="
echo "[+] Starting zero-backend static HTTP server on port $PORT..."
echo "[+] Serving directory: $APP_DIR"

if command -v python3 >/dev/null 2>&1; then
    echo "[+] Using Python 3 http.server..."
    python3 -m http.server -d "$APP_DIR" "$PORT" &
    SERVER_PID=$!
elif command -v npx >/dev/null 2>&1; then
    echo "[+] Using npx serve..."
    npx serve "$APP_DIR" -l "$PORT" &
    SERVER_PID=$!
elif command -v python >/dev/null 2>&1; then
    echo "[+] Using Python 2 SimpleHTTPServer..."
    (cd "$APP_DIR" && python -m SimpleHTTPServer "$PORT") &
    SERVER_PID=$!
else
    echo "[-] Error: No suitable static HTTP server found (checked python3, npx, python)."
    echo "[i] Please install Python 3 or Node.js to launch Lokarta."
    exit 1
fi

echo ""
echo "=== Lokarta: Come Into The Light is live! ==="
echo "  👉 Open in your browser: http://localhost:$PORT"
echo ""
echo "Press Ctrl+C to stop the server."

wait "$SERVER_PID"
