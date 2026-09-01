import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo, Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Server as TlsServer } from "node:tls";

type SupertestServer = NetServer & {
  address(): ReturnType<NetServer["address"]>;
  listen(port: number): NetServer;
};

type SupertestTestInstance = {
  _server?: SupertestServer;
};

type SupertestTestConstructor = {
  prototype: {
    serverAddress(this: SupertestTestInstance, app: SupertestServer, path: string): string;
    __paperclipLoopbackPatched?: boolean;
  };
};

const require = createRequire(import.meta.url);
const SupertestTest = require("supertest/lib/test.js") as SupertestTestConstructor;

if (!process.env.CODEX_HOME) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-codex-home-"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-vitest"}\n', { mode: 0o600 });
  process.env.CODEX_HOME = codexHome;
}

// Allow the local-encrypted secrets provider to auto-generate a master key
// during tests. Individual tests that need to verify the deny-by-default
// behavior explicitly delete this env var.
if (process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION === undefined) {
  process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = "1";
}

// Keep auto-generated key material inside a throwaway directory owned by this
// suite. The fork resolves every persisted key file from the master key's
// location (PAPERCLIP_SECRETS_MASTER_KEY_FILE, defaulting to
// /etc/paperclip/secrets), so a suite that creates a secret without pinning
// this path writes a real key file at the shared default. That file then
// outlives the suite and is visible to every later suite on the same runner,
// which makes secret-provider-registry.test.ts (it asserts the default-path
// behavior with no key file present) pass or fail purely on suite ordering.
// Suites that need their own directory still override this value.
if (process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE === undefined) {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-secrets-"));
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsDir, "master.key");
}

// The automatic Tailscale HTTPS default (PAP-17158) probes for a real host
// broker socket, so leaving it enabled would make every test that starts a
// service named `paperclip-dev` behave differently on a broker-capable host
// than on CI. Tests that exercise the default opt in explicitly.
if (!process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS) {
  process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = "off";
}

if (!SupertestTest.prototype.__paperclipLoopbackPatched) {
  SupertestTest.prototype.serverAddress = function serverAddress(app, path) {
    const addr = app.address();

    if (!addr) {
      this._server = app.listen(0) as SupertestServer;
    }

    const listeningAddress = app.address() as AddressInfo | string | null;
    if (!listeningAddress || typeof listeningAddress === "string") {
      throw new Error("Expected Supertest server to listen on a TCP port");
    }

    const host = listeningAddress.address === "::"
      ? "[::1]"
      : listeningAddress.address === "0.0.0.0"
        ? "127.0.0.1"
        : listeningAddress.address;
    const protocol = app instanceof TlsServer ? "https" : "http";
    return `${protocol}://${host}:${listeningAddress.port}${path}`;
  };

  SupertestTest.prototype.__paperclipLoopbackPatched = true;
}
