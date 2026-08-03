import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import {
  SECRET_REDACTION_TOKEN,
  redactSecretTokens,
  redactSecretValue,
} from "../log-redaction.js";

// Every fixture below is an obvious TESTONLY fake. No real credential material.
const FAKE = "TESTONLYaaaabbbbcccc1234";

describe("redactSecretTokens — prefixed secret shapes", () => {
  it("masks Supabase secret keys but leaves publishable keys intact", () => {
    const input = [
      `secret=sb_secret_${FAKE}`,
      `publishable=sb_publishable_${FAKE}`,
    ].join("\n");

    const result = redactSecretTokens(input);

    expect(result).toContain(`secret=${SECRET_REDACTION_TOKEN}`);
    expect(result).not.toContain(`sb_secret_${FAKE}`);
    expect(result).toContain(`sb_publishable_${FAKE}`);
  });

  it("masks service-role shaped JWTs", () => {
    const jwt = "eyJTESTONLYheader.eyJTESTONLYpayload.TESTONLYsignature01";

    const result = redactSecretTokens(`token ${jwt} end`);

    expect(result).toBe(`token ${SECRET_REDACTION_TOKEN} end`);
  });

  it("masks a JWT that follows a dot or hyphen", () => {
    const jwt = "eyJTESTONLYheader.eyJTESTONLYpayload.TESTONLYsignature01";

    expect(redactSecretTokens(`bearer-${jwt}`)).not.toContain("TESTONLYsignature01");
    expect(redactSecretTokens(`https://x.test/t.${jwt}`)).not.toContain("TESTONLYsignature01");
  });

  it("masks a 4-segment JWE whole, leaving no ciphertext tail", () => {
    const jwe = "eyJTESTONLYheader.TESTONLYkey0000.TESTONLYiv000000.TESTONLYcipher01";

    const result = redactSecretTokens(jwe);

    expect(result).toBe(SECRET_REDACTION_TOKEN);
  });

  it("masks sk_ / sk- API keys of 20 chars or more", () => {
    expect(redactSecretTokens(`sk_live_${FAKE}`)).toBe(SECRET_REDACTION_TOKEN);
    expect(redactSecretTokens("sk-ant-api03-TESTONLYaaaabbbb1")).toBe(SECRET_REDACTION_TOKEN);
  });

  it("masks common vendor token prefixes", () => {
    const fixtures = [
      "ghp_TESTONLYaaaabbbbccccddddeeee01",
      "github_pat_TESTONLY11ABCDEFG0aaaabbbbcccc",
      "xoxb-TESTONLY-1234567890-abcdefghij",
      "glpat-TESTONLYaaaabbbbcccc01",
      "AKIATESTONLYAAAABBBB",
      "AIzaTESTONLYaaaabbbbccccdddd0",
    ];

    for (const token of fixtures) {
      expect(redactSecretTokens(`remote: ${token}`)).toBe(`remote: ${SECRET_REDACTION_TOKEN}`);
    }
  });

  it("masks bearer and basic authorization values while keeping the scheme", () => {
    const result = redactSecretTokens(
      "Authorization: Bearer TESTONLYopaque0123456789abcdef",
    );

    expect(result).toBe(`Authorization: Bearer ${SECRET_REDACTION_TOKEN}`);
    expect(redactSecretTokens("Authorization: Basic dXNlcjpURVNUT05MWQ==")).toContain(
      `Basic ${SECRET_REDACTION_TOKEN}`,
    );
  });

  it("masks the password inside a connection URI", () => {
    const result = redactSecretTokens(
      "psql postgres://postgres:TESTONLYdbpass123@db.example.supabase.co:5432/postgres",
    );

    expect(result).not.toContain("TESTONLYdbpass123");
    expect(result).toContain("postgres://postgres:");
    expect(result).toContain("@db.example.supabase.co:5432/postgres");
  });

  it("masks PEM private key blocks", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEATESTONLYkeymaterialaaaa",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const result = redactSecretTokens(`before\n${pem}\nafter`);

    expect(result).toBe(`before\n${SECRET_REDACTION_TOKEN}\nafter`);
  });
});

