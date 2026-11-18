# Changelog

## 0.3.1

### Added
- Settings switch **无人值守 / Unattended**: when a turn ends because the model hit its output
  token cap (`turn/end` with `reason.kind === 'max-tokens'`), the plugin sends the configured
  continue message (`continueText`, default `继续`) to the same session, so a long answer
  resumes without user interaction. Consecutive auto-continues are capped at 20 and reset by
  any completed turn or after 30 minutes; the cap is logged once.
- With unattended mode off, a small bar above the composer offers **填入「继续」** (fills the
  draft and focuses the input) and dismiss; the built-in “output token limit reached” notice
  stays as before.
- `/ratelimit-log` now prints the unattended state and auto-continue events
  (`auto-continue`, `auto-continue-capped`).
- Tests for auto-continue on/off, custom text, the 20-turn cap, counter reset, and both
  banner states (67 tests total).

## 0.3.0

Verified against DeepSeek Harness 0.2.2-rc.3 (headless and web profiles in an isolated
`DSH_HOME`, mock OpenAI-compatible endpoint), including the settings page, `/ratelimit-log`
and the countdown row.

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
  instead of failing every later request (benched for an hour, at most two keys of a reference per ten minutes; 403 is ignored).
  When that limit is hit the guard stops benching and puts the original key back, so a
  rejected key is not left installed.
- No rotation ever overwrites a key that is stored nowhere else: the first unknown key is
  saved to `<REF>_RLG_ORIGINAL`, a later one to `<REF>_RLG_PREVIOUS`, and when both are
  taken, or a backup or the target cannot be read, or the target changed while the
  rotation was running, the rotation is refused. Rotations of all targets run one at a
  time, and a target reference is never used as another target's pool key.
- Waits and cooldowns have a one-second floor (`minWaitSeconds`; the last wait of a
  step's total budget may be shorter), so millisecond hints do
  not turn into a burst of retries.
- Exhausted quota (`QUOTA`, `ACCOUNT_QUOTA`) is no longer waited out by default.
- Wait hints: status codes, dates and counts are no longer read as seconds
  (`please wait (429)`, `retry after 2026-11-18…`, `resets in 3 requests`), and
  `retry_after_ms` fields are read as milliseconds.

### Added
- Wait hints in Chinese and compound durations (`请在 30 秒后重试`, `请等待 30 秒`, `1m30s`),
  plus `retry in 34.5s`, `retryDelay: "34s"`, `resets after 20s`, `try again after 20s`, and
  gateway messages such as `holding sends until 2026-11-18T11:11:52Z (~9s, …)`.
- Options: `keepOriginalKey`, `quotaCooldownMinutes`, `waitOnQuota`, `jitter`,
  `maxTotalWaitMinutes`, `language`, `minWaitSeconds`.
- A per-step total wait budget (default 60 minutes; the old worst case was 12 × 15 minutes).
- `/ratelimit-log` shows which pool key each target holds and which keys are ready, cooling
  or rejected; log notes and the report are available in English.
- Reference-name validation in the host and on the settings page.
- `node:test` suites and CI.

## 0.2.1

Initial public source.
