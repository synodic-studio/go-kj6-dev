---
name: patchbay-go
description: Use when generating a tappable https link to a native-app URL scheme (Obsidian, Apple Reminders/Calendar, Things, Fantastical, WhatsApp, Telegram, and more) for Telegram or any chat app that won't render custom schemes as links. Patchbay Go wraps the scheme in a plain https link at go.synodic.co that redirects into the app on tap.
---

# Patchbay Go

Chat apps (Telegram especially) won't linkify custom URL schemes like `obsidian://` or `things:///`. Patchbay Go is a redirector at **`https://go.synodic.co`** that wraps them in a normal https link. Tap it → a tiny page meta-refreshes (with a JS fallback) into the native app.

Always emit `https://go.synodic.co/...` links, never raw `obsidian://` / `things://` schemes, when the link is destined for a chat message.

## Core routes

```
https://go.synodic.co/obs/<vault>/<path>        → obsidian://open?vault=…&file=…
https://go.synodic.co/remind/<title>            → Apple Reminders
https://go.synodic.co/cal/<yyyy-mm-dd>          → Calendar.app (optionally /<hh:mm>)
https://go.synodic.co/raw/<base64url>           → any native scheme (browser-privileged
                                                   schemes like javascript:/http(s): refused)
https://go.synodic.co/key/<uuid>                → end-to-end encrypted secret intake form
```

The first `/obs/` segment is the Obsidian vault name; everything after it is the vault-relative file path.

To collect a secret (API key, password) without it touching the chat log, use the `/key` flow via the reference client — it encrypts in the browser and the worker never sees the plaintext:

```
uv run <patchbay-go>/clients/patchbay_key.py register <service>   # prints the link
uv run <patchbay-go>/clients/patchbay_key.py fetch <service>       # decrypts into pass
```

## Named app routes (so you rarely need /raw)

Content routes take one free-text value (URI-encoded automatically):

```
/things/<title>          /todoist/<content>     /omnifocus/<name>    /due/<title>
/bear/<title>            /drafts/<text>         /ulysses/<text>
/fantastical/<sentence>  (natural language, e.g. "Lunch with Sam tomorrow 1pm")
/shortcuts/<name>        (run a Shortcut by name)
/twitter/<handle>        /instagram/<username>  /telegram/<username>  /whatsapp/<phone>
/googlemaps/<query>      /waze/<address>        /zoom/<meeting-id>
```

Launchers (just open the app, no argument):

```
/music  /podcasts  /overcast  /soundcloud  /slack  /discord  /reddit  /linkedin
```

The live, authoritative list renders on `https://go.synodic.co/` (single source of truth is `APP_ROUTES` in the patchbay-go worker). For any scheme not covered, base64url-encode the full URI and use `/raw/<base64url>`.

Note: a named route with a wrong or stale scheme prefix produces a link that redirects but silently opens nothing — no error. If an app doesn't open, fall back to `/raw` with the correct scheme.

## Notes

- The redirect page is sub-second; the user never really sees it. The bare `/` page is a Synodic Studio billboard.
