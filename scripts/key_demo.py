#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["cryptography>=42", "certifi"]
# ///
"""Walk one /key handoff from both ends, in a single process.

The requester side of the protocol, instrumented so the envelope the server
held is visible next to the plaintext it could never read. Retrieval is
one-shot, so the fetch happens exactly once here: printing the envelope and
decrypting it are two views of the same response.

    key_demo.py                 register, wait for a human to submit, reveal
    key_demo.py --telegram      send the link to a chat, the way an agent would
    key_demo.py --auto          submit the secret from here too, no browser

The private key lives in memory for the life of the process and is never
written anywhere. `clients/patchbay_key.py` is the real client; this one
exists to make the protocol legible while it runs.
"""

import argparse
import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

import certifi
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DEMO_SECRET = b"sk-live-DEMO-not-a-real-key-0000"
CTX = ssl.create_default_context(cafile=certifi.where())
UA = "patchbay-demo/1.0"

BOLD, DIM, GREEN, YELLOW, RESET = "\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[0m"
if not sys.stdout.isatty():
    BOLD = DIM = GREEN = YELLOW = RESET = ""


def post(url, obj):
    req = urllib.request.Request(
        url,
        data=json.dumps(obj).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
        body = r.read()
        return r.status, (json.loads(body) if body else None)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None


def telegram(text):
    """Send the link the way a real agent would ask for a secret.

    Credentials come from the environment, so the demo config stays out of
    the repo. Returns False and stays quiet if there is nothing to send with.
    """
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return False
    body = {"chat_id": chat, "text": text, "disable_web_page_preview": True}
    thread = os.environ.get("TELEGRAM_THREAD_ID")
    if thread:
        body["message_thread_id"] = int(thread)
    try:
        status, _ = post(f"https://api.telegram.org/bot{token}/sendMessage", body)
        return status == 200
    except Exception:
        return False


def encrypt_to(public_key, secret):
    """The browser's half: fresh AES key, wrapped to the requester's public key."""
    aes = AESGCM.generate_key(bit_length=256)
    iv = os.urandom(12)
    ciphertext = AESGCM(aes).encrypt(iv, secret, None)
    wrapped = public_key.encrypt(
        aes,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return {
        "v": 1,
        "alg": "RSA-OAEP+A256GCM",
        "wrappedKey": base64.b64encode(wrapped).decode(),
        "iv": base64.b64encode(iv).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }


def decrypt(private_key, envelope):
    aes = private_key.decrypt(
        base64.b64decode(envelope["wrappedKey"]),
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return AESGCM(aes).decrypt(
        base64.b64decode(envelope["iv"]),
        base64.b64decode(envelope["ciphertext"]),
        None,
    )


def main():
    ap = argparse.ArgumentParser(description="Narrated /key handoff.")
    ap.add_argument("--host", default=os.environ.get("PATCHBAY_HOST", "https://go.synodic.co"))
    ap.add_argument("--label", default="openai-api-key")
    ap.add_argument("--auto", action="store_true", help="submit the secret from here, no browser")
    ap.add_argument("--telegram", action="store_true", help="send the link to a chat")
    ap.add_argument("--timeout", type=int, default=180, help="seconds to wait for a submission")
    args = ap.parse_args()
    host = args.host.rstrip("/")

    print(f"{DIM}Generating a keypair. The private half stays in this process.{RESET}")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    spki = key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    print(f"{DIM}Only the public half is sent.{RESET}")
    try:
        status, reg = post(
            f"{host}/key/register",
            {"label": args.label, "publicKey": base64.b64encode(spki).decode()},
        )
    except Exception as e:
        sys.exit(f"{YELLOW}register failed: {e}{RESET}")
    if status != 200 or not reg:
        sys.exit(f"{YELLOW}register returned HTTP {status}{RESET}")

    sent = False
    if args.telegram:
        sent = telegram(f"I need your {args.label}. Paste it here, it is "
                        f"encrypted in your browser:\n\n{reg['url']}")

    if sent:
        print(f"\n{BOLD}Asked for it in the chat. Tap the link there:{RESET}\n")
    else:
        print(f"\n{BOLD}Tap this, paste anything, and send it:{RESET}\n")
    print(f"  {reg['url']}\n")

    if args.auto:
        print(f"{DIM}--auto: encrypting in place instead of waiting for a browser.{RESET}")
        status, _ = post(f"{host}/key/{reg['uuid']}", encrypt_to(key.public_key(), DEMO_SECRET))
        if status != 200:
            sys.exit(f"{YELLOW}submit returned HTTP {status}{RESET}")
    else:
        print(f"{DIM}Waiting for a submission. Ctrl-C to give up.{RESET}")

    deadline = time.time() + args.timeout
    envelope = None
    while time.time() < deadline:
        status, envelope = get(f"{host}/key/{reg['uuid']}/result")
        if status == 200 and envelope:
            break
        if status not in (404, 200):
            sys.exit(f"{YELLOW}fetch returned HTTP {status}{RESET}")
        time.sleep(2)
    if not envelope:
        sys.exit(f"{YELLOW}Nothing was submitted before the timeout.{RESET}")

    print(f"\n{BOLD}Everything the server held:{RESET}\n")
    print(json.dumps(envelope, indent=2))

    plaintext = decrypt(key, envelope)
    print(f"\n{BOLD}Decrypted here, with a key it never had:{RESET}\n")
    print(f"  {GREEN}{plaintext.decode(errors='replace')}{RESET}\n")

    status, _ = get(f"{host}/key/{reg['uuid']}/result")
    verdict = "gone" if status == 404 else f"still there, HTTP {status}"
    print(f"{DIM}Asking for it a second time: {verdict}. Retrieval is one-shot.{RESET}")


if __name__ == "__main__":
    main()
