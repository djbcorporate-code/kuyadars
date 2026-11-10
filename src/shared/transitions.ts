import type { DeliveryStatus, FulfillmentStatus, OrderState, PaymentStatus, RefundStatus, ReviewStatus } from "./domain.js";

const transitions = {
  review: {
    awaiting_review: ["on_hold", "approved", "rejected"],
    on_hold: ["approved", "rejected"],
    approved: ["on_hold"],
    rejected: [],
  } satisfies Record<ReviewStatus, ReviewStatus[]>,
  payment: {
    unpaid: ["evidence_submitted", "collected"],
    evidence_submitted: ["under_review", "rejected", "duplicate"],
    under_review: ["verified", "short", "rejected", "duplicate"],
    short: ["evidence_submitted", "verified", "collected"],
    verified: [],
    rejected: ["evidence_submitted"],
    duplicate: [],
    collected: [],
  } satisfies Record<PaymentStatus, PaymentStatus[]>,
  fulfillment: {
    submitted: ["confirmed", "cancelled", "stock_out"],
    confirmed: ["preparing", "cancelled", "stock_out"],
    preparing: ["ready", "cancelled", "stock_out"],
    ready: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
    stock_out: ["cancelled", "confirmed"],
  } satisfies Record<FulfillmentStatus, FulfillmentStatus[]>,
  delivery: {
    not_scheduled: ["ready_for_dispatch"],
    ready_for_dispatch: ["out_for_delivery"],
    out_for_delivery: ["unreachable", "delivered", "failed"],
    unreachable: ["out_for_delivery", "rts"],
    rts: ["ready_for_dispatch"],
    delivered: [],
    failed: ["rts"],
  } satisfies Record<DeliveryStatus, DeliveryStatus[]>,
  refund: {
    not_required: ["required"],
    required: ["initiated", "rejected"],
    initiated: ["verified", "rejected"],
    verified: ["settled"],
    settled: [],
    rejected: ["required"],
  } satisfies Record<RefundStatus, RefundStatus[]>,
};

export function assertTransition<K extends keyof typeof transitions>(domain: K, from: keyof (typeof transitions)[K], to: string): void {
  const allowed = transitions[domain][from] as readonly string[];
  if (!allowed?.includes(to)) throw new Error(`Invalid ${domain} transition: ${String(from)} → ${to}`);
}

export function assertMayConfirm(state: OrderState): void {
  if (state.reviewStatus !== "approved") throw new Error("CSR approval is required before confirmation.");
  if (state.paymentMethod === "gcash_manual" && state.paymentStatus !== "verified"
    && !(state.paymentStatus === "short" && state.balanceResolution === "collect_on_delivery")) {
    throw new Error("Manual GCash must be verified, or its exact short balance approved for collection on delivery, before confirmation.");
  }
  if (state.paymentMethod === "cod" && !["unpaid", "short"].includes(state.paymentStatus)) {
    throw new Error("COD must remain unpaid or short until collection.");
  }
}

export function assertMayPrepare(state: OrderState): void {
  if (state.fulfillmentStatus !== "confirmed") throw new Error("Only confirmed orders can enter preparation.");
  assertMayConfirm(state);
}

export function assertMayDeliver(state: OrderState, riderConfirmed: boolean): void {
  if (state.deliveryStatus !== "out_for_delivery") throw new Error("Order must be out for delivery.");
  if (!riderConfirmed) throw new Error("Rider confirmation is required before CSR marks an order delivered.");
}