describe("redactSecretTokens — name-driven assignments", () => {
  it("masks NAME=value for secret-suffixed names", () => {
    const cases = [
      "SUPABASE_SERVICE_ROLE_KEY",
      "TSP_CRYPTOPANIC_API_KEY",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "CF_ACCESS_CLIENT_SECRET",
    ];

    for (const name of cases) {
      expect(redactSecretTokens(`${name}=${FAKE}`)).toBe(`${name}=${SECRET_REDACTION_TOKEN}`);
    }
  });

  it("masks lowercase and camelCase secret field names", () => {
    expect(redactSecretTokens(`{"api_key": "${FAKE}"}`)).toBe(
      `{"api_key": "${SECRET_REDACTION_TOKEN}"}`,
    );
    expect(redactSecretTokens(`{"serviceRoleKey":"${FAKE}"}`)).toBe(
      `{"serviceRoleKey":"${SECRET_REDACTION_TOKEN}"}`,
    );
    expect(redactSecretTokens(`password=${FAKE}`)).toBe(`password=${SECRET_REDACTION_TOKEN}`);
  });

  it("masks escaped-JSON secret fields without leaking an escaped tail", () => {
    const input = `{\\"API_TOKEN\\":\\"TEST\\u0041ONLYaaaabbbb\\"}`;

    const result = redactSecretTokens(input);

    expect(result).toContain(SECRET_REDACTION_TOKEN);
    expect(result).not.toContain("ONLYaaaabbbb");
    expect(result).toContain(`\\"API_TOKEN\\"`);
  });

  it("masks a bare value whole, including punctuation inside the credential", () => {
    // Terminating at punctuation used to emit a marker followed by the tail of
    // the real secret — `DB_PASSWORD=Ab3#cdefgh` kept `#cdefgh` on disk.
    for (const punctuation of ["#", ",", "&", "|", ";", ")", "]", "}", "[", "(", "{", "\\", "<"]) {
      const password = `Xk9${punctuation}TESTONLYtail123`;

      const result = redactSecretTokens(`DB_PASSWORD=${password}`);

      expect(result).toBe(`DB_PASSWORD=${SECRET_REDACTION_TOKEN}`);
      expect(result).not.toContain("TESTONLYtail");
    }
  });

  it("masks glued-prefix password env vars", () => {
    for (const name of ["PGPASSWORD", "PGPASS", "MYSQL_PWD"]) {
      expect(redactSecretTokens(`${name}=${FAKE} psql -h db.example.supabase.co`)).toBe(
        `${name}=${SECRET_REDACTION_TOKEN} psql -h db.example.supabase.co`,
      );
      expect(redactSecretTokens(`${name}="${FAKE}"`)).toBe(
        `${name}="${SECRET_REDACTION_TOKEN}"`,
      );
    }
  });

  it("masks the space-separated CLI password flag", () => {
    expect(redactSecretTokens(`supabase link --project-ref abcd --password ${FAKE}`)).toBe(
      `supabase link --project-ref abcd --password ${SECRET_REDACTION_TOKEN}`,
    );
    expect(redactSecretTokens(`supabase db push --db-password ${FAKE}`)).toBe(
      `supabase db push --db-password ${SECRET_REDACTION_TOKEN}`,
    );
  });

  it("masks a scheme-less user:password@host connection fragment", () => {
    const result = redactSecretTokens(
      "postgres.abcdefgh:TESTONLYdbpass123@aws-0-eu-west-2.pooler.supabase.com:6543",
    );

    expect(result).not.toContain("TESTONLYdbpass123");
    expect(result).toContain("@aws-0-eu-west-2.pooler.supabase.com:6543");
  });

  it("keeps quoted and JSON structure after the masked value", () => {
    expect(redactSecretTokens(`{"ADMIN_TOKEN": "${FAKE}", "region": "us"}`)).toBe(
      `{"ADMIN_TOKEN": "${SECRET_REDACTION_TOKEN}", "region": "us"}`,
    );
    expect(redactSecretTokens(`API_KEY="${FAKE}" region=us-east-1`)).toBe(
      `API_KEY="${SECRET_REDACTION_TOKEN}" region=us-east-1`,
    );
  });

  it("leaves publishable key assignments intact", () => {
    const publishable = `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_${FAKE}`;

    expect(redactSecretTokens(publishable)).toBe(publishable);
  });

  it("still masks an anon JWT — shape is indistinguishable from a service-role JWT", () => {
    // Deliberate over-redaction: the name rule spares ANON_KEY, but any JWT-shaped
    // value is masked because an anon token and a service-role token differ only in
    // their (base64) payload claims.
    const anon = "NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJTESTONLYanon.TESTONLYpayload.TESTONLYsig000";

    expect(redactSecretTokens(anon)).toBe(
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${SECRET_REDACTION_TOKEN}`,
    );
  });
});

describe("redactSecretTokens — false positives", () => {
  it("leaves ordinary prose and identifiers untouched", () => {
    const prose = [
      "const SESSION_TOKEN = await getToken();",
      "ERROR: invalid API_KEY: expected 32 chars, got 0",
      "### GITHUB_TOKEN: how to set it up",
      "rotate SUPABASE_SERVICE_ROLE_KEY tomorrow",
      "MONKEY=banana and TURKEY=bird",
      "the sk- prefix denotes an API key",
      "semver 1.22.333 and file a.bb.ccc",
      "[omitted base64 image data: 4096 chars]",
      "ACCESS_TOKEN=<paste-here>",
      "FOO_KEY=",
    ].join("\n");

    expect(redactSecretTokens(prose)).toBe(prose);
  });

  it("leaves code identifiers that merely start with sk_ or sk- untouched", () => {
    const code = [
      '<div class="sk-circle-fade-delay-one"></div>',
      "obj.sk_internal_state_container.reset()",
      "https://github.com/org/repo/blob/main/src/sk_utils_and_helpers.py",
      "task sk-1 done; disk-1234567890123456789",
    ].join("\n");

    expect(redactSecretTokens(code)).toBe(code);
  });

  it("leaves a secret-shaped name with a non-secret suffix untouched", () => {
    expect(redactSecretTokens("FOO_KEY_ID=plainvalue")).toBe("FOO_KEY_ID=plainvalue");
  });

  it("does not corrupt comparison operators in pasted code", () => {
    const code = [
      "if (apiKey === undefined) {}",
      "if (apiKey == null) return;",
      "if (SESSION_TOKEN !== previous) {}",
      "const ok = password >= minimum;",
      "const fn = (API_KEY) => API_KEY;",
      "credential ??= fallback;",
      "secret += suffix;",
    ].join("\n");

    expect(redactSecretTokens(code)).toBe(code);
  });

  it("leaves env-var indirections intact — they are the safe form to write", () => {
    const indirections = [
      "export ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY",
      "docker run -e OPENAI_API_KEY=${OPENAI_API_KEY} app",
      "set API_KEY=%API_KEY%",
    ].join("\n");

    expect(redactSecretTokens(indirections)).toBe(indirections);
  });

  it("leaves diagnostic sentinel values readable", () => {
    const diagnostics = [
      "API_KEY=undefined",
      "SUPABASE_SERVICE_ROLE_KEY=null is not a valid key",
      "DB_PASSWORD=false",
      "TOKEN_TTL_SECRET=3600",
    ].join("\n");

    expect(redactSecretTokens(diagnostics)).toBe(diagnostics);
  });
});

describe("redactSecretTokens — idempotence and marker safety", () => {
  it("is idempotent", () => {
    const input = `FOO_TOKEN=${FAKE} and sb_secret_${FAKE}`;
    const once = redactSecretTokens(input);

    expect(redactSecretTokens(once)).toBe(once);
  });

  it("does not rewrite or corrupt an existing marker", () => {
    expect(redactSecretTokens(`FOO_SECRET=x${SECRET_REDACTION_TOKEN}`)).not.toContain(
      `${SECRET_REDACTION_TOKEN}]`,
    );
    expect(redactSecretTokens(`GITHUB_TOKEN=${REDACTED_EVENT_VALUE}`)).toBe(
      `GITHUB_TOKEN=${REDACTED_EVENT_VALUE}`,
    );
  });

  it("returns falsy input unchanged", () => {
    expect(redactSecretTokens("")).toBe("");
  });
});

describe("redactSecretValue", () => {
  it("recursively redacts nested payload values", () => {
    const result = redactSecretValue({
      cmd: `export GITHUB_TOKEN=${FAKE}`,
      nested: { key: `sb_secret_${FAKE}` },
      values: [`sk_live_${FAKE}`, "ordinary text"],
      count: 3,
    });

    expect(result).toEqual({
      cmd: `export GITHUB_TOKEN=${SECRET_REDACTION_TOKEN}`,
      nested: { key: SECRET_REDACTION_TOKEN },
      values: [SECRET_REDACTION_TOKEN, "ordinary text"],
      count: 3,
    });
  });
});
