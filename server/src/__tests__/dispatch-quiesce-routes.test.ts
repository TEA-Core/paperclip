import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchQuiesce } from "../services/dispatch-quiesce.ts";

const mockHeartbeatService = vi.hoisted(() => ({
  summarizeInFlightRuns: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: true,
  },
) {
  const [{ errorHandler }, { dispatchQuiesceRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/dispatch-quiesce.js") as Promise<
      typeof import("../routes/dispatch-quiesce.js")
    >,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", dispatchQuiesceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

// SUP-9857. The deploy script needs two things the control plane did not offer:
// a way to stop dispatch that does not cancel in-flight runs, and a count of
// what is actually in flight so its drain loop has something real to wait on.
describe("dispatch quiesce routes", () => {
  beforeEach(() => {
    dispatchQuiesce.release();
    mockLogActivity.mockClear();
    mockHeartbeatService.summarizeInFlightRuns.mockReset();
    mockHeartbeatService.summarizeInFlightRuns.mockResolvedValue({
      running: 14,
      queued: 3,
      runIds: ["run-1", "run-2"],
    });
  });

  afterEach(() => {
    dispatchQuiesce.release();
  });

  it("reports the released state alongside a real in-flight count", async () => {
    const app = await createApp();

    const res = await requestApp(app, (base) => request(base).get("/api/instance/dispatch-quiesce"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      quiesced: false,
      reason: null,
      engagedAt: null,
      expiresAt: null,
      inFlightRuns: 14,
      queuedRuns: 3,
      runIds: ["run-1", "run-2"],
    });
  });

  it("engages the quiesce and leaves in-flight runs untouched", async () => {
    const app = await createApp();

    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/instance/dispatch-quiesce")
        .send({ reason: "deploy-image.sh v2026.722.1", ttlSeconds: 600 }),
    );

    expect(res.status).toBe(200);
    expect(res.body.quiesced).toBe(true);
    expect(res.body.reason).toBe("deploy-image.sh v2026.722.1");
    expect(res.body.inFlightRuns).toBe(14);
    expect(dispatchQuiesce.isQuiesced()).toBe(true);
    // Nothing on this path may cancel: the whole defect was that quiescing
    // through `agent pause` emptied the drain before the drain looked at it.
    expect(res.body.cancelled).toBeUndefined();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "instance.dispatch_quiesce.engaged" }),
    );
  });

  it("clamps a ttl that would park the fleet indefinitely", async () => {
    const app = await createApp();

    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/instance/dispatch-quiesce")
        .send({ reason: "deploy", ttlSeconds: 86_400 }),
    );

    expect(res.status).toBe(200);
    const ttlMs = Date.parse(res.body.expiresAt) - Date.parse(res.body.engagedAt);
    expect(ttlMs).toBe(6 * 60 * 60 * 1_000);
  });

  it("releases the quiesce and says whether it had been engaged", async () => {
    const app = await createApp();
    dispatchQuiesce.engage({ reason: "deploy", ttlMs: 60_000 });

    const res = await requestApp(app, (base) =>
      request(base).delete("/api/instance/dispatch-quiesce"),
    );

    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);
    expect(res.body.quiesced).toBe(false);
    expect(dispatchQuiesce.isQuiesced()).toBe(false);

    const again = await requestApp(app, (base) =>
      request(base).delete("/api/instance/dispatch-quiesce"),
    );
    expect(again.body.released).toBe(false);
  });

  it("requires instance-admin board access to engage", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-2",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (base) =>
      request(base).post("/api/instance/dispatch-quiesce").send({ reason: "deploy" }),
    );

    expect(res.status).toBe(403);
    expect(dispatchQuiesce.isQuiesced()).toBe(false);
  });

  it("rejects a non-board actor outright", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-1", companyIds: ["company-1"] });

    const res = await requestApp(app, (base) =>
      request(base).get("/api/instance/dispatch-quiesce"),
    );

    expect(res.status).toBe(403);
  });
});
