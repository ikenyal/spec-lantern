// Feature: spec-lantern, Property 10: each mood's categories include what its inline comment names, and lookup matches by id

// Correctness_Property for the MoodPlays Claim claim-mood-categories-lookup. It
// targets the pure lookup helpers + per-mood comments in
//   sandbox/moodplays/src/utils/moodMapper.ts
// e.g. L21 "categories: ['cafe', 'coffee_shop'], // Cafes for work",
//      L29 "// Restaurants, cafes, bars for dates",
//      L53 "// Chill cafes and bars".
//
// 1:1 mapping: this is the one and only property test file for
// claim-mood-categories-lookup.
//
// INDEPENDENT ORACLE (from the comment text, not the code). An earlier draft
// compared getCategoriesForMood(id) to getMoodConfig(id)?.categories — both are
// the SAME lookup, so the oracle was circular. This version builds the oracle
// from the ENGLISH of each mood's inline comment: the words a comment uses name
// category ids ("Cafes" -> cafe, "Restaurants" -> restaurant, "Bars" -> bar,
// "Fast food" -> fast_food), and the property asserts the mood's categories
// INCLUDE each named category. A comment that names no concrete category
// ("Budget-friendly places", and the vague "quick spots" / "party spots") gets
// NO category assertion. We deliberately do NOT transcribe the source arrays
// (that would copy the code); we assert a subset relationship derived purely
// from what the comment claims.
//
// The deterministic lookup contract is also checked independently:
// getMoodConfig(id).id === id for every configured mood, and an unknown mood id
// yields an empty category list (the documented `|| []` fallback).
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

/**
 * Oracle built from the INLINE COMMENT TEXT only (see moodMapper.ts):
 *   work        "Cafes for work"                 -> cafe
 *   date        "Restaurants, cafes, bars ..."   -> restaurant, cafe, bar
 *   quick_bite  "Fast food and quick spots"      -> fast_food
 *   budget      "Budget-friendly places"         -> (names no category)
 *   sad         "Chill cafes and bars"           -> cafe, bar
 *   fun         "Bars and party spots"           -> bar
 * Each listed category must be INCLUDED in the mood's configured categories.
 */
const COMMENT_NAMES: Record<MoodType, string[]> = {
  work: ["cafe"],
  date: ["restaurant", "cafe", "bar"],
  quick_bite: ["fast_food"],
  budget: [],
  sad: ["cafe", "bar"],
  fun: ["bar"],
};

test("each mood's categories include what its inline comment names, and lookup matches by id", () => {
  // Per configured mood: id match + comment-named categories are included.
  for (const mood of KNOWN_MOODS) {
    const config = getMoodConfig(mood);
    expect(config, `expected a config for "${mood}"`).toBeDefined();
    expect(
      config?.id,
      `expected config.id "${mood}", actual ${String(config?.id)}`,
    ).toBe(mood);

    const categories = getCategoriesForMood(mood);
    for (const named of COMMENT_NAMES[mood]) {
      expect(
        categories.includes(named),
        `mood "${mood}": comment names "${named}" but categories are [${categories.join(", ")}]`,
      ).toBe(true);
    }
  }

  // Unknown-mood fallback: an id not in the config list yields [], and
  // getMoodConfig returns undefined. (>=100 runs via random arbitrary ids.)
  fc.assert(
    fc.property(fc.string(), (arbitrary) => {
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
    }),
    { numRuns: 100 },
  );
});
