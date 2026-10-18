# Renovate 44.166.0 structured-log fixture provenance

This is a deliberate, sanitized fixture update for Renovate `44.166.0`. It
retains the lifecycle order carried forward from the `43.288.0` fixture, while
its runtime-specific record shapes were source-verified against Renovate tag
`44.166.0`, immutable commit
`6d36b403afeaaa7fe9d423c9c1c57c8aa13096a8`.

Both runtime-specific shapes were re-verified at that commit rather than assumed
to survive the major bump. `lib/workers/repository/index.ts` still logs
`Repository timing splits (milliseconds)` from the repository worker, emitting
the object returned by `getSplits()`; `lib/util/split.ts` still defines that
return as `{ splits, total }`. The message-less debug record is still the exact
`logger.debug({ update })` call in the version-compatibility path, called from
`lib/workers/repository/process/lookup/index.ts`, delegating to
`lib/workers/repository/process/lookup/version-compatibility.ts`; its
`restoreVersionCompatibility` function logs the unchanged message-less update
shape. The sanitized fixture
retains only the bounded update fields needed to distinguish that source record;
wrong levels, missing required fields, and extra top-level or update keys remain
rejected.

The numeric values here are deliberately synthetic, and this provenance makes no
claim of a live run on `44.166.0`. No managed-repository workflow has been
dispatched on this runtime, and the earlier `43.288.0` live runs describe a
different pin, so they are not evidence for this one. The next dispatched
workflow remains the authoritative field proof, and until it runs, this fixture
proves shape agreement with the pinned source and nothing more.

The warning, error, and fatal records are sanitized hostile scenarios. Every
record carries the exact accepted runtime so a fixture cannot be adopted for a
new pin by renaming files alone.
