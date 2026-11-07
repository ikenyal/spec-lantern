// Feature: spec-lantern, Property 10: getCategoriesForMood returns the mood's configured categories and getMoodConfig matches by id

// Correctness_Property for the MoodPlays Claim claim-mood-categories-lookup. It
// targets the pure lookup helpers in
//   sandbox/moodplays/src/utils/moodMapper.ts
// whose per-mood comments annotate each config's category list, e.g. L21
//   "categories: ['cafe', 'coffee_shop'], // Cafes for work" and L29
//   "// Restaurants, cafes, bars for dates".
//
// 1:1 mapping: this is the one and only property test file for
// claim-mood-categories-lookup. getMoodConfig, getCategoriesForMood, and
// moodConfigs are exported and pure, so the property calls them directly. For
// every configured mood it asserts getMoodConfig(id).id === id and
// getCategoriesForMood(id) equals that config's categories; for an unknown
// mood id it asserts the documented empty-array fallback (`|| []`). The
// SEMANTIC judgement in the comments (whether a cafe "is for work") is
// subjective and NOT asserted — only the deterministic lookup contract is.
//
// Note on the external taxonomy: whether each category string is a valid
// Foursquare category ID is recorded separately as the UNVERIFIABLE Claim
// claim-foursquare-category-ids (network-dependent, R3.6) and is NOT asserted
// here.
//
// kind: function. No clock is read; TZ pinned only for consistency.
// Terminates PASS or FAIL; >=100 runs.

import { expect, test } from "vitest";
import fc from "fast-check";

import {
  moodConfigs,
  getMoodConfig,
  getCategoriesForMood,
  type MoodType,
} from "@/utils/moodMapper";

process.env.TZ = "UTC";

const KNOWN_MOODS = moodConfigs.map((m) => m.id);

test("getCategoriesForMood returns the mood's configured categories and getMoodConfig matches by id", () => {
  fc.assert(
    fc.property(
      fc.record({
        // A configured mood id, plus an arbitrary string that may or may not be
        // a known mood (to exercise the unknown-mood fallback too).
        known: fc.constantFrom(...KNOWN_MOODS),
        arbitrary: fc.string(),
      }),
      ({ known, arbitrary }) => {
        // getMoodConfig finds the config whose id equals the requested mood.
        const config = getMoodConfig(known);
        expect(config, `expected a config for "${known}"`).toBeDefined();
        expect(
          config?.id,
          `expected config.id "${known}", actual ${String(config?.id)}`,
        ).toBe(known);

        // getCategoriesForMood returns exactly that config's categories.
        expect(
          getCategoriesForMood(known),
          `categories mismatch for "${known}"`,
        ).toEqual(config?.categories);

        // Unknown-mood fallback: an id not in the config list yields [].
        if (!KNOWN_MOODS.includes(arbitrary as MoodType)) {
          expect(
            getMoodConfig(arbitrary as MoodType),
            `expected undefined config for unknown "${arbitrary}"`,
          ).toBeUndefined();
          expect(
            getCategoriesForMood(arbitrary as MoodType),
            `expected [] for unknown "${arbitrary}"`,
          ).toEqual([]);
        }
      },
    ),
    { numRuns: 100 },
  );
});
