#!/usr/bin/env bash
#
# A guided tour of a running deployment, and a smoke test of one.
#
#   scripts/demo.sh              pick a length from the menu
#   scripts/demo.sh short        the message and the tap, about 30 seconds
#   scripts/demo.sh long         adds what it refuses, and the /key handoff
#   scripts/demo.sh tour         every beat, including the test suite
#
#   --auto     run start to finish with no interaction, for rehearsal
#   --host H   point at another deployment, default https://go.synodic.co
#
# Nothing needs typing. One keypress advances a beat, one keypress picks a
# length. Credentials come from scripts/demo.env, which is gitignored; see
# scripts/demo.env.example. Without it the Telegram beat prints its cue
# instead of sending anything, and every other beat is unaffected.
#
# Offline, if the venue network is hostile:
#   npm run build && npx wrangler pages dev dist --kv VAULT
#   scripts/demo.sh long --host http://localhost:8788
# The /raw and /key beats work unchanged. The Telegram beat still sends,
# but the link it sends points at a host only this laptop can reach.
#
# Before demoing on a machine for the first time:
#   1. Telegram is signed in and the destination chat is visible.
#   2. Obsidian is installed and DEMO_VAULT/DEMO_NOTE actually exist in it.
#   3. Run it once in the browser you will demo with, and answer the
#      "allow this site to open Obsidian" prompt, so it stays quiet live.
#
# Deliberately without `set -e`. A failed beat prints and the tour continues.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="https://go.synodic.co"
MODE=""
AUTO=""

[ -f "$ROOT/scripts/demo.env" ] && . "$ROOT/scripts/demo.env"
DEMO_VAULT="${DEMO_VAULT:-Notes}"
DEMO_NOTE="${DEMO_NOTE:-today.md}"
DEMO_NOTE_ALT="${DEMO_NOTE_ALT:-}"
DEMO_KEY_LABEL="${DEMO_KEY_LABEL:-openai-api-key}"

while [ $# -gt 0 ]; do
  case "$1" in
    short|long|tour) MODE="$1"; shift ;;
    --host) HOST="${2%/}"; shift 2 ;;
    --auto) AUTO="1"; shift ;;
    -h|--help) sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; Y=$'\033[33m'; R=$'\033[0m'
else
  B=""; D=""; C=""; Y=""; R=""
fi

beat() { printf '\n%s%s== %s%s\n\n' "$D" "$B" "$1" "$R"; }
say()  { printf '%s%s%s\n' "$D" "$1" "$R"; }
warn() { printf '%s%s%s\n' "$Y" "$1" "$R"; }

# Any single key advances. Never waits when rehearsing.
advance() {
  [ -n "$AUTO" ] && return 0
  printf '\n%s[any key]%s' "$D" "$R"
  read -n 1 -s -r _ </dev/tty 2>/dev/null || read -r _ </dev/tty 2>/dev/null
  printf '\r%*s\r' 12 ""
}

# Print a command, then run it.
run() {
  local label="$1"; shift
  printf '%s$ %s%s\n' "$C" "$label" "$R"
  "$@" || printf '%s(exit %d)%s\n' "$Y" "$?" "$R"
}

if [ -z "$MODE" ]; then
  printf '\n%sPatchbay Go%s\n\n' "$B" "$R"
  printf '  %s1%s  short   the message and the tap, about 30 seconds\n' "$B" "$R"
  printf '  %s2%s  long    adds what it refuses, and the encrypted handoff\n' "$B" "$R"
  printf '  %s3%s  tour    every beat, including the test suite\n\n' "$B" "$R"
  printf '%s[1, 2 or 3]%s ' "$D" "$R"
  read -n 1 -s -r pick </dev/tty
  case "$pick" in
    1) MODE="short" ;;
    2) MODE="long" ;;
    3) MODE="tour" ;;
    *) MODE="short" ;;
  esac
  printf '%s\n' "$MODE"
fi

# Percent-encode a note path for the URL, leaving the separators alone.
encode_path() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe="/"))' "$1"; }

WRAPPED="$HOST/obsidian/$DEMO_VAULT/$(encode_path "$DEMO_NOTE")"
WRAPPED_ALT=""
[ -n "$DEMO_NOTE_ALT" ] && WRAPPED_ALT="$HOST/obsidian/$DEMO_VAULT/$(encode_path "$DEMO_NOTE_ALT")"
SCHEME="obsidian://open?vault=$DEMO_VAULT&file=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$DEMO_NOTE")"

# ---------------------------------------------------------------------------

