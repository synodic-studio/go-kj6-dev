#!/usr/bin/env bash
set -e

# Script to create QA Gate labels via Forgejo API
# Requires environment variable FORGEJO_TOKEN with an API token
# and optionally FORGEJO_HOST (defaults to codeberg.org)

FORGEJO_HOST="${FORGEJO_HOST:-codeberg.org}"
REPO_OWNER="$(git remote get-url origin | sed -E 's|.*[/:]([^/]+)/([^/]+)\.git|\1/\2|')"
if [[ -z "${REPO_OWNER}" ]]; then
    echo "Could not detect repository owner/name."
    exit 1
fi

API_URL="https://${FORGEJO_HOST}/api/v1/repos/${REPO_OWNER}/labels"

echo "Using repository: ${REPO_OWNER}"
echo "API endpoint: ${API_URL}"

if [[ -z "${FORGEJO_TOKEN}" ]]; then
    echo "ERROR: FORGEJO_TOKEN environment variable is not set."
    echo "Please generate a token at https://${FORGEJO_HOST}/user/settings/applications"
    exit 1
fi

create_label() {
    local name="$1"
    local color="$2"
    echo "Creating label: ${name}"
    curl -s -f -X POST \
        -H "Accept: application/vnd.github.v3+json" \
        -H "Authorization: token ${FORGEJO_TOKEN}" \
        "${API_URL}" \
        -d "{\"name\":\"${name}\",\"color\":\"${color}\"}" \
        && echo "  OK" \
        || echo "  Failed (maybe already exists, continuing)"
}

create_label "qa-pass" "0e8a16"
create_label "author-pass" "fbca04"
create_label "i18n-pass" "0052cc"

echo "Done."
