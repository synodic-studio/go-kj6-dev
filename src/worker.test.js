import { describe, it, expect } from "vitest";
import worker from "./worker.js";

/**
 * Creates a mock Request object for testing
 * @param {string} path - Request path
 * @param {string} [method="GET"] - HTTP method
 * @returns {Request} Mock request
 */
function makeRequest(path, method = "GET") {
  return new Request(`https://go.kj6.dev${path}`, { method });
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
    expect(body).toContain("go.kj6.dev");
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
    const res = await worker.fetch(
      makeRequest("/cal/2026-03-15"),
      mockEnv(),
    );
    const body = await res.text();
    expect(body).toContain("calshow:");
    expect(body).toContain("2026-03-15");
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
