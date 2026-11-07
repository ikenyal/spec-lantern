// Feature: spec-lantern, Property 8: calculateDistance returns the Haversine great-circle distance in kilometers

// Correctness_Property for the MoodPlays Claim claim-haversine-distance. It
// targets the exported calculateDistance in
//   sandbox/moodplays/src/utils/distanceCalculator.ts
// whose doc comment on L2 reads
//   "Calculate distance between two coordinates using the Haversine formula"
// with "@returns Distance in kilometers" (L7) and "const R = 6371; // Earth's
// radius in kilometers" (L15).
//
// 1:1 mapping: this is the one and only property test file for
// claim-haversine-distance. calculateDistance is exported and pure, so the
// property calls it directly and checks it against an INDEPENDENT Haversine
// reference (same documented formula, R = 6371 km). Two sanity anchors are also
// asserted that follow from the claim regardless of implementation: a point to
// itself is 0 km, and no two points on Earth are more than ~half the great
// circle (<= pi * R) apart.
//
// kind: function. No clock is read; TZ pinned only for consistency.
// Terminates PASS or FAIL; >=100 runs.

import { expect, test } from "vitest";
import fc from "fast-check";

import { calculateDistance } from "@/utils/distanceCalculator";

process.env.TZ = "UTC";

const R_KM = 6371;
const toRad = (deg: number): number => deg * (Math.PI / 180);

/** Independent Haversine reference (the formula the claim names). */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(a));
  return R_KM * c;
}

const lat = () => fc.double({ min: -90, max: 90, noNaN: true });
const lon = () => fc.double({ min: -180, max: 180, noNaN: true });

test("calculateDistance returns the Haversine great-circle distance in kilometers", () => {
  fc.assert(
    fc.property(lat(), lon(), lat(), lon(), (lat1, lon1, lat2, lon2) => {
      const actual = calculateDistance(lat1, lon1, lat2, lon2);
      const expected = haversineKm(lat1, lon1, lat2, lon2);

      // Matches the documented Haversine formula (km) to high precision.
      expect(
        actual,
        `expected ~${expected} km for (${lat1},${lon1})->(${lat2},${lon2}), actual ${actual}`,
      ).toBeCloseTo(expected, 6);

      // Identity: a point to itself is 0 km.
      const self = calculateDistance(lat1, lon1, lat1, lon1);
      expect(self, `expected 0 km to self, actual ${self}`).toBeCloseTo(0, 9);

      // Range: no farther than half the great circle (pi * R), plus slack.
      expect(
        actual,
        `expected <= ${Math.PI * R_KM} km, actual ${actual}`,
      ).toBeLessThanOrEqual(Math.PI * R_KM + 1e-6);
    }),
    { numRuns: 100 },
  );
});
