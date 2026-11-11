/**
 * dsh-submodel / setup.js —— 自动配置向导 `configure_submodel`。
 *
 * ## 为什么是「探测 + 一张确认卡」而不是纯自动
 *
 * 宿主 `llm` 服务的模型元数据只有 `id/name/description/context`，**没有价格字段**
 * （`resolveModelInfo` 的返回里也没有）。纯自动只能靠模型名猜贵贱，开源后一定会把活
 * 派错模型，而且不报错。所以这里把「探测」与「决定」拆开：本模块探测候选并预填顺序，
 * 用户点一次卡完成选择，同时把花钱风险交回用户。
 *
 * ## 为什么必须连宿主授权表一起写
 *
 * `dsh-tool-subagent` 在会话没有记录 model-selection policy 时只允许父路由；不写
 * `allowedModels`，执行路由与专家路由第一次调用就报
 * `child LLM route "…" is not allowed for this Session`——这是 README「5 行配置」不完整的根因。
 * 写入走官方 `configEditor`（带锁、原子写、失败回滚），不自改 YAML、不建私有状态文件。
 *
 * ## 写入顺序：先宿主、后插件
 *
 * 宿主字段是 `.volatile()`，写入即时生效且不重载插件；插件配置写入会重载本插件并销毁
 * 正在执行的本工具注册。因此宿主授权先写、插件配置最后写，返回文案在写之前拼好。
 * 写成功后本工具实例会被卸载——属预期，不是失败。
 *
 * ## 失败降级
 *
 * 任何宿主服务缺失/异常（llm、userQuestions、configEditor、宿主授权行）都**不抛**，
 * 降级为「未写入原因 + 手动两步 YAML」返回给模型；只有非 root 调用才抛错。
 *
 * @module dsh-submodel/setup
 */
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

/** 本插件在 profile 补丁里的配置行 id（cordis.patch.yml 的 insert 行）。 */
const PLUGIN_ENTRY_ID = 'submodel';

/** 路由的展示文本。 */
function routeText(route) {
  return `${route.provider}/${route.model}`;
}

/** 自动配置不可用时给用户的手动两步配置（示例路由零本机信息）。 */
function manualConfigText() {
  return [
    '请在 profile 补丁层（cordis.patch.yml）手动完成两步配置，然后新开会话：',
    '',
    '① 宿主授权（加到已有行或新增该行）：',
    '- id: subagent-model-selection-settings',
    '  config:',
    '    enabled: true',
    '    allowedModels:',
    '      - { provider: your-provider, model: your-model }',
    '',
    '② 本插件配置：',
    '- id: submodel',
    '  config:',
    '    executor:',
    '      provider: your-provider',
    '      model: your-model',
    '      reasoningEffort: max',
    '    experts: []',
    '    economyRoutes:',
    '      - { provider: your-provider, model: your-model }',
  ].join('\n');
}

/**
 * 收集宿主当前可用的 provider/model。
 * 单个 provider 的 `listModels` 失败只跳过该 provider，不影响整体（best-effort）。
 * @param llm - 宿主 llm 服务。
 * @returns `[{provider, model, name, description}]`。
 */
async function collectRoutes(llm) {
  const pack = [];
  let providers;
  try {
    providers = llm.listProviders();
  } catch {
    return pack;
  }
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerId = provider?.id;
    if (typeof providerId !== 'string' || providerId === '') continue;
    let models;
    try {
      models = await llm.listModels(providerId);
    } catch {
      continue;
    }
    for (const model of Array.isArray(models) ? models : []) {
      if (typeof model?.id !== 'string' || model.id === '') continue;
      pack.push({
        provider: providerId,
        model: model.id,
        name: typeof model.name === 'string' ? model.name : '',
        description: typeof model.description === 'string' ? model.description : '',
      });
    }
  }
  return pack;
}

/**
 * 创建 `configure_submodel` 工具定义。
 *
 * @param options - 依赖注入：
 *   - `ctx`：**插件顶层 ctx**（用 `ctx.get(...)` 取服务、`ctx.fiber.entry` 定位本插件配置行）；
 *   - `config`：插件原始配置（保留字段时用，允许为空）；
 *   - `logger`：日志器。
 * @returns 可直接 `agent.ctx.tools.register(...)` 的工具定义。
 */
