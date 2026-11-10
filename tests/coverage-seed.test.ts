import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const seed = JSON.parse(readFileSync(path.join(process.cwd(), "data", "kuya_dars_davao_delivery_seed.json"), "utf8")) as {
  delivery_rules: Record<string, unknown>;
  barangays: Array<{ id: string; service_status: string }>;
};

describe("Davao City coverage seed", () => {
  it("contains exactly 182 unique authoritative rows", () => {
    expect(seed.barangays).toHaveLength(182);
    expect(new Set(seed.barangays.map((item) => item.id)).size).toBe(182);
  });
  it("preserves 87 distance-based and 95 blocked barangays", () => {
    expect(seed.barangays.filter((item) => item.service_status === "distance_based")).toHaveLength(87);
    expect(seed.barangays.filter((item) => item.service_status === "blocked")).toHaveLength(95);
    expect(seed.delivery_rules.blocked_barangays_override_distance).toBe(true);
    expect(seed.delivery_rules.distance_method).toBe("great_circle_haversine_km");
  });
});
