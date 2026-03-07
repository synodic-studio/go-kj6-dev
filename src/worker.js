/**
 * go.kj6.dev — App link wrapper for Telegram
 *
 * Wraps custom URL schemes (obsidian://, things://, etc.) in https:// URLs
 * that Telegram recognizes as clickable links. When opened, the page
 * redirects to the native app via meta refresh + JS fallback.
 *
 * Routes:
 *   /obs/<vault>/<path>  → obsidian://open?vault=<vault>&file=<path>
 *   /raw/<encoded-uri>   → any custom scheme (base64url-encoded)
 *   /                    → usage page
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Root: show usage
    if (path === "/" || path === "") {
      return new Response(usagePage(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Obsidian: /obs/<vault>/<file-path>
    if (path.startsWith("/obs/")) {
      const rest = path.slice(5); // remove "/obs/"
      const slashIndex = rest.indexOf("/");
      if (slashIndex === -1) {
        return errorResponse("Missing file path. Format: /obs/<vault>/<path>");
      }
      const vault = decodeURIComponent(rest.slice(0, slashIndex));
      const file = decodeURIComponent(rest.slice(slashIndex + 1));
      const appUri = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
      return redirectPage(appUri, `Opening "${file}" in Obsidian...`);
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
  <meta http-equiv="refresh" content="0;url=${escapeHtml(appUri)}">
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
    <p><a href="${escapeHtml(appUri)}">Tap here if nothing happened</a></p>
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
  </style>
</head>
<body>
  <h1>go.kj6.dev</h1>
  <p>App link wrapper. Makes custom URL schemes clickable in Telegram.</p>
  <h2>Routes</h2>
  <pre>/obs/{vault}/{file-path}  → Obsidian
/raw/{base64url}          → Any app scheme</pre>
  <h2>Examples</h2>
  <pre>go.kj6.dev/obs/EverythingEverywhereAllAtOnce/05-Fanta/gadget/report.md
go.kj6.dev/raw/dGhpbmdzOi8vLw  (base64url of "things://")</pre>
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
