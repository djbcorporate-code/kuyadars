import type { Catalog } from "./types";

type CoverageBarangay = Catalog["coverage"][number];

type ReverseAddress = {
  city?: string;
  municipality?: string;
  town?: string;
  county?: string;
  suburb?: string;
  neighbourhood?: string;
  quarter?: string;
  village?: string;
  hamlet?: string;
  city_district?: string;
};

type ReverseGeocodeResponse = {
  display_name?: string;
  address?: ReverseAddress;
};

export type ResolvedLocation = {
  city: string;
  barangayCandidates: string[];
  displayName: string;
};

const DEFAULT_GEOCODER_URL = "https://nominatim.openstreetmap.org/reverse";

export function normalizePlaceName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(?:city of\s+|barangay\s+|brgy\.?\s*)/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isDavaoCity(value: string) {
  const normalized = normalizePlaceName(value);
  return normalized === "davao" || normalized === "davao city";
}

export function matchCoverageBarangay(candidates: string[], coverage: CoverageBarangay[]) {
  const coverageByName = new Map(coverage.map((item) => [normalizePlaceName(item.barangay), item]));
  for (const candidate of candidates) {
    const match = coverageByName.get(normalizePlaceName(candidate));
    if (match) return match;
  }
  return null;
}

export async function reverseGeocode(latitude: number, longitude: number): Promise<ResolvedLocation> {
  const endpoint = import.meta.env.VITE_GEOCODER_URL || DEFAULT_GEOCODER_URL;
  const url = new URL(endpoint);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", latitude.toString());
  url.searchParams.set("lon", longitude.toString());
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("layer", "address");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error("Location lookup failed.");
    const body = await response.json() as ReverseGeocodeResponse;
    const address = body.address ?? {};
    const city = address.city ?? address.municipality ?? address.town ?? address.county ?? "";
    const barangayCandidates = [address.suburb, address.neighbourhood, address.quarter, address.village, address.hamlet, address.city_district]
      .filter((value): value is string => Boolean(value));
    return { city, barangayCandidates, displayName: body.display_name ?? "" };
  } finally {
    window.clearTimeout(timeout);
  }
}

export function safeCoordinate(value: string | null, minimum: number, maximum: number, fallback: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
