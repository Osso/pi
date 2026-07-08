# Changelog

## [Unreleased]

### Fixed

- Fixed `Agent.continue()` to allow continuing transcripts whose last message is an assistant message.
- Fixed harness compaction summaries to omit assistant thinking content and avoid reasoning-mode summary requests.
- Fixed harness split-turn compaction to serialize summary requests so single-concurrency providers are not asked to run overlapping generations ([#5536](https://github.com/earendil-works/pi/issues/5536)).

## [0.80.3] - 2026-06-30

### Added

- Added `prepareNextTurnWithContext` for `Agent` users that need the next-turn loop context.

### Fixed

- Fixed oversized harness shell execution timeouts to fail with a clear validation error instead of being clamped to an immediate timeout ([#6181](https://github.com/earendil-works/pi/issues/6181)).
- Fixed `Agent.prepareNextTurn` to keep receiving the run abort signal instead of the next-turn context.
