/**
 * Client half of the rate limit guard bundle: a Settings section that edits the
 * guard configuration (wait timer / key pool), stores API keys through the
 * credentials service, and explains the `/ratelimit-log` report.
 *
 * Loaded through the Web module table: React comes from `require('react')` and
 * every registration is owned by the plugin context.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rate-limit-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'rate-limit-guard-ui'
    const SETTINGS_NS = 'rate-limit-guard'

    const DICT = {
      zh: {
        nav: '限流守护',
        title: '限流守护',
        intro: '模型请求触发提供方的 PRM/TPM 限额时，在重试前等待窗口刷新，或切换到密钥池中的下一个密钥；恢复后会自动继续原来的工作。',
        loading: '正在读取配置…',
        readFailed: '读取配置失败',
        writeFailed: '保存配置失败',
        notFound: '尚未找到限流守护的配置，请确认插件已启用。',
        readonly: '当前配置文档不可写，修改无法保存。',
        retry: '重试',
        reload: '重新读取',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        modeTitle: '限额响应方式',
        modeDesc: '两种方式都在当前步骤内生效，不会重新开始整个回合。',
        modeWait: '智能等待',
        modeWaitDesc: '按计时器或服务端建议的时长暂停，窗口刷新后自动重试。',
        modeRotate: '轮换密钥',
        modeRotateDesc: '把提供方正在使用的密钥换成密钥池中的另一个，然后立即重试。',
        waitTitle: '等待与重试',
        waitDesc: '等待发生在当前步骤内，结束后自动继续，已生成的上下文不会丢失。',
        waitSeconds: '默认等待时长（秒）',
        waitSecondsHint: '没有服务端建议时使用；可在 1 秒到 1 天之间。',
        useRetryAfter: '优先使用服务端建议的等待时长',
        useRetryAfterHint: '读取响应中的 retry-after；缺失时回退到默认等待时长。',
        maxWaitSeconds: '单次等待上限（秒）',
        maxWaitSecondsHint: '超过上限的等待会截断到这个值，避免长时间停住。',
        jitter: '加入随机抖动',
        jitterHint: '在等待时长上随机增加最多 10%（不超过 5 秒），避免多个会话同时重试。',
        waitOnQuota: '额度耗尽时也等待',
        waitOnQuotaHint: '默认关闭：QUOTA / ACCOUNT_QUOTA 表示余额或额度用完，等待无法恢复，会直接交回默认处理。',
        maxAttempts: '每步骤最多重试次数',
        maxAttemptsHint: '达到上限后交回默认重试策略，避免无限等待。',
        keysTitle: '密钥池',
        keysDesc: '密钥值只写入凭据服务，本页保存的是引用名称。轮换会把备用密钥的值写入目标引用，下一个请求立即生效。',
        credentialRef: '目标密钥引用',
        credentialRefHint: '提供方实际读取的引用，例如 DEEPSEEK_API_KEY 或 SHUSHENG_API_KEY。',
        alternates: '备用密钥引用',
        alternatesHint: '每行一个。按顺序轮流使用，跳过正在冷却（刚被限流）的密钥。',
        keepOriginalKey: '轮换前备份原密钥',
        keepOriginalKeyHint: '第一次换走不在池中的密钥时，把它保存到 <目标引用>_RLG_ORIGINAL，并让它参与后续轮换，原密钥不会丢失。',
        quotaCooldownMinutes: '额度耗尽的密钥冷却（分钟）',
        quotaCooldownMinutesHint: 'QUOTA / ACCOUNT_QUOTA 的密钥在这段时间内不会再被选中。',
        invalidRefs: '引用名称只能包含字母、数字和下划线，且不能以数字开头',
        providerRefs: '按提供方映射（provider=引用）',
        providerRefsHint: '可选，每行一条，例如 deepseek-api-key=DEEPSEEK_API_KEY。未匹配的提供方使用目标密钥引用。',
        fallbackToWait: '没有可用备用密钥时改为等待',
        fallbackToWaitHint: '关闭后会把限流错误交回后续处理器，不再等待。',
        keysEmpty: '先在“目标密钥引用”里填写引用名称，再保存。',
        keyConfigured: '已配置',
        keyMissing: '未配置',
        keyPlaceholder: '粘贴密钥值（保存后不回显）',
        saveKey: '保存密钥',
        keySaved: '密钥已更新，下一个请求生效',
        keyEmpty: '密钥不能为空',
        keySaveFailed: '密钥保存失败',
        advancedTitle: '范围',
        advancedDesc: '默认守护所有提供方；可以只对列出的提供方生效。',
        guardedProviders: '只守护这些提供方',
        guardedProvidersHint: '逗号或换行分隔，留空表示全部。',
        logTitle: '中断记录',
        logDesc: '插件日志记录每次限流、等待、恢复和轮换的时间与原因；对话中也会出现带倒计时的重试行。',
        logHint: '在对话输入 /ratelimit-log 查看最近 20 条记录。',
      },
      en: {
        nav: 'Rate limit guard',
        title: 'Rate limit guard',
        intro: 'When a provider answers with a PRM/TPM rate limit, wait for the window to refresh or rotate to the next key in the pool. The interrupted step resumes automatically.',
        loading: 'Reading configuration…',
        readFailed: 'Could not read the configuration',
        writeFailed: 'Could not save the configuration',
        notFound: 'Rate limit guard settings were not found. Check that the plugin is enabled.',
        readonly: 'The configuration document is read-only; changes cannot be saved.',
        retry: 'Retry',
        reload: 'Reload',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        modeTitle: 'On a rate limit',
        modeDesc: 'Both modes act inside the current step, without restarting the turn.',
        modeWait: 'Wait',
        modeWaitDesc: 'Pause for the timer or the server hint, then retry when the window refreshes.',
        modeRotate: 'Rotate key',
        modeRotateDesc: 'Replace the key the provider is using with another pool key, then retry at once.',
        waitTitle: 'Wait and retry',
        waitDesc: 'The wait stays inside the current step and resumes with the generated context intact.',
        waitSeconds: 'Default wait (seconds)',
        waitSecondsHint: 'Used when the server sends no hint; 1 second to 1 day.',
        useRetryAfter: 'Prefer the server retry-after hint',
        useRetryAfterHint: 'Uses the response hint when present, otherwise the default wait.',
        maxWaitSeconds: 'Wait cap (seconds)',
        maxWaitSecondsHint: 'Longer waits are truncated to this value.',
        jitter: 'Add random jitter',
        jitterHint: 'Adds up to 10 % (at most 5 s) to each wait so sessions do not all retry at once.',
        waitOnQuota: 'Wait on exhausted quota too',
        waitOnQuotaHint: 'Off by default: QUOTA / ACCOUNT_QUOTA means the balance or quota is used up, so waiting cannot help and the failure is handed back.',
        maxAttempts: 'Retries per step',
        maxAttemptsHint: 'After this cap the ordinary retry policy takes over.',
        keysTitle: 'Key pool',
        keysDesc: 'Key values go to the credentials service only; this page stores reference names. Rotation writes a pool value into the target reference and the next request uses it.',
        credentialRef: 'Target credential reference',
        credentialRefHint: 'The reference the provider actually reads, e.g. DEEPSEEK_API_KEY or SHUSHENG_API_KEY.',
        alternates: 'Pool references',
        alternatesHint: 'One per line. Keys are used in turn; keys still cooling down after a limit are skipped.',
        keepOriginalKey: 'Back up the original key before rotating',
        keepOriginalKeyHint: 'The first time a key outside the pool is rotated away, it is saved to <target>_RLG_ORIGINAL and joins the rotation, so it is never lost.',
        quotaCooldownMinutes: 'Cooldown for exhausted keys (minutes)',
        quotaCooldownMinutesHint: 'A key that returned QUOTA / ACCOUNT_QUOTA is not picked again for this long.',
        invalidRefs: 'Reference names may only contain letters, digits and underscores, and must not start with a digit',
        providerRefs: 'Provider mapping (provider=ref)',
        providerRefsHint: 'Optional, one per line, e.g. deepseek-api-key=DEEPSEEK_API_KEY. Unmatched providers use the target reference.',
        fallbackToWait: 'Wait when no pool key is usable',
        fallbackToWaitHint: 'Turn this off to hand the failure back to later handlers instead of waiting.',
        keysEmpty: 'Enter a target credential reference first.',
        keyConfigured: 'configured',
        keyMissing: 'missing',
        keyPlaceholder: 'Paste the key (never shown again)',
        saveKey: 'Save key',
        keySaved: 'Key updated; the next request uses it',
        keyEmpty: 'The key cannot be empty',
        keySaveFailed: 'Could not save the key',
        advancedTitle: 'Scope',
        advancedDesc: 'All providers are guarded by default; restrict the list if needed.',
        guardedProviders: 'Guard only these providers',
        guardedProvidersHint: 'Comma or newline separated; empty means all.',
        logTitle: 'Interruption log',
        logDesc: 'The plugin log records each rate limit, wait, resume and rotation with timestamps. Chat also shows a countdown retry row.',
        logHint: 'Run /ratelimit-log in the conversation to see the last 20 entries.',
      },
    }

    const CSS = `
.rlg-page { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 860px; padding: 4px 0 40px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.rlg-hero { display: flex; flex-direction: column; gap: 6px; padding: 0 2px 4px; }
.rlg-title { margin: 0; font-size: 17px; font-weight: 600; }
.rlg-intro { margin: 0; color: var(--dsw-alias-label-secondary); line-height: 1.7; font-size: 12.5px; }
.rlg-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.rlg-card-head { padding: 14px 18px 0; }
.rlg-card-title { margin: 0; font-size: 13.5px; font-weight: 600; }
.rlg-card-desc { margin: 6px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.65; }
.rlg-card-body { display: flex; flex-direction: column; gap: 14px; padding: 14px 18px 18px; }
.rlg-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.rlg-row-label { max-width: 54%; }
.rlg-label { font-size: 12.5px; font-weight: 500; }
.rlg-hint { margin-top: 4px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 1.55; }
.rlg-row-control { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.rlg-seg { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.rlg-seg-item { display: flex; flex-direction: column; gap: 4px; padding: 11px 13px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 11px; background: var(--dsw-alias-bg-layer-2); color: inherit; text-align: left; cursor: pointer; transition: border-color .15s, background .15s; }
.rlg-seg-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.rlg-seg-item.is-active { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-3); box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.rlg-seg-item:disabled { cursor: default; opacity: .6; }
.rlg-seg-title { font-size: 13px; font-weight: 600; }
.rlg-seg-desc { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.55; }
.rlg-input, .rlg-textarea { box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12.5px; outline: none; transition: border-color .15s, box-shadow .15s; }
.rlg-input { height: 30px; min-width: 220px; padding: 0 10px; }
.rlg-input-num { min-width: 96px; width: 110px; }
.rlg-input:focus, .rlg-textarea:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.rlg-input:disabled, .rlg-textarea:disabled { opacity: .6; }
.rlg-textarea { width: min(440px, 100%); min-width: 300px; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.6; resize: vertical; }
.rlg-check { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; cursor: pointer; user-select: none; }
.rlg-check input { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.rlg-keys { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.rlg-key { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.rlg-key-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.rlg-ref { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; padding: 2px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-3); }
.rlg-badge { padding: 1px 8px; border-radius: 999px; font-size: 10.5px; line-height: 1.7; }
.rlg-badge.is-ok { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.rlg-badge.is-missing { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.rlg-masked { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.rlg-key-form { display: flex; flex-wrap: wrap; gap: 8px; }
.rlg-key-form .rlg-input { flex: 1 1 220px; }
.rlg-button { display: inline-flex; align-items: center; justify-content: center; height: 30px; padding: 0 13px; border: 1px solid transparent; border-radius: 9px; font-size: 12.5px; cursor: pointer; transition: background .15s, border-color .15s, opacity .15s; }
.rlg-button:disabled { cursor: default; opacity: .55; }
.rlg-button-primary { background: var(--dsw-alias-brand-primary); color: #fff; }
.rlg-button-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); filter: brightness(1.06); }
.rlg-button-secondary { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.rlg-button-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.rlg-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 2px 2px 0; }
.rlg-spacer { flex: 1; }
.rlg-notice { font-size: 12px; }
.rlg-notice.is-ok { color: var(--dsw-alias-state-success-primary); }
.rlg-notice.is-error { color: var(--dsw-alias-state-error-primary); }
.rlg-notice.is-busy { color: var(--dsw-alias-label-secondary); }
.rlg-banner { padding: 10px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; background: var(--dsw-alias-bg-layer-2); }
.rlg-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 16px 2px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.rlg-error { color: var(--dsw-alias-state-error-primary); }
`

    function splitList(text) {
      if (typeof text !== 'string') return []
      const seen = new Set()
      const out = []
      for (const piece of text.split(/[\n,]+/)) {
        const value = piece.trim()
        if (value === '' || seen.has(value)) continue
        seen.add(value)
        out.push(value)
      }
      return out
    }

    const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

    function invalidRefsOf(draft) {
      const refs = [String(draft.credentialRef ?? '').trim(), ...splitList(draft.alternateKeyRefs)]
      for (const mapping of splitList(draft.providerRefs)) {
        const separator = mapping.indexOf('=')
        refs.push(separator > 0 ? mapping.slice(separator + 1).trim() : mapping)
      }
      return refs.filter((ref) => ref !== '' && !REF_PATTERN.test(ref))
    }

    function refsOf(value) {
      if (!value) return []
      const out = []
      const push = (ref) => {
        if (typeof ref === 'string' && ref.trim() !== '' && !out.includes(ref.trim())) out.push(ref.trim())
      }
      push(value.credentialRef)
      if (value.keepOriginalKey && typeof value.credentialRef === 'string' && value.credentialRef.trim() !== '') {
        push(`${value.credentialRef.trim()}_RLG_ORIGINAL`)
      }
      for (const ref of splitList(value.alternateKeyRefs)) push(ref)
      for (const mapping of splitList(value.providerRefs)) {
        const separator = mapping.indexOf('=')
        if (separator > 0) push(mapping.slice(separator + 1))
      }
      return out
    }

    function draftFrom(value) {
      const v = value ?? {}
      return {
        mode: v.mode === 'rotate' ? 'rotate' : 'wait',
        waitSeconds: String(v.waitSeconds ?? 60),
        useRetryAfter: v.useRetryAfter !== false,
        maxWaitSeconds: String(v.maxWaitSeconds ?? 900),
        maxAttempts: String(v.maxAttempts ?? 12),
        credentialRef: String(v.credentialRef ?? 'DEEPSEEK_API_KEY'),
        alternateKeyRefs: Array.isArray(v.alternateKeyRefs) ? v.alternateKeyRefs.join('\n') : '',
        providerRefs: Array.isArray(v.providerRefs) ? v.providerRefs.join('\n') : '',
        fallbackToWait: v.fallbackToWait !== false,
        jitter: v.jitter !== false,
        waitOnQuota: v.waitOnQuota === true,
        quotaCooldownMinutes: String(v.quotaCooldownMinutes ?? 60),
        keepOriginalKey: v.keepOriginalKey !== false,
        guardedProviders: Array.isArray(v.guardedProviders) ? v.guardedProviders.join(', ') : '',
      }
    }

    function numberOr(value, fallback, min, max) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return fallback
      return Math.min(Math.max(Math.round(parsed), min), max)
    }

    function buildOps(draft) {
      return [
        { op: 'set', path: ['mode'], value: draft.mode },
        { op: 'set', path: ['waitSeconds'], value: numberOr(draft.waitSeconds, 60, 1, 86400) },
        { op: 'set', path: ['useRetryAfter'], value: draft.useRetryAfter === true },
        { op: 'set', path: ['maxWaitSeconds'], value: numberOr(draft.maxWaitSeconds, 900, 1, 86400) },
        { op: 'set', path: ['maxAttempts'], value: numberOr(draft.maxAttempts, 12, 1, 100) },
        { op: 'set', path: ['credentialRef'], value: String(draft.credentialRef ?? '').trim() || 'DEEPSEEK_API_KEY' },
        { op: 'set', path: ['alternateKeyRefs'], value: splitList(draft.alternateKeyRefs) },
        { op: 'set', path: ['providerRefs'], value: splitList(draft.providerRefs) },
        { op: 'set', path: ['fallbackToWait'], value: draft.fallbackToWait === true },
        { op: 'set', path: ['jitter'], value: draft.jitter === true },
        { op: 'set', path: ['waitOnQuota'], value: draft.waitOnQuota === true },
        { op: 'set', path: ['quotaCooldownMinutes'], value: numberOr(draft.quotaCooldownMinutes, 60, 1, 10080) },
        { op: 'set', path: ['keepOriginalKey'], value: draft.keepOriginalKey === true },
        { op: 'set', path: ['guardedProviders'], value: splitList(draft.guardedProviders) },
      ]
    }

    function createApi(ctx) {
      const read = async () => {
        const response = await ctx.remote.settings.describe()
        if (!response.ok) throw new Error(response.error?.message ?? 'settings/read-failed')
        const view = response.value.namespaces.find((candidate) => candidate.ns === SETTINGS_NS)
        return { view, writable: response.value.writable }
      }
      return {
        read,
        async write(ops) {
          let lastError = null
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const { view } = await read()
            if (!view) return { ok: false, error: 'settings/namespace-missing' }
            const response = await ctx.remote.settings.mutate(SETTINGS_NS, ops, view.revision)
            if (response.ok) return { ok: true }
            if (response.error?.code !== 'settings/conflict') {
              return { ok: false, error: response.error?.message ?? 'settings/rejected' }
            }
            lastError = response.error
          }
          return { ok: false, error: lastError?.message ?? 'settings/conflict' }
        },
        async describeCredentials(refs) {
          const unique = [...new Set(refs)].slice(0, 64)
          if (unique.length === 0) return {}
          const response = await ctx.remote.credentials.describe(unique)
          return response.ok ? response.value : {}
        },
        async setCredential(ref, value) {
          const response = await ctx.remote.credentials.set(ref, value)
          return response.ok ? { ok: true } : { ok: false, error: response.error?.message ?? 'credentials/rejected' }
        },
      }
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'rlg-row' },
        h('div', { className: 'rlg-row-label' },
          h('div', { className: 'rlg-label' }, label),
          hint ? h('div', { className: 'rlg-hint' }, hint) : null),
        h('div', { className: 'rlg-row-control' }, children))
    }

    function Card({ title, desc, children }) {
      return h('section', { className: 'rlg-card' },
        h('header', { className: 'rlg-card-head' },
          h('h3', { className: 'rlg-card-title' }, title),
          desc ? h('p', { className: 'rlg-card-desc' }, desc) : null),
        h('div', { className: 'rlg-card-body' }, children))
    }

    function Check({ checked, disabled, onChange, label }) {
      return h('label', { className: 'rlg-check' },
        h('input', { type: 'checkbox', checked, disabled, onChange: (event) => onChange(event.target.checked) }),
        h('span', null, label))
    }

    function CredentialRow({ reference, info, t, draftValue, onChange, onSave, busy, disabled }) {
      const configured = info?.configured === true
      return h('div', { className: 'rlg-key' },
        h('div', { className: 'rlg-key-head' },
          h('code', { className: 'rlg-ref' }, reference),
          h('span', { className: `rlg-badge ${configured ? 'is-ok' : 'is-missing'}` },
            configured ? t('keyConfigured') : t('keyMissing')),
          info?.masked ? h('span', { className: 'rlg-masked' }, info.masked) : null),
        h('div', { className: 'rlg-key-form' },
          h('input', {
            className: 'rlg-input',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: t('keyPlaceholder'),
            value: draftValue ?? '',
            disabled: disabled,
            onChange: (event) => onChange(event.target.value),
          }),
          h('button', {
            className: 'rlg-button rlg-button-secondary',
            type: 'button',
            disabled: disabled || busy || String(draftValue ?? '').trim() === '',
            onClick: onSave,
          }, busy ? t('saving') : t('saveKey'))))
    }

    function Section({ api, t }) {
      const [state, setState] = React.useState({ status: 'loading' })
      const [draft, setDraft] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [credentials, setCredentials] = React.useState({})
      const [keyDraft, setKeyDraft] = React.useState({})
      const [busyKey, setBusyKey] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        setState({ status: 'loading' })
        try {
          const result = await api.read()
          if (!result.view) {
            setState({ status: 'missing' })
            return
          }
          const nextDraft = draftFrom(result.view.value)
          setDraft(nextDraft)
          setState({ status: 'ready', view: result.view, writable: result.writable })
          const refs = refsOf(nextDraft)
          if (refs.length > 0) setCredentials(await api.describeCredentials(refs))
        } catch (error) {
          setState({ status: 'error', message: String(error?.message ?? error) })
        }
      }, [api])

      React.useEffect(() => {
        load()
      }, [load])

      if (state.status === 'loading') {
        return h('div', { className: 'rlg-page' }, h('style', null, CSS),
          h('div', { className: 'rlg-empty' }, t('loading')))
      }
      if (state.status === 'error') {
        return h('div', { className: 'rlg-page' }, h('style', null, CSS),
          h('div', { className: 'rlg-empty' },
            h('span', { className: 'rlg-error' }, `${t('readFailed')}: ${state.message}`),
            h('button', { className: 'rlg-button rlg-button-secondary', type: 'button', onClick: load }, t('retry'))))
      }
      if (state.status === 'missing') {
        return h('div', { className: 'rlg-page' }, h('style', null, CSS),
          h('div', { className: 'rlg-empty' },
            h('span', null, t('notFound')),
            h('button', { className: 'rlg-button rlg-button-secondary', type: 'button', onClick: load }, t('retry'))))
      }

      const writable = state.writable === true && draft !== null
      const refs = refsOf(draft)
      const mode = draft.mode
      const update = (patch) => setDraft((current) => ({ ...current, ...patch }))

      const save = async () => {
        if (!writable) return
        const invalid = invalidRefsOf(draft)
        if (invalid.length > 0) {
          setNotice({ kind: 'error', text: `${t('invalidRefs')}: ${invalid.join(', ')}` })
          return
        }
        setBusy(true)
        setNotice({ kind: 'busy', text: t('saving') })
        try {
          const result = await api.write(buildOps(draft))
          if (result.ok) {
            setNotice({ kind: 'ok', text: t('saved') })
            await load()
          } else {
            setNotice({ kind: 'error', text: `${t('writeFailed')}: ${result.error}` })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('writeFailed')}: ${String(error?.message ?? error)}` })
        } finally {
          setBusy(false)
        }
      }

      const saveKey = async (reference) => {
        const value = String(keyDraft[reference] ?? '').trim()
        if (value === '') {
          setNotice({ kind: 'error', text: t('keyEmpty') })
          return
        }
        setBusyKey(reference)
        try {
          const result = await api.setCredential(reference, value)
          if (result.ok) {
            setKeyDraft((current) => ({ ...current, [reference]: '' }))
            setCredentials(await api.describeCredentials(refsOf(draft)))
            setNotice({ kind: 'ok', text: `${t('keySaved')}: ${reference}` })
          } else {
            setNotice({ kind: 'error', text: `${t('keySaveFailed')}: ${result.error}` })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('keySaveFailed')}: ${String(error?.message ?? error)}` })
        } finally {
          setBusyKey(null)
        }
      }

      const checkRow = (field) => h(Row, { label: t(field), hint: t(`${field}Hint`) },
        h(Check, {
          checked: draft[field],
          disabled: !writable,
          label: t(field),
          onChange: (checked) => update({ [field]: checked }),
        }))

      const numberInput = (field, min, max) => h('input', {
        className: 'rlg-input rlg-input-num',
        type: 'number',
        min,
        max,
        step: 1,
        value: draft[field],
        disabled: !writable,
        onChange: (event) => update({ [field]: event.target.value }),
      })

      return h('div', { className: 'rlg-page' },
        h('style', null, CSS),
        h('div', { className: 'rlg-hero' },
          h('h2', { className: 'rlg-title' }, t('title')),
          h('p', { className: 'rlg-intro' }, t('intro'))),
        !writable ? h('div', { className: 'rlg-banner' }, t('readonly')) : null,

        h(Card, { title: t('modeTitle'), desc: t('modeDesc') },
          h('div', { className: 'rlg-seg' },
            h('button', {
              type: 'button',
              className: `rlg-seg-item ${mode === 'wait' ? 'is-active' : ''}`,
              disabled: !writable,
              onClick: () => update({ mode: 'wait' }),
            },
              h('span', { className: 'rlg-seg-title' }, t('modeWait')),
              h('span', { className: 'rlg-seg-desc' }, t('modeWaitDesc'))),
            h('button', {
              type: 'button',
              className: `rlg-seg-item ${mode === 'rotate' ? 'is-active' : ''}`,
              disabled: !writable,
              onClick: () => update({ mode: 'rotate' }),
            },
              h('span', { className: 'rlg-seg-title' }, t('modeRotate')),
              h('span', { className: 'rlg-seg-desc' }, t('modeRotateDesc'))))),

        mode === 'wait' || draft.fallbackToWait ? h(Card, { title: t('waitTitle'), desc: t('waitDesc') },
          h(Row, { label: t('waitSeconds'), hint: t('waitSecondsHint') }, numberInput('waitSeconds', 1, 86400)),
          h(Row, { label: t('useRetryAfter'), hint: t('useRetryAfterHint') },
            h(Check, {
              checked: draft.useRetryAfter,
              disabled: !writable,
              label: t('useRetryAfter'),
              onChange: (checked) => update({ useRetryAfter: checked }),
            })),
          h(Row, { label: t('maxWaitSeconds'), hint: t('maxWaitSecondsHint') }, numberInput('maxWaitSeconds', 1, 86400)),
          checkRow('jitter'),
          checkRow('waitOnQuota')) : null,

        h(Card, { title: t('keysTitle'), desc: t('keysDesc') },
          h(Row, { label: t('credentialRef'), hint: t('credentialRefHint') },
            h('input', {
              className: 'rlg-input',
              type: 'text',
              spellCheck: false,
              value: draft.credentialRef,
              disabled: !writable,
              onChange: (event) => update({ credentialRef: event.target.value }),
            })),
          h(Row, { label: t('alternates'), hint: t('alternatesHint') },
            h('textarea', {
              className: 'rlg-textarea',
              rows: 3,
              spellCheck: false,
              value: draft.alternateKeyRefs,
              disabled: !writable,
              onChange: (event) => update({ alternateKeyRefs: event.target.value }),
            })),
          h(Row, { label: t('providerRefs'), hint: t('providerRefsHint') },
            h('textarea', {
              className: 'rlg-textarea',
              rows: 2,
              spellCheck: false,
              value: draft.providerRefs,
              disabled: !writable,
              onChange: (event) => update({ providerRefs: event.target.value }),
            })),
          refs.length === 0 ? h('div', { className: 'rlg-hint' }, t('keysEmpty')) : null,
          refs.length > 0 ? h('div', { className: 'rlg-keys' }, refs.map((reference) => h(CredentialRow, {
            key: reference,
            reference,
            info: credentials[reference],
            t,
            draftValue: keyDraft[reference],
            onChange: (value) => setKeyDraft((current) => ({ ...current, [reference]: value })),
            onSave: () => saveKey(reference),
            busy: busyKey === reference,
            disabled: !writable || busyKey !== null,
          }))) : null,
          mode === 'rotate' ? checkRow('keepOriginalKey') : null,
          mode === 'rotate' ? h(Row, { label: t('quotaCooldownMinutes'), hint: t('quotaCooldownMinutesHint') },
            numberInput('quotaCooldownMinutes', 1, 10080)) : null,
          mode === 'rotate' ? h(Row, { label: t('fallbackToWait'), hint: t('fallbackToWaitHint') },
            h(Check, {
              checked: draft.fallbackToWait,
              disabled: !writable,
              label: t('fallbackToWait'),
              onChange: (checked) => update({ fallbackToWait: checked }),
            })) : null),

        h(Card, { title: t('advancedTitle'), desc: t('advancedDesc') },
          h(Row, { label: t('maxAttempts'), hint: t('maxAttemptsHint') }, numberInput('maxAttempts', 1, 100)),
          h(Row, { label: t('guardedProviders'), hint: t('guardedProvidersHint') },
            h('textarea', {
              className: 'rlg-textarea',
              rows: 2,
              spellCheck: false,
              value: draft.guardedProviders,
              disabled: !writable,
              onChange: (event) => update({ guardedProviders: event.target.value }),
            }))),

        h(Card, { title: t('logTitle'), desc: t('logDesc') },
          h('div', { className: 'rlg-hint' }, t('logHint'))),

        h('div', { className: 'rlg-footer' },
          h('button', {
            className: 'rlg-button rlg-button-primary',
            type: 'button',
            disabled: !writable || busy,
            onClick: save,
          }, busy ? t('saving') : t('save')),
          h('button', {
            className: 'rlg-button rlg-button-secondary',
            type: 'button',
            disabled: busy,
            onClick: load,
          }, t('reload')),
          h('span', { className: 'rlg-spacer' }),
          notice ? h('span', {
            className: `rlg-notice is-${notice.kind}`,
          }, notice.text) : null))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.settings', 'remote.credentials'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'rate-limit-guard: locale')
        const t = ctx.locale.bind(NS)
        const api = createApi(ctx)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'rate-limit-guard',
          order: 40,
          label: () => t('nav'),
          inject: () => ({ api, t }),
        }, Section))
      },
    }
  },
})
