# Patchbay Go

Chat apps only linkify web links. Paste `obsidian://open?vault=Notes&file=today.md` into Telegram and it arrives as dead text. Your phone is holding a perfectly good URI it refuses to make tappable.

Patchbay Go is a tiny redirector that fixes that. Send `https://go.synodic.co/obs/Notes/today.md` instead: the chat app linkifies it, the tap opens a browser, and the browser, where custom schemes *are* allowed, hands off to `obsidian://`. One hop, a fraction of a second, and the app opens.

![The deployed landing page, contrasting a dead obsidian:// URI in a chat message with the tappable https link that replaces it](docs/screenshots/landing.png)

This is part of the Patchbay family of small tools that connect a phone chat app to a host that runs agents and apps, along with [Patchbay Relay](https://github.com/synodic-studio/patchbay-relay) and [Patchbay Voice](https://github.com/synodic-studio/patchbay-voice).

## Use it

There is nothing to install and no account to make. **`https://go.synodic.co` is live and open.** Build a URL and send it:

```
https://go.synodic.co/obs/MyVault/notes/today.md
https://go.synodic.co/things/Buy%20milk
https://go.synodic.co/cal/2026-03-14
```

Or [run your own](DEPLOYING.md), which is one file and a `wrangler` command. Then the domain is yours, the link prefix is yours, and the `/key` ciphertext sits in your own KV namespace instead of someone else's.

Worth knowing before you rely on it:

- **No auth, no logging, no state.** Every route is a pure function of the URL. The only storage anywhere is the optional KV namespace behind `/key`, and that holds ciphertext with a ten-minute TTL.
- **A wrapped link can only ever open a native app.** `/raw` refuses twelve browser-privileged schemes, `https:` among them, so a link built by someone else cannot run in your browser or quietly redirect you somewhere. [The list is short and worth reading.](#what-raw-refuses)
- **The redirect is not a guarantee the app opens.** If the target app is not installed, you land on the fallback page and nothing happens. There is no error to catch: that is the platform's behavior, not the worker's.
- **Host-agnostic.** Nothing is hardcoded to a domain; a deployment serves the same routes and advertises its own hostname.

## Screenshots

The redirect page is the entire user-facing surface of a wrapped link: it flashes by on the way into the app, and only lingers if the app is not installed. The `/key` form is the one page that asks for input.

![The redirect page: a spinner over the text "Opening today.md in Obsidian", with a manual tap-through link below it](docs/screenshots/redirect.png) ![The /key paste form: a labeled field reading "openai-api-key", a paste box, and an "Encrypt & send" button](docs/screenshots/key-form.png)

## Routes

| Route | Opens |
| --- | --- |
| `/obs/<vault>/<path>` | A note in Obsidian |
| `/remind/<title>` | A new reminder in Apple Reminders |
| `/cal/<yyyy-mm-dd>` | Calendar.app on that date. Add `/<hh:mm>` for a time |
| `/things/<title>` | A quick-add to-do in Things |
| `/todoist/<content>` | A new task in Todoist |
| `/omnifocus/<name>` | A new task in OmniFocus |
| `/due/<title>` | A new reminder in Due |
| `/bear/<title>` | A new note in Bear |
| `/drafts/<text>` | A new draft in Drafts |
| `/ulysses/<text>` | A new sheet in Ulysses |
| `/fantastical/<sentence>` | An event parsed from plain language, like `Lunch with Sam 1pm` |
| `/shortcuts/<name>` | A Shortcut, run by name |
| `/zoom/<meeting-id>` | A Zoom meeting |
| `/telegram/<username>` | A Telegram user or channel |
| `/whatsapp/<phone>` | A WhatsApp chat with a number |
| `/twitter/<handle>` | An X profile |
| `/instagram/<username>` | An Instagram profile |
| `/googlemaps/<query>` | A place in Google Maps |
| `/waze/<address>` | Navigation to an address in Waze |
| `/music` `/podcasts` `/overcast` `/soundcloud`<br>`/slack` `/discord` `/reddit` `/linkedin` | Just the app. These take no argument |
| `/raw/<base64url>` | Any other native scheme, base64url-encoded |
| `/key/<uuid>` | The encrypted paste form |
| `/` | The usage page, listing all of this for the deployment you are on |

Every value is URI-encoded for you, so `/things/Buy%20milk` is all a caller has to write. That predictability is the point: a language model gets these right on the first try, and agents are the main callers. `APP_ROUTES` in `src/worker.js` is the source of truth, and adding an app is one entry there.

For a scheme with no named route, base64url-encode the whole URI:

```
https://go.synodic.co/raw/dGhpbmdzOi8vLw       # opens things:///
```

### What `/raw` refuses

`/raw` takes a URI from whoever built the link, so it checks the scheme before emitting anything. These twelve are rejected with a 400:

| Runs or reads inside the browser | Never leaves the browser |
| --- | --- |
| `javascript:`<br>`vbscript:`<br>`data:`<br>`blob:`<br>`file:`<br>`filesystem:`<br>`about:`<br>`view-source:` | `http:`<br>`https:`<br>`ws:`<br>`wss:` |

The first column is the obvious half: those schemes execute script or read local content, so a wrapped link could do something in your browser rather than hand off to an app.

The second column is the one people miss. Refusing `http:` and `https:` is what keeps `/raw` from being an open redirect. Without it, anyone could publish `go.synodic.co/raw/<base64 of https://evil.example>` and their phishing link would be wearing this domain.

It is a denylist, matched case-insensitively against the scheme before the first colon, so it is only ever as complete as the browser's own set of privileged schemes. Everything after the scheme is escaped rather than trusted, so a payload that tries to break out of the redirect page cannot.

## The `/key` vault

An agent on your machine needs an API key that is on your phone. Pasting it into the chat leaves it in the chat history forever, and every other quick way just picks a different log to leave it in.

`/key` sends you a one-time link instead. You open it, paste the secret into a small labeled form, and the page encrypts it in your browser before anything is sent. The worker stores ciphertext and holds no key that could read it. The agent decrypts on its own machine, where its private key never was anywhere else.

[KEY-VAULT.md](KEY-VAULT.md) has the protocol, the reference client, and the limits.

## Agent hosts

Export the URL prefix on the host so agents pick it up:

```bash
export PATCHBAY_URL_WRAPPER="https://go.synodic.co"
```

Agent code that builds links reads this prefix and emits `${PATCHBAY_URL_WRAPPER}/obs/<vault>/<path>` instead of raw `obsidian://` URIs.

## License

MIT.