beat_telegram() {
  beat "The problem, and the whole fix"
  say "Chat apps only linkify web links. The URI your machine knows how to"
  say "open is the one thing the chat refuses to make tappable."
  echo

  if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
    warn "No Telegram credentials, so nothing was sent. See scripts/demo.env.example."
    say "The message would carry the raw URI, the same URI behind a label,"
    say "and the wrapped link:"
    printf '\n  %s\n  %s\n' "$SCHEME" "$WRAPPED"
    return
  fi

  # Three attempts at the same destination, in HTML mode so the middle one
  # can be a real anchor. Telegram accepts that anchor and then drops it,
  # which is the point: the markup arrives with no link on it at all.
  local payload code
  payload=$(SCHEME="$SCHEME" WRAPPED="$WRAPPED" ALT="$WRAPPED_ALT" \
    CHAT="$TELEGRAM_CHAT_ID" THREAD="$TELEGRAM_THREAD_ID" python3 -c '
import html, json, os

scheme, wrapped, alt = os.environ["SCHEME"], os.environ["WRAPPED"], os.environ["ALT"]
e = html.escape
lines = [
    "Straight up:", e(scheme), "",
    "Behind a label, to force it:",
    f"<a href=\"{e(scheme, quote=True)}\">Open the note</a>", "",
    "Wrapped:", e(wrapped),
]
if alt:
    lines.append(e(alt))
body = {"chat_id": os.environ["CHAT"], "parse_mode": "HTML",
        "text": "\n".join(lines), "disable_web_page_preview": True}
if os.environ.get("THREAD"):
    body["message_thread_id"] = int(os.environ["THREAD"])
print(json.dumps(body))')

  printf '%s$ telegram sendMessage%s\n' "$C" "$R"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
    -H 'Content-Type: application/json' -d "$payload")
  if [ "$code" = "200" ]; then
    say "Sent. Three attempts at the same note, in the chat now."
    echo
    say "The first is grey text. The second was sent as a real hyperlink and"
    say "arrived as grey text too: Telegram took the markup, kept the label,"
    say "and threw the link away without saying so."
    echo
    say "The last one is tappable, and it opens the note."
  else
    warn "Telegram returned HTTP $code, so check the token and chat id."
  fi
}

beat_mechanism() {
  beat "One page, and no state anywhere"
  say "That link is not a lookup. Nothing was stored when it was built, and"
  say "nothing is stored when it is opened. The path is the whole input."
  echo
  run "curl -s $WRAPPED | grep http-equiv" \
    sh -c "curl -s '$WRAPPED' | grep -i 'http-equiv=\"refresh\"'"
  echo
  say "That is the entire mechanism. Browsers may follow custom schemes and"
  say "chat apps may not, so the link borrows a browser for a fraction of a"
  say "second. Nothing is pinned to a hostname either: any deployment serves"
  say "the same routes and hands out links on its own domain."
}

beat_raw() {
  beat "What it refuses to do"
  say "/raw takes a base64url URI, so whoever builds the link picks the"
  say "scheme. That is an open redirect waiting to happen, so it is checked."
  echo
  local evil good
  evil=$(printf 'https://evil.example' | base64 | tr -d '\n=' | tr '+/' '-_')
  good=$(printf 'spotify:track:4cOdK2wGLETKBW3PvgPWqT' | base64 | tr -d '\n=' | tr '+/' '-_')
  run "curl -so /dev/null -w '%{http_code}' $HOST/raw/\$(base64 https://evil.example)" \
    curl -s -o /dev/null -w '%{http_code}\n' "$HOST/raw/$evil"
  say "Refusing http and https is what stops a phishing link from wearing"
  say "this domain. javascript, data, file and blob are refused for the more"
  say "obvious reason: they run or read things inside the browser."
  echo
  run "curl -so /dev/null -w '%{http_code}' $HOST/raw/\$(base64 spotify:track:...)" \
    curl -s -o /dev/null -w '%{http_code}\n' "$HOST/raw/$good"
  say "A scheme that can only ever reach an app passes through."
}

beat_key() {
  beat "Handing a secret over with zero knowledge"
  say "An agent needs an API key that only you have. Pasting it into the chat"
  say "leaves it in the history forever. This passes it instead, and the"
  say "server is oblivious by construction: it only ever holds ciphertext."
  echo
  if ! command -v uv >/dev/null 2>&1; then
    warn "This beat needs uv: https://docs.astral.sh/uv/"
    return
  fi
  local flags="--host $HOST --label $DEMO_KEY_LABEL"
  [ -n "$AUTO" ] && flags="$flags --auto"
  [ -z "$AUTO" ] && [ -n "$TELEGRAM_BOT_TOKEN" ] && flags="$flags --telegram"
  run "uv run scripts/key_demo.py $flags" \
    uv run "$ROOT/scripts/key_demo.py" $flags
}

beat_cost() {
  beat "What it costs to run"
  say "One file, no runtime dependencies, and a suite that needs no network"
  say "and no Cloudflare account."
  echo
  run "wc -l src/worker.js" wc -l "$ROOT/src/worker.js"
  echo
  run "npm test" sh -c "cd '$ROOT' && npm test 2>&1 | tail -5"
}

# ---------------------------------------------------------------------------

printf '\n%sPatchbay Go%s  %s%s, %s%s\n' "$B" "$R" "$D" "$HOST" "$MODE" "$R"

case "$MODE" in
  short)
    beat_telegram
    ;;
  long)
    beat_telegram; advance
    beat_mechanism; advance
    beat_raw; advance
    beat_key
    ;;
  tour)
    beat_telegram; advance
    beat_mechanism; advance
    beat_raw; advance
    beat_key; advance
    beat_cost
    ;;
esac

printf '\n%sgithub.com/synodic-studio/patchbay-go%s\n\n' "$D" "$R"
