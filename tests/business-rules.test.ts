import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canAccessCsr, canAdminister, firstOrderDiscountCentavos, isOrderingOpen, refundDeadline, type OrderState } from "../src/shared/domain";
import { assertMayConfirm, assertMayDeliver, assertMayPrepare, assertTransition } from "../src/shared/transitions";

const atManila = (isoLocal: string) => new Date(`${isoLocal}+08:00`);
const base: OrderState = { reviewStatus: "awaiting_review", paymentStatus: "evidence_submitted", paymentMethod: "gcash_manual", fulfillmentStatus: "submitted", deliveryStatus: "not_scheduled", refundStatus: "not_required", verifiedPaidCentavos: 0, totalCentavos: 28000 };

describe("ordering and money", () => {
  it("opens at 08:00 and closes exactly at 22:00 Manila time", () => {
    expect(isOrderingOpen(atManila("2026-11-09T08:00:00"))).toBe(true);
    expect(isOrderingOpen(atManila("2026-11-09T21:59:59"))).toBe(true);
    expect(isOrderingOpen(atManila("2026-11-09T07:59:59"))).toBe(false);
    expect(isOrderingOpen(atManila("2026-11-09T22:00:00"))).toBe(false);
  });
  it("uses integer centavos and a 10% first-order discount with no invented cap", () => {
    expect(firstOrderDiscountCentavos(28000)).toBe(2800);
    expect(firstOrderDiscountCentavos(84000)).toBe(8400);
  });
  it("persists a five-minute refund action deadline", () => {
    const event = new Date("2026-11-09T10:00:00.000Z");
    expect(refundDeadline(event).toISOString()).toBe("2026-11-09T10:05:00.000Z");
  });
});

describe("payment and order state isolation", () => {
  it("never treats a GCash receipt upload as verified or preparation-ready", () => {
    expect(() => assertMayConfirm(base)).toThrow(/approval/i);
    expect(() => assertMayPrepare({ ...base, reviewStatus: "approved", fulfillmentStatus: "confirmed" })).toThrow(/verified/i);
  });
  it("allows COD confirmation while still unpaid after CSR approval", () => {
    expect(() => assertMayConfirm({ ...base, reviewStatus: "approved", paymentMethod: "cod", paymentStatus: "unpaid" })).not.toThrow();
  });
  it("allows an exact short GCash balance to be explicitly collected on delivery", () => {
    expect(() => assertMayConfirm({ ...base, reviewStatus: "approved", paymentStatus: "short", balanceResolution: "collect_on_delivery" })).not.toThrow();
    expect(() => assertMayConfirm({ ...base, reviewStatus: "approved", paymentStatus: "short", balanceResolution: "pay_online" })).toThrow(/verified/i);
  });
  it("requires recorded rider confirmation to finish delivery", () => {
    const delivering = { ...base, deliveryStatus: "out_for_delivery" as const };
    expect(() => assertMayDeliver(delivering, false)).toThrow(/Rider confirmation/i);
    expect(() => assertMayDeliver(delivering, true)).not.toThrow();
  });
  it("enforces unreachable → RTS and fresh reschedule review", () => {
    expect(() => assertTransition("delivery", "out_for_delivery", "rts")).toThrow();
    expect(() => assertTransition("delivery", "out_for_delivery", "unreachable")).not.toThrow();
    expect(() => assertTransition("delivery", "unreachable", "rts")).not.toThrow();
  });
  it("prevents invalid refund and fulfillment jumps", () => {
    expect(() => assertTransition("refund", "required", "settled")).toThrow();
    expect(() => assertTransition("fulfillment", "submitted", "preparing")).toThrow();
  });
});

describe("permissions and database concurrency guards", () => {
  it("keeps customer and rider roles out of CSR/admin data", () => {
    expect(canAccessCsr("customer")).toBe(false);
    expect(canAccessCsr("rider")).toBe(false);
    expect(canAccessCsr("csr")).toBe(true);
    expect(canAdminister("csr")).toBe(false);
    expect(canAdminister("owner")).toBe(true);
  });
  it("declares atomic uniqueness and optimistic locking invariants in the migration", () => {
    const sql = readFileSync(path.join(process.cwd(), "db", "migrations", "001_initial.sql"), "utf8");
    expect(sql).toMatch(/UNIQUE \(promotion_id, identity_key_hash\)/);
    expect(sql).toMatch(/PRIMARY KEY \(scope, key\)/);
    expect(sql).toMatch(/stock_reserved integer NOT NULL/);
    expect(sql).toMatch(/version integer NOT NULL DEFAULT 1/g);
    expect(sql).toMatch(/audit_immutable/);
  });
});