export function createSetupTool({ ctx, config, logger }) {
  void config; // 写回值时以 configEditor 的当前原始配置为基准，不重新拼整个 config。
  /** 同一 agent 的并发保护：正在提问时第二次调用直接返回，不重复弹卡。 */
  let asking = false;

  /** 真正执行：所有失败降级为文本，不抛（非 root 调用由外层抛）。 */
  async function run(exec) {
    const signal = exec?.signal;
    const llm = ctx.get('llm');
    if (llm === undefined || llm === null) {
      return `configure_submodel: 当前宿主没有可用的 llm 服务，无法自动探测路由，未写入任何配置。\n\n${manualConfigText()}`;
    }
    const userQuestions = ctx.get('userQuestions');
    if (userQuestions === undefined || userQuestions === null) {
      return `configure_submodel: 当前宿主没有提问服务（纯 CLI 会话常见），无法弹卡，未写入任何配置。\n\n${manualConfigText()}`;
    }

    // ① 探测候选（best-effort；空则引导用户先配置渠道）。
    const pack = await collectRoutes(llm);
    if (pack.length === 0) {
      return `configure_submodel: 还没有可用的渠道/模型（或它们全部无法列出）。请先在设置里配置渠道与密钥后重试。\n\n${manualConfigText()}`;
    }

    // ② 宿主当前授权状态（best-effort，仅用于候选排序与预填）。
    let host;
    try {
      host = ctx.get('subagentModelSelection')?.current?.();
    } catch {
      host = undefined;
    }

    // ③ 一张卡问三题：执行路由 / 专家路由 / 是否写宿主授权。
    const candidates = deriveSetupCandidates(pack, host);
    const questions = buildSetupQuestions(candidates);
    let answer;
    try {
      answer = await userQuestions.ask({ questions, agent: exec?.agent, signal });
    } catch (error) {
      const detail = error?.code ?? error?.message ?? String(error);
      return `configure_submodel: 未能完成提问（${String(detail)}），未写入任何配置。\n\n${manualConfigText()}`;
    }

    // ④ 解析回答：selected 必须来自候选；custom 只接受 provider/model，且要过 llm 存在性校验。
    const parsed = parseSetupAnswers(answer?.answers, candidates);
    if (!parsed.ok) {
      return `configure_submodel: 回答无效（${parsed.reason}），未写入任何配置。\n\n${manualConfigText()}`;
    }
    for (const route of parsed.customRoutes) {
      try {
        await llm.resolveModelInfo(route.provider, route.model, signal);
      } catch {
        return `configure_submodel: 自定义路由 ${routeText(route)} 在宿主里不存在，未写入任何配置。\n\n${manualConfigText()}`;
      }
    }

    // ⑤ 定位本插件配置行（写插件配置会在成功后卸载本工具实例，属预期）。
    const editor = ctx.get('configEditor');
    if (editor === undefined || editor === null) {
      return `configure_submodel: 当前宿主没有配置编辑器（非 GUI / 只读 profile），无法自动写配置。\n\n${manualConfigText()}`;
    }
    let entries;
    try {
      entries = editor.entries();
    } catch {
      entries = undefined;
    }
    if (!Array.isArray(entries)) {
      return `configure_submodel: 读取 profile 配置失败，未写入任何配置。\n\n${manualConfigText()}`;
    }
    const entry = ctx.fiber?.entry ?? entries.find((row) => row?.options?.id === PLUGIN_ENTRY_ID);
    if (entry === undefined) {
      return `configure_submodel: 找不到本插件（id=${PLUGIN_ENTRY_ID}）的配置行，未写入任何配置。\n\n${manualConfigText()}`;
    }

    // ⑥ 先写宿主授权（volatile、即时生效、不重载）；失败只记录并继续写插件配置。
    const hostRoutes = [parsed.executor, ...parsed.experts];
    let hostNote;
    if (!parsed.authorize) {
      hostNote = '宿主授权未写入（按你的选择）';
    } else {
      const hostEntry = entries.find((row) => row?.options?.id === HOST_SELECTION_ENTRY_ID);
      if (hostEntry === undefined) {
        hostNote = '宿主授权行不存在，请按 README 手动添加该行';
      } else {
        try {
          await editor.edit(hostEntry, (current) => composeNextHostConfig(current, hostRoutes));
          hostNote = '宿主授权已写入（只对新会话生效）';
        } catch (error) {
          logger?.warn?.(`dsh-submodel: configure_submodel 写宿主授权失败: ${String(error)}`);
          hostNote = `宿主授权写入失败（${String(error?.message ?? error)}），请按 README 手动添加该行`;
        }
      }
    }

    // ⑦ 返回文案在写插件配置**之前**拼好：写入会卸载本实例，写后可能拿不到执行权。
    const summary =
      `已写入执行路由 ${routeText(parsed.executor)}、${parsed.experts.length} 条专家路由、` +
      `economyRoutes=[${routeText(parsed.executor)}]；${hostNote}。新会话生效（宿主授权只对新会话生效）。`;

    // ⑧ 再写插件配置（触发本插件重载，放最后）。
    try {
      await editor.edit(entry, (current) => composeNextPluginConfig(current, parsed));
    } catch (error) {
      logger?.warn?.(`dsh-submodel: configure_submodel 写插件配置失败: ${String(error)}`);
      return `configure_submodel: 插件配置写入失败（${String(error?.message ?? error)}）；${hostNote}。\n\n${manualConfigText()}`;
    }
    return summary;
  }

  return {
    name: SETUP_TOOL_NAME,
    description:
      'Configure subagent routing by asking the user once: pick the executor route, pick expert routes, ' +
      'and optionally authorize those routes in the host subagent model-selection table. ' +
      'Only available while no executor route is configured.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(_args, exec) {
      if (roleOf(exec?.agent) !== 'root') {
        throw new Error('configure_submodel is only available to a top-level agent (delegated subagents cannot configure routing)');
      }
      if (asking) return 'configure_submodel: 配置进行中，请先回答当前弹卡；不要重复调用。';
      asking = true;
      try {
        return await run(exec);
      } finally {
        asking = false;
      }
    },
  };
}
