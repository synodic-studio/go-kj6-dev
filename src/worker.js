/**
 * patchbay-go
 *
 * Cloudflare Pages worker (advanced-mode _worker.js) that wraps custom URL
 * schemes (obsidian://, things://, x-apple-reminderkit://, calshow:, etc.) in
 * plain https:// URLs that Telegram and other chat apps recognize as tappable.
 * When the wrapped link is opened, the page redirects into the native app via
 * a meta refresh and JS fallback.
 *
 * Also includes an optional end-to-end encrypted "key vault": a requester
 * registers a public key, the phone encrypts the secret in the browser, and
 * the worker stores only ciphertext, which the requester retrieves and
 * decrypts. The worker never sees the plaintext and never holds a private key.
 *
 * Routes:
 *   /obs/<vault>/<path>       → obsidian://open?vault=<vault>&file=<path>
 *   /remind/<title>           → x-apple-reminderkit://REMCDReminder/<title>
 *   /cal/<yyyy-mm-dd>         → calshow:<epoch> (opens Calendar.app)
 *   /raw/<base64url>          → any custom scheme (base64url-encoded)
 *   POST /key/register        → start an E2E request {label, publicKey, webhook?}
 *   /key/<uuid>               → browser-encrypting paste form (ciphertext only)
 *   GET  /key/<uuid>/result   → one-shot ciphertext retrieval
 *   /                         → usage page
 *
 * The /key routes are no-op if no `VAULT` KV namespace is bound.
 */

/**
 * @typedef {Object} Env
 * @property {import("@cloudflare/workers-types").KVNamespace} [VAULT]
 */

/**
 * @typedef {Object} AppRoute
 * @property {string} prefix - Custom-scheme prefix; the URI-encoded path tail
 *   is appended to it to form the final native-app URI.
 * @property {string} label - Human name shown on the redirect + billboard.
 * @property {string} param - Name of the tail value, for usage hints.
 * @property {string} opens - One-line description of what it opens.
 */

/**
 * Named routes for popular apps so callers rarely need /raw. Each maps a short
 * path segment to a custom-scheme prefix; `/things/Buy%20milk` becomes
 * `things:///add?title=Buy%20milk`. Only *custom* schemes belong here — apps
 * that open via an https universal link (Maps, Spotify web, ...) need no
 * wrapping. Routes are safe by construction (fixed prefix + encoded tail), so
 * they skip the isSafeScheme check that /raw needs.
 * @type {Record<string, AppRoute>}
 */
