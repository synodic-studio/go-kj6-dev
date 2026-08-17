# Deploying your own

Running your own gets you the domain and the data: your Cloudflare account, your link prefix, your KV namespace. Nothing routes through anyone else's host, which matters most for `/key`, the one route that stores anything.

Patchbay Go runs as a **Cloudflare Pages** project in direct-upload advanced mode: the build step copies `src/worker.js` to `dist/_worker.js`, and Pages runs it as the function in front of the static assets. It is not a Workers deployment, and the distinction matters for `wrangler.toml`. A Workers-shaped config will fail here.

You need a Cloudflare account and the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

## First deploy

```bash
npm install
cp wrangler.example.toml wrangler.toml   # edit the project name to taste
npm run deploy                           # build + wrangler pages deploy dist
```

`npm run deploy` runs `wrangler pages deploy dist --project-name <name> --branch main`. The first deploy gives you `https://<name>.pages.dev`, which already works. Every route is live on it.

`wrangler.toml` is gitignored, because the project name and KV namespace id are environment state rather than source. `wrangler.example.toml` is the template.

## Headless deploy with API tokens

No interactive `wrangler login` is needed. Set two environment variables:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run deploy
```

The token needs **Cloudflare Pages: Edit**. If you also attach a custom domain, it needs **Workers Routes: Edit** and **DNS: Edit** on that zone.

## A short custom domain

Strongly recommended: the whole point is a link that looks harmless in a chat, and `go.example.com/obs/…` reads better than a `pages.dev` subdomain. Attach the domain to the Pages project, then point DNS at it:

```bash
curl -H "Authorization: Bearer $CF_TOKEN" -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCT/pages/projects/<name>/domains" \
  -d '{"name":"go.example.com"}'
```

Then create a **proxied** CNAME record `go` → `<name>.pages.dev` in that zone. Proxied matters: an unproxied record bypasses Pages entirely.

Nothing in the worker is pinned to a hostname. It serves the same routes on whatever domain reaches it, and the `/` usage page and `/key/register` responses both use the host the request came in on.

## Enabling `/key`

The `/key` routes need somewhere to put the ciphertext, so they need a KV namespace:

```bash
npx wrangler kv namespace create VAULT
```

Paste the returned `id` into the `[[kv_namespaces]]` block in your `wrangler.toml` and redeploy. Records carry a ten-minute TTL, and retrieval is one-shot. If the binding is absent, `/key/*` returns 400 and every other route works normally.

## Adding an app

`APP_ROUTES` in `src/worker.js` is the single source of truth for the named routes. An app is one entry: the custom-scheme prefix, a label, the name of the value it takes, and a one-line description for the usage page. Set `bare: true` for a launcher that ignores its path tail, or `alias: true` for a spelling that works but stays off the usage page.

Only *custom* schemes belong there. An app that opens from an ordinary https universal link needs no wrapping, because chat apps already make those tappable.

## Local development

```bash
npm run dev    # build + wrangler pages dev dist
npm test       # vitest, no network or Cloudflare account needed
```

To exercise `/key` locally, add a local KV namespace:

```bash
npx wrangler pages dev dist --kv VAULT
```

The test suite stubs KV entirely, so `npm test` covers the `/key` routes without any binding.

`scripts/demo.sh` is a guided tour of a running deployment and a smoke test of one: point it at any host with `--host`, add `--auto` to run the `/key` handoff without a second device.
