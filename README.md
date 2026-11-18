# dsh-rate-limit-guard

![version](https://img.shields.io/badge/version-0.2.1-blue)
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
  - **Rotate key** — picks the first configured alternate credential whose value differs
    from the one currently in use, writes it into the provider's credential reference, and
    retries immediately. DSH resolves credentials per request, so the next attempt uses the
    new key without a restart.
- **Guards the right failures** — `RATE_LIMIT`, `HTTP_429`, `QUOTA` and `ACCOUNT_QUOTA`
  (PRM/TPM limits and account/balance exhaustion).
- **Auto-resume, not auto-fail** — returns `retry` for the current step of the agent loop;
  no restart, no lost turn.
- **Bounded retries** — a per-step attempt cap (default 12) hands control back to the
  default retry policy instead of looping forever.
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
   append llm/retry                 find a different configured
   sleep (retry-after │ timer)      credential in the pool
   append llm/retry-started         credentials.set(target ref, value)
              │                      append llm/retry (delay 0)
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
- A provider configured through a **credential reference** for rotate mode. Account-login
  providers (for example the desktop default `deepseek-account`) do not read a swappable
  API key; rotation logs "unable to rotate" and falls back to waiting (configurable).

## Installation

The plugin is a DSH **bundle**: a directory with `package.json`, a Cordis patch, a host
half (`index.js`) and a client half (`client.js`).

1. Clone or copy this directory to a permanent local path (keep it; DSH links the installed
   bundle to this directory, so deleting it breaks the plugin):

   ```bash
   git clone https://github.com/<you>/dsh-rate-limit-guard.git
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
| `credentialRef` | `DEEPSEEK_API_KEY` | The credential reference the provider reads and that rotation writes to. |
| `alternateKeyRefs` | `[]` | Credential references that form the key pool. Only reference names are stored here. |
| `providerRefs` | `[]` | Optional `provider=REFERENCE` lines for providers that read different references. |
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

Reference names must match `^[A-Za-z_][A-Za-z0-9_]*$`. Values come from the credentials
service (a stored value outranks the launch environment), so a rotation takes effect on the
very next request.

## Usage

- Choose **Wait** when you are limited by a rolling window and want to keep the same key.
- Choose **Rotate key** when you have several keys and want to continue immediately on a
  fresh quota.
- Watch the conversation: a waiting row shows the countdown, delay and failure details, and
  flips to "started" when the retry fires.
- Type `/ratelimit-log` in a session to print the last 20 guard events (local time, action,
  provider, failure code, mode, retry number, delay and resume time).
- Host logs carry structured lines such as:

  ```
  rate-limit-guard waiting at=21:07:42 provider=shusheng code=RATE_LIMIT mode=wait retry=2 delay=60s key=SHUSHENG_API_KEY resumeAt=21:08:42 note=使用默认等待时长
  ```

## Limitations

- **Same provider only.** DSH's retry action reuses the step's provider/model; a plugin
  cannot switch providers mid-step. Rotate mode therefore changes *the key the current
  provider reads*, not the provider itself. Use a separate provider selection if you need
  cross-provider failover.
- **Account-login providers** (`deepseek-account`, OAuth-style routes) have no API key to
  rotate. In rotate mode the guard logs the reason and falls back to waiting (unless
  `fallbackToWait` is off).
- **In-memory budget and log.** Attempt counters and the 200-entry log ring are per process
  and reset when the plugin reloads or the app restarts. The durable report is the
  `llm/retry` event in the session.
- **A retry is a new request.** Waiting keeps the conversation and generated context, but
  the failed attempt itself is not resumed mid-stream.
- **One wait at a time per step.** Aborting the session (or unloading the plugin) cancels a
  pending wait; the guard then returns control without starting new work.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Settings page says the config was not found | Plugin enabled in this profile? Restart the app and reopen Settings. |
| No wait happened | Is the provider covered by `guardedProviders`? Was the failure code one of `RATE_LIMIT`/`HTTP_429`/`QUOTA`/`ACCOUNT_QUOTA`? |
| No rotation happened | Are alternates configured with values different from the current one? Is the provider an account-login route? |
| Save fails | Settings document is read-only, or someone edited it concurrently — click reload and save again. |
| `/ratelimit-log` is unknown | Host half not loaded; reinstall/re-enable the bundle. |

## Repository layout

```
dsh-rate-limit-guard/
├── package.json            # bundle + client manifest
├── cordis.patch.yml        # inserts the rate-limit-guard entry
├── index.js                # host: request-error listener, config, log, command
├── client.js               # settings page (React, no build step)
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
node --check index.js
node --check client.js
```

Manual verification used a small mock harness that stubs `ctx.on`, `agent.session.append`,
`ctx.credentials`, and `ctx.inject`, then asserts:

- wait mode returns `{ kind: 'retry' }` after the expected delay and appends
  `llm/retry` followed by `llm/retry-started`;
- a `retry after 2s` message produces a 2000 ms delay;
- rotate mode writes the alternate value through `credentials.set` and retries with
  `delayMs: 0`;
- reaching `maxAttempts` calls `next()` once;
- `/ratelimit-log` renders the mode line and recent events.

The client registration was checked by stubbing `window.__ModuleLoader__` and the React
module: one locale registration, one `settings.section` registration (id
`rate-limit-guard`, order 40), and complete zh/en key coverage.

## 中文说明

**限流守护**是一个 DeepSeek Harness 插件。当模型提供方返回 PRM/TPM 限额
（`RATE_LIMIT`、`HTTP_429`、`QUOTA`、`ACCOUNT_QUOTA`）时，它在默认重试策略之前接管，
按你在 **设置 → 限流守护** 中选择的方式恢复当前步骤：

- **智能等待**：优先使用服务端建议的 `retry-after`，其次从错误信息解析等待时长，否则
  使用你填写的秒数；到点后自动重试同一步骤，上下文不丢。
- **轮换密钥**：从密钥池中选第一个「已配置且与当前值不同」的引用，通过凭据服务写入
  提供方正在读取的引用，然后立即重试；没有可用备用密钥时按配置回退为等待。

页面上可以设置计时器、单次等待上限、每步骤重试上限、密钥池与提供方映射，并查看每个
引用的配置状态。对话中每次等待显示倒计时行；插件日志包含时间与恢复时间；输入
`/ratelimit-log` 查看最近事件。

**限制**：一次重试只能复用同一提供方，不能中途切换提供方；账号登录型提供方
（如 `deepseek-account`）没有可替换的 API Key，轮换会回退为等待。尝试次数与日志缓存在
内存中，插件重载后清空。

安装：把仓库目录放在固定位置，在插件管理中选择该目录安装 bundle，重启应用后在设置页
配置。密钥只通过 DSH 凭据服务保存，设置页仅保存引用名称并显示掩码。

## License

The plugin code in this repository does not yet declare a license; add a `LICENSE` file
(such as MIT) before publishing if you want others to reuse it. The vendored
`schemastery` and `cosmokit` copies are MIT-licensed by their upstream author; see
[`vendor/NOTICE.md`](vendor/NOTICE.md) for the full notices.
