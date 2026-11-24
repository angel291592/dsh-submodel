window.__ModuleLoader__.load({
  id: 'dsh-submodel',
  factory(require) {
    const { createElement: element, useEffect, useId, useRef, useState, useSyncExternalStore } = require('react');
    const namespace = 'submodel.settings';
    const dictionaries = {
      en: {
        title: 'Delegation settings', loading: 'Loading settings…', unavailable: 'Settings are unavailable in this profile.',
        readOnly: 'These settings are read-only.', loadFailed: 'Could not load settings.', retry: 'Try again',
        reconnect: 'Connection changed. Reload the page before editing again. Your draft was not sent to the new connection.',
        reload: 'Reload page', saving: 'Saving…', saved: 'Saved. New conversations will use these settings.',
        pending: 'Unsaved changes', saveFailed: 'Could not save settings. Try again.', transport: 'Connection lost. Please try again.',
        conflict: 'Settings changed elsewhere. Reload the saved settings and review your changes before saving.',
        retain: 'Load saved settings and review draft', review: 'Saved settings reloaded. Review the draft before saving again.',
        reviewOverlap: 'The same settings changed elsewhere. Saving will replace those changes with the draft shown here.',
        noChanges: 'The latest settings already match your draft.',
        discard: 'Discard draft', save: 'Save settings',
        authorization: 'Allow models separately under Plugins → Subagent. Authorization applies to new conversations.',
        notAuthorized: 'Authorization needed', unavailableModel: 'Saved choice (currently unavailable)',
        directoryLoading: 'Loading available models…', directoryFailed: 'Some models could not be loaded.',
        noModels: 'There are no available models.', retryCatalog: 'Reload model list',
        models: 'Delegation models', orderHelp: 'Put your usual choice first. The main model sees this order and your notes, and can choose a different starting model for the task.',
        executors: 'Cost-effective models', experts: 'Expert models',
        executorHelp: 'For routine work such as reading files and checking results.', expertHelp: 'For difficult decisions and problems that need stronger reasoning.',
        chooseModel: 'Choose a model', addExecutor: 'Add a cost-effective model', addExpert: 'Add an expert model',
        noChoices: 'No models in this group yet.', note: 'Use for', noteExample: 'For example, coding first',
        effort: 'Reasoning effort', defaultEffort: 'Model default', previousEffort: 'Saved effort (currently unavailable)',
        remove: 'Remove', up: 'Move up', down: 'Move down', items: 'Selected models',
        legacyLists: 'Saving a group replaces the old backup lists with the order shown here. Review both groups before saving.',
        watchdog: 'Usage reminders', usageHelp: 'Usage is what the model reports in tokens, the units it uses to count text. A single request can go over this amount.',
        mode: 'When to act', off: 'Off', notify: 'Remind the subagent to finish', stop: 'Remind, then prompt me to stop it',
        retryMode: 'Try the next model after failure', manualStop: 'If the task is still running after the wait, use the Subagent panel to stop it.',
        retryHelp: 'After the current model exhausts its retries (five by default), eligible tasks try the next model in the same group if it is authorized. A different provider may charge for the new attempt.',
        legacyRetryHelp: 'Your saved backup lists still apply until you save the new group order.',
        tiers: 'Apply to', executorTier: 'Cost-effective models', expertTier: 'Expert models',
        warnTokens: 'Remind me at this usage (tokens)', graceSeconds: 'Wait after the reminder (seconds)', maxRetries: 'Maximum number of model switches',
      },
      zh: {
        title: '派活设置', loading: '正在加载设置', unavailable: '当前配置环境没有可用的设置页。',
        readOnly: '当前配置只读', loadFailed: '无法加载设置。', retry: '重试',
        reconnect: '连接已更换。请重新加载页面后再编辑；旧草稿不会发往新连接。',
        reload: '重新加载页面', saving: '正在保存…', saved: '已保存。新会话使用此配置',
        pending: '有未保存的修改', saveFailed: '保存失败。请重试', transport: '连接失败。请重试。',
        conflict: '设置已在别处更新。请重新加载后确认修改',
        retain: '读取最新设置并核对草稿', review: '已读到最新设置。请核对草稿后再保存。',
        reviewOverlap: '你编辑的设置在别处也改过。保存会用当前草稿覆盖这部分修改。',
        noChanges: '最新设置已和草稿一致。',
        discard: '放弃草稿', save: '保存设置',
        authorization: '请在插件里的「子代理」设置允许模型。授权对新会话生效。',
        notAuthorized: '需另行授权', unavailableModel: '已保存的选择（当前不可用）',
        directoryLoading: '正在加载模型列表…', directoryFailed: '部分模型暂时无法加载',
        noModels: '暂无可选模型。', retryCatalog: '重试加载模型',
        models: '派活模型', orderHelp: '常用模型排在第一位。主模型会看到顺序和备注，也可以按任务选择从哪一位开始。',
        executors: '性价比模型', experts: '专家模型',
        executorHelp: '适合查资料、读文件和验证结果等日常任务。', expertHelp: '适合棘手的判断和需要更强推理的任务。',
        chooseModel: '选择模型', addExecutor: '添加性价比模型', addExpert: '添加专家模型',
        noChoices: '这组还没有模型。', note: '用途备注', noteExample: '例如：代码优先',
        effort: '默认推理强度', defaultEffort: '模型默认', previousEffort: '已保存档位（当前不可用）',
        remove: '移除', up: '上移', down: '下移', items: '已选模型',
        legacyLists: '保存两组模型后，会按这里的顺序接着试。想保留的旧备选，请先加到对应组里。',
        watchdog: '用量提醒', usageHelp: '词元是模型计算文字用量的单位，以模型报告为准。单次请求可能超过提醒值。',
        mode: '什么时候处理', off: '关闭', notify: '提醒子代理收尾', stop: '提醒后还在运行，就提示我停止',
        retryMode: '失败后尝试下一位模型', manualStop: '等候时间到了如果任务还在运行，可以在「子代理」面板停止。',
        retryHelp: '原模型用完重试次数（默认 5 次）后，满足用量等条件的任务会尝试同组下一位。下一位须已授权。换到其他渠道可能产生费用。',
        legacyRetryHelp: '保存新的分组顺序之前，仍按已保存的旧备选设置处理。',
        tiers: '应用于', executorTier: '性价比模型', expertTier: '专家模型',
        warnTokens: '用量达到多少时提醒（词元）', graceSeconds: '提醒后再等（秒）', maxRetries: '最多换几次模型',
      },
    };
    const style = `
      .submodel-settings {color:var(--dsw-alias-label-primary);min-width:0;font:inherit;font-size:14px;line-height:1.5}
      .submodel-settings [hidden] {display:none}
      .submodel-settings h3,.submodel-settings h4,.submodel-settings p {margin:0;overflow-wrap:anywhere}
      .submodel-settings h3 {font-size:18px;font-weight:600}
      .submodel-settings h4,.submodel-settings legend {font-size:14px;font-weight:600}
      .submodel-settings form,.submodel-section,.submodel-models,.submodel-field {display:grid;gap:8px;min-width:0}
      .submodel-settings form {gap:24px;margin-top:12px}
      .submodel-section {padding-block-start:16px;border-block-start:1px solid var(--dsw-alias-border-l1)}
      .submodel-settings fieldset {margin:0;padding:0;border:0;min-width:0}
      .submodel-field {margin-block:4px}
      .submodel-settings label,.submodel-model-name {font-weight:500}
      .submodel-muted {color:var(--dsw-alias-label-secondary);font-size:13px}
      .submodel-settings :is(select,input[type=number],input[type=text],button) {box-sizing:border-box;min-height:40px;max-width:100%;text-align:start;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:inherit;font:inherit;padding:4px 12px}
      .submodel-settings :is(select,input[type=number],input[type=text]) {width:min(100%,420px)}
      .submodel-settings input[type=number] {font-variant-numeric:tabular-nums}
      .submodel-settings button {cursor:pointer}
      .submodel-settings button:not(:disabled):hover {background:var(--dsw-alias-interactive-bg-hover)}
      .submodel-settings :is(input,select,button):focus-visible {outline:2px solid currentColor;outline-offset:2px}
      .submodel-settings :is(button,input,select):disabled {opacity:.55;cursor:default}
      .submodel-settings .submodel-save {font-weight:600;background:var(--dsw-alias-button-ghost-active-fill)}
      .submodel-settings .submodel-save:not(:disabled):hover {background:var(--dsw-alias-button-ghost-active-hover)}
      .submodel-list {display:grid;list-style:none;gap:8px;margin:0;padding:0}
      .submodel-item,.submodel-actions {display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
      .submodel-item {justify-content:space-between;overflow-wrap:anywhere}
      .submodel-choices {display:flex;flex-wrap:wrap;gap:4px 16px}
      .submodel-choices label {display:inline-flex;min-height:40px;align-items:center;gap:8px}
      .submodel-group {display:grid;gap:8px;min-width:0;padding-block-start:12px}
      .submodel-group + .submodel-group {border-block-start:1px solid var(--dsw-alias-border-l1)}
      .submodel-choice {display:grid;gap:8px;min-width:0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
      .submodel-rank {font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
      .submodel-feedback {min-height:1.5em}
    `;
    const fields = ['modelGroups', 'watchdog'];
    const pair = ({ provider, model }) => ({ provider, model });
    const keyOf = (route) => JSON.stringify([route?.provider, route?.model]);
    const hasPair = (route) => Boolean(route?.provider && route?.model);
    const unique = (rows) => {
      const seen = new Set();
      return rows.filter(row => {
        const key = keyOf(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const reorder = (rows, index, by) => {
      const next = rows.slice();
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    };
    const canonical = (value) => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const sourceOf = (store) => ({ listen: callback => store.subscribe(callback), read: () => store.getSnapshot() });
    const isReady = (snapshot) => snapshot.status === 'ready' && snapshot.value && Number.isSafeInteger(snapshot.revision);
    const text = (name, value, className = 'submodel-muted') => element('p', { className, key: name }, value);
    const button = (label, onClick, disabled, ariaLabel) => element('button', {
      type: 'button', onClick, disabled, ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
    }, label);
    const didLoad = (result) => result?.ok === true && Array.isArray(result.value?.groups);

    function directoryOf(catalog) {
      const models = (catalog?.groups ?? []).flatMap((group) => (group.models ?? [])
        .filter(model => typeof model.name === 'string' && model.name.trim())
        .map(model => ({ provider: group.id, model: model.id, name: model.name,
          // The catalog group carries the provider's display name; fall back to its id.
          channel: typeof group.name === 'string' && group.name.trim() ? group.name.trim() : group.id,
          efforts: model.reasoning?.efforts ?? [] })));
      const counts = new Map();
      for (const model of models) counts.set(model.name, (counts.get(model.name) ?? 0) + 1);
      return unique(models).map(model => ({ ...model, label: counts.get(model.name) > 1
        ? `${model.name} · ${model.channel}` : model.name }));
    }

    function PickModel({ label, placeholder, rows, onPick }) {
      const id = useId();
      return element('div', { className: 'submodel-field' },
        element('label', { htmlFor: id }, label),
        element('select', { id, value: '', 'data-submodel-model-picker': '', disabled: rows.length === 0,
          onChange: event => { if (event.target.value !== '') onPick(rows[Number(event.target.value)]); } },
        element('option', { value: '', disabled: true }, placeholder),
        ...rows.map((row, index) => element('option', { key: keyOf(row), value: String(index) }, row.label))));
    }

    function RowLabel({ route, catalog, allowed, translate }) {
      const model = catalog.get(keyOf(route));
      return element('span', { className: model ? 'submodel-model-name' : 'submodel-muted' },
        model?.label ?? translate('unavailableModel'), model && allowed && !allowed.has(keyOf(route))
          ? element('span', { className: 'submodel-muted', 'data-submodel-not-authorized': '' }, ` · ${translate('notAuthorized')}`) : null);
    }

    function importedGroups(settings) {
      if (Array.isArray(settings.modelGroups?.executors) && Array.isArray(settings.modelGroups?.experts)) return settings.modelGroups;
      const executor = settings.executor;
      return {
        executors: hasPair(executor) ? [{ ...pair(executor), note: '', reasoningEffort: executor.reasoningEffort ?? 'max' }] : [],
        experts: unique((settings.experts ?? []).filter(hasPair)).map(row => ({
          ...pair(row), reasoningEffort: row.reasoningEffort ?? '',
          note: ([row.model, `${row.provider}/${row.model}`].includes(row.label) ? '' : row.label ?? '').slice(0, 120),
        })),
      };
    }

    function RowEffort({ row, update, catalog, translate }) {
      const id = useId();
      const options = catalog.get(keyOf(row))?.efforts ?? [];
      const effort = row.reasoningEffort;
      return element('div', { className: 'submodel-field' }, element('label', { htmlFor: id }, translate('effort')),
        element('select', { id, value: effort, onChange: event => update({ reasoningEffort: event.target.value }) },
          element('option', { value: '' }, translate('defaultEffort')),
          effort && !options.some(option => option.id === effort)
            ? element('option', { value: effort, disabled: true }, translate('previousEffort')) : null,
          ...options.map(option => element('option', { key: option.id, value: option.id }, option.name))));
    }

    function OrderedModels({ group, rows, update, models, catalog, allowed, translate }) {
      const title = translate(group);
      const executor = group === 'executors';
      const available = models.filter(model => !rows.some(row => keyOf(row) === keyOf(model)));
      return element('section', { className: 'submodel-group', 'data-submodel-group': group, 'aria-label': title },
        element('h4', null, title), text('help', translate(executor ? 'executorHelp' : 'expertHelp')),
        rows.length ? element('ol', { className: 'submodel-list' }, ...rows.map((row, index) => {
          const name = catalog.get(keyOf(row))?.label ?? `${translate('unavailableModel')} ${index + 1}`;
          const updateRow = fields => update(rows.map((item, position) => position === index ? { ...item, ...fields } : item));
          return element('li', { key: keyOf(row), className: 'submodel-choice' },
            element('div', { className: 'submodel-item' },
              element('div', { className: 'submodel-actions' }, element('span', { className: 'submodel-rank' }, `${index + 1}.`),
                element(RowLabel, { route: row, catalog, allowed, translate })),
              element('div', { className: 'submodel-actions' },
                button(translate('up'), () => update(reorder(rows, index, -1)), index === 0, `${translate('up')}: ${name}`),
                button(translate('down'), () => update(reorder(rows, index, 1)), index === rows.length - 1, `${translate('down')}: ${name}`),
                button(translate('remove'), () => update(rows.filter((_item, position) => position !== index)), false, `${translate('remove')}: ${name}`))),
            element('label', { className: 'submodel-field' }, translate('note'),
              element('input', { type: 'text', value: row.note, maxLength: 120, placeholder: translate('noteExample'),
                'aria-label': `${translate('note')}: ${name}`, onChange: event => updateRow({ note: event.target.value }) })),
            element(RowEffort, { row, update: updateRow, catalog, translate }));
        })) : text('empty', translate('noChoices')),
        element(PickModel, { label: translate(executor ? 'addExecutor' : 'addExpert'),
          placeholder: translate('chooseModel'), rows: available,
          onPick: model => update([...rows, { ...pair(model), note: '', reasoningEffort: '' }]) }));
    }

    function ModelFields({ settings, legacyLists, change, models, catalog, allowed, translate }) {
      const groups = importedGroups(settings);
      return element('section', { className: 'submodel-section', 'aria-label': translate('models') },
        text('order-help', translate('orderHelp')),
        legacyLists ? text('legacy-lists', translate('legacyLists')) : null,
        ...['executors', 'experts'].map(group => element(OrderedModels, { key: group, group, rows: groups[group],
          update: rows => change('modelGroups', { ...groups, [group]: rows }), models, catalog, allowed, translate })));
    }

    function NumberField({ title, field, value, minimum, maximum, step = 1, onChange }) {
      const id = useId();
      return element('div', { className: 'submodel-field' }, element('label', { htmlFor: id }, title),
        element('input', { id, type: 'number', inputMode: step === 1 ? 'numeric' : 'decimal',
          'data-submodel-number': field, min: minimum, max: maximum, step, required: true,
          value: value ?? '', onChange: event => onChange(event.target.value) }));
    }

    function graceMilliseconds(seconds) {
      const value = Number(seconds);
      const milliseconds = Math.round(value * 1000);
      return seconds !== '' && value === milliseconds / 1000 && milliseconds >= 1000 && milliseconds <= 600000
        ? milliseconds : seconds;
    }

    function MonitoringFields({ value, grouped, change, translate }) {
      const modeId = useId();
      const update = (patch) => change('watchdog', { ...value, ...patch });
      const modes = { off: 'off', notify: 'notify', stop: 'stop', retry: 'retryMode' };
      return element('section', { className: 'submodel-section', 'aria-label': translate('watchdog') },
        element('h4', null, translate('watchdog')), text('usage', translate('usageHelp')),
        element('div', { className: 'submodel-field' }, element('label', { htmlFor: modeId }, translate('mode')),
          element('select', { id: modeId, value: value.mode, onChange: event => update({ mode: event.target.value }) },
            ...Object.entries(modes).map(([mode, label]) => element('option', { key: mode, value: mode }, translate(label))))),
        value.mode === 'stop' ? text('manual', translate('manualStop')) : null,
        value.mode === 'retry' ? text('retry', translate(grouped ? 'retryHelp' : 'legacyRetryHelp')) : null,
        element('fieldset', null, element('legend', null, translate('tiers')),
          element('div', { className: 'submodel-choices' }, ...['executor', 'expert'].map(tier => element('label', { key: tier },
            element('input', { type: 'checkbox', checked: value.tiers.includes(tier),
              disabled: value.tiers.length === 1 && value.tiers.includes(tier),
              onChange: event => update({ tiers: event.target.checked ? [...value.tiers, tier] : value.tiers.filter(other => other !== tier) }) }),
            translate(`${tier}Tier`))))),
        element(NumberField, { field: 'usage', title: translate('warnTokens'), value: value.warnTokens, minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER, onChange: val => update({ warnTokens: val }) }),
        element(NumberField, { field: 'wait', title: translate('graceSeconds'), minimum: 1, maximum: 600, step: 0.001,
          value: typeof value.graceMs === 'number' ? value.graceMs / 1000 : value.graceMs,
          onChange: val => update({ graceMs: graceMilliseconds(val) }) }),
        element(NumberField, { field: 'switches', title: translate('maxRetries'), value: value.maxRetries, minimum: 0,
          maximum: 2, onChange: val => update({ maxRetries: val }) }));
    }

    function makeEditor({ form, authForm, mirror, generation, connectionChanged, getRemote }) {
      const snapshotSource = sourceOf(form);
      const authSource = sourceOf(authForm);
      const mirrorSource = sourceOf(mirror);
      const generationSource = sourceOf(generation);
      return function Editor({ t: translate }) {
        const saved = useSyncExternalStore(snapshotSource.listen, snapshotSource.read);
        const authorization = useSyncExternalStore(authSource.listen, authSource.read);
        const mirrorState = useSyncExternalStore(mirrorSource.listen, mirrorSource.read);
        const epoch = useSyncExternalStore(generationSource.listen, generationSource.read);
        const [catalogState, setCatalogState] = useState({ status: 'loading' });
        const [catalogAttempt, setCatalogAttempt] = useState(0);
        const [draft, setDraft] = useState(null);
        const [feedback, setFeedback] = useState('');
        const [saving, setSaving] = useState(false);
        const active = useRef(false);
        const busy = useRef(false);
        useEffect(() => {
          active.current = true;
          return () => { active.current = false; };
        }, []);
        useEffect(() => {
          if (!epoch || connectionChanged()) return undefined;
          let cancelled = false;
          const remote = getRemote();
          const refresh = () => {
            if (cancelled || generationSource.read() !== epoch || connectionChanged()) return;
            setCatalogState({ status: 'loading' });
            const accept = (result) => {
              if (cancelled || generationSource.read() !== epoch || connectionChanged()) return;
              setCatalogState(didLoad(result) ? { status: result.value.failures?.length ? 'partial' : 'ready', value: result.value }
                : { status: 'error' });
            };
            Promise.resolve().then(() => remote.session.modelCatalog()).then(accept, () => accept(undefined));
          };
          const off = remote.$on?.('llm/adapters-updated', refresh);
          refresh();
          return () => {
            cancelled = true;
            off?.();
          };
        }, [epoch, catalogAttempt]);

        const generationLost = connectionChanged() || (draft !== null && draft.epoch !== epoch);
        const ready = isReady(saved);
        const isStale = ready && draft !== null && saved.revision !== draft.revision;
        const canEdit = ready && saved.writable && Boolean(epoch) && !generationLost && !mirrorState.error;
        const settings = { ...saved.value, ...draft?.changes };
        const models = directoryOf(catalogState.value);
        const catalog = new Map(models.map(model => [keyOf(model), model]));
        const allowed = isReady(authorization)
          ? new Set((authorization.value.enabled ? authorization.value.allowedModels ?? [] : []).map(keyOf)) : undefined;
        const reload = () => globalThis.location.reload();
        const reloadCatalog = () => setCatalogAttempt(previous => previous + 1);
        const changed = draft !== null && Object.keys(draft.changes).length > 0;

        function edit(field, value) {
          if (!canEdit || busy.current || generationSource.read() !== epoch) return;
          if (feedback !== 'conflict') setFeedback('');
          setDraft(old => {
            const base = old ?? { revision: saved.revision, epoch, source: saved.value, changes: {} };
            const changes = { ...base.changes };
            if (equal(value, base.source[field])) delete changes[field];
            else changes[field] = structuredClone(value);
            return Object.keys(changes).length > 0 ? { ...base, changes } : null;
          });
        }

        function review() {
          const current = snapshotSource.read();
          if (connectionChanged() || generationSource.read() !== draft?.epoch || !isReady(current) || !current.writable) return;
          const changes = { ...draft.changes };
          let overlap = false;
          if (changes.modelGroups) {
            const previous = importedGroups(draft.source);
            const savedGroups = importedGroups(current.value);
            const draftGroups = { ...changes.modelGroups };
            for (const group of ['executors', 'experts']) {
              if (equal(draftGroups[group], previous[group])) draftGroups[group] = savedGroups[group];
              else if (!equal(savedGroups[group], previous[group]) && !equal(savedGroups[group], draftGroups[group])) overlap = true;
            }
            changes.modelGroups = draftGroups;
          }
          for (const field of fields) {
            if (equal(changes[field], current.value[field])) delete changes[field];
            else if (field === 'watchdog' && changes.watchdog && !equal(draft.source.watchdog, current.value.watchdog)) overlap = true;
          }
          const changed = Object.keys(changes).length > 0;
          setDraft(changed ? { ...draft, changes, source: current.value, revision: current.revision } : null);
          setFeedback(changed ? (overlap ? 'reviewOverlap' : 'review') : 'noChanges');
        }

        async function save(event) {
          event.preventDefault();
          if (!canEdit || !changed || busy.current || connectionChanged() || generationSource.read() !== draft.epoch) return;
          const before = snapshotSource.read();
          if (before.revision !== draft.revision) { setFeedback('conflict'); return; }
          if (!isReady(before) || !before.writable) return;
          const patch = structuredClone(draft.changes);
          if (patch.watchdog) {
            for (const [field, minimum, maximum] of [
              ['warnTokens', 1, Number.MAX_SAFE_INTEGER], ['graceMs', 1000, 600000], ['maxRetries', 0, 2],
            ]) {
              const raw = patch.watchdog[field];
              const number = field === 'graceMs' && typeof raw !== 'number' ? NaN : Number(raw);
              if (raw === '' || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
                setFeedback('saveFailed');
                return;
              }
              patch.watchdog[field] = number;
            }
          }
          const operations = fields.filter(field => Object.hasOwn(patch, field))
            .map(field => ({ op: 'set', path: [field], value: patch[field] }));
          const currentConnection = () => active.current && !connectionChanged() && generationSource.read() === draft.epoch;
          busy.current = true;
          setSaving(true);
          setFeedback('');
          try {
            const success = await form.mutate(operations, draft.revision);
            if (!currentConnection()) return;
            const after = snapshotSource.read();
            if (success && isReady(after) && operations.every(op => equal(after.value[op.path[0]], op.value))) {
              setDraft(null);
              setFeedback('saved');
            } else if (after.revision !== draft.revision) setFeedback('conflict');
            else setFeedback(mirrorSource.read().error ? 'transport' : 'saveFailed');
          } catch {
            if (currentConnection()) setFeedback('transport');
          } finally {
            busy.current = false;
            if (active.current) setSaving(false);
          }
        }

        const heading = element('h3', null, translate('title'));
        const problem = generationLost ? 'reconnect' : !epoch && ready ? 'transport' : mirrorState.error ? 'loadFailed'
          : saved.status === 'unavailable' ? 'unavailable' : !ready ? 'loading' : !saved.writable ? 'readOnly' : '';
        const status = problem || (saving ? 'saving' : isStale ? 'conflict' : feedback || (changed ? 'pending' : ''));
        const availableModels = catalogState.status === 'loading' || catalogState.status === 'error' ? [] : models;
        return element('section', { className: 'submodel-settings', 'data-submodel-settings': '' }, element('style', null, style), heading,
          ready ? element('form', { onSubmit: save, 'aria-busy': saving },
            element('fieldset', { disabled: !canEdit || saving, className: 'submodel-models' },
              text('allowed', translate('authorization')),
              catalogState.status === 'loading' ? text('catalog', translate('directoryLoading')) : null,
              catalogState.status === 'ready' && models.length === 0 ? text('catalog', translate('noModels')) : null,
              catalogState.status === 'partial' || catalogState.status === 'error'
                ? element('div', { className: 'submodel-actions' }, text('catalog', translate('directoryFailed')), button(translate('retryCatalog'), reloadCatalog)) : null,
              element(ModelFields, { settings, legacyLists: !saved.value.modelGroups?.executors &&
                (saved.value.fallbacks?.length > 0 || saved.value.watchdog?.mode === 'retry'),
                change: edit, models: availableModels, catalog, allowed, translate }),
              element(MonitoringFields, { value: settings.watchdog, grouped: Boolean(settings.modelGroups?.executors), change: edit, translate })),
            element('div', { className: 'submodel-actions' },
              element('button', { type: 'submit', className: 'submodel-save', disabled: !canEdit || !changed || isStale || saving }, translate('save')),
              changed ? button(translate('discard'), () => { setDraft(null); setFeedback(''); }, saving) : null,
              isStale && canEdit ? button(translate('retain'), review, saving) : null)) : null,
          element('p', { className: 'submodel-feedback submodel-muted', role: 'status' }, status ? translate(status) : ''),
          problem === 'reconnect' || problem === 'loadFailed' || problem === 'transport'
            ? button(translate(problem === 'reconnect' ? 'reload' : 'retry'), reload, saving) : null);
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, dictionaries));
        const listeners = new Set();
        let Editor;
        const readEditor = () => Editor;
        const subscribe = (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
        const updateEditor = (component) => {
          Editor = component;
          for (const listener of listeners) listener();
        };
        ctx.inject(['configForms', 'connection', 'remote', 'remote.session'], (bound) => {
          const forms = bound.configForms;
          const { generation } = bound.connection;
          let firstGeneration = generation.getSnapshot();
          let retired = false;
          const unwatch = generation.subscribe(() => {
            const current = generation.getSnapshot();
            if (firstGeneration === undefined) firstGeneration = current;
            else if (current !== firstGeneration) retired = true;
          });
          updateEditor(makeEditor({
            form: forms.get('submodel'), authForm: forms.get('subagent-model-selection-settings'),
            mirror: forms.describe(), generation, connectionChanged: () => retired, getRemote: () => bound.remote,
          }));
          return () => {
            retired = true;
            unwatch();
            updateEditor(undefined);
          };
        });
        function Panel({ t: translate, view }) {
          const Settings = useSyncExternalStore(subscribe, readEditor);
          if (view !== 'page') return null;
          return Settings ? element(Settings, { t: translate }) : element('section', {
            className: 'submodel-settings', 'data-submodel-settings': '',
          }, element('h3', null, translate('title')), element('p', { role: 'status' }, translate('unavailable')));
        }
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', id: 'submodel-settings', key: 'dsh-submodel', locale: namespace,
        }, Panel));
      },
    };
  },
});
