# 更新日志

[English version](CHANGELOG.en.md)

## 0.3.1

### 新增

- 设置页新增「无人值守」开关（`unattended`，默认关闭）和「自动发送的内容」（`continueText`，默认「继续」）。
- 开启「无人值守」后，当一轮对话因为模型达到单次输出 token 上限而结束（`turn/end`，`reason.kind === 'max-tokens'`）时，插件会向同一会话自动发送 `continueText`，让模型接着刚才的工作继续写。
- 自动继续本身不会更换密钥，也不会修改凭据；后续请求如果再次触发限流，仍按当前的限额响应方式处理。
- 关闭「无人值守」时，DSH 自带的「已达到输出 token 上限」提示照旧；输入框上方还会多出一条提示条。点「填入“继续”」会把 `continueText` 放进输入框并聚焦，按回车即可发送；也可以直接关闭提示条。
- `/ratelimit-log` 增加无人值守状态，以及 `auto-continue`、`auto-continue-capped` 两类事件记录。

### 行为说明

- 连续自动继续最多 20 次；只要出现一次不是因截断结束的回合，或距离上次自动继续超过 30 分钟，计数就会重置。达到上限时写一条 `auto-continue-capped` 日志后停止，避免异常情况下无限循环。
- 只在 `max-tokens` 结束时触发；提供方以其他结束原因返回的截断不会介入。

### 测试

- 测试增至 67 项，覆盖自动继续的开启/关闭、自定义 `continueText`、20 次上限、计数重置，以及提示条的显示与填入两种状态。

## 0.3.0

在 DeepSeek Harness 0.2.2-rc.3 上验证（隔离的 `DSH_HOME` 中分别运行 headless 与 web profile，配合 mock 的 OpenAI 兼容端点），覆盖设置页、`/ratelimit-log` 和对话里的倒计时行。

### 修复

- 轮换模式不再覆盖并丢失原 Key：原 Key 先备份到 `<引用>_RLG_ORIGINAL`，之后继续参与轮换。
- Key 按轮询顺序使用，不再在前两个备用 Key 之间反复切换。
- 刚被限流的 Key 会进入冷却并被跳过；池中所有 Key 都被限流时，改为等待最早恢复的那个，而不是零延迟重试。
- 同一引用的轮换会串行执行，多个会话同时触发时不会跳号。
- 触发轮换的那一步不再在刚失败的 Key 上多花一次请求（3 个 Key 的池从 7 次尝试降到 3 次）。
- 不读取 API Key 的提供方不再参与轮换：`deepseek-account` 自动识别，其他提供方在映射中写 `provider=-`。
- 刚换上就被 401 拒绝的池内 Key 会被暂停并替换，而不是让后续每个请求都失败（暂停 1 小时，同一引用 10 分钟内最多暂停 2 个；403 不计入）。达到该上限时停止暂停并换回原 Key，避免把失效 Key 留在目标引用里。
- 轮换不会覆盖一个没有在别处保存的 Key：第一个未知 Key 存入 `<引用>_RLG_ORIGINAL`，之后的存入 `<引用>_RLG_PREVIOUS`；两个备份都已占用、备份或目标读取失败、或轮换过程中目标被改动时，拒绝本次轮换。所有目标的轮换串行执行，目标引用不会被当作另一个目标的池内 Key。
- 等待与冷却有 1 秒下限（`minWaitSeconds`；步骤累计等待预算的最后一次等待可以更短），避免毫秒级提示变成连续重试。
- 额度耗尽（`QUOTA`、`ACCOUNT_QUOTA`）默认不再空等。
- 等待提示解析更严格：状态码、日期和次数不再被当成秒数（如 `please wait (429)`、`retry after 2026-11-18…`、`resets in 3 requests`），`retry_after_ms` 按毫秒处理。

### 新增

- 支持中文和复合时长提示（`请在 30 秒后重试`、`请等待 30 秒`、`1m30s`），以及 `retry in 34.5s`、`retryDelay: "34s"`、`resets after 20s`、`try again after 20s` 和网关消息 `holding sends until 2026-11-18T11:11:52Z (~9s, …)`。
- 新配置项：`keepOriginalKey`、`quotaCooldownMinutes`、`waitOnQuota`、`jitter`、`maxTotalWaitMinutes`、`language`、`minWaitSeconds`。
- 每步骤累计等待预算（默认 60 分钟；此前最坏情况为 12 × 15 分钟）。
- `/ratelimit-log` 显示每个目标当前持有的池内 Key，以及各 Key 是可用、冷却还是已暂停；日志备注和报告支持英文。
- 主机端和设置页都会校验引用名格式。
- `node:test` 测试套件和 CI。

## 0.2.1

首个公开源码版本。
