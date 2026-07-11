import { describe, it, expect } from "vitest";
import worker, {
  escapeHtml,
  escapeAttr,
  isSafeScheme,
  jsStringLiteral,
} from "./worker.js";

/**
 * base64url-encodes a string the same way /raw expects its input.
 * @param {string} uri
 * @returns {string}
 */
function b64url(uri) {
  return btoa(uri).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Creates a mock Request object for testing
 * @param {string} path - Request path
 * @param {string} [method="GET"] - HTTP method
 * @param {Object} [options={}] - Additional Request options (body, headers, etc.)
 * @returns {Request} Mock request
 */
function makeRequest(path, method = "GET", options = {}) {
  return new Request(`https://example.test${path}`, { method, ...options });
}

/**
 * Creates a POST request with form data for testing key vault submission
 * @param {string} path - Request path
 * @param {Object} fields - Form field key-value pairs
 * @returns {Request} POST request with form body
 */
function makeFormPost(path, fields) {
  const formData = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });
}

/**
 * Creates a mock environment with KV store for testing
 * @param {Object} [kvStore={}] - Initial key-value store data
 * @returns {Object} Mock environment with VAULT namespace
 */
function mockEnv(kvStore = {}) {
  return {
    VAULT: {
      get: async (key) => kvStore[key] ?? null,
      put: async (key, val) => {
        kvStore[key] = val;
      },
      delete: async (key) => {
        delete kvStore[key];
      },
    },
  };
}

