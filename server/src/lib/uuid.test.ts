import { describe, expect, it } from "vitest";
import { canonicalizeUuid } from "./uuid.js";

const id = "12345678-90ab-cdef-1234-567890abcdef";

describe("canonicalizeUuid", () => {
  it.each([
    "", null, undefined, 123, {},
    ` ${id}`, `${id} `, `${id}\n`, `${id}tail`,
    `{${id}`, `${id}}`, `{{${id}}}`, `urn:uuid:urn:uuid:${id}`,
    `${id}-`, `-${id}`, id.replace("-", "--"),
    id.replace("a", "g"), id.slice(1), `${id}0`,
    "123-4567890abcdef1234567890abcdef", "urn:uuid:not-a-run",
  ])("does not convert malformed run identity %j into a UUID", (value) => {
    expect(canonicalizeUuid(value)).toBeNull();
  });

  it("preserves all 128 bits, including UUIDs outside generated version/variant ranges", () => {
    expect(canonicalizeUuid("{00000000000000000000000000000000}"))
      .toBe("00000000-0000-0000-0000-000000000000");
    expect(canonicalizeUuid("URN:UUID:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"))
      .toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });
});
