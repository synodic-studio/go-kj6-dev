import { describe, it, expect } from "vitest";
import worker from "./worker.js";

function makeRequest(path, method = "GET") {
  return new Request(`https://go.kj6.dev${path}`, { method });
}

describe("root route", () => {
  it("returns HTML usage page", async () => {
    const res = await worker.fetch(makeRequest("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("go.kj6.dev");
    expect(body).toContain("/obs/");
    expect(body).toContain("/raw/");
  });
});

describe("/obs/ route", () => {
  it("redirects to obsidian:// URI", async () => {
    const res = await worker.fetch(makeRequest("/obs/MyVault/path/to/note"));
    const body = await res.text();
    expect(body).toContain("obsidian://open");
    expect(body).toContain("MyVault");
    expect(body).toContain("path%2Fto%2Fnote");
  });

  it("errors when missing file path", async () => {
    const res = await worker.fetch(makeRequest("/obs/JustVault"));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Missing file path");
  });
});

describe("/raw/ route", () => {
  it("redirects from base64url-encoded URI", async () => {
    // "things:///" base64 = "dGhpbmdzOi8vLw"
    const res = await worker.fetch(makeRequest("/raw/dGhpbmdzOi8vLw"));
    const body = await res.text();
    expect(body).toContain("things:///");
  });

  it("errors on invalid base64", async () => {
    const res = await worker.fetch(makeRequest("/raw/!!!"));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Invalid base64url");
  });
});

describe("unknown route", () => {
  it("returns 400 error", async () => {
    const res = await worker.fetch(makeRequest("/nope"));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Unknown route");
  });
});
