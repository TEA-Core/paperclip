import { afterEach, describe, expect, it, vi } from "vitest";

const bootstrap = vi.hoisted(() => {
  const state = {
    entered: null as null | (() => void),
    release: null as null | (() => void),
    calls: 0,
  };
  return state;
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    config = {
      credentials: async () => {
        bootstrap.calls += 1;
        await new Promise<void>((resolve) => {
          bootstrap.release = resolve;
          bootstrap.entered?.();
        });
        return { accessKeyId: "AKIA_HELD", secretAccessKey: "held-secret" };
      },
    };
  },
}));

import { createAwsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";

const SECRET_ID =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-1/openai-api-key";

function resolve(provider: ReturnType<typeof createAwsSecretsManagerProvider>, signal?: AbortSignal) {
  return provider.resolveVersion({
    material: { scheme: "aws_secrets_manager_v1", secretId: SECRET_ID, versionId: "v1", source: "managed" },
    externalRef: SECRET_ID,
    providerVersionRef: "v1",
    context: { companyId: "company-1", secretId: "secret-1", secretKey: "openai-api-key", version: 1 },
    signal,
  });
}

function settle<T>(promise: Promise<T>) {
  const out = { settled: false };
  promise.then(
    () => { out.settled = true; },
    () => { out.settled = true; },
  );
  return out;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => setImmediate(r));
}

describe("AWS credential bootstrap caller abort", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets each caller abort the shared bootstrap wait without cancelling other callers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ SecretString: "expected-secret" }), { status: 200 }),
    );
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
    });

    const entered = new Promise<void>((r) => { bootstrap.entered = r; });
    const starterAbort = new AbortController();
    const joinerAbort = new AbortController();
    const starter = resolve(provider, starterAbort.signal);
    const starterState = settle(starter);
    starter.catch(() => {});
    await entered;
    const joiner = resolve(provider, joinerAbort.signal);
    const joinerState = settle(joiner);
    joiner.catch(() => {});
    const survivor = resolve(provider);
    const survivorState = settle(survivor);
    await flush();

    starterAbort.abort(new Error("starter deadline"));
    await flush();
    expect(starterState.settled).toBe(true);
    await expect(starter).rejects.toBeDefined();
    expect(joinerState.settled).toBe(false);

    joinerAbort.abort(new Error("joiner deadline"));
    await flush();
    expect(joinerState.settled).toBe(true);
    await expect(joiner).rejects.toBeDefined();
    expect(survivorState.settled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bootstrap.calls).toBe(1);

    bootstrap.release!();
    await expect(survivor).resolves.toBe("expected-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bootstrap.calls).toBe(1);
  });
});
