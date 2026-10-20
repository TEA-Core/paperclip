import { describe, expect, it, vi } from "vitest";
import { canonicalizeExternalObjectUrl } from "@paperclipai/shared/external-objects-server";
import {
  buildRecoveredExternalObjectIdentity,
  claimDeliveryReceipt,
  claimDeliveryReceiptForPublication,
  consumeDeliveryReceipt,
  invalidateDeliveryReceipt,
  normalizeDeliveryReceiptRecoveryInput,
  type DeliveryReceiptClaim,
} from "./delivery-receipt-recovery.js";

function updateDb(returning: unknown[]) {
  const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(returning) });
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where }),
    }),
    where,
  } as any;
}

describe("delivery receipt recovery", () => {
  it("uses the shared canonical URL and identity hash for recovered PR objects", () => {
    const url = "https://github.com/TEA-Core/paperclip/pull/579";
    const canonical = canonicalizeExternalObjectUrl(url)!;
    expect(buildRecoveredExternalObjectIdentity({ owner: "TEA-Core", repo: "paperclip", pullRequestNumber: 579 })).toEqual({
      sanitizedCanonicalUrl: canonical.sanitizedCanonicalUrl,
      canonicalIdentityHash: canonical.canonicalIdentityHash,
      canonicalIdentity: canonical.canonicalIdentity,
    });
  });

  it("normalizes exact recovery coordinates and rejects non-canonical input", () => {
    expect(normalizeDeliveryReceiptRecoveryInput({
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: "a".repeat(40),
      reason: "restore approved publication",
      idempotencyKey: "recover-579",
    })).toEqual({
      owner: "tea-core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: "a".repeat(40),
      reason: "restore approved publication",
      idempotencyKey: "recover-579",
    });

    expect(() => normalizeDeliveryReceiptRecoveryInput({
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: "A".repeat(40),
      reason: "restore approved publication",
      idempotencyKey: "recover-579",
    })).toThrow();

    expect(() => normalizeDeliveryReceiptRecoveryInput({
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: "a".repeat(40),
      reason: "restore approved publication",
      idempotencyKey: "recover-579",
      extra: true,
    } as any)).toThrow();

    expect(() => normalizeDeliveryReceiptRecoveryInput({
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: "not-a-sha",
      reason: "restore approved publication",
      idempotencyKey: "recover-579",
    })).toThrow();
  });

  it("allows exactly one ready receipt claim", async () => {
    const db = updateDb([{ id: "receipt-1", headSha: "a".repeat(40) }]);
    const input = {
      companyId: "company-1",
      issueId: "issue-1",
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: "a".repeat(40),
    };
    const first = await claimDeliveryReceipt(db, input);
    const second = await claimDeliveryReceipt(updateDb([]), input);
    expect(first).toEqual({ receiptId: "receipt-1", claimToken: expect.any(String), headSha: input.headSha });
    expect(second).toBeNull();
  });

  it("refuses a mismatched receipt head before attempting a GitHub publication claim", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ headSha: "b".repeat(40), state: "ready" }]),
          }),
        }),
      }),
      update: vi.fn(),
    } as any;
    const result = await claimDeliveryReceiptForPublication(db, {
      companyId: "company-1",
      issueId: "issue-1",
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: "a".repeat(40),
    });
    expect(result).toEqual({ kind: "blocked", reason: "head_mismatch" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each(["claimed", "consumed", "invalidated"] as const)("refuses a %s receipt without claiming it again", async (state) => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ headSha: "a".repeat(40), state }]),
          }),
        }),
      }),
      update: updateDb([]).update,
    } as any;
    const result = await claimDeliveryReceiptForPublication(db, {
      companyId: "company-1",
      issueId: "issue-1",
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: "a".repeat(40),
    });
    expect(result).toEqual({ kind: "blocked", reason: "state_unavailable" });
  });

  it("treats a receipt link with different coordinates as missing", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      update: vi.fn(),
    } as any;
    const result = await claimDeliveryReceiptForPublication(db, {
      companyId: "company-1",
      issueId: "issue-1",
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: "a".repeat(40),
    });
    expect(result).toEqual({ kind: "missing" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("allows only one of two concurrent publication claims", async () => {
    const claim = { id: "receipt-1", headSha: "a".repeat(40) };
    const candidates = [{ headSha: claim.headSha, state: "ready" }];
    let updateCount = 0;
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(candidates),
          }),
        }),
      }),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(updateCount++ === 0 ? [claim] : []),
          }),
        }),
      })),
    } as any;
    const input = {
      companyId: "company-1",
      issueId: "issue-1",
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 579,
      headSha: claim.headSha,
    };
    const results = await Promise.all([
      claimDeliveryReceiptForPublication(db, input),
      claimDeliveryReceiptForPublication(db, input),
    ]);
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "blocked")).toEqual([{ kind: "blocked", reason: "state_unavailable" }]);
  });

  it("consumes and invalidates only the matching claimed token", async () => {
    const claim: DeliveryReceiptClaim = { receiptId: "receipt-1", claimToken: "00000000-0000-0000-0000-000000000001", headSha: "a".repeat(40) };
    expect(await consumeDeliveryReceipt(updateDb([{ id: claim.receiptId }]), claim)).toBe(true);
    expect(await invalidateDeliveryReceipt(updateDb([{ id: claim.receiptId }]), claim)).toBe(true);
    expect(await consumeDeliveryReceipt(updateDb([]), claim)).toBe(false);
  });
});
