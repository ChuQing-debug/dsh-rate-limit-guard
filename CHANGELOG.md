# Changelog

## 0.3.0

Verified against DeepSeek Harness 0.2.2-rc.1 (headless profile, mock OpenAI-compatible endpoint).

### Fixed
- Rotate mode no longer overwrites and loses the original key: it is backed up to
  `<REF>_RLG_ORIGINAL` and stays in the rotation.
- Keys rotate round-robin; previously the first two alternates bounced back and forth.
- Keys that were just limited cool down and are skipped; a fully limited pool is waited out
  instead of retried with zero delay.
- Rotations of one reference are serialized, so concurrent sessions do not skip keys.
- The step that caused a rotation no longer spends an extra request on the key that just
  failed (a 3-key pool took 7 attempts to exhaust, now 3).
- Providers without an API key are not rotated: `deepseek-account` automatically, others
  with `provider=-` under Provider mapping.
- A pool key rejected right after it was installed (`AUTH` / 401) is benched and replaced
  instead of failing every later request (at most two keys per rotation; 403 is ignored).
- The first backed-up key is never overwritten; a later unknown key is saved to
  `<REF>_RLG_PREVIOUS`. A target reference that cannot be read is not overwritten.
- Waits and cooldowns have a one-second floor (`minWaitSeconds`), so millisecond hints do
  not turn into a burst of retries.
- Exhausted quota (`QUOTA`, `ACCOUNT_QUOTA`) is no longer waited out by default.
- Wait hints: status codes, dates and counts are no longer read as seconds
  (`please wait (429)`, `retry after 2026-11-18…`, `resets in 3 requests`), and
  `retry_after_ms` fields are read as milliseconds.

### Added
- Wait hints in Chinese and compound durations (`请在 30 秒后重试`, `请等待 30 秒`, `1m30s`),
  plus `retry in 34.5s`, `retryDelay: "34s"`, `resets after 20s`.
- Options: `keepOriginalKey`, `quotaCooldownMinutes`, `waitOnQuota`, `jitter`.
- Reference-name validation in the host and on the settings page.
- `node:test` suites and CI.

## 0.2.1

Initial public source.