const APP_ROUTES = {
  // Content deep-links: the path tail is a single free-text value that gets
  // URI-encoded and appended to `prefix`. These replace most /raw usage.
  things: {
    prefix: "things:///add?title=",
    label: "Things",
    param: "title",
    opens: "Things — quick-add a to-do",
  },
  shortcuts: {
    prefix: "shortcuts://run-shortcut?name=",
    label: "Shortcuts",
    param: "name",
    opens: "Shortcuts — run a shortcut by name",
  },
  bear: {
    prefix: "bear://x-callback-url/create?title=",
    label: "Bear",
    param: "title",
    opens: "Bear — new note",
  },
  drafts: {
    prefix: "drafts://x-callback-url/create?text=",
    label: "Drafts",
    param: "text",
    opens: "Drafts — new draft",
  },
  ulysses: {
    prefix: "ulysses://x-callback-url/new-sheet?text=",
    label: "Ulysses",
    param: "text",
    opens: "Ulysses — new sheet",
  },
  todoist: {
    prefix: "todoist://addtask?content=",
    label: "Todoist",
    param: "content",
    opens: "Todoist — add a task",
  },
  omnifocus: {
    prefix: "omnifocus:///add?name=",
    label: "OmniFocus",
    param: "name",
    opens: "OmniFocus — add a task",
  },
  due: {
    prefix: "due://x-callback-url/add?title=",
    label: "Due",
    param: "title",
    opens: "Due — new reminder",
  },
  fantastical: {
    prefix: "x-fantastical3://parse?sentence=",
    label: "Fantastical",
    param: "sentence",
    opens: "Fantastical — new event from natural language",
  },
  twitter: {
    prefix: "twitter://user?screen_name=",
    label: "X (Twitter)",
    param: "handle",
    opens: "X — open a profile",
  },
  instagram: {
    prefix: "instagram://user?username=",
    label: "Instagram",
    param: "username",
    opens: "Instagram — open a profile",
  },
  telegram: {
    prefix: "tg://resolve?domain=",
    label: "Telegram",
    param: "username",
    opens: "Telegram — open a user or channel",
  },
  whatsapp: {
    prefix: "whatsapp://send?phone=",
    label: "WhatsApp",
    param: "phone",
    opens: "WhatsApp — message a phone number",
  },
  googlemaps: {
    prefix: "comgooglemaps://?q=",
    label: "Google Maps",
    param: "query",
    opens: "Google Maps — search a place",
  },
  waze: {
    prefix: "waze://?q=",
    label: "Waze",
    param: "address",
    opens: "Waze — navigate to an address",
  },
  zoom: {
    prefix: "zoommtg://zoom.us/join?confno=",
    label: "Zoom",
    param: "meeting-id",
    opens: "Zoom — join a meeting by ID",
  },

  // Launchers: no argument, just open the app. `bare` ignores the path tail.
  music: {
    prefix: "music://",
    label: "Apple Music",
    bare: true,
    opens: "Apple Music",
  },
  podcasts: {
    prefix: "podcasts://",
    label: "Apple Podcasts",
    bare: true,
    opens: "Apple Podcasts",
  },
  overcast: {
    prefix: "overcast://",
    label: "Overcast",
    bare: true,
    opens: "Overcast",
  },
  soundcloud: {
    prefix: "soundcloud://",
    label: "SoundCloud",
    bare: true,
    opens: "SoundCloud",
  },
  slack: { prefix: "slack://open", label: "Slack", bare: true, opens: "Slack" },
  discord: {
    prefix: "discord://",
    label: "Discord",
    bare: true,
    opens: "Discord",
  },
  reddit: { prefix: "reddit://", label: "Reddit", bare: true, opens: "Reddit" },
  linkedin: {
    prefix: "linkedin://",
    label: "LinkedIn",
    bare: true,
    opens: "LinkedIn",
  },
};

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} [ctx]
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      // Serve the static marketing page (dist/index.html) when the Pages
      // assets binding is present; fall back to the inline billboard (dev/test,
      // or a deploy without the asset).
      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response(usagePage(url.host), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path.startsWith("/key/")) {
      if (!env || !env.VAULT) {
        return errorResponse("Key vault is not configured on this deployment.");
      }
      if (path === "/key/register") {
        return handleKeyRegister(request, env);
      }
      if (path.endsWith("/result")) {
        const uuid = decodeURIComponent(path.slice(5).replace(/\/result$/, ""));
        return handleKeyResult(env, uuid);
      }
      return handleKeyVault(request, env, path, ctx);
    }

    if (path.startsWith("/obs/")) {
      const rest = decodeURIComponent(path.slice(5));
      const slashIndex = rest.indexOf("/");
      if (slashIndex === -1) {
        return errorResponse("Missing file path. Format: /obs/<vault>/<path>");
      }
      const vault = rest.slice(0, slashIndex);
      const file = rest.slice(slashIndex + 1);
      const appUri = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
      return redirectPage(appUri, `Opening "${file}" in Obsidian`);
    }

    if (path.startsWith("/remind/")) {
      const title = decodeURIComponent(path.slice(8));
      if (!title) {
        return errorResponse("Missing reminder title. Format: /remind/<title>");
      }
      const appUri = `x-apple-reminderkit://REMCDReminder/${encodeURIComponent(title)}`;
      return redirectPage(appUri, `Opening reminder: "${title}"`);
    }

    if (path.startsWith("/cal/")) {
      const rest = decodeURIComponent(path.slice(5));
      const match = rest.match(/^(\d{4}-\d{2}-\d{2})(?:\/(\d{2}:\d{2}))?$/);
      if (!match) {
        return errorResponse(
          "Invalid date. Format: /cal/YYYY-MM-DD or /cal/YYYY-MM-DD/HH:MM",
        );
      }
      const dateStr = match[2]
        ? `${match[1]}T${match[2]}:00`
        : `${match[1]}T00:00:00`;
      // calshow: expects Cocoa/CFAbsoluteTime (seconds since 2001-01-01), NOT
      // Unix epoch. Emitting Unix epoch opened Calendar ~31 years late
      // (verified on-device 2026-07-11: /cal/2026-03-15 landed on March 2057).
      // 978307200 = seconds from 1970-01-01 to 2001-01-01.
      const COCOA_EPOCH_OFFSET = 978307200;
      const epoch =
        Math.floor(new Date(dateStr).getTime() / 1000) - COCOA_EPOCH_OFFSET;
      const appUri = `calshow:${epoch}`;
      const display = match[2] ? `${match[1]} at ${match[2]}` : match[1];
      return redirectPage(appUri, `Opening Calendar: ${display}`);
    }

    if (path.startsWith("/raw/")) {
      const encoded = path.slice(5);
      let appUri;
      try {
        appUri = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
      } catch {
        return errorResponse("Invalid base64url encoding.");
      }
      if (!isSafeScheme(appUri)) {
        return errorResponse(
          "Refused: only native app schemes are allowed here, not browser-privileged ones (javascript, data, http, https, ...).",
        );
      }
      return redirectPage(appUri, "Redirecting to app...");
    }

    const segments = path.slice(1).split("/");
    const appKey = segments[0];
    if (Object.prototype.hasOwnProperty.call(APP_ROUTES, appKey)) {
      const route = APP_ROUTES[appKey];
      if (route.bare) {
        return redirectPage(route.prefix, `Opening ${route.label}`);
      }
      const tail = decodeURIComponent(segments.slice(1).join("/"));
      if (!tail) {
        return errorResponse(
          `Missing input. Format: /${appKey}/<${route.param}>`,
        );
      }
      const appUri = route.prefix + encodeURIComponent(tail);
      return redirectPage(appUri, `Opening ${route.label}`);
    }

    return errorResponse(`Unknown route: ${path}`);
  },
};

