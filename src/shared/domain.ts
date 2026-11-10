export const STORE_POINT = { latitude: 7.1380336, longitude: 125.5879857 } as const;

export type Role = "owner" | "admin" | "csr" | "rider" | "customer";
export type PaymentStatus = "unpaid" | "evidence_submitted" | "under_review" | "short" | "verified" | "rejected" | "duplicate" | "collected";
export type ReviewStatus = "awaiting_review" | "on_hold" | "approved" | "rejected";
export type FulfillmentStatus = "submitted" | "confirmed" | "preparing" | "ready" | "completed" | "cancelled" | "stock_out";
export type DeliveryStatus = "not_scheduled" | "ready_for_dispatch" | "out_for_delivery" | "unreachable" | "rts" | "delivered" | "failed";
export type RefundStatus = "not_required" | "required" | "initiated" | "verified" | "settled" | "rejected";

export type OrderState = {
  reviewStatus: ReviewStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: "cod" | "gcash_manual";
  fulfillmentStatus: FulfillmentStatus;
  deliveryStatus: DeliveryStatus;
  refundStatus: RefundStatus;
  verifiedPaidCentavos: number;
  totalCentavos: number;
  balanceResolution?: "pay_online" | "collect_on_delivery" | null;
};

export type DeliveryRate = {
  freeRadiusKm: number;
  paidZoneMaxKm: number;
  paidZoneBaseFeeCentavos: number;
  extraStartedKmFeeCentavos: number;
};

export const DEFAULT_DELIVERY_RATE: DeliveryRate = {
  freeRadiusKm: 7,
  paidZoneMaxKm: 10,
  paidZoneBaseFeeCentavos: 3000,
  extraStartedKmFeeCentavos: 1000,
};

export function haversineKm(origin: { latitude: number; longitude: number }, destination: { latitude: number; longitude: number }): number {
  const radiusKm = 6371.0088;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(destination.latitude - origin.latitude);
  const longitudeDelta = radians(destination.longitude - origin.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(origin.latitude)) * Math.cos(radians(destination.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function deliveryFeeCentavos(distanceKm: number, rate: DeliveryRate = DEFAULT_DELIVERY_RATE): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) throw new Error("Distance must be a non-negative finite number");
  if (distanceKm <= rate.freeRadiusKm) return 0;
  if (distanceKm <= rate.paidZoneMaxKm) return rate.paidZoneBaseFeeCentavos;
  return rate.paidZoneBaseFeeCentavos + Math.ceil(distanceKm - rate.paidZoneMaxKm) * rate.extraStartedKmFeeCentavos;
}

export function isOrderingOpen(at: Date, open = "08:00", close = "22:00"): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const value = hour * 60 + minute;
  const [openHour, openMinute] = open.split(":").map(Number);
  const [closeHour, closeMinute] = close.split(":").map(Number);
  return value >= openHour * 60 + openMinute && value < closeHour * 60 + closeMinute;
}

export function formatPhp(centavos: number): string {
  return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(centavos / 100);
}

export function validateDavaoPin(latitude: number, longitude: number): { valid: boolean; reason?: string } {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { valid: false, reason: "Pin coordinates are required." };
  if (latitude < 6.8 || latitude > 7.65 || longitude < 125.15 || longitude > 125.75) {
    return { valid: false, reason: "The pin is outside the Davao City validation envelope." };
  }
  return { valid: true };
}

export function refundDeadline(recordedAt: Date, minutes = 5): Date {
  return new Date(recordedAt.getTime() + minutes * 60_000);
}

export function canAccessCsr(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "csr";
}

export function canAdminister(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export function coverageDecision(status: "distance_based" | "blocked" | undefined) {
  if (status === "distance_based") return { serviceable: true as const };
  return { serviceable: false as const, reason: status === "blocked" ? "BARANGAY_BLOCKED" : "BARANGAY_UNLISTED" };
}

export function firstOrderDiscountCentavos(eligibleSubtotalCentavos: number, basisPoints = 1000): number {
  if (!Number.isInteger(eligibleSubtotalCentavos) || eligibleSubtotalCentavos < 0) throw new Error("Subtotal must be non-negative integer centavos");
  return Math.floor((eligibleSubtotalCentavos * basisPoints) / 10_000);
}
