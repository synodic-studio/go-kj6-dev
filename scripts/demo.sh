#!/usr/bin/env bash
#
# A guided tour of a running deployment, and a smoke test of one.
#
# Three beats: a chat message that only one link in survives, what /raw
# refuses to redirect to, and the encrypted /key handoff.
#
#   --auto     run start to finish with no interaction, for rehearsal
#   --host H   point at another deployment, default https://go.synodic.co
#
# Nothing needs typing; one keypress advances a beat. Credentials come from
# scripts/demo.env, which is gitignored; see scripts/demo.env.example.
# Without it the Telegram beat prints its cue instead of sending anything,
# and every other beat is unaffected.
#
# Offline, if the venue network is hostile:
#   npm run build && npx wrangler pages dev dist --kv VAULT
#   scripts/demo.sh --host http://localhost:8788
# The /raw and /key beats work unchanged. The Telegram beat still sends,
# but the link it sends points at a host only this laptop can reach.
#
# Before demoing on a machine for the first time:
#   1. Telegram is signed in and the destination chat is visible.
#   2. Obsidian is installed and DEMO_VAULT/DEMO_NOTE actually exist in it.
#   3. Run it once in the browser you will demo with, and answer the
#      "allow this site to open Obsidian" prompt, so it stays quiet live.
#
# Deliberately without `set -e`. A failed beat prints and the rest still runs.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="https://go.synodic.co"
AUTO=""

[ -f "$ROOT/scripts/demo.env" ] && . "$ROOT/scripts/demo.env"
DEMO_KEY_LABEL="${DEMO_KEY_LABEL:-weather-api-key}"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2%/}"; shift 2 ;;
    --auto) AUTO="1"; shift ;;
    -h|--help) sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Any single key advances. Never waits when rehearsing. Keys come from fd 3,
# the terminal opened at startup, so a redirected stdin does not swallow them.
advance() {
  [ -n "$AUTO" ] && return 0
  printf '\n%s[any key]%s' "$D" "$R"
  read -n 1 -s -r _ <&3
  printf '\r%*s\r' 12 ""
}

# Print a command, then run it.
run() {
  local label="$1"; shift
  printf '%s$ %s%s\n' "$C" "$label" "$R"
  "$@" || printf '%s(exit %d)%s\n' "$Y" "$?" "$R"
}

# Without a terminal every keypress returns instantly and all three beats run
# in one breath, which looks exactly like the demo failing. Say so and stop.
# Tested in a subshell first: a failed `exec` redirect prints its own error
# before any 2>/dev/null on the same line can take effect.
if [ -z "$AUTO" ]; then
  if (exec 3</dev/tty) 2>/dev/null; then
    exec 3</dev/tty
  else
    warn "No terminal to read keypresses from, so every beat would run at once."
    warn "Run it from a terminal, or use --auto to run the whole thing."
    exit 1
  fi
fi

if [ -z "$DEMO_VAULT" ] || [ -z "$DEMO_NOTE" ]; then
  printf '%sSet DEMO_VAULT and DEMO_NOTE in scripts/demo.env before demoing.%s\n' "$Y" "$R"
  printf '%sThey have to name a vault and note that exist here, or the link%s\n' "$Y" "$R"
  printf '%sopens an error dialog instead of a page. See demo.env.example.%s\n' "$Y" "$R"
  exit 1
fi

# Percent-encode a note path for the URL, leaving the separators alone.
encode_path() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe="/"))' "$1"; }

WRAPPED="$HOST/obsidian/$DEMO_VAULT/$(encode_path "$DEMO_NOTE")"
[ -n "$DEMO_NOTE_ALT" ] && WRAPPED_ALT="$HOST/obsidian/$DEMO_VAULT/$(encode_path "$DEMO_NOTE_ALT")"
SCHEME="obsidian://open?vault=$DEMO_VAULT&file=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$DEMO_NOTE")"

# ---------------------------------------------------------------------------

