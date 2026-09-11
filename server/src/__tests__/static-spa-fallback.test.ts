import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Request } from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStaticSpaFallbackHandler,
  shouldReturnJsonApi404,
} from "../app.js";

function fakeReq(
  pathname: string,
  opts: { authorization?: string; acceptsHtml: string | false } = {
    acceptsHtml: "html",
  },
): Request {
  return {
    path: pathname,
    headers: opts.authorization !== undefined ? { authorization: opts.authorization } : {},
    accepts: () => opts.acceptsHtml,
  } as unknown as Request;
}

function makeUiDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-static-spa-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><html><head><title>Shell</title></head><body><div id=\"root\"></div></body></html>",
    "utf8",
  );
  return dir;
}

// Mirrors createApp's static-mode wiring: specific API routes are mounted
// first, then the /api catch-all 404, then the SPA fallback as the last resort.
// That ordering is what keeps correctly-prefixed /api paths out of the fallback.
function makeApp(uiDist: string): express.Express {
  const app = express();
  app.get("/api/agents/me", (_req, res) => {
    res.status(200).json({ id: "me" });
  });
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.get(/.*/, createStaticSpaFallbackHandler(uiDist));
  return app;
}

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("shouldReturnJsonApi404", () => {
  it("treats a browser navigation (Accept: text/html, no Authorization) as a shell request", () => {
    expect(shouldReturnJsonApi404(fakeReq("/some/deep/ui/link", { acceptsHtml: "html" }))).toBe(false);
  });

  it("treats a JSON-accepting machine client as an API request even without Authorization", () => {
    expect(
      shouldReturnJsonApi404(fakeReq("/agents/me", { acceptsHtml: false })),
    ).toBe(true);
  });

  it("treats any Authorization-bearing request as an API request even when it accepts html", () => {
    expect(
      shouldReturnJsonApi404(fakeReq("/agents/me", { authorization: "Bearer tok", acceptsHtml: "html" })),
    ).toBe(true);
  });
});

describe("static SPA fallback handler", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function app() {
    const dir = makeUiDist();
    tempDirs.push(dir);
    return makeApp(dir);
  }

  it("still serves the 200 HTML shell to a browser-shaped deep link", async () => {
    const res = await request(app()).get("/some/deep/ui/link").set("Accept", BROWSER_ACCEPT);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain('<div id="root">');
  });

  it("returns a JSON 404 for a mis-rooted read that carries Authorization", async () => {
    const res = await request(app())
      .get("/companies/company-1/summary-slots/project/header?scopeId=s1")
      .set("Authorization", "Bearer tok")
      .set("Accept", "application/json");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toHaveProperty("error");
    // The body must point the mis-rooted client at the missing /api prefix.
    expect(JSON.stringify(res.body)).toMatch(/\/api/);
  });

  it("returns a JSON 404 for a mis-rooted /agents/me read with Authorization", async () => {
    const res = await request(app()).get("/agents/me").set("Authorization", "Bearer tok");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("returns a JSON 404 for an Accept: application/json read without Authorization", async () => {
    const res = await request(app()).get("/issues/SUP-15765").set("Accept", "application/json");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("still returns a bodiless 404 for missing /assets/* paths", async () => {
    const res = await request(app()).get("/assets/does-not-exist.js");
    expect(res.status).toBe(404);
    expect(res.text).toBe("");
  });

  it("leaves correctly-prefixed /api routes unaffected", async () => {
    const res = await request(app()).get("/api/agents/me").set("Authorization", "Bearer tok");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ id: "me" });
  });
});
