/**
 * Canonical airport reference for the swarm — ONE table for every consumer.
 *
 * It used to be a 12-entry map private to hackathonApi.ts, used only for map
 * pins. That table held none of the Asia-Pacific airports the flight partner
 * covers best (SIN→CGK/BOM/DPS/KUL, HND/NRT/BKK/HKG/TPE/MNL/ICN/SYD), so the
 * change map was blank exactly where most real rebookings happen. The same
 * facts — which country an airport is in, how long it takes to reach town —
 * are also what the sanity layer needs to size a realistic arrival buffer, so
 * they live here once rather than being re-guessed in two places.
 *
 * Pure data, no network. `cityTransitMinutes` is a TYPICAL door-to-door time
 * from the terminal to the city centre by the usual rail/road link, not a
 * worst case: the buffer it feeds is a floor for common sense, not a promise.
 */

export interface AirportInfo {
  lat: number;
  lng: number;
  /** Display label used on map pins. */
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** Typical terminal → city-centre travel time, minutes. */
  cityTransitMinutes: number;
}

export const AIRPORTS: Readonly<Record<string, AirportInfo>> = {
  // ── Europe ──────────────────────────────────────────────────────────────
  CDG: { lat: 49.0097, lng: 2.5479, city: "Paris CDG", country: "FR", cityTransitMinutes: 50 },
  ORY: { lat: 48.7262, lng: 2.3594, city: "Paris Orly", country: "FR", cityTransitMinutes: 40 },
  LIS: { lat: 38.7742, lng: -9.1342, city: "Lisbon", country: "PT", cityTransitMinutes: 25 },
  OPO: { lat: 41.2481, lng: -8.6814, city: "Porto", country: "PT", cityTransitMinutes: 30 },
  FAO: { lat: 37.0146, lng: -7.9659, city: "Faro", country: "PT", cityTransitMinutes: 20 },
  MAD: { lat: 40.4983, lng: -3.5676, city: "Madrid", country: "ES", cityTransitMinutes: 35 },
  BCN: { lat: 41.2974, lng: 2.0833, city: "Barcelona", country: "ES", cityTransitMinutes: 35 },
  LHR: { lat: 51.47, lng: -0.4543, city: "London Heathrow", country: "GB", cityTransitMinutes: 50 },
  LGW: { lat: 51.1537, lng: -0.1821, city: "London Gatwick", country: "GB", cityTransitMinutes: 45 },
  FRA: { lat: 50.0379, lng: 8.5622, city: "Frankfurt", country: "DE", cityTransitMinutes: 20 },
  MUC: { lat: 48.3537, lng: 11.775, city: "Munich", country: "DE", cityTransitMinutes: 45 },
  AMS: { lat: 52.3105, lng: 4.7683, city: "Amsterdam", country: "NL", cityTransitMinutes: 25 },
  FCO: { lat: 41.8003, lng: 12.2389, city: "Rome Fiumicino", country: "IT", cityTransitMinutes: 45 },
  IST: { lat: 41.2753, lng: 28.7519, city: "Istanbul", country: "TR", cityTransitMinutes: 60 },
  // ── Americas ────────────────────────────────────────────────────────────
  JFK: { lat: 40.6413, lng: -73.7781, city: "New York JFK", country: "US", cityTransitMinutes: 60 },
  LAX: { lat: 33.9416, lng: -118.4085, city: "Los Angeles", country: "US", cityTransitMinutes: 60 },
  MIA: { lat: 25.7959, lng: -80.287, city: "Miami", country: "US", cityTransitMinutes: 30 },
  // ── Middle East ─────────────────────────────────────────────────────────
  DXB: { lat: 25.2532, lng: 55.3657, city: "Dubai", country: "AE", cityTransitMinutes: 30 },
  DOH: { lat: 25.2731, lng: 51.6081, city: "Doha", country: "QA", cityTransitMinutes: 30 },
  // ── Asia-Pacific ────────────────────────────────────────────────────────
  SIN: { lat: 1.3644, lng: 103.9915, city: "Singapore", country: "SG", cityTransitMinutes: 30 },
  HND: { lat: 35.5494, lng: 139.7798, city: "Tokyo Haneda", country: "JP", cityTransitMinutes: 35 },
  NRT: { lat: 35.772, lng: 140.3929, city: "Tokyo Narita", country: "JP", cityTransitMinutes: 75 },
  KIX: { lat: 34.4347, lng: 135.244, city: "Osaka Kansai", country: "JP", cityTransitMinutes: 60 },
  SGN: { lat: 10.8188, lng: 106.652, city: "Ho Chi Minh City", country: "VN", cityTransitMinutes: 35 },
  HAN: { lat: 21.2212, lng: 105.8072, city: "Hanoi", country: "VN", cityTransitMinutes: 50 },
  BKK: { lat: 13.69, lng: 100.7501, city: "Bangkok", country: "TH", cityTransitMinutes: 45 },
  KUL: { lat: 2.7456, lng: 101.7099, city: "Kuala Lumpur", country: "MY", cityTransitMinutes: 60 },
  HKG: { lat: 22.308, lng: 113.9185, city: "Hong Kong", country: "HK", cityTransitMinutes: 35 },
  TPE: { lat: 25.0797, lng: 121.2342, city: "Taipei", country: "TW", cityTransitMinutes: 50 },
  MNL: { lat: 14.5086, lng: 121.0198, city: "Manila", country: "PH", cityTransitMinutes: 60 },
  ICN: { lat: 37.4602, lng: 126.4407, city: "Seoul Incheon", country: "KR", cityTransitMinutes: 60 },
  DPS: { lat: -8.7482, lng: 115.1675, city: "Bali Denpasar", country: "ID", cityTransitMinutes: 45 },
  CGK: { lat: -6.1256, lng: 106.6559, city: "Jakarta", country: "ID", cityTransitMinutes: 60 },
  BOM: { lat: 19.0896, lng: 72.8656, city: "Mumbai", country: "IN", cityTransitMinutes: 60 },
  SYD: { lat: -33.9399, lng: 151.1753, city: "Sydney", country: "AU", cityTransitMinutes: 30 },
};

/** Schengen members among the countries above — no passport control between them. */
const SCHENGEN: ReadonlySet<string> = new Set([
  "FR", "PT", "ES", "DE", "NL", "IT", "BE", "LU", "AT", "CH", "GR", "SE", "DK", "FI", "NO", "PL", "CZ",
]);

export function airportInfo(code: string | null | undefined): AirportInfo | null {
  if (typeof code !== "string") return null;
  return AIRPORTS[code.trim().toUpperCase()] ?? null;
}

/**
 * Does landing here mean clearing immigration? True for any international
 * arrival outside a shared border zone. null when either airport is unknown —
 * the caller then applies its conservative default rather than guessing.
 */
export function crossesBorderControl(origin: string | null | undefined, destination: string | null | undefined): boolean | null {
  const from = airportInfo(origin);
  const to = airportInfo(destination);
  if (!from || !to) return null;
  if (from.country === to.country) return false;
  return !(SCHENGEN.has(from.country) && SCHENGEN.has(to.country));
}
