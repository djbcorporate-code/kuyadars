import { describe, expect, it } from "vitest";
import { coverageDecision, DEFAULT_DELIVERY_RATE, deliveryFeeCentavos, haversineKm, STORE_POINT, validateDavaoPin } from "../src/shared/domain";

describe("authoritative delivery rules", () => {
  it.each([
    [7, 0], [7.001, 3000], [10, 3000], [10.001, 4000], [11.1, 5000], [15, 8000],
  ])("charges the exact boundary at %f km", (distance, expected) => {
    expect(deliveryFeeCentavos(distance, DEFAULT_DELIVERY_RATE)).toBe(expected);
  });

  it("uses a great-circle calculation without integer rounding", () => {
    const point = { latitude: STORE_POINT.latitude + 0.063, longitude: STORE_POINT.longitude };
    const distance = haversineKm(STORE_POINT, point);
    expect(distance).toBeGreaterThan(7);
    expect(distance).toBeLessThan(7.01);
    expect(deliveryFeeCentavos(distance)).toBe(3000);
  });

  it("blocks listed blocked and unlisted barangays before radius", () => {
    expect(coverageDecision("blocked")).toEqual({ serviceable: false, reason: "BARANGAY_BLOCKED" });
    expect(coverageDecision(undefined)).toEqual({ serviceable: false, reason: "BARANGAY_UNLISTED" });
    expect(coverageDecision("distance_based")).toEqual({ serviceable: true });
    expect(deliveryFeeCentavos(1)).toBe(0);
  });

  it("rejects invalid or geographically implausible pins", () => {
    expect(validateDavaoPin(0, 0).valid).toBe(false);
    expect(validateDavaoPin(STORE_POINT.latitude, STORE_POINT.longitude).valid).toBe(true);
  });
});
