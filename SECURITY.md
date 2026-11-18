# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x | ✅ |
| < 0.3 | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). Include:

- the affected version and DSH version,
- steps to reproduce or a minimal proof of concept,
- the impact you expect (for example: a key value leaking into logs).

You will get an acknowledgement within a few days. Please give us a chance to
ship a fix before any public disclosure.

## Handling credentials

- The plugin never stores API key values in its own config or log files.
  Keys live in DSH's credentials service; this plugin only stores reference
  names, and `/ratelimit-log` prints reference names plus timestamps.
- When reporting a problem, redact key values, tokens, account ids and
  provider URLs. Reference names such as `DEEPSEEK_API_KEY` are fine.
- Rotation writes to the reference the provider actually reads. Backups are
  kept under `<REF>_RLG_ORIGINAL` / `<REF>_RLG_PREVIOUS` inside the same
  credentials service, not on disk.

## Out of scope

Vulnerabilities in DeepSeek Harness itself, in model providers, or in
third-party packages belong to their respective projects. The vendored
`schemastery` and `cosmokit` copies are unmodified MIT builds; see
[`vendor/NOTICE.md`](vendor/NOTICE.md).
