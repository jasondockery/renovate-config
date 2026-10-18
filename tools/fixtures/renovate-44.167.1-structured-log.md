# Renovate 44.167.1 structured-log fixture provenance

This sanitized fixture was source-verified on October 18, 2026 against
Renovate tag `44.167.1`, immutable commit
`2450b18011f95bee83e8fa0469e7bfd6986fffaa`.

The source review checked these logging boundaries at that exact commit:

- [`lib/workers/global/index.ts`](https://github.com/renovatebot/renovate/blob/2450b18011f95bee83e8fa0469e7bfd6986fffaa/lib/workers/global/index.ts) emits `Renovate started` through `logger.info`.
- [`lib/workers/repository/index.ts`](https://github.com/renovatebot/renovate/blob/2450b18011f95bee83e8fa0469e7bfd6986fffaa/lib/workers/repository/index.ts) emits `Repository started` through `logger.info`, and `Repository timing splits (milliseconds)` through `logger.debug`. Timing records therefore use level 20, while lifecycle records use level 30.
- [`lib/util/split.ts`](https://github.com/renovatebot/renovate/blob/2450b18011f95bee83e8fa0469e7bfd6986fffaa/lib/util/split.ts) returns `{ splits, total }` from `getSplits()`.
- [`lib/workers/repository/process/lookup/version-compatibility.ts`](https://github.com/renovatebot/renovate/blob/2450b18011f95bee83e8fa0469e7bfd6986fffaa/lib/workers/repository/process/lookup/version-compatibility.ts) retains the exact message-less `logger.debug({ update })` call in `restoreVersionCompatibility`, called by the lookup worker. The fixture keeps only the bounded update fields accepted by the parser; wrong levels, missing fields, and extra keys remain rejected.

The lifecycle order is carried forward from the earlier fixture. Numeric values
are deliberately synthetic; warning, error, and fatal records are sanitized
hostile scenarios. Lifecycle, timing, and hostile records explicitly identify
the accepted fixture runtime. The message-less record preserves its exact
source-confirmed shape, with provenance here rather than added log fields.

This fixture establishes source-shape agreement only. It does not establish a
live run, package-update eligibility, or consumer CI success. Fresh field proof
must identify a workflow run using this exact runtime; the earlier live
`44.166.0` run belongs to the previous pin.
