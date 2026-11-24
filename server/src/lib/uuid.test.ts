import { describe, expect, it } from "vitest";
import { canonicalizeUuid } from "./uuid.js";

const id = "12345678-90ab-cdef-1234-567890abcdef";

describe("canonicalizeUuid", () => {
  it.each([
    "", 123, {}, [id], false,
    ` ${id}`, `${id} `, `${id}\n`, `${id}tail`,
    `{${id}`, `${id}}`, `{{${id}}}`, `urn:uuid:urn:uuid:${id}`,
    `${id}-`, `-${id}`, id.replace("-", "--"),
    id.replace("a", "g"), id.slice(1), `${id}0`,
    "123-4567890abcdef1234567890abcdef", "urn:uuid:not-a-run",
  ])("rejects malformed run identity %j with a stable HTTP 400", (value) => {
    expect(() => canonicalizeUuid(value)).toThrow(expect.objectContaining({
      status: 400, details: { code: "invalid_run_id" },
    }));
  });

  it.each([null, undefined])("keeps absent optional run identity %j unbound", (value) => {
    expect(canonicalizeUuid(value)).toBeNull();
  });

  it("preserves all 128 bits, including UUIDs outside generated version/variant ranges", () => {
    expect(canonicalizeUuid("{00000000000000000000000000000000}"))
      .toBe("00000000-0000-0000-0000-000000000000");
    expect(canonicalizeUuid("URN:UUID:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"))
      .toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });
});
