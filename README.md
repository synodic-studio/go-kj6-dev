# patchbay-go

A small Cloudflare Worker that wraps custom URL schemes (`obsidian://`, `x-apple-reminderkit://`, `calshow:`, `things://`, `shortcuts://`, etc.) in plain `https://` links so Telegram and other chat apps recognize them as tappable. Part of the Synodic Patchbay family; it lives at a short `go.` host (e.g. `go.synodic.co`) — tap a link on the go, the app opens.

When an agent (or a script, or a human) wants to send a tappable link to a note in your Obsidian vault, a reminder, a calendar date, or anything else that lives behind a custom scheme, it cannot send `obsidian://open?vault=...` directly — most chat apps do not render custom schemes as links. Instead it sends `https://your-domain.example/obs/<vault>/<path>`. Tapping the link in the chat app opens it in the browser, which serves a tiny page that immediately redirects to the real native-scheme URI through `meta refresh` and a JS fallback. The app opens on your phone.

This is part of the [Patchbay](https://github.com/synodic-studio/patchbay-relay) family of small tools that connect a phone chat app to a host that runs agents and apps.

## Routes

| Route | Redirects to |
| --- | --- |
| `/obs/<vault>/<path>` | `obsidian://open?vault=<vault>&file=<path>` |
| `/remind/<title>` | `x-apple-reminderkit://REMCDReminder/<title>` |
| `/cal/<yyyy-mm-dd>` | `calshow:<epoch>` (Calendar.app) |
| `/cal/<yyyy-mm-dd>/<hh:mm>` | `calshow:<epoch>` at a specific time |
| `/raw/<base64url>` | Any **native** custom scheme (base64url-encoded full URI). Browser-privileged schemes (`javascript:`, `data:`, `http(s):`, …) are refused. |
| `/key/<uuid>` | Token-secured paste form (KV-backed, optional) |
| `/` | Usage page (renders the deployed hostname automatically) |

### Popular app routes

So callers rarely need `/raw`, common apps get named routes. Content routes take a single free-text value (URI-encoded automatically); launcher routes just open the app.

```
/things/<title>            things:///add?title=<title>
/todoist/<content>         todoist://addtask?content=<content>
/fantastical/<sentence>    x-fantastical3://parse?sentence=<sentence>
/shortcuts/<name>          shortcuts://run-shortcut?name=<name>
/bear/<title>  /drafts/<text>  /ulysses/<text>  /omnifocus/<name>  /due/<title>
/twitter/<handle>  /instagram/<username>  /telegram/<username>  /whatsapp/<phone>
/googlemaps/<query>  /waze/<address>  /zoom/<meeting-id>
/music  /podcasts  /overcast  /soundcloud  /slack  /discord  /reddit  /linkedin   (launchers)
```

The full, live list renders on the `/` page of a deployment (single source of truth is `APP_ROUTES` in `src/worker.js` — adding an app is one entry). For any scheme not listed, use `/raw/<base64url>`.

## Deploy

Runs as a **Cloudflare Pages** project (direct upload, advanced mode — the build step just copies `src/worker.js` to `dist/_worker.js`). You need a Cloudflare account and the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

```bash
npm install
cp wrangler.example.toml wrangler.toml   # edit project name to taste
npm run deploy                           # build + wrangler pages deploy dist
```

`npm run deploy` runs `wrangler pages deploy dist --project-name <name> --branch main`. The first deploy gives you `https://<name>.pages.dev`.

To put it on a short custom domain (recommended — nicer in chats), attach it to the Pages project and point DNS at `<name>.pages.dev` (proxied):

```bash
# attach custom domain to the project
curl -H "Authorization: Bearer $CF_TOKEN" -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCT/pages/projects/<name>/domains" \
  -d '{"name":"go.example.com"}'
# then create a proxied CNAME  go -> <name>.pages.dev  in that zone
```

### Headless deploy with API tokens

Set `CLOUDFLARE_API_TOKEN` (a token with **Cloudflare Pages: Edit**, plus **Workers Routes / DNS: Edit** on the zone if you attach a custom domain) and `CLOUDFLARE_ACCOUNT_ID` — no interactive `wrangler login` needed:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run deploy
```

## Optional: `/key` vault

The `/key/<uuid>` route is a KV-backed paste form for handing a secret value from a phone to a service, which reads it back from KV key `vault:<name>` directly (there is no `GET /vault/<name>` route on the worker). The value is encrypted at rest in Cloudflare KV, submitted over HTTPS, and TTL-expired within 5 minutes — short-lived and off the chat log, but not end-to-end encrypted (the worker and anything with KV access can read the plaintext during the window).

**Only the deployment operator can initiate a `/key` flow.** Starting one means writing the `token:<uuid>` entry into the `VAULT` KV, which requires that deployment's Cloudflare credentials — there is no worker route that mints tokens. A third party who merely taps the domain cannot request a secret. Patchbay Go is also self-hosted: anyone who wants the `/key` feature runs their own copy on their own Cloudflare account, so secrets only ever live in the operator's own KV, never someone else's.

To enable it:

```bash
npx wrangler kv namespace create VAULT
```

Take the returned `id` and uncomment + paste it into the `[[kv_namespaces]]` block in your `wrangler.toml`. If the binding is not present, `/key/*` returns 400 — every other route still works.

The expected flow is: the host generates a random token, calls `PUT token:<uuid> = <key-name>` on the KV (TTL e.g. 5 min), then DMs the user `https://your-domain.example/key/<uuid>`. The user taps, sees a form labeled with `<key-name>`, pastes the value, submits. The Worker writes `vault:<key-name> = <value>` with a 5-min TTL and deletes the token. The host polls `GET vault:<key-name>` and pulls the value into its real keystore.

## Use it from anywhere

Once it is deployed, any code that wants to send a tappable native-scheme link from a chat message can construct one of the wrapped URLs by hand. The Worker has no auth, no logging, and no state outside the optional KV.

For Obsidian:

```
https://your-domain.example/obs/MyVault/notes/today.md
```

For any other scheme, base64url-encode the full URI:

```
https://your-domain.example/raw/dGhpbmdzOi8vLw       # → things:///
```

## Pointing a Patchbay host at your domain

Once deployed, export the URL prefix as `PATCHBAY_URL_WRAPPER` on the host so agents pick it up:

```bash
export PATCHBAY_URL_WRAPPER="https://go.example.com"
```

Agent code that builds links reads this prefix and emits `${PATCHBAY_URL_WRAPPER}/obs/<vault>/<path>` instead of raw `obsidian://` URIs.

## License

MIT.
