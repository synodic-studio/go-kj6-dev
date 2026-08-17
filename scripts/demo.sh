#!/usr/bin/env bash
#
# A guided tour of a running deployment, and a smoke test of one.
#
# Five beats: what a wrapped link is, what it refuses to be, and the encrypted
# handoff behind /key. Each command is printed before it runs, so the terminal
# is the slide deck.
#
#   scripts/demo.sh                       tour https://go.synodic.co
#   scripts/demo.sh --auto                no second device needed, runs start to finish
#   scripts/demo.sh --host http://localhost:8788
#
# For the offline path, serve it yourself first:
#   npm run build && npx wrangler pages dev dist --kv VAULT
#
# Deliberately without `set -e`. A failed beat prints and the tour continues.

HOST="https://go.synodic.co"
AUTO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2%/}"; shift 2 ;;
    --auto) AUTO="--auto"; shift ;;
    -h|--help) sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; Y=$'\033[33m'; R=$'\033[0m'
else
  B=""; D=""; C=""; Y=""; R=""
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

beat() { printf '\n%s\n%s== %s%s\n\n' "$D--------------------------------------------------------------$R" "$B" "$1" "$R"; }
say()  { printf '%s%s%s\n' "$D" "$1" "$R"; }
pause() { printf '\n%s[enter]%s ' "$D" "$R"; read -r _; }

# Print a command, then run it.
run() {
  printf '%s$ %s%s\n' "$C" "$1" "$R"
  shift
  "$@"
  local rc=$?
  [ $rc -ne 0 ] && printf '%s(exit %d)%s\n' "$Y" "$rc" "$R"
  return $rc
}

printf '\n%sPatchbay Go%s  %s%s%s\n' "$B" "$R" "$D" "$HOST" "$R"

beat "The problem, on the device"
say "Paste an obsidian:// URI into a chat app and it arrives as dead text."
say "Chat apps only linkify web links, so the URI your phone knows how to open"
say "is the one thing it refuses to make tappable."
say ""
say "Send this instead, and it is a link like any other:"
printf '\n  %s/obsidian/Notes/today.md\n' "$HOST"
pause

beat "A wrapped link is one page and no state"
say "That link is not a lookup. Nothing was stored when it was built, and"
say "nothing is stored when it is opened. The path is the whole input."
echo
run "curl -s $HOST/obsidian/Notes/today.md | grep -i 'http-equiv=\"refresh\"'" \
  sh -c "curl -s '$HOST/obsidian/Notes/today.md' | grep -i 'http-equiv=\"refresh\"'"
echo
say "The browser is allowed to follow custom schemes. The chat app is not."
say "So the link takes one hop through a browser and hands off to the app."
say "Same routes on any hostname: nothing here is pinned to a domain."
pause

beat "What it refuses to do"
say "/raw takes a base64url URI, so whoever builds the link picks the scheme."
say "That is an open redirect waiting to happen, so the scheme is checked first."
echo
EVIL=$(printf 'https://evil.example' | base64 | tr -d '\n=' | tr '+/' '-_')
run "curl -s -o /dev/null -w '%{http_code}' $HOST/raw/$EVIL   # https://evil.example" \
  curl -s -o /dev/null -w '%{http_code}\n' "$HOST/raw/$EVIL"
say "400. Refusing http and https is what keeps a phishing link from wearing"
say "this domain. javascript, data, file and blob are refused for the more"
say "obvious reason: they run or read things inside the browser."
echo
GOOD=$(printf 'spotify:track:4cOdK2wGLETKBW3PvgPWqT' | base64 | tr -d '\n=' | tr '+/' '-_')
run "curl -s -o /dev/null -w '%{http_code}' $HOST/raw/$GOOD   # spotify:track:..." \
  curl -s -o /dev/null -w '%{http_code}\n' "$HOST/raw/$GOOD"
say "200. A scheme that can only ever reach an app passes through."
pause

beat "Handing a secret over with zero knowledge"
say "An agent needs an API key that only you have. Pasting it into the chat"
say "leaves it in the history forever. This route passes it instead, and the"
say "server is oblivious by construction: it only ever holds ciphertext."
echo
if command -v uv >/dev/null 2>&1; then
  run "uv run scripts/key_demo.py --host $HOST $AUTO" \
    uv run "$ROOT/scripts/key_demo.py" --host "$HOST" $AUTO
else
  printf '%suv is not installed, so this beat needs it: https://docs.astral.sh/uv/%s\n' "$Y" "$R"
fi
pause

beat "What it costs to run"
say "One file, no runtime dependencies, and a suite that needs no network"
say "and no Cloudflare account."
echo
run "wc -l src/worker.js" wc -l "$ROOT/src/worker.js"
echo
run "npm test" sh -c "cd '$ROOT' && npm test 2>&1 | tail -5"

printf '\n%sgithub.com/synodic-studio/patchbay-go%s\n\n' "$D" "$R"
