# Changelog

[中文版](CHANGELOG.md)

## 0.3.1

### Added

- The settings page gains an **Unattended** switch (`unattended`, off by default) and a
  **Text sent automatically** field (`continueText`, default `继续`).
- With unattended mode on, when a turn ends because the model reached its single-response
  output token cap (`turn/end` with `reason.kind === 'max-tokens'`), the plugin sends
  `continueText` to the same session so the model carries on with the work it was doing.
- Auto-continue itself never swaps keys or modifies credentials; later requests still follow
  the configured rate-limit mode if they hit a limit again.
- With unattended mode off, DSH's built-in “output token limit reached” notice stays as before,
  and a small bar appears above the composer. **Fill continue** puts `continueText` into the
  draft and focuses the input; press Enter to send. The bar can also be dismissed.
- `/ratelimit-log` now reports the unattended state and logs `auto-continue` /
  `auto-continue-capped` events.

### Behaviour

- At most 20 consecutive auto-continues are allowed. Any turn that does not end in a
  truncation, or a gap of more than 30 minutes since the last auto-continue, resets the
  counter. When the cap is reached the plugin writes one `auto-continue-capped` entry and
  stops, so an abnormal loop cannot run forever.
- Only `max-tokens` endings trigger it; truncation reported under a different finish reason is
  left alone.

### Tests

- 67 tests, covering unattended on/off, a custom `continueText`, the 20-turn cap, the counter
  reset, and both banner states (shown, and filling the draft).

## 0.3.0

Verified against DeepSeek Harness 0.2.2-rc.3 (headless and web profiles in an isolated
`DSH_HOME`, against a mock OpenAI-compatible endpoint), including the settings page,
`/ratelimit-log`, and the countdown row.

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
  instead of failing every later request (benched for an hour, at most two keys of one
  reference per ten minutes; 403 is ignored). When that limit is hit the guard stops benching
  and puts the original key back, so a rejected key is not left installed.
- No rotation ever overwrites a key that is stored nowhere else: the first unknown key is
  saved to `<REF>_RLG_ORIGINAL`, a later one to `<REF>_RLG_PREVIOUS`. When both are taken, a
  backup or the target cannot be read, or the target changes while the rotation is running,
  the rotation is refused. Rotations of all targets run one at a time, and a target reference
  is never used as another target's pool key.
- Waits and cooldowns have a one-second floor (`minWaitSeconds`; the last wait of a step's
  total budget may be shorter), so millisecond hints do not become a burst of retries.
- Exhausted quota (`QUOTA`, `ACCOUNT_QUOTA`) is no longer waited out by default.
- Wait-hint parsing is stricter: status codes, dates and counts are no longer read as seconds
  (`please wait (429)`, `retry after 2026-11-18…`, `resets in 3 requests`), and
  `retry_after_ms` fields are read as milliseconds.

### Added

- Chinese and compound-duration hints (`请在 30 秒后重试`, `请等待 30 秒`, `1m30s`), plus
  `retry in 34.5s`, `retryDelay: "34s"`, `resets after 20s`, `try again after 20s`, and
  gateway messages such as `holding sends until 2026-11-18T11:11:52Z (~9s, …)`.
- New options: `keepOriginalKey`, `quotaCooldownMinutes`, `waitOnQuota`, `jitter`,
  `maxTotalWaitMinutes`, `language`, `minWaitSeconds`.
- A per-step total wait budget (default 60 minutes; the old worst case was 12 × 15 minutes).
- `/ratelimit-log` shows which pool key each target holds and which keys are ready, cooling
  or rejected; log notes and the report are available in English.
- Reference-name validation in the host and on the settings page.
- `node:test` suites and CI.

## 0.2.1

Initial public source release.
