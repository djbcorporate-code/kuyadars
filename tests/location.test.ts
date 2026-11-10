import { describe, expect, it } from "vitest";
import { isDavaoCity, matchCoverageBarangay, normalizePlaceName, safeCoordinate } from "../src/client/location";
import type { Catalog } from "../src/client/types";

const coverage: Catalog["coverage"] = [
  { id: "tigatto", legislative_district: "District 2", administrative_district: "Buhangin", barangay: "Tigatto", service_status: "distance_based" },
  { id: "barangay-76-a", legislative_district: "District 1", administrative_district: "Poblacion", barangay: "Barangay 76-A", service_status: "blocked" },
];

describe("location matching", () => {
  it("accepts common Davao City labels but rejects other cities", () => {
    expect(isDavaoCity("Davao City")).toBe(true);
    expect(isDavaoCity("City of Davao")).toBe(true);
    expect(isDavaoCity("Davao")).toBe(true);
    expect(isDavaoCity("Panabo City")).toBe(false);
  });

  it("normalizes barangay prefixes and punctuation", () => {
    expect(normalizePlaceName("Brgy. 76-A")).toBe("76 a");
    expect(normalizePlaceName("Barangay 76-A")).toBe("76 a");
  });

  it("matches reverse-geocoded barangay candidates to authoritative coverage", () => {
    expect(matchCoverageBarangay(["Unknown", "Barangay Tigatto"], coverage)?.id).toBe("tigatto");
    expect(matchCoverageBarangay(["Brgy. 76-A"], coverage)?.service_status).toBe("blocked");
    expect(matchCoverageBarangay(["Bajada"], coverage)).toBeNull();
  });

  it("rejects invalid coordinates from query parameters", () => {
    expect(safeCoordinate("7.12", -90, 90, 0)).toBe(7.12);
    expect(safeCoordinate("999", -90, 90, 7.13)).toBe(7.13);
    expect(safeCoordinate("not-a-number", -180, 180, 125.58)).toBe(125.58);
  });
});
