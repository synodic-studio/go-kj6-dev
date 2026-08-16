# Patchbay Go

Chat apps only linkify `http(s)`. Paste `obsidian://open?vault=Notes&file=today.md` into Telegram and it arrives as dead text — your phone is holding a perfectly good URI it refuses to make tappable.

Patchbay Go is a tiny redirector that fixes that. Send `https://go.synodic.co/obs/Notes/today.md` instead: the chat app linkifies it, the tap opens a browser, and the browser — where custom schemes *are* allowed — hands off to `obsidian://`. One hop, a fraction of a second, and the app opens.

![The deployed landing page, contrasting a dead obsidian:// URI in a chat message with the tappable https link that replaces it](docs/screenshots/landing.png)

This is part of the [Patchbay](https://github.com/synodic-studio/patchbay-relay) family of small tools that connect a phone chat app to a host that runs agents and apps.

## Use it

There is nothing to install and no account to make. **`https://go.synodic.co` is live and open** — build a URL and send it:

```
https://go.synodic.co/obs/MyVault/notes/today.md
https://go.synodic.co/things/Buy%20milk
https://go.synodic.co/cal/2026-03-14
```

It is offered as-is, on a free tier, with no uptime promise. If you would rather not depend on someone else's host — or you want the `/key` vault, which stores data — [deploy your own](DEPLOYING.md). It is one file and a `wrangler` command.

Worth knowing before you rely on it:

- **No auth, no logging, no state.** Every route is a pure function of the URL. The only storage anywhere is the optional KV namespace behind `/key`, and that holds ciphertext with a ten-minute TTL.
- **A wrapped link can only ever open a native app.** `/raw` refuses browser-privileged schemes (`javascript:`, `data:`, `http(s):`, …), so a link built by someone else cannot run in your browser.
- **The redirect is not a guarantee the app opens.** If the target app is not installed, you land on the fallback page and nothing happens. There is no error to catch — that is the platform's behavior, not the worker's.
- **Host-agnostic.** Nothing is hardcoded to a domain; a deployment serves the same routes and advertises its own hostname.

## What a tap looks like

The redirect page is the entire user-facing surface of a wrapped link: it flashes by on the way into the app, and only lingers if the app is not installed. The `/key` form is the one page that asks for input.

<p>
  <img src="docs/screenshots/redirect.png" alt="The redirect page: a spinner over the text &quot;Opening today.md in Obsidian&quot;, with a manual tap-through link below it" width="340">
  <img src="docs/screenshots/key-form.png" alt="The /key paste form: a labeled field reading &quot;OpenAI API key&quot;, a paste box, and an &quot;Encrypt &amp; send&quot; button" width="340">
</p>

## Routes

| Route | Redirects to |
| --- | --- |
| `/obs/<vault>/<path>` | `obsidian://open?vault=<vault>&file=<path>` |
| `/remind/<title>` | `x-apple-reminderkit://REMCDReminder/<title>` |
| `/cal/<yyyy-mm-dd>` | `calshow:<epoch>` (Calendar.app) |
| `/cal/<yyyy-mm-dd>/<hh:mm>` | `calshow:<epoch>` at a specific time |
| `/raw/<base64url>` | Any **native** custom scheme (base64url-encoded full URI). Browser-privileged schemes are refused. |
| `/key/<uuid>` | Token-secured paste form (KV-backed, optional) |
| `/` | Usage page (renders the deployed hostname automatically) |

### Popular app routes

Common apps get named routes, so callers rarely need `/raw`. Content routes take a single free-text value, URI-encoded for you:

- `/things/<title>` → `things:///add?title=<title>`
- `/todoist/<content>` → `todoist://addtask?content=<content>`
- `/fantastical/<sentence>` → `x-fantastical3://parse?sentence=<sentence>`, natural language like `Lunch with Sam tomorrow 1pm`
- `/shortcuts/<name>` → runs a Shortcut by name
- `/bear/<title>`, `/drafts/<text>`, `/ulysses/<text>`, `/omnifocus/<name>`, `/due/<title>` → notes and tasks
- `/twitter/<handle>`, `/instagram/<username>`, `/telegram/<username>`, `/whatsapp/<phone>` → a profile or a chat
- `/googlemaps/<query>`, `/waze/<address>`, `/zoom/<meeting-id>` → maps and meetings

Launchers take no argument and just open the app: `/music`, `/podcasts`, `/overcast`, `/soundcloud`, `/slack`, `/discord`, `/reddit`, `/linkedin`.

Because the path is plain and predictable, a language model writes `go.synodic.co/things/Buy%20milk` correctly on the first try — which is the point, since agents are the main callers. The live list renders on the `/` page of any deployment; the single source of truth is `APP_ROUTES` in `src/worker.js`, and adding an app is one entry.

For any scheme not listed, base64url-encode the full URI and use `/raw`:

```
https://go.synodic.co/raw/dGhpbmdzOi8vLw       # → things:///
```

## `/key`: move a secret without putting it in a chat log

An agent needs your API key. Pasting it into the chat means it lives in the chat history, on a server, forever. `/key` is the way around that.

The agent generates a keypair and registers its **public** key, which yields a one-time `https://<host>/key/<uuid>` link. You open it, paste the secret into the form, and the page encrypts it *in your browser* — AES-GCM, wrapped to the agent's RSA-OAEP key — before anything is sent. The worker only ever stores ciphertext and never holds a key that could read it. The agent fetches the envelope and decrypts it on its own machine, where its private key never left.

```
POST /key/register  {label, publicKey, webhook?}  -> {uuid, secret, url}
GET  /key/<uuid>                                  -> browser-encrypting form
POST /key/<uuid>    {envelope}                    -> stores ciphertext, fires webhook
GET  /key/<uuid>/result                           -> one-shot ciphertext retrieval
```

A ready-to-use client is in [`clients/patchbay_key.py`](clients/patchbay_key.py), a self-contained `uv` script:

```bash
uv run clients/patchbay_key.py register my-service   # prints the tappable link
uv run clients/patchbay_key.py fetch my-service      # decrypts into `pass`
```

These routes are the only part that needs storage, so they only work on a deployment with a KV namespace bound — see [DEPLOYING.md](DEPLOYING.md). Without the binding, `/key/*` returns 400 and every other route still works.

## Pointing a Patchbay host at your domain

Export the URL prefix on the host so agents pick it up:

```bash
export PATCHBAY_URL_WRAPPER="https://go.synodic.co"
```

Agent code that builds links reads this prefix and emits `${PATCHBAY_URL_WRAPPER}/obs/<vault>/<path>` instead of raw `obsidian://` URIs.

## License

MIT.
