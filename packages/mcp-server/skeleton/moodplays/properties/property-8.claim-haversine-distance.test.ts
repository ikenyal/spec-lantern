// Feature: spec-lantern, Property 8: calculateDistance returns the real great-circle distance in kilometers

// Correctness_Property for the MoodPlays Claim claim-haversine-distance. It
// targets the exported calculateDistance in
//   sandbox/moodplays/src/utils/distanceCalculator.ts
// whose doc comment on L2 reads
//   "Calculate distance between two coordinates using the Haversine formula"
// with "@returns Distance in kilometers" (L7) and "const R = 6371; // Earth's
// radius in kilometers" (L15).
//
// 1:1 mapping: this is the one and only property test file for
// claim-haversine-distance.
//
// INDEPENDENT ORACLE (not the implementation restated). An earlier draft of
// this property recomputed the Haversine formula itself and compared — that
// oracle just mirrors the code, so it would PASS even if the code's formula
// were wrong. This version instead pins the claim to behavior derived WITHOUT
// the implementation:
//   1. KNOWN REAL DISTANCES: a small table of well-known city/landmark
//      coordinate pairs whose real-world great-circle distance (km) is known
//      from external references, asserted within a stated tolerance. These
//      anchor the result to physical reality and to the "kilometers" unit.
//   2. METRIC PROPERTIES that any true distance must satisfy, independent of
//      the formula used: identity d(a,a)=0, non-negativity, symmetry
//      d(a,b)=d(b,a), and the triangle inequality d(a,c) <= d(a,b)+d(b,c).
//
// kind: function. No clock is read; TZ pinned only for consistency.
// Terminates PASS or FAIL; >=100 runs.

import { expect, test } from "vitest";
import fc from "fast-check";

import { calculateDistance } from "@/utils/distanceCalculator";

process.env.TZ = "UTC";

/**
 * Known great-circle distances between real coordinate pairs, in kilometers,
 * from external references (not computed from the code under test). Tolerances
 * are generous enough to absorb coordinate rounding and the ~0.3% ellipsoid-vs-
 * sphere difference, but far tighter than any wrong-formula / wrong-unit result
 * (e.g. radius in miles, or returning meters) would be.
 */
const KNOWN: ReadonlyArray<{
  name: string;
  a: readonly [number, number];
  b: readonly [number, number];
  km: number;
  tolKm: number;
}> = [
  {
    name: "Tokyo Station -> Shin-Osaka Station",
    a: [35.681236, 139.767125],
    b: [34.733163, 135.500214],
    km: 403,
    tolKm: 10,
  },
  {
    name: "London (Big Ben) -> Paris (Notre-Dame)",
    a: [51.500729, -0.124625],
    b: [48.852968, 2.349902],
    km: 343,
    tolKm: 10,
  },
  {
    name: "New York (Times Sq) -> Los Angeles (City Hall)",
    a: [40.758, -73.9855],
    b: [34.0537, -118.2428],
    km: 3936,
    tolKm: 40,
  },
  {
    name: "Equator one degree of longitude (0,0)->(0,1)",
    a: [0, 0],
    b: [0, 1],
    km: 111.19,
    tolKm: 1,
  },
];

test("calculateDistance matches known real great-circle distances and obeys metric laws", () => {
  // 1. Known real distances (external oracle).
  for (const { name, a, b, km, tolKm } of KNOWN) {
    const actual = calculateDistance(a[0], a[1], b[0], b[1]);
    expect(
      Math.abs(actual - km) <= tolKm,
      `${name}: expected ~${km} km (+/-${tolKm}), actual ${actual} km`,
    ).toBe(true);
  }

  // 2. Metric properties that hold for any true distance, formula-independent.
  const lat = () => fc.double({ min: -90, max: 90, noNaN: true });
  const lon = () => fc.double({ min: -180, max: 180, noNaN: true });

  fc.assert(
    fc.property(
      lat(), lon(), lat(), lon(), lat(), lon(),
      (latA, lonA, latB, lonB, latC, lonC) => {
        const dAA = calculateDistance(latA, lonA, latA, lonA);
        const dAB = calculateDistance(latA, lonA, latB, lonB);
        const dBA = calculateDistance(latB, lonB, latA, lonA);
        const dBC = calculateDistance(latB, lonB, latC, lonC);
        const dAC = calculateDistance(latA, lonA, latC, lonC);

        // Identity.
        expect(dAA, `d(a,a) expected 0, actual ${dAA}`).toBeCloseTo(0, 6);
        // Non-negativity.
        expect(dAB, `d(a,b) expected >= 0, actual ${dAB}`).toBeGreaterThanOrEqual(0);
        // Symmetry.
        expect(dAB, `symmetry: d(a,b) ${dAB} vs d(b,a) ${dBA}`).toBeCloseTo(dBA, 6);
        // Triangle inequality (small epsilon absorbs float error).
        expect(
          dAC <= dAB + dBC + 1e-6,
          `triangle: d(a,c) ${dAC} <= d(a,b) ${dAB} + d(b,c) ${dBC}`,
        ).toBe(true);
      },
    ),
    { numRuns: 100 },
  );
});