beat_telegram() {
  beat "The problem, and the whole fix"
  say "Chat apps only linkify web links."
  echo

  if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
    warn "No Telegram credentials, so nothing was sent. See scripts/demo.env.example."
    say "The message would carry the raw URI, the same URI behind a label,"
    say "and the wrapped link:"
    printf '\n  %s\n  %s\n' "$SCHEME" "$WRAPPED"
    return
  fi

  # The same destination four ways, in HTML mode so two of them can be real
  # anchors. Telegram accepts the custom-scheme anchor and then drops it,
  # which is the point: identical markup, and only the https one survives.
  local payload code
  payload=$(SCHEME="$SCHEME" WRAPPED="$WRAPPED" ALT="$WRAPPED_ALT" \
    NOTE="$DEMO_NOTE" NOTE_ALT="$DEMO_NOTE_ALT" \
    CHAT="$TELEGRAM_CHAT_ID" THREAD="$TELEGRAM_THREAD_ID" python3 -c '
import html, json, os

env = os.environ
e = html.escape
label = lambda path: e(path.rsplit("/", 1)[-1])
anchor = lambda href, text: f"<a href=\"{e(href, quote=True)}\">{text}</a>"

lines = [
    "The URI itself:", e(env["SCHEME"]), "",
    "The same URI behind a label, which does not help:",
    anchor(env["SCHEME"], "Open the note"), "",
    "Patchbay Go links:", e(env["WRAPPED"]),
]
if env["ALT"]:
    lines.append(e(env["ALT"]))
lines += ["", "The same links, labeled:",
          anchor(env["WRAPPED"], label(env["NOTE"]))]
if env["ALT"]:
    lines.append(anchor(env["ALT"], label(env["NOTE_ALT"])))

body = {"chat_id": env["CHAT"], "parse_mode": "HTML",
        "text": "\n".join(lines), "disable_web_page_preview": True}
if env.get("THREAD"):
    body["message_thread_id"] = int(env["THREAD"])
print(json.dumps(body))')

  printf '%s$ telegram sendMessage%s\n' "$C" "$R"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
    -H 'Content-Type: application/json' -d "$payload")
  if [ "$code" = "200" ]; then
    say "Sent. The same note, four ways."
    echo
    say "The top two are grey text. The second was a real hyperlink: the chat"
    say "kept the label and dropped the link, and called it a success."
    echo
    say "The other two work, labeled or not. Same markup, different scheme."
    echo
    # On screen as well as in the thread, so it can be pasted to whoever is
    # watching rather than only tapped on the phone.
    printf '  %s%s%s\n' "$B" "$WRAPPED" "$R"
  else
    warn "Telegram returned HTTP $code, so check the token and chat id."
  fi
}

beat_raw() {
  beat "What it refuses to do"
  say "/raw takes any URI, so the caller picks the scheme. It gets checked."
  echo
  local evil good
  evil=$(printf 'https://evil.example' | base64 | tr -d '\n=' | tr '+/' '-_')
  good=$(printf 'spotify:track:4cOdK2wGLETKBW3PvgPWqT' | base64 | tr -d '\n=' | tr '+/' '-_')
  run "curl -so /dev/null -w '%{http_code}' $HOST/raw/\$(base64 https://evil.example)" \
    curl -s -o /dev/null -w '%{http_code}\n' "$HOST/raw/$evil"
  say "Refusing http and https stops a phishing link from wearing this"
  say "domain. javascript, data and file would run inside the browser."
  echo
  run "curl -so /dev/null -w '%{http_code}' $HOST/raw/\$(base64 spotify:track:...)" \
    curl -s -o /dev/null -w '%{http_code}\n' "$HOST/raw/$good"
  say "A scheme that can only reach an app passes."
}

beat_key() {
  beat "Handing a secret over with zero knowledge"
  say "An agent needs a key only you have. Pasting it in the chat leaves it"
  say "there forever. This hands it over instead, and the server only ever"
  say "holds ciphertext."
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

# ---------------------------------------------------------------------------

printf '\n%sPatchbay Go%s  %s%s%s\n' "$B" "$R" "$D" "$HOST" "$R"

beat_telegram; advance
beat_raw; advance
beat_key

printf '\n%sgithub.com/synodic-studio/patchbay-go%s\n\n' "$D" "$R"
