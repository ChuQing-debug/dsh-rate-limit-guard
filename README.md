# dsh-rate-limit-guard

![version](https://img.shields.io/badge/version-0.3.0-blue)
![platform](https://img.shields.io/badge/DSH-0.2.2--rc.3%20tested-6f42c1)
![language](https://img.shields.io/badge/UI-中文%20%7C%20English-1f6feb)

A DeepSeek Harness (DSH) plugin that keeps an agent working through provider rate limits.
When a model request fails with a PRM/TPM style limit, the guard either **waits for the
window to refresh and resumes the same step**, or **rotates the provider credential to the
next key in a configured pool** — the choice is yours, switchable at runtime from a visual
settings page. Every interruption is reported with timestamps in the chat, in the plugin
log, and through a `/ratelimit-log` command.

<img src="icon.svg" alt="Rate limit guard icon" width="72" height="72">

---

## Features

- **Two recovery strategies**
  - **Wait** — a configurable timer (default 60 s), optionally overridden by the provider's
    `retry-after` hint or a delay parsed from the error message, then the same step is
    retried automatically with its context intact.
  - **Rotate key** — moves to the next key in the pool (round-robin), writes it into the
    provider's credential reference, and retries immediately. DSH resolves credentials per
    request, so the next attempt uses the new key without a restart.
    - The key that was in use before the first rotation is backed up to
      `<REF>_RLG_ORIGINAL` and stays in the rotation, so it is never lost.
    - A key that was just limited cools down (for the retry-after / hinted / default wait,
      or `quotaCooldownMinutes` for exhausted quota) and is skipped meanwhile; when every
      key is cooling, the guard waits for the first one to come back instead of hammering
      the pool with zero-delay retries.
    - Rotations of one reference are serialized, and a failure that arrives within 5 s of a
      rotation is retried once on the new key without rotating again, so concurrent
      sessions do not skip keys.
- **Guards the right failures** — `RATE_LIMIT`, `HTTP_429`, `QUOTA` and `ACCOUNT_QUOTA`
  (PRM/TPM limits and account/balance exhaustion). Exhausted quota (`QUOTA`,
  `ACCOUNT_QUOTA`) is never waited out by default, since waiting cannot refill a balance:
  rotate mode moves to another key, and otherwise the failure goes straight back to DSH.
- **Hint parsing in English and Chinese** — `retry after 30s`, `try again in 1m30s`,
  `resets in 6m0s`, `until 2026-11-18T11:11:52Z (~9s`, `请在 30 秒后重试`, `1分30秒后重试`; waits get up to 10 % (max 5 s)
  jitter so sessions limited together do not retry together.
- **Auto-resume, not auto-fail** — returns `retry` for the current step of the agent loop;
  no restart, no lost turn.
- **Bounded retries** — a per-step attempt cap (default 12) and a per-step total wait
  budget (default 60 minutes) hand control back to the default retry policy instead of
  looping or waiting forever.
- **Visible interruptions** — each wait appears in the conversation as a live countdown
  row (reusing DSH's durable `llm/retry` / `llm/retry-started` events), and each event is
  written to the plugin log with a local timestamp and the expected resume time.
- **Settings UI** — a bilingual page under **Settings → Rate Limit Guard** to choose the
  mode, tune timers, edit the key pool, restrict which providers are guarded, and inspect
  credential status (configured / missing, masked preview).
- **Self-contained** — ships its own vendored `schemastery`/`cosmokit` (MIT), so it needs
  no extra runtime dependencies in the profile.

## How it works

```
provider request
      │
      ▼
finish(error: RATE_LIMIT | HTTP_429 | QUOTA | ACCOUNT_QUOTA)
      │
      ▼
agent/request-error  ──►  rate-limit-guard (prepended listener)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
        wait mode                        rotate mode
   append llm/retry                 cool down the key that failed
   sleep (hint │ timer)             next pool key that is not cooling
   append llm/retry-started         credentials.set(target ref, value)
              │                      append llm/retry (delay 0)
              │                      (all cooling: wait for the first)
              └───────────────┬───────────────┘
                              ▼
                       return { kind: 'retry' }
                              │
                              ▼
                    agent loop retries the same step
```

The listener is registered with `prepend: true` on `agent/request-error`, so it decides
before DSH's built-in retry policy. For failures it does not own (non-limit codes, provider
outside the allowlist, attempt cap reached, rotation unavailable with fallback disabled) it
calls `next()` and behaves exactly like the stock policy.

The per-step budget is keyed by `session id : turn : step`, so the cap counts retries of
one step and resets for the next step or turn. Retrospective data (attempt counters, the
200-entry log ring) lives in process memory and is cleared when the plugin reloads.

## Requirements

- DeepSeek Harness desktop or `dsh web`, tested against **0.2.2-rc.3** (profile `desktop`).
- A provider configured through a **credential reference** (`apiKeyEnv`) for rotate mode.
  DSH does not tell plugins which reference a provider reads, so providers that read no
  API key must be excluded by hand with `provider=-` under **Provider mapping** (local
  models, fixed `Authorization` headers). `deepseek-account` is excluded automatically.
  An excluded provider falls back to waiting (or hands the failure back when
  `fallbackToWait` is off).
- Rotate mode needs the `credentials` service. It is on in the desktop and web profiles
  and **off by default in `headless`**; there the guard logs "the credentials service is
  unavailable" (or its Chinese equivalent, according to `language`) and waits instead, unless the profile enables it (`- id: credentials` / `disabled: false`).

## Installation

The plugin is a DSH **bundle**: a directory with `package.json`, a Cordis patch, a host
half (`index.js`) and a client half (`client.js`).

1. Clone or copy this directory to a permanent local path (keep it; DSH links the installed
   bundle to this directory, so deleting it breaks the plugin):

   ```bash
   git clone https://github.com/ChuQing-debug/dsh-rate-limit-guard.git
   ```

2. In DSH, open **Plugin Manager → Install bundle** and choose the absolute path of the
   cloned directory (for example `D:\plugins\dsh-rate-limit-guard`), or use the
   `plugin_manager` tool with action `install_bundle` and that path as `target`.
   The bundle patch inserts one entry:

   ```yaml
   - insert:
       - id: rate-limit-guard
         name: dsh-rate-limit-guard
   ```

3. Restart the application (or reload the web client) once so the client module is picked
   up, then enable the plugin if it is not enabled yet.

4. Open **Settings → Rate Limit Guard** to configure it. If you later edit the source in
   place, reinstall/re-enable the bundle (or reload the host fiber) to apply host changes.

> Never hand-edit the profile's `cordis.patch.yml` or `package.json`; the profile is managed
> by the application and the bundle patch is composed at load time.

## Configuration

All fields are *volatile* settings, editable from the settings page and effective on the
next request. Values can also be supplied in the bundle's patch `config:` block.

| Key | Default | Description |
| --- | --- | --- |
| `mode` | `wait` | `wait` or `rotate`. |
| `waitSeconds` | `60` | Default wait when the provider gives no hint. |
| `useRetryAfter` | `true` | Prefer `providerRetryAfterMs`, then a delay parsed from the error message (e.g. `retry after 30s`), then `waitSeconds`. |
| `maxWaitSeconds` | `900` | Upper bound for any single wait. |
| `maxAttempts` | `12` | Per-step retry cap; after this the failure goes back to the default policy. |
| `maxTotalWaitMinutes` | `60` | Total time one step may spend waiting. The last wait is shortened to what is left; after that the failure goes back to the default policy (which may still retry a few times on its own). `0` disables the limit. |
| `language` | `auto` | Language of log notes and `/ratelimit-log`: `auto` (system locale), `zh` or `en`. |
| `minWaitSeconds` | `1` | Floor for any wait or key cooldown, so a hint like "try again in 6ms" cannot burn the retry budget. Not on the settings page. |
| `jitter` | `true` | Add up to 10 % (at most 5 s) to each wait. |
| `waitOnQuota` | `false` | Also wait on `QUOTA` / `ACCOUNT_QUOTA` (the previous behaviour). |
| `quotaCooldownMinutes` | `60` | How long a key that returned exhausted quota is skipped in rotate mode. |
| `credentialRef` | `DEEPSEEK_API_KEY` | The credential reference the provider reads and that rotation writes to. |
| `alternateKeyRefs` | `[]` | Credential references that form the key pool. Only reference names are stored here. |
| `providerRefs` | `[]` | Optional `provider=REFERENCE` lines for providers that read different references. `provider=-` marks a provider that has no key to rotate. |
| `keepOriginalKey` | `true` | Before the first rotation away from a key that is not in the pool, save it to `<REF>_RLG_ORIGINAL` and rotate through it too. Neither backup slot is ever overwritten: a later unknown key (for example one typed into the target afterwards) goes to `<REF>_RLG_PREVIOUS`, and if that is taken too the guard refuses to rotate (it waits instead) until the key is added to the pool or a slot is cleared. With this option off, rotation overwrites the target without a backup. |
| `fallbackToWait` | `true` | When rotation is impossible, wait instead of handing the failure back. |
| `guardedProviders` | `[]` | Allowlist of providers to guard; empty means all. |

### Setting up the key pool

The settings page never stores API key values in the plugin config. It shows the state of
each reference and writes new values through DSH's credentials service:

1. Set **Target credential reference** to what the provider actually reads, e.g.
   `DEEPSEEK_API_KEY` for the DeepSeek API-key route, or `SHUSHENG_API_KEY` / `SS_API_KEY`
   for the bundled `llm-pi-ai` providers.
2. Add one reference per line under **Alternate credential references**, for example
   `DEEPSEEK_KEY_BACKUP`.
3. In the key pool list, paste a value next to each reference and click save. Values are
   masked and never returned by the API; the badge shows *configured* or *missing*.
4. If providers map to different references, add lines like `shusheng=SHUSHENG_API_KEY`
   under **Provider mapping** so rotation targets the right one.
5. For every provider that does not read an API key, add `provider=-` there. Without it
   the guard would rotate the default reference on that provider's rate limits, which
   cannot help and needlessly cools the pool down.

Reference names must match `^[A-Za-z_][A-Za-z0-9_]*$`; the settings page refuses to save
other names and the host ignores them. Values come from the credentials
service (a stored value outranks the launch environment), so a rotation takes effect on the
very next request.

## Usage

- Choose **Wait** when you are limited by a rolling window and want to keep the same key.
- Choose **Rotate key** when you have several keys and want to continue immediately on a
  fresh quota.
- Watch the conversation: a waiting row shows the countdown, delay and failure details, and
  flips to "started" when the retry fires.
- Type `/ratelimit-log` in a session to print, in rotate mode, which pool reference each
  target currently holds and which keys are ready, cooling or rejected (names and times
  only, never key values), followed by the last 20 guard events (local time, action,
  provider, failure code, mode, retry number, delay and resume time). The report is in
  Chinese or English according to `language`.
- Host logs carry structured lines such as:

  ```
  rate-limit-guard waiting at=21:07:42 provider=shusheng code=RATE_LIMIT mode=wait retry=2 delay=3s resumeAt=21:07:45 using the wait found in the error message
  rate-limit-guard rotated at=21:09:10 provider=shusheng retry=1 key=SHUSHENG_API_KEY retrying at once with the value of SHUSHENG_KEY_BACKUP
  ```

## Limitations

- **Same provider only.** DSH's retry action reuses the step's provider/model; a plugin
  cannot switch providers mid-step. Rotate mode therefore changes *the key the current
  provider reads*, not the provider itself. Use a separate provider selection if you need
  cross-provider failover.
- **Keyless providers.** `deepseek-account` and providers mapped to `-` have no API key to
  rotate. In rotate mode the guard logs the reason and falls back to waiting (unless
  `fallbackToWait` is off). Other keyless providers are not detected automatically.
- **Retry-After headers may not arrive.** With DSH 0.2.2-rc.3 and an `openai-completions`
  provider, a `Retry-After: 2` response header did not reach the plugin (the failure had
  no `providerRetryAfterMs`); only a hint in the error message is honoured there, otherwise
  the default wait applies.
- **Rejected pool keys.** If the key a rotation just installed is rejected (`AUTH` / 401)
  within a minute, for the same provider, the guard benches it for an hour (in memory) and
  installs the next pool key; at most two keys of a reference per ten minutes, so a failure
  that follows every key cannot bench the pool. A late failure from a request that was
  still using the rejected key is retried on the replacement instead. 403 is not treated as a rejected key (it usually means
  the key may not use that model or region). Auth failures at any other time, or of a key
  the guard did not install, are left to DSH.
- **In-memory budget, cooldowns and log.** Attempt counters, key cooldowns and the 200-entry
  log ring are per process and reset when the plugin reloads or the app restarts. Key
  cooldowns store a SHA-256 fingerprint, never the key. The durable report is the
  `llm/retry` event in the session.
- **No live status on the settings page.** DSH fixes the host capabilities a client can call
  at build time, so a third-party plugin cannot feed its runtime state to its settings
  page. Key status is shown by `/ratelimit-log` instead.
- **Rotation is global.** The target reference is shared, so a rotation affects every
  session that reads it, which is also why rotations are serialized (across all targets).
  A reference that is some provider's target is never used as a pool key, even if it is
  listed under the alternates.
- **A retry is a new request.** Waiting keeps the conversation and generated context, but
  the failed attempt itself is not resumed mid-stream.
- **One wait at a time per step.** Aborting the session (or unloading the plugin) cancels a
  pending wait; the guard then returns control without starting new work.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Settings page says the config was not found | Plugin enabled in this profile? Restart the app and reopen Settings. |
| No wait happened | Is the provider covered by `guardedProviders`? Was the failure code one of `RATE_LIMIT`/`HTTP_429`/`QUOTA`/`ACCOUNT_QUOTA`? |
| No rotation happened | Are alternates configured with values different from the current one? Is the provider excluded (`provider=-`, `deepseek-account`)? Is the `credentials` service enabled in this profile? Are all keys cooling down (`/ratelimit-log` lists each key's state)? Does the log say the rotation was refused because the backup references are full or unreadable? |
| Want the original key back | It is stored in `<REF>_RLG_ORIGINAL`; it rejoins the rotation automatically, or copy it back on the settings page. |
| Save fails | Settings document is read-only, or someone edited it concurrently — click reload and save again. |
| `/ratelimit-log` is unknown | Host half not loaded; reinstall/re-enable the bundle. |

## Repository layout

```
dsh-rate-limit-guard/
├── package.json            # bundle + client manifest
├── cordis.patch.yml        # inserts the rate-limit-guard entry
├── index.js                # host: request-error listener, config, log, command
├── lib.js                  # pure helpers: hint parsing, delays, key selection
├── client.js               # settings page (React, no build step)
├── test/                   # node:test suites (host, helpers, settings page)
├── .github/workflows/      # CI: syntax check + tests
├── README.md
├── LICENSE                 # MIT
├── .gitignore
├── locale/
│   ├── zh.json             # localized title / description / detail doc
│   └── en.json
├── docs/
│   └── DETAIL.md           # in-app detail document (Chinese)
├── vendor/
│   ├── schemastery.mjs     # vendored MIT dependency
│   ├── cosmokit.js         # vendored MIT dependency
│   └── NOTICE.md           # upstream license notices
└── icon.svg
```

## Development

There is no build step: the client half is plain `window.__ModuleLoader__` JavaScript and
the host half is ESM executed by DSH.

```bash
npm run check   # node --check on every entry
npm test        # node:test, no dependencies
```

The suites stub only what the plugin touches (`ctx.on`, `ctx.inject`, `ctx.credentials`,
`agent.session.append`, `window.__ModuleLoader__`, a minimal React hooks runtime) and cover:

- wait mode, message hints, abort and unload, the per-step cap, quota hand-off;
- rotate mode: original-key backup, round-robin back to the original, cooldown skipping,
  waiting for the earliest key, the post-rotation grace retry, concurrent failures,
  invalid reference names;
- hint parsing (English, Chinese, compound durations), delay order, jitter bounds;
- the settings page: zh/en key parity, every rendered label present, reference validation
  on save, the new fields written.

## 中文说明

**限流守护**是一个 DeepSeek Harness 插件。当模型提供方返回 PRM/TPM 限额
（`RATE_LIMIT`、`HTTP_429`、`QUOTA`、`ACCOUNT_QUOTA`）时，它在默认重试策略之前接管，
按你在 **设置 → 限流守护** 中选择的方式恢复当前步骤：

- **智能等待**：优先使用服务端建议的 `retry-after`，其次从错误信息解析等待时长，否则
  使用你填写的秒数；到点后自动重试同一步骤，上下文不丢。
- **轮换密钥**：按顺序轮流使用密钥池中的密钥，通过凭据服务写入提供方正在读取的引用，
  然后立即重试。第一次换走原密钥前会把它备份到 `<引用>_RLG_ORIGINAL` 并让它参与轮换；
  刚被限流的密钥进入冷却，全部冷却时等待最早恢复的那个；并发会话不会重复轮换。

额度/余额耗尽（`QUOTA`、`ACCOUNT_QUOTA`）默认不等待：轮换模式换下一个密钥，否则直接
交回 DSH。等待时长可从中英文错误信息解析（如「请在 30 秒后重试」），并加入随机抖动。

页面上可以设置计时器、单次等待上限、每步骤重试上限、密钥池与提供方映射，并查看每个
引用的配置状态。对话中每次等待显示倒计时行；插件日志包含时间与恢复时间；输入
`/ratelimit-log` 查看最近事件。

**限制**：一次重试只能复用同一提供方，不能中途切换提供方；账号登录型提供方
（如 `deepseek-account`）没有可替换的 API Key，轮换会回退为等待。尝试次数、密钥冷却与
日志缓存在内存中（冷却只记录密钥指纹），插件重载后清空。不读取 API Key 的提供方
（本地模型、固定请求头）需要在「按提供方映射」里写成 `提供方=-`，否则轮换模式会对它
白白改写默认引用；轮换刚换上的密钥如果被服务端拒绝（401），会被暂停使用并换下
一个（仅 401，403 不算）。同一步骤累计等待超过 60 分钟（可配置）后不再等待；
`/ratelimit-log` 会显示各密钥的状态，日志语言可在设置页选择中文或英文。

原密钥备份在 `<引用>_RLG_ORIGINAL`，之后出现的未知密钥备份在 `<引用>_RLG_PREVIOUS`；两个
备份都不会被覆盖，都占用时插件拒绝轮换、改为等待，直到你清理其中一个或把新密钥加入
密钥池。无界面（headless）profile 默认不启用凭据服务，轮换不可用，会回退为等待。

安装：把仓库目录放在固定位置，在插件管理中选择该目录安装 bundle，重启应用后在设置页
配置。密钥只通过 DSH 凭据服务保存，设置页仅保存引用名称并显示掩码。

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md).

## License

The plugin code in this repository is released under the MIT License; see
[`LICENSE`](LICENSE). The vendored `schemastery` and `cosmokit` copies are MIT-licensed by
their upstream author; see [`vendor/NOTICE.md`](vendor/NOTICE.md) for the full notices.