/**
 * Encode a string as a JS string literal safe to embed inside an inline
 * <script>. JSON.stringify alone does not neutralize "</script>" (or the
 * JS-string-breaking line separators U+2028/U+2029), so a /raw value such as
 * `x://</script><img onerror=...>` — whose scheme passes isSafeScheme — would
 * otherwise break out of the script tag and execute (reflected XSS).
 * @param {string} str
 * @returns {string}
 */
export function jsStringLiteral(str) {
  return JSON.stringify(str)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * @param {string} appUri
 * @param {string} message
 * @returns {Response}
 */
function redirectPage(appUri, message) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${escapeAttr(appUri)}">
  <title>${escapeHtml(message)}</title>
  <style>
    body {
      font-family: -apple-system, system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #1a1a2e;
      color: #e0e0e0;
    }
    .card { text-align: center; padding: 2rem; max-width: 400px; }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #333;
      border-top-color: #7c3aed;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    a { color: #7c3aed; }
    .fallback { margin-top: 1.5rem; font-size: 0.85rem; color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <p>${escapeHtml(message)}</p>
    <p><a href="${escapeAttr(appUri)}">Tap here if nothing happened</a></p>
    <p class="fallback">This link opens a native app. It won't work in a desktop browser without the app installed.</p>
  </div>
  <script>window.location.href = ${jsStringLiteral(appUri)};</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * @param {string} host - The deployed hostname (used in usage examples).
 * @returns {string}
 */
function usagePage(host) {
  const h = escapeHtml(host || "your-domain.example");
  const appRows = Object.entries(APP_ROUTES)
    .map(([key, route]) => {
      const usage = route.bare
        ? `<code>/${key}</code>`
        : `<code>/${key}/{${escapeHtml(route.param)}}</code>`;
      return `<tr><td>${usage}</td><td>${escapeHtml(route.opens)}</td></tr>`;
    })
    .join("\n    ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Patchbay Go — Synodic Studio</title>
  <style>
    body {
      font-family: -apple-system, system-ui, sans-serif;
      max-width: 600px;
      margin: 0 auto;
      padding: 3rem 1rem;
      background: #1a1a2e;
      color: #e0e0e0;
      line-height: 1.5;
    }
    .brand { font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: #a78bfa; text-decoration: none; }
    .brand:hover { color: #c4b5fd; }
    h1 { color: #7c3aed; margin: 0.25rem 0 0.5rem; font-size: 2rem; }
    .lede { font-size: 1.05rem; color: #cfcfe0; }
    h2 { color: #7c3aed; font-size: 0.85rem; letter-spacing: 0.06em; text-transform: uppercase; margin-top: 2.5rem; }
    code { background: #2a2a3e; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    pre { background: #2a2a3e; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #333; }
    th { color: #7c3aed; }
    .cta { display: inline-block; margin-top: 2.5rem; padding: 0.75rem 1.25rem; background: #7c3aed; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; }
    .cta:hover { background: #6d28d9; }
    footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #333; font-size: 0.85rem; color: #888; }
    footer a { color: #a78bfa; }
  </style>
</head>
<body>
  <a class="brand" href="https://synodic.co">Synodic Studio</a>
  <h1>Patchbay Go</h1>
  <p class="lede">A tiny link relay. It wraps native app links (<code>obsidian://</code>, <code>calshow:</code>, and friends) in plain <code>https://</code> so chat apps render them as tappable — tap on the go, the app opens.</p>
  <a class="cta" href="https://synodic.co">Made by Synodic Studio →</a>
  <h2>Routes</h2>
  <table>
    <tr><th>Route</th><th>Opens</th></tr>
    <tr><td><code>/obs/{vault}/{path}</code></td><td>Obsidian note</td></tr>
    <tr><td><code>/remind/{title}</code></td><td>Apple Reminders</td></tr>
    <tr><td><code>/cal/{yyyy-mm-dd}</code></td><td>Calendar.app date</td></tr>
    <tr><td><code>/cal/{date}/{hh:mm}</code></td><td>Calendar.app date+time</td></tr>
    <tr><td><code>/raw/{base64url}</code></td><td>Any native app scheme</td></tr>
    <tr><td><code>/key/{uuid}</code></td><td>Key vault (token-secured, KV-backed)</td></tr>
  </table>
  <h2>Popular apps</h2>
  <p>Named shortcuts so you rarely need <code>/raw</code>:</p>
  <table>
    <tr><th>Route</th><th>Opens</th></tr>
    ${appRows}
  </table>
  <h2>Examples</h2>
  <pre>${h}/obs/MyVault/notes/today.md
${h}/remind/Buy%20groceries
${h}/cal/2026-03-15
${h}/cal/2026-03-15/14:00
${h}/raw/dGhpbmdzOi8vLw</pre>
  <footer>Part of the <a href="https://synodic.co">Synodic</a> Patchbay family — small tools that connect a phone to a host that runs agents and apps.</footer>
</body>
</html>`;
}

/**
 * @param {string} msg
 * @returns {Response}
 */
function errorResponse(msg) {
  return new Response(`Error: ${msg}`, {
    status: 400,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Schemes the browser acts on itself instead of handing off to the OS.
 * A /raw target using any of these could execute or navigate inside the
 * Worker's own origin (XSS / open redirect), so they are refused.
 */
const BLOCKED_SCHEMES = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
  "filesystem",
  "blob",
  "about",
  "view-source",
  "http",
  "https",
  "ws",
  "wss",
]);

/**
 * A /raw URI is safe to redirect to only if it carries an explicit scheme
 * that the browser passes through to the OS (obsidian:, things:, ...) rather
 * than one the browser evaluates itself. Anything without a clean `scheme:`
 * prefix, or whose scheme is browser-privileged, is rejected — fail closed.
 * @param {string} uri
 * @returns {boolean}
 */
export function isSafeScheme(uri) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  if (!match) {
    return false;
  }
  return !BLOCKED_SCHEMES.has(match[1].toLowerCase());
}

/**
 * @param {string} str
 * @returns {string}
 */
export function escapeAttr(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {string} path
 * @returns {Promise<Response>}
 */
async function handleKeyVault(request, env, path, ctx) {
  const token = decodeURIComponent(path.slice(5)).replace(/\/$/, "");
  if (!token) {
    return errorResponse("Missing token.");
  }

  // The token must carry the requester's public key: the secret is encrypted
  // in the browser, so this worker only ever stores ciphertext (see
  // handleKeyRegister).
  const raw = await env.VAULT.get(`token:${token}`);
  const record = raw ? parseTokenRecord(raw) : null;
  if (!record || !record.publicKey) {
    return keyExpiredPage();
  }
  return handleKeyVaultE2E(request, env, token, record, ctx);
}

/**
 * Parse a token KV value. A token is JSON `{label, publicKey, webhook,
 * secret}`; anything without a `publicKey` is not a usable token.
 * @param {string} raw
 * @returns {?{label:string, publicKey:string, webhook:?string, secret:string}}
 */
function parseTokenRecord(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && obj.publicKey ? obj : null;
  } catch {
    return null;
  }
}

/**
 * POST /key/register — an agent's opening handshake. It supplies a label, its
 * RSA-OAEP public key, and an optional https webhook; no secret exists yet.
 * The public key is required and is imported here to validate it.
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function handleKeyRegister(request, env) {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `rl:register:${ip}`;
  const count = parseInt((await env.VAULT.get(rlKey)) || "0", 10);
  if (count >= 30) {
    return jsonResponse({ error: "Rate limited. Try again shortly." }, 429);
  }
  await env.VAULT.put(rlKey, String(count + 1), { expirationTtl: 60 });

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Body must be JSON." }, 400);
  }
  const { label, publicKey, webhook } = body || {};
  if (!publicKey || typeof publicKey !== "string") {
    return jsonResponse(
      { error: "A base64 SPKI RSA-OAEP publicKey is required." },
      400,
    );
  }
  if (!(await importRsaPublicKey(publicKey))) {
    return jsonResponse(
      { error: "publicKey is not a valid RSA-OAEP public key." },
      400,
    );
  }
  if (webhook != null && !/^https:\/\//.test(String(webhook))) {
    return jsonResponse({ error: "webhook must be an https URL." }, 400);
  }

  const uuid = crypto.randomUUID();
  const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const record = {
    label: typeof label === "string" && label ? label.slice(0, 120) : "secret",
    publicKey,
    webhook: webhook != null ? String(webhook) : null,
    secret,
  };
  await env.VAULT.put(`token:${uuid}`, JSON.stringify(record), {
    expirationTtl: 600,
  });
  return jsonResponse({
    uuid,
    secret,
    url: `${new URL(request.url).origin}/key/${uuid}`,
  });
}

/**
 * The end-to-end branch of the /key flow: serve the encrypting form on GET,
 * store the ciphertext envelope on POST. The worker never sees plaintext and
 * never holds a private key.
 * @param {Request} request
 * @param {Env} env
 * @param {string} token
 * @param {{label:string, publicKey:string, webhook:?string, secret:string}} record
 * @param {ExecutionContext} [ctx]
 * @returns {Promise<Response>}
 */
async function handleKeyVaultE2E(request, env, token, record, ctx) {
  if (request.method === "GET") {
    return keyFormPageE2E(record.label, record.publicKey);
  }
  if (request.method === "POST") {
    let envelope;
    try {
      envelope = await request.json();
    } catch {
      return jsonResponse({ error: "Body must be the JSON envelope." }, 400);
    }
    if (!(await validateEnvelope(envelope, record.publicKey))) {
      return jsonResponse(
        { error: "Submission is not a valid encrypted envelope." },
        400,
      );
    }
    await env.VAULT.put(`vault:${token}`, JSON.stringify(envelope), {
      expirationTtl: 600,
    });
    await env.VAULT.delete(`token:${token}`);
    if (record.webhook) {
      const job = fireWebhook(record.webhook, record.secret, token, envelope);
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(job);
      } else {
        await job;
      }
    }
    return jsonResponse({ ok: true, stored: true });
  }
  return methodNotAllowed("GET, POST");
}

/**
 * GET /key/<uuid>/result — one-shot retrieval of the stored ciphertext
 * envelope for agents that cannot receive a webhook. Deleted on read.
 * @param {Env} env
 * @param {string} uuid
 * @returns {Promise<Response>}
 */
async function handleKeyResult(env, uuid) {
  if (!uuid) {
    return jsonResponse({ error: "Missing token." }, 400);
  }
  const stored = await env.VAULT.get(`vault:${uuid}`);
  if (!stored) {
    return jsonResponse({ ready: false }, 404);
  }
  await env.VAULT.delete(`vault:${uuid}`);
  return new Response(stored, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Structural check that a submission is a real hybrid RSA-OAEP+AES-GCM
 * envelope for the token's key — the wrapped AES key must be exactly the RSA
 * modulus length, with a 12-byte IV and a GCM-tagged ciphertext. This can't
 * cryptographically prove encryption (the worker holds no private key by
 * design), but it rejects plaintext and malformed bodies.
 * @param {*} envelope
 * @param {string} publicKeyB64
 * @returns {Promise<boolean>}
 */
async function validateEnvelope(envelope, publicKeyB64) {
  if (
    !envelope ||
    envelope.v !== 1 ||
    envelope.alg !== "RSA-OAEP+A256GCM" ||
    typeof envelope.wrappedKey !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    return false;
  }
  let wrapped, iv, ct;
  try {
    wrapped = base64ToBytes(envelope.wrappedKey);
    iv = base64ToBytes(envelope.iv);
    ct = base64ToBytes(envelope.ciphertext);
  } catch {
    return false;
  }
  if (iv.length !== 12 || ct.length < 16) {
    return false;
  }
  const pub = await importRsaPublicKey(publicKeyB64);
  if (!pub) {
    return false;
  }
  return wrapped.length === pub.algorithm.modulusLength / 8;
}

/**
 * Best-effort signed callback to the agent's webhook. HMAC-SHA256 of the body
 * with the per-request secret lets the agent verify the call is genuine.
 * @param {string} url
 * @param {string} secret
 * @param {string} uuid
 * @param {*} envelope
 * @returns {Promise<void>}
 */
async function fireWebhook(url, secret, uuid, envelope) {
  const payload = JSON.stringify({ uuid, envelope });
  try {
    const sig = await hmacHex(secret, payload);
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Patchbay-Signature": sig,
      },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-fatal: the agent can still poll GET /key/<uuid>/result.
  }
}

/**
 * @param {string} b64
 * @returns {Promise<?CryptoKey>}
 */
async function importRsaPublicKey(b64) {
  try {
    return await crypto.subtle.importKey(
      "spki",
      base64ToBytes(b64),
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"],
    );
  } catch {
    return null;
  }
}

/**
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>}
 */
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toHex(new Uint8Array(sig));
}

/**
 * @param {string} b64 - standard or base64url
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * @param {*} obj
 * @param {number} [status]
 * @returns {Response}
 */
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param {string} allow
 * @returns {Response}
 */
function methodNotAllowed(allow) {
  return new Response("Error: Method not allowed.", {
    status: 405,
    headers: { "Content-Type": "text/plain", Allow: allow },
  });
}

/**
 * @param {string} label
 * @param {string} publicKeyB64
 * @returns {Response}
 */
function keyFormPageE2E(label, publicKeyB64) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Encrypted paste — ${escapeHtml(label)}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0; }
    .card { width: 90%; max-width: 420px; padding: 2rem; }
    h2 { color: #7c3aed; margin-top: 0; font-size: 1.1rem; }
    .key-name { background: #2a2a3e; padding: 0.5rem 0.75rem; border-radius: 6px; font-family: monospace; font-size: 0.95rem; margin-bottom: 1rem; color: #a78bfa; }
    textarea { width: 100%; min-height: 100px; background: #2a2a3e; color: #e0e0e0; border: 2px solid #333; border-radius: 8px; padding: 0.75rem; font-family: monospace; font-size: 0.9rem; resize: vertical; box-sizing: border-box; }
    textarea:focus { border-color: #7c3aed; outline: none; }
    button { width: 100%; padding: 0.875rem; margin-top: 1rem; background: #7c3aed; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: 0.6; }
    .error { color: #f87171; font-size: 0.85rem; margin-top: 0.5rem; }
    .note { color: #888; font-size: 0.75rem; margin-top: 1rem; }
    .lock { color: #5ee0a0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Paste your secret</h2>
    <div class="key-name">${escapeHtml(label)}</div>
    <textarea id="v" placeholder="Paste value here..." autofocus></textarea>
    <p class="error" id="err" style="display:none"></p>
    <button id="go" onclick="submitSecret()">Encrypt &amp; send</button>
    <p class="note"><span class="lock">&#128274; Encrypted in your browser</span> before it is sent. The server only ever stores ciphertext and cannot read it.</p>
  </div>
  <script>
    const PUBKEY = ${jsStringLiteral(publicKeyB64)};
    const b64d = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const b64e = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
    function showErr(m) { const e = document.getElementById("err"); e.textContent = m; e.style.display = "block"; }
    function done() {
      const card = document.querySelector(".card");
      card.textContent = "";
      const h = document.createElement("h2");
      h.className = "lock";
      h.textContent = "✓ Sent";
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = "Your secret was encrypted and delivered. You can close this tab.";
      card.appendChild(h);
      card.appendChild(p);
    }
    async function submitSecret() {
      const val = document.getElementById("v").value;
      if (!val.trim()) { showErr("Please paste a value."); return; }
      const btn = document.getElementById("go");
      btn.disabled = true;
      try {
        const pub = await crypto.subtle.importKey("spki", b64d(PUBKEY), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
        const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(val));
        const wrapped = await crypto.subtle.wrapKey("raw", aes, pub, { name: "RSA-OAEP" });
        const envelope = { v: 1, alg: "RSA-OAEP+A256GCM", wrappedKey: b64e(wrapped), iv: b64e(iv), ciphertext: b64e(ct) };
        const res = await fetch(location.pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
        if (res.ok) { done(); } else { showErr("The server rejected the submission."); btn.disabled = false; }
      } catch (e) { showErr("Encryption failed in your browser."); btn.disabled = false; }
    }
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * @returns {Response}
 */
function keyExpiredPage() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Expired</title>
  <style>
    body {
      font-family: -apple-system, system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #1a1a2e;
      color: #e0e0e0;
    }
    .card { text-align: center; padding: 2rem; max-width: 400px; }
    h2 { color: #f87171; }
    .note { color: #888; font-size: 0.85rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Link expired or invalid</h2>
    <p>This key submission link has expired or was already used.</p>
    <p class="note">Ask the host for a new link.</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
