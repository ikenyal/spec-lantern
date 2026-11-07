# How the second Target_Repo was selected

The reference target (writing-tracker) could look cherry-picked, so the second
target was chosen by fixed criteria BEFORE any claim was verified.

## Criteria (decided before screening)
1. Public, built with Lovable (README starts with "Welcome to your Lovable project").
2. MIT license with a real copyright holder (not a copied third-party license).
3. Abandoned: no push for several months.
4. Logic Kiro can execute without a backend: pure functions or props-driven
   components (files that call Supabase directly are excluded as unverifiable).
5. Contains claim-like comments in logic code (hooks/lib/utils/components).

## Screening (2026-11-07)
- GitHub search: `"Welcome to your Lovable project" in:readme license:mit language:TypeScript pushed:<2026-05-01`
  (523 results; ~150 repos under 20 MB screened by a grep for claim-like comments).
- Excluded examples: crypto trading bots (domain), repos whose LICENSE belongs to a
  different project, repos where the logic lives behind Supabase calls, repos without a license.

## Selected
- gargi04sahu/MoodPlays @ 4b4152f (last commit 2026-02-11), MIT © 2026 Gargi Sahu.
- Reason: `src/utils/openingHoursParser.ts` is a pure function used by the
  `PlaceCard` component, with several claims about time formats and midnight.
- Selection was based on testability, not on any suspected bug: no claim was
  executed or verified before Kiro's predictions were locked.
