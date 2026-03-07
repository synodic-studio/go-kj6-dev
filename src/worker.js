/**
 * go.kj6.dev — App link wrapper + key vault for Telegram
 *
 * Wraps custom URL schemes (obsidian://, things://, etc.) in https:// URLs
 * that Telegram recognizes as clickable links. When opened, the page
 * redirects to the native app via meta refresh + JS fallback.
 *
 * Also provides a key vault for securely passing API keys from mobile
 * to the Mac's Keychain via KV storage with 5-min TTL.
 *
 * Routes:
 *   /obs/<vault>/<path>       → obsidian://open?vault=<vault>&file=<path>
 *   /remind/<title>           → x-apple-reminderkit://REMCDReminder/<title>
 *   /cal/<yyyy-mm-dd>         → calshow:<epoch> (opens Calendar.app to date)
 *   /raw/<base64url>          → any custom scheme (base64url-encoded)
 *   /key/<uuid>               → token-secured paste form for API keys
 *   /                         → usage page
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Root: show usage
    if (path === "/" || path === "") {
      return new Response(usagePage(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Key vault: /key/<uuid> (token must be pre-registered locally)
    if (path.startsWith("/key/")) {
      return handleKeyVault(request, env, path);
    }

    // Obsidian: /obs/<vault>/<file-path>
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

    // Reminders: /remind/<title>
    if (path.startsWith("/remind/")) {
      const title = decodeURIComponent(path.slice(8));
      if (!title) {
        return errorResponse("Missing reminder title. Format: /remind/<title>");
      }
      const appUri = `x-apple-reminderkit://REMCDReminder/${encodeURIComponent(title)}`;
      return redirectPage(appUri, `Opening reminder: "${title}"`);
    }

    // Calendar: /cal/<yyyy-mm-dd> or /cal/<yyyy-mm-dd>/<hh:mm>
    if (path.startsWith("/cal/")) {
      const rest = decodeURIComponent(path.slice(5));
      const match = rest.match(/^(\d{4}-\d{2}-\d{2})(?:\/(\d{2}:\d{2}))?$/);
      if (!match) {
        return errorResponse("Invalid date. Format: /cal/2026-03-15 or /cal/2026-03-15/14:00");
      }
      const dateStr = match[2] ? `${match[1]}T${match[2]}:00` : `${match[1]}T00:00:00`;
      const epoch = Math.floor(new Date(dateStr).getTime() / 1000);
      const appUri = `calshow:${epoch}`;
      const display = match[2] ? `${match[1]} at ${match[2]}` : match[1];
      return redirectPage(appUri, `Opening Calendar: ${display}`);
    }

    // Raw: /raw/<base64url-encoded-uri>
    if (path.startsWith("/raw/")) {
      const encoded = path.slice(5);
      try {
        const appUri = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
        return redirectPage(appUri, `Redirecting to app...`);
      } catch {
        return errorResponse("Invalid base64url encoding.");
      }
    }

    return errorResponse(`Unknown route: ${path}`);
  },
};

function redirectPage(appUri, message) {
  const html = `<!DOCTYPE html>
<html>
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
    .card {
      text-align: center;
      padding: 2rem;
      max-width: 400px;
    }
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
  <script>window.location.href = ${JSON.stringify(appUri)};</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function usagePage() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>go.kj6.dev</title>
  <style>
    body {
      font-family: -apple-system, system-ui, sans-serif;
      max-width: 600px;
      margin: 2rem auto;
      padding: 0 1rem;
      background: #1a1a2e;
      color: #e0e0e0;
    }
    h1 { color: #7c3aed; }
    code { background: #2a2a3e; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    pre { background: #2a2a3e; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #333; }
    th { color: #7c3aed; }
  </style>
</head>
<body>
  <h1>go.kj6.dev</h1>
  <p>App link wrapper. Makes custom URL schemes clickable in Telegram.</p>
  <table>
    <tr><th>Route</th><th>Opens</th></tr>
    <tr><td><code>/obs/{vault}/{path}</code></td><td>Obsidian note</td></tr>
    <tr><td><code>/remind/{title}</code></td><td>Apple Reminders</td></tr>
    <tr><td><code>/cal/{yyyy-mm-dd}</code></td><td>Calendar.app date</td></tr>
    <tr><td><code>/cal/{date}/{hh:mm}</code></td><td>Calendar.app date+time</td></tr>
    <tr><td><code>/raw/{base64url}</code></td><td>Any app scheme</td></tr>
    <tr><td><code>/key/{uuid}</code></td><td>Key vault (token-secured)</td></tr>
  </table>
  <h2>Examples</h2>
  <pre>go.kj6.dev/obs/EverythingEverywhereAllAtOnce/05-Fanta/gadget/report.md
go.kj6.dev/remind/Buy%20groceries
go.kj6.dev/cal/2026-03-15
go.kj6.dev/cal/2026-03-15/14:00
go.kj6.dev/raw/dGhpbmdzOi8vLw</pre>
</body>
</html>`;
}

function errorResponse(msg) {
  return new Response(`Error: ${msg}`, {
    status: 400,
    headers: { "Content-Type": "text/plain" },
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
    await env.VAULT.put(`vault:${keyName}`, value.trim(), { expirationTtl: 300 });
    await env.VAULT.delete(`token:${token}`);
    return keySuccessPage(keyName);
  }

  return errorResponse("Method not allowed.");
}

function keyFormPage(keyName, error) {
  const label = keyName.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const html = `<!DOCTYPE html>
<html>
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
    .card {
      width: 90%;
      max-width: 420px;
      padding: 2rem;
    }
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

function keyExpiredPage() {
  const html = `<!DOCTYPE html>
<html>
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
    <p class="note">Ask the agent for a new link.</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function keySuccessPage(keyName) {
  const html = `<!DOCTYPE html>
<html>
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
