/**
 * patchbay-go
 *
 * Cloudflare Worker that wraps custom URL schemes (obsidian://, things://,
 * x-apple-reminderkit://, calshow:, etc.) in plain https:// URLs that
 * Telegram and other chat apps recognize as tappable. When the wrapped
 * link is opened, the page redirects into the native app via a meta
 * refresh and JS fallback.
 *
 * Also includes an optional KV-backed "key vault" route for passing a
 * short-lived value (API key, OTP, etc.) from a phone form into a
 * service the host fetches with `GET /vault/<name>` against the same KV.
 *
 * Routes:
 *   /obs/<vault>/<path>       → obsidian://open?vault=<vault>&file=<path>
 *   /remind/<title>           → x-apple-reminderkit://REMCDReminder/<title>
 *   /cal/<yyyy-mm-dd>         → calshow:<epoch> (opens Calendar.app)
 *   /raw/<base64url>          → any custom scheme (base64url-encoded)
 *   /key/<uuid>               → token-secured paste form (needs VAULT KV)
 *   /                         → usage page
 *
 * The /key route is no-op if no `VAULT` KV namespace is bound.
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

/** Canonical host. Legacy hosts 301-redirect here, preserving path + query. */
const CANONICAL_HOST = "go.synodic.co";

/** Old hosts kept alive only to forward already-sent links to the canonical host. */
const LEGACY_HOSTS = new Set(["go.kj6.dev"]);

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
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (LEGACY_HOSTS.has(url.hostname)) {
      return Response.redirect(
        `https://${CANONICAL_HOST}${url.pathname}${url.search}`,
        301,
      );
    }

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
      return handleKeyVault(request, env, path);
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
  "blob",
  "about",
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
async function handleKeyVault(request, env, path) {
  const token = decodeURIComponent(path.slice(5)).replace(/\/$/, "");
  if (!token) {
    return errorResponse("Missing token.");
  }

  const keyName = await env.VAULT.get(`token:${token}`);
  if (!keyName) {
    return keyExpiredPage();
  }

  if (request.method === "GET") {
    return keyFormPage(keyName);
  }

  if (request.method === "POST") {
    const formData = await request.formData();
    const value = formData.get("value");
    if (!value || !value.trim()) {
      return keyFormPage(keyName, "Please paste a value.");
    }
    await env.VAULT.put(`vault:${keyName}`, value.trim(), {
      expirationTtl: 300,
    });
    await env.VAULT.delete(`token:${token}`);
    return keySuccessPage(keyName);
  }

  return new Response("Error: Method not allowed.", {
    status: 405,
    headers: {
      "Content-Type": "text/plain",
      Allow: "GET, POST",
    },
  });
}

/**
 * @param {string} keyName
 * @param {string} [error]
 * @returns {Response}
 */
function keyFormPage(keyName, error) {
  const label = keyName
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Key Vault — ${escapeHtml(label)}</title>
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
    .card { width: 90%; max-width: 420px; padding: 2rem; }
    h2 { color: #7c3aed; margin-top: 0; font-size: 1.1rem; }
    .key-name {
      background: #2a2a3e;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-family: monospace;
      font-size: 0.95rem;
      margin-bottom: 1rem;
      color: #a78bfa;
    }
    textarea {
      width: 100%;
      min-height: 100px;
      background: #2a2a3e;
      color: #e0e0e0;
      border: 2px solid #333;
      border-radius: 8px;
      padding: 0.75rem;
      font-family: monospace;
      font-size: 0.9rem;
      resize: vertical;
      box-sizing: border-box;
    }
    textarea:focus { border-color: #7c3aed; outline: none; }
    button {
      width: 100%;
      padding: 0.875rem;
      margin-top: 1rem;
      background: #7c3aed;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:active { background: #6d28d9; }
    .error { color: #f87171; font-size: 0.85rem; margin-top: 0.5rem; }
    .note { color: #888; font-size: 0.75rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Paste your key</h2>
    <div class="key-name">${escapeHtml(keyName)}</div>
    <form method="POST">
      <textarea name="value" placeholder="Paste value here..." autofocus></textarea>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <button type="submit">Submit</button>
    </form>
    <p class="note">Stored for 5 minutes, one-time retrieval, then auto-deleted.</p>
  </div>
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

/**
 * @param {string} keyName
 * @returns {Response}
 */
function keySuccessPage(keyName) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Key Saved</title>
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
    .check { font-size: 3rem; margin-bottom: 1rem; }
    h2 { color: #7c3aed; }
    .note { color: #888; font-size: 0.85rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h2>Saved</h2>
    <p><code>${escapeHtml(keyName)}</code> stored securely.</p>
    <p class="note">Expires in 5 minutes. You can close this tab.</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
