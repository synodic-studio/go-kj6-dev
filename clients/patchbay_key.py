#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["cryptography>=42", "certifi"]
# ///
"""Patchbay Go — end-to-end secret intake client.

Move a secret (API key, password, OTP) from a phone into an agent without it
ever touching a chat log — and without the go.synodic.co worker ever seeing the
plaintext. The worker only stores ciphertext; the private key never leaves this
machine.

    patchbay_key.py register <service> [--webhook URL]
        Generate a keypair, register the request, print the tappable link.
        The private key is held locally (0600) until `fetch`.

    patchbay_key.py fetch <service> [--print]
        Retrieve the ciphertext, decrypt locally, store it in `pass`
        (or --print it), then discard the private key.

Requires the `cryptography` package. Host defaults to https://go.synodic.co
(override with PATCHBAY_HOST).
"""

import argparse
import base64
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import certifi
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HOST = os.environ.get("PATCHBAY_HOST", "https://go.synodic.co").rstrip("/")
STATE = Path.home() / ".patchbay-go" / "pending"
# macOS framework Python has no system CA bundle; use certifi's explicitly.
_SSL = ssl.create_default_context(cafile=certifi.where())
# Cloudflare bot protection blocks the default "Python-urllib" UA; any other
# UA passes, so set an explicit one.
_UA = "patchbay-key/1.0"


def _post(url, obj):
    req = urllib.request.Request(
        url,
        data=json.dumps(obj).encode(),
        headers={"Content-Type": "application/json", "User-Agent": _UA},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15, context=_SSL) as r:
        return json.load(r)


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": _UA}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15, context=_SSL) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None


def register(service, webhook=None):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    spki = key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    body = {"label": service, "publicKey": base64.b64encode(spki).decode()}
    if webhook:
        body["webhook"] = webhook
    resp = _post(f"{HOST}/key/register", body)

    STATE.mkdir(parents=True, exist_ok=True)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    dest = STATE / f"{service}.json"
    dest.write_text(json.dumps({"uuid": resp["uuid"], "privateKey": pem.decode()}))
    dest.chmod(0o600)
    print(resp["url"])


def fetch(service, print_only=False):
    pending = STATE / f"{service}.json"
    if not pending.exists():
        sys.exit(f"No pending request for '{service}'. Run `register` first.")
    state = json.loads(pending.read_text())

    status, envelope = _get(f"{HOST}/key/{state['uuid']}/result")
    if status == 404:
        sys.exit("Not submitted yet (or already fetched). Ask them to tap the link.")
    if status != 200 or not envelope:
        sys.exit(f"Unexpected response ({status}).")

    key = serialization.load_pem_private_key(
        state["privateKey"].encode(), password=None
    )
    aes_key = key.decrypt(
        base64.b64decode(envelope["wrappedKey"]),
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    plaintext = AESGCM(aes_key).decrypt(
        base64.b64decode(envelope["iv"]),
        base64.b64decode(envelope["ciphertext"]),
        None,
    )

    if print_only:
        sys.stdout.buffer.write(plaintext)
    else:
        subprocess.run(
            ["pass", "insert", "-m", "-f", service],
            input=plaintext,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        print(f"stored in pass: {service}")
    pending.unlink()  # discard the private key


def main():
    ap = argparse.ArgumentParser(description="Patchbay Go E2E secret intake.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("register", help="register a request, print the link")
    r.add_argument("service")
    r.add_argument("--webhook", help="optional https callback fired on submit")

    f = sub.add_parser("fetch", help="decrypt the submitted secret into pass")
    f.add_argument("service")
    f.add_argument(
        "--print",
        dest="print_only",
        action="store_true",
        help="print the secret instead of storing it in pass",
    )

    args = ap.parse_args()
    if args.cmd == "register":
        register(args.service, args.webhook)
    else:
        fetch(args.service, args.print_only)


if __name__ == "__main__":
    main()
