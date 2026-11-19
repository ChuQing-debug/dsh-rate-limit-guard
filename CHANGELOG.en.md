# Changelog

[中文版](CHANGELOG.md)

## Unreleased

### Fixed

- **The rotation pool only accepts manual references.** The old multi-select picker listed other
  providers' key references, which the host deliberately ignores so that two providers cannot
  overwrite the same credential, so ticking a key looked like it worked but never rotated. The
  picker now only chooses the **target**; the pool is a manual list of independent storage
  references (such as `DEEPSEEK_KEY_2`). A provider-owned reference typed into the pool is ignored,
  and `/ratelimit-log` explains why.
- **A cooling-pool wait no longer retries a key that is still cooling.** When the earliest recovery
  is later than `maxWaitSeconds`, the failure goes back to DSH immediately; if a completed wait still
  has no usable key, it also hands back instead of retrying unconditionally.
- The rotation log's `keyRef` now records the pool slot that was actually written, not the target.

### Tests

- 85 tests. Added regressions for ignored provider references, recovery beyond the single-wait cap,
  a wait that still has no usable key, and the rotation log field; the client selector tests now
  cover the manual pool list.

## 0.5.0

### Added

- **The key selector is now collapsible and grouped.** Both key lists in the rotation card became
  one grouped selector: providers are the groups, a click on a group title expands or collapses it,
  and clicking options in multi-select adds them to the rotation pool.
  - Selected keys are shown as tags at the top; the × on a tag removes just that key.
  - Every group has **Select group** and **Clear group**.
  - The search box filters by provider or reference name and opens the matching groups; with no
    match it reports "No key matches the search".
  - Options can be disabled: the current target key is shown in the pool as a disabled option.
  - The selector is an inline area of the page, so clicking outside it closes nothing.

### Changed

- **Only providers that really hold a key are listed.** The directory still comes from the official
  `llm.listConfigurableProviders` + `settings.describe` seams, but entries whose reference is not
  configured according to `credentials.describe` are filtered out; an empty result shows an empty
  state instead.

### Tests

- Six new selector cases (configured only, collapse/expand, search, select-all/clear, tag removal,
  disabled target), 83 tests in total.

## 0.4.0

### Added

- **Pick the rotation keys in the settings page.** The rotation card now reads the keys already
  configured on the desktop. References come from DSH's official provider directory
  (`llm.listConfigurableProviders`) and settings forms (`credentials.describe`), and each row
  shows the provider name, the reference name and a configured / not configured badge.
  - **Target key** is a radio list: pick a configured key and it becomes the reference the
    provider resolves and rotation writes into.
  - **Rotation pool** is a checkbox list: tick a key to add it, untick to remove it. The target
    key never appears in the pool, and ticking it cannot add it either.
  - **Refresh** re-reads the directory and the credential states, so adding a provider or
    changing a key does not require reopening the settings page.
  - The manual inputs stay below the lists: a reference the desktop does not expose (a
    hand-made `DEEPSEEK_KEY_2`, say) can still be typed, and manual text wins.
- **The host side now resolves the reference each provider reads.** For a provider without a
  hand-written mapping, the plugin uses that provider's `apiKeyEnv` from the official directory
  as the rotation target; an explicit `providerRefs` entry still wins, and `provider=-` still
  means “never rotate this provider”. The directory is cached for 30 seconds and failures fall
  back to the previous default reference.

### Changed

- Rotation-pool references are deduplicated and the target reference is dropped from the pool,
  so a stale entry in the profile can no longer turn the target key into a pool key.
- The `/ratelimit-log` mode line now says “N reference(s) in the pool”.

### Fixed

- Saving the settings page no longer writes the target reference into the rotation pool twice.

### Tests

- 77 tests: the key picker (enumeration, ticking writes the pool, choosing a target, fallback
  without the LLM service), host-side directory resolution (auto-detected reference, explicit
  mapping wins, `provider=-`, fallback when nothing is declared), and the `hasMapping` /
  `declaredKeyRef` helpers.

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
