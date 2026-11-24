import { CONFIG_ENTRY, SETUP_FIELDS, executorConfigured, settingOps } from './config.js';
import {
  HOST_SELECTION_ENTRY_ID,
  SETUP_TOOL_NAME,
  buildSetupQuestions,
  composeNextHostConfig,
  composeNextPluginConfig,
  deriveSetupCandidates,
  parseSetupAnswers,
  roleOf,
} from './policy.js';

const MANUAL_CONFIG = [
  '请在插件页选择执行模型，再到「子代理」设置允许相应模型。新会话会读取保存的设置和授权。',
  '没有设置页面时，可以按维护文档分别配置这两行：',
  '',
  '- id: subagent-model-selection-settings',
  '  config:',
  '    enabled: true',
  '    allowedModels:',
  '      - { provider: your-provider, model: your-model }',
  '- id: submodel',
  '  config:',
  '    modelGroups:',
  '      executors:',
  '        - { provider: your-provider, model: your-model, note: "日常执行", reasoningEffort: "" }',
  '      experts: []',
].join('\n');

async function collectRoutes(llm, signal) {
  const pack = [];
  const providers = llm.listProviders();
  for (const { id: provider } of providers) {
    signal?.throwIfAborted();
    try {
      const models = await llm.listModels(provider, signal);
      for (const model of models) {
        if (!model.id) continue;
        pack.push({ provider, model: model.id, name: model.name ?? '' });
      }
    } catch {
      signal?.throwIfAborted();
    }
  }
  return pack;
}

function readableRow(rows, ns) {
  const row = rows.find(item => item.ns === ns);
  return Number.isSafeInteger(row?.revision) && row.value && typeof row.value === 'object' ? row : undefined;
}

function unavailable(reason) {
  return `${reason}\n\n${MANUAL_CONFIG}`;
}

const REOPEN = '设置已在别处更新。请重新打开设置后确认修改。';
const GRANT_REVIEW = '请在「子代理」设置复查；授权对新会话生效。';

/** The two user decisions have separate revision fences and separate results. */
export function createSetupTool({ ctx, config, logger }) {
  let asking = false;

  async function run(exec) {
    const { agent, signal } = exec;
    const settings = ctx.get('settings');
    const llm = ctx.get('llm');
    const userQuestions = ctx.get('userQuestions');
    if (!settings?.writable || !llm || !userQuestions) return unavailable('当前无法自动保存设置。');

    let pack;
    let rows;
    try {
      pack = await collectRoutes(llm, signal);
      rows = settings.describe();
    } catch {
      return unavailable('暂时无法读取模型或设置。');
    }
    if (executorConfigured(config)) return REOPEN;
    const preferences = readableRow(rows, CONFIG_ENTRY);
    const host = readableRow(rows, HOST_SELECTION_ENTRY_ID);
    if (!preferences) return unavailable('当前找不到可写的插件设置。');
    if (pack.length === 0) return unavailable('暂时没有可选模型。请先在模型设置中添加模型。');

    const candidates = deriveSetupCandidates(pack, host?.value);
    const questions = buildSetupQuestions(candidates);
    let parsed;
    try {
      const result = await userQuestions.ask({ questions: questions.slice(0, 2), agent, signal });
      parsed = parseSetupAnswers(result?.answers, candidates);
    } catch {
      return unavailable('模型选择未完成。');
    }
    if (!parsed.ok) return unavailable('请重新选择一个有效的执行模型。');

    for (const route of parsed.customRoutes) {
      try {
        const model = await llm.resolveModelInfo(route.provider, route.model, signal);
        if (model == null) return unavailable('找不到所填模型。');
      } catch {
        return unavailable('暂时无法验证所填模型。');
      }
    }

    let confirmation;
    try {
      const result = await userQuestions.ask({ questions: questions.slice(2), agent, signal });
      confirmation = parseSetupAnswers([
        { id: 'executor', custom: `${parsed.executor.provider}/${parsed.executor.model}` },
        ...(result?.answers ?? []).filter(answer => answer.id === 'authorize'),
      ], candidates);
    } catch {
      return unavailable('未完成授权选择，设置尚未保存。');
    }
    if (!confirmation.ok || signal?.aborted) return unavailable('未完成授权选择，设置尚未保存。');

    let hostNote = '已保留原有授权。';
    if (confirmation.authorize) {
      if (!host) {
        hostNote = '授权未写入。请在「子代理」设置手动允许所选模型。';
      } else {
        try {
          const allowed = composeNextHostConfig(host.value, [parsed.executor, ...parsed.experts]);
          await settings.mutate(HOST_SELECTION_ENTRY_ID, settingOps(['enabled', 'allowedModels'], allowed), host.revision);
          hostNote = `已保存授权。${GRANT_REVIEW}`;
        } catch (error) {
          logger?.warn?.('dsh-submodel: setup authorization write refused');
          hostNote = error?.code === 'SETTINGS_CONFLICT'
            ? `授权未写入。${REOPEN}`
            : '授权未写入。请在「子代理」设置手动允许所选模型。';
        }
      }
    }

    if (signal?.aborted) return `插件设置尚未保存。${hostNote}`;
    try {
      const next = composeNextPluginConfig(preferences.value, parsed);
      await settings.mutate(CONFIG_ENTRY, settingOps(SETUP_FIELDS, next), preferences.revision);
    } catch (error) {
      logger?.warn?.('dsh-submodel: setup preference write refused');
      const reason = error?.code === 'SETTINGS_CONFLICT' ? REOPEN : '插件设置未保存。请重试。';
      return `${reason}${hostNote}`;
    }
    return `已保存模型选择。新会话使用此配置。${hostNote}`;
  }

  return {
    name: SETUP_TOOL_NAME,
    description: 'Set the execution model for new sessions. Ask separately before adding model authorization.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      if (!exec?.agent || roleOf(exec.agent) !== 'root') throw new Error('Only the main conversation can configure delegation.');
      if (executorConfigured(config)) return REOPEN;
      if (asking) return '配置进行中，请先回答当前问题。';
      asking = true;
      try {
        return await run(exec);
      } finally {
        asking = false;
      }
    },
  };
}
