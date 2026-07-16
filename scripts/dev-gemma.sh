#!/usr/bin/env bash
# Launch opod-agent against a local MLX (gemma) chat model + Ollama embeddings.
#   scripts/dev-gemma.sh [start|stop|status]
# - Ollama serves embeddings (qwen3-embedding); mlx_lm.server serves gemma chat.
# - gemma is started once and left warm across opod restarts; `stop` kills it.
set -euo pipefail

# ── config (override via env) ────────────────────────────────────────────────
GEMMA_MODEL="${GEMMA_MODEL:-mlx-community/gemma-4-31b-it-8bit}"
GEMMA_HOST="${GEMMA_HOST:-127.0.0.1}"
GEMMA_PORT="${GEMMA_PORT:-8080}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-qwen3-embedding:8b}"
OPOD_PORT="${PORT:-8787}"
MLX_SERVER="${MLX_SERVER:-$HOME/.venv-mlx-lm/bin/mlx_lm.server}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.dev-logs"
GEMMA_LOG="$LOG_DIR/gemma.log"
GEMMA_PID="$LOG_DIR/gemma.pid"
GEMMA_URL="http://$GEMMA_HOST:$GEMMA_PORT"
mkdir -p "$LOG_DIR"

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
up() { curl -fsS -m 2 "$1" >/dev/null 2>&1; }

wait_until() { # url, label, tries
  local url="$1" label="$2" tries="${3:-120}"
  for ((i = 1; i <= tries; i++)); do
    up "$url" && { c_ok "  $label ready"; return 0; }
    sleep 1
  done
  c_err "  $label did not come up in ${tries}s (see $GEMMA_LOG)"; return 1
}

ensure_ollama() {
  echo "• Ollama ($OLLAMA_URL)"
  if ! up "$OLLAMA_URL/api/version"; then
    command -v ollama >/dev/null || { c_err "  ollama not installed"; exit 1; }
    c_warn "  not running — starting 'ollama serve'"
    nohup ollama serve >"$LOG_DIR/ollama.log" 2>&1 &
    wait_until "$OLLAMA_URL/api/version" "Ollama" 30 || exit 1
  else
    c_ok "  already running"
  fi
  if ! curl -fsS -m 3 "$OLLAMA_URL/api/tags" 2>/dev/null | grep -q "\"$EMBEDDING_MODEL\""; then
    c_warn "  embedding model '$EMBEDDING_MODEL' not found — pull it with:"
    c_warn "      ollama pull $EMBEDDING_MODEL"
  else
    c_ok "  embedding model '$EMBEDDING_MODEL' present"
  fi
}

ensure_gemma() {
  echo "• gemma chat ($GEMMA_URL)"
  if up "$GEMMA_URL/v1/models"; then c_ok "  already serving — reusing"; return; fi
  [ -x "$MLX_SERVER" ] || { c_err "  mlx_lm.server not found at $MLX_SERVER (set MLX_SERVER)"; exit 1; }
  c_warn "  starting mlx_lm.server (model loads lazily on first chat)"
  nohup "$MLX_SERVER" --model "$GEMMA_MODEL" --host "$GEMMA_HOST" --port "$GEMMA_PORT" \
    >"$GEMMA_LOG" 2>&1 &
  echo $! >"$GEMMA_PID"
  wait_until "$GEMMA_URL/v1/models" "gemma server" 120 || exit 1
}

start() {
  echo "=== opod-agent + gemma (MLX) + Ollama embeddings ==="
  ensure_ollama
  ensure_gemma
  echo "• opod-agent (:$OPOD_PORT)"
  c_ok "  playground → http://localhost:$OPOD_PORT/playground"
  echo
  cd "$ROOT"
  LLM_BASE_URL="$GEMMA_URL/v1" \
  LLM_MODEL="$GEMMA_MODEL" \
  LLM_API_KEY="not-needed" \
  EMBEDDING_BASE_URL="$OLLAMA_URL/v1" \
  EMBEDDING_API_KEY="ollama" \
  EMBEDDING_MODEL="$EMBEDDING_MODEL" \
  PORT="$OPOD_PORT" \
  exec npm run dev
}

stop() {
  echo "• stopping gemma server"
  if [ -f "$GEMMA_PID" ] && kill -0 "$(cat "$GEMMA_PID")" 2>/dev/null; then
    kill "$(cat "$GEMMA_PID")" && c_ok "  killed pid $(cat "$GEMMA_PID")"
    rm -f "$GEMMA_PID"
  else
    pkill -f "mlx_lm.server.*$GEMMA_PORT" && c_ok "  killed by port match" || c_warn "  no gemma server running"
  fi
  c_warn "  (Ollama left running — it is a shared system service)"
}

status() {
  up "$OLLAMA_URL/api/version" && c_ok "ollama   UP   $OLLAMA_URL" || c_err "ollama   DOWN $OLLAMA_URL"
  up "$GEMMA_URL/v1/models"    && c_ok "gemma    UP   $GEMMA_URL ($GEMMA_MODEL)" || c_err "gemma    DOWN $GEMMA_URL"
  up "http://localhost:$OPOD_PORT/healthz" \
    && c_ok "opod     UP   http://localhost:$OPOD_PORT  (playground: /playground)" \
    || c_err "opod     DOWN :$OPOD_PORT"
}

case "${1:-start}" in
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  *) echo "usage: $0 [start|stop|status]" >&2; exit 1 ;;
esac