describe("root route", () => {
  it("returns HTML usage page with all routes listed", async () => {
    const res = await worker.fetch(makeRequest("/"), mockEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Patchbay Go");
    expect(body).toContain("synodic.co");
    expect(body).toContain("/obs/");
    expect(body).toContain("/remind/");
    expect(body).toContain("/cal/");
    expect(body).toContain("/raw/");
    expect(body).toContain("/key/");
  });
});

describe("/obs/ route", () => {
  it("redirects to obsidian:// URI", async () => {
    const res = await worker.fetch(
      makeRequest("/obs/MyVault/path/to/note"),
      mockEnv(),
    );
    const body = await res.text();
    expect(body).toContain("obsidian://open");
    expect(body).toContain("MyVault");
    expect(body).toContain("path%2Fto%2Fnote");
  });

  it("errors when missing file path", async () => {
    const res = await worker.fetch(makeRequest("/obs/JustVault"), mockEnv());
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Missing file path");
  });
});

describe("/remind/ route", () => {
  it("redirects to Reminders app", async () => {
    const res = await worker.fetch(
      makeRequest("/remind/Buy%20groceries"),
      mockEnv(),
    );
    const body = await res.text();
    expect(body).toContain("x-apple-reminderkit://");
    expect(body).toContain("Buy%20groceries");
  });
});

describe("/cal/ route", () => {
  it("redirects to Calendar with date", async () => {
    const res = await worker.fetch(makeRequest("/cal/2026-03-15"), mockEnv());
    const body = await res.text();
    expect(body).toContain("calshow:");
    expect(body).toContain("2026-03-15");
    // Must be Cocoa/CFAbsoluteTime (seconds since 2001), not Unix epoch:
    // a 2026 date is ~7.95e8 in Cocoa time vs ~1.77e9 in Unix time.
    const n = Number(body.match(/calshow:(\d+)/)[1]);
    expect(n).toBeGreaterThan(700000000);
    expect(n).toBeLessThan(1000000000);
  });

  it("redirects to Calendar with date and time", async () => {
    const res = await worker.fetch(
      makeRequest("/cal/2026-03-15/14:00"),
      mockEnv(),
    );
    const body = await res.text();
    expect(body).toContain("calshow:");
    expect(body).toContain("14:00");
  });

  it("errors on invalid date format", async () => {
    const res = await worker.fetch(makeRequest("/cal/not-a-date"), mockEnv());
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Invalid date");
  });
});

describe("/raw/ route", () => {
  it("redirects from base64url-encoded URI", async () => {
    const res = await worker.fetch(
      makeRequest("/raw/dGhpbmdzOi8vLw"),
      mockEnv(),
    );
    const body = await res.text();
    expect(body).toContain("things:///");
  });

  it("errors on invalid base64", async () => {
    const res = await worker.fetch(makeRequest("/raw/!!!"), mockEnv());
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Invalid base64url");
  });

  it("allows another native app scheme", async () => {
    const res = await worker.fetch(
      makeRequest(`/raw/${b64url("shortcuts://run-shortcut?name=Test")}`),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("shortcuts://");
  });

  it("refuses javascript: scheme", async () => {
    const res = await worker.fetch(
      makeRequest(`/raw/${b64url("javascript:alert(1)")}`),
      mockEnv(),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Refused");
  });

  it("refuses http(s): open redirect", async () => {
    const res = await worker.fetch(
      makeRequest(`/raw/${b64url("https://evil.example")}`),
      mockEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("refuses data: scheme", async () => {
    const res = await worker.fetch(
      makeRequest(`/raw/${b64url("data:text/html,<script>alert(1)</script>")}`),
      mockEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("neutralizes a </script> breakout payload (no reflected XSS)", async () => {
    // scheme "x" passes isSafeScheme, but the rest is attacker-controlled
    const payload = "x://</script><img src=x onerror=alert(1)>";
    const res = await worker.fetch(
      makeRequest(`/raw/${b64url(payload)}`),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // The inline <script> block must not be closed early by the payload:
    // its captured content escapes the payload's </script> and remains a
    // complete statement (ends with ';'). With the bug it truncates at the
    // payload's raw </script>, dropping the escaped marker and the semicolon.
    const scriptContent = body.match(/<script>([\s\S]*?)<\/script>/)[1];
    expect(scriptContent).toContain("\\u003c/script");
    expect(scriptContent.trim().endsWith(";")).toBe(true);
  });
});

describe("jsStringLiteral", () => {
  it("escapes </script> and & so a value cannot break out of an inline script", () => {
    expect(jsStringLiteral("a</script>b")).toBe('"a\\u003c/script\\u003eb"');
    expect(jsStringLiteral("x&y")).toBe('"x\\u0026y"');
  });

  it("still round-trips as a valid JS string for a normal scheme", () => {
    expect(JSON.parse(jsStringLiteral("things:///add?title=Hi"))).toBe(
      "things:///add?title=Hi",
    );
  });
});

describe("isSafeScheme", () => {
  it("allows native app schemes", () => {
    expect(isSafeScheme("obsidian://open?vault=x")).toBe(true);
    expect(isSafeScheme("things:///")).toBe(true);
    expect(isSafeScheme("x-apple-reminderkit://REMCDReminder/x")).toBe(true);
    expect(isSafeScheme("calshow:12345")).toBe(true);
  });

  it("blocks browser-privileged schemes case-insensitively", () => {
    expect(isSafeScheme("javascript:alert(1)")).toBe(false);
    expect(isSafeScheme("JavaScript:alert(1)")).toBe(false);
    expect(isSafeScheme("data:text/html,x")).toBe(false);
    expect(isSafeScheme("http://x")).toBe(false);
    expect(isSafeScheme("HTTPS://x")).toBe(false);
    expect(isSafeScheme("file:///etc/passwd")).toBe(false);
  });

  it("rejects strings without a clean scheme (fails closed)", () => {
    expect(isSafeScheme("evil.example/path")).toBe(false);
    expect(isSafeScheme(" javascript:alert(1)")).toBe(false);
    expect(isSafeScheme("")).toBe(false);
  });
});

describe("/key/ vault route", () => {
  it("shows form when token is valid", async () => {
    const kv = { "token:abc-123": "my-api-key" };
    const res = await worker.fetch(makeRequest("/key/abc-123"), mockEnv(kv));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("my-api-key");
    expect(body).toContain("Paste your key");
  });

  it("shows expired page for unknown token", async () => {
    const res = await worker.fetch(makeRequest("/key/bad-token"), mockEnv());
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("expired");
  });
});

describe("unknown route", () => {
  it("returns 400 error", async () => {
    const res = await worker.fetch(makeRequest("/nope"), mockEnv());
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Unknown route");
  });
});

describe("named app routes", () => {
  it("encodes a free-text param into the app scheme (Things)", async () => {
    const res = await worker.fetch(
      makeRequest("/things/Buy%20milk"),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("things:///add?title=Buy%20milk");
  });

  it("runs a Shortcut by name", async () => {
    const res = await worker.fetch(
      makeRequest("/shortcuts/Morning%20Routine"),
      mockEnv(),
    );
    const body = await res.text();
    expect(body).toContain("shortcuts://run-shortcut?name=Morning%20Routine");
  });

  it("opens a bare launcher with no argument (Slack)", async () => {
    const res = await worker.fetch(makeRequest("/slack"), mockEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("slack://open");
  });

  it("errors when a param route is missing its input", async () => {
    const res = await worker.fetch(makeRequest("/things"), mockEnv());
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Missing input");
  });

  it("lists the app routes on the billboard", async () => {
    const res = await worker.fetch(makeRequest("/"), mockEnv());
    const body = await res.text();
    expect(body).toContain("Popular apps");
    expect(body).toContain("/things/");
    expect(body).toContain("Fantastical");
  });
});

describe("legacy host redirect", () => {
  it("301-redirects go.kj6.dev to go.synodic.co, preserving path + query", async () => {
    const res = await worker.fetch(
      new Request("https://go.kj6.dev/obs/Cobalt/05-Fanta/note.md?x=1"),
      mockEnv(),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(
      "https://go.synodic.co/obs/Cobalt/05-Fanta/note.md?x=1",
    );
  });

  it("serves normally on the canonical host", async () => {
    const res = await worker.fetch(
      new Request("https://go.synodic.co/things/Test"),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("things:///add?title=Test");
  });
});

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("handles strings with no special characters", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
  });

  it("escapes multiple special characters together", () => {
    expect(escapeHtml('<img src="x" onerror="alert(1)">')).toBe(
      "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("escapeAttr", () => {
  it("escapes ampersands", () => {
    expect(escapeAttr("a&b")).toBe("a&amp;b");
  });

  it("escapes double quotes", () => {
    expect(escapeAttr('val"ue')).toBe("val&quot;ue");
  });

  it("escapes single quotes", () => {
    expect(escapeAttr("it's")).toBe("it&#39;s");
  });

  it("handles strings with no special characters", () => {
    expect(escapeAttr("safe-value")).toBe("safe-value");
  });

  it("escapes a crafted XSS payload in attribute context", () => {
    expect(escapeAttr('" onmouseover="alert(1)')).toBe(
      "&quot; onmouseover=&quot;alert(1)",
    );
  });

  it("handles empty string", () => {
    expect(escapeAttr("")).toBe("");
  });

  it("does not escape angle brackets (attribute-safe only)", () => {
    expect(escapeAttr("<>")).toBe("<>");
  });
});

describe("/key/ POST submission flow", () => {
  it("stores value in VAULT and deletes the token", async () => {
    const kv = { "token:abc-123": "my-api-key" };
    const env = mockEnv(kv);
    const res = await worker.fetch(
      makeFormPost("/key/abc-123", { value: "secret-value-123" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Saved");
    expect(body).toContain("my-api-key");
    // Token should be deleted after successful submission
    expect(await env.VAULT.get("token:abc-123")).toBeNull();
    // Value should be stored under vault: prefix
    expect(await env.VAULT.get("vault:my-api-key")).toBe("secret-value-123");
  });

  it("rejects empty value and re-shows form", async () => {
    const kv = { "token:abc-123": "my-api-key" };
    const res = await worker.fetch(
      makeFormPost("/key/abc-123", { value: "   " }),
      mockEnv(kv),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Please paste a value");
    expect(body).toContain("Paste your key");
  });

  it("rejects missing value field and re-shows form", async () => {
    const kv = { "token:abc-123": "my-api-key" };
    const res = await worker.fetch(
      makeFormPost("/key/abc-123", {}),
      mockEnv(kv),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Please paste a value");
  });

  it("returns expired page when token is invalid on POST", async () => {
    const res = await worker.fetch(
      makeFormPost("/key/bad-token", { value: "something" }),
      mockEnv(),
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("expired");
  });

  it("trims whitespace from submitted value", async () => {
    const kv = { "token:abc-123": "my-key" };
    const env = mockEnv(kv);
    await worker.fetch(
      makeFormPost("/key/abc-123", { value: "  trimmed-value  " }),
      env,
    );
    expect(await env.VAULT.get("vault:my-key")).toBe("trimmed-value");
  });
});

describe("/key/ unsupported methods", () => {
  it("returns 405 for PUT", async () => {
    const kv = { "token:abc-123": "my-key" };
    const res = await worker.fetch(
      makeRequest("/key/abc-123", "PUT"),
      mockEnv(kv),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
    const body = await res.text();
    expect(body).toContain("Method not allowed");
  });

  it("returns 405 for DELETE", async () => {
    const kv = { "token:abc-123": "my-key" };
    const res = await worker.fetch(
      makeRequest("/key/abc-123", "DELETE"),
      mockEnv(kv),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
  });

  it("returns 405 for PATCH", async () => {
    const kv = { "token:abc-123": "my-key" };
    const res = await worker.fetch(
      makeRequest("/key/abc-123", "PATCH"),
      mockEnv(kv),
    );
    expect(res.status).toBe(405);
  });
});
