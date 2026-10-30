/**
 * dsh-submodel / index.js —— 插件入口（v0.1.0）。
 *
 * 职责：全局注册**唯一的策略提示词段**；`enabled` 时再对每个合格的 standard agent 安装
 * scoped 能力（提示词段正文替换、角色 guard、统一委派入口 `delegate_task`），并在
 * Agent 释放 / 组合变化 / 配置重载时**准确卸载自己装的东西**。
 *
 * ## 与官方工具的分工（本包**不发布**任何控制工具）
 *
 * 状态查看 `list_agents`、追加消息 `send_message`、停止 `interrupt_agent` 由官方
 * `@deepseek-ai/dsh-tool-subagent-control` 提供；本包只做"什么时候自己干、什么时候派出去、
 * 派给谁"的策略层。重复注册同名工具会冲突，也没有理由让用户为重复功能付费注意力。
 *
 * ## 为什么逐 agent 安装，而不是全局注册这些工具
 *
 * 原生 subagent 的选模能力是**按会话**授予并 Recorded 进会话的。同一时刻有的会话有该能力、
 * 有的没有（例如恢复型旧会话）。只有在"该 agent 自己的 scope 里确实看得见原生 subagent 且
 * 参数含 provider/model"时才装，模型才不会拿到一个必然失败的按钮。
 *
 * ## 安装纪律
 *
 * - 先标 `installing` 再注册，避免 `tools/change` 重入；
 * - 同一个 agent 的并发安装**共用一个 Promise**；
 * - 失败清理**部分注册**并上报，不吞异常；
 * - 卸载只动自己装的东西，绝不碰别的 Session / 标准插件。
 *
 * ## 两个已确认的宿主契约（写错即静默失效，别凭直觉改）
 *
 * 1. **`ctx.tools.guard(fn)` 靠"返回字符串"拒绝**，不是抛异常（"a returned string denies
 *    the execution"）。抛异常会被当成 guard 自身故障。且 guard 是**同步**检查。
 * 2. **`ctx.tools.restrict()` 不能点名 scope-local 工具**（只认 `restrictableNames`）。
 *    所以子代的工具面收敛只走 guard 这个执行期硬边界，**不用 restrict**。
 *
 * ## fail-fast（v0.1.0 新增，只记日志、绝不抛）
 *
 * 公开版默认 `enabled:true`：缺前置时必须在日志里**明确**说清哪一项不可用，把"装完零感知"
 * 变成"可诊断"。级别与文案见 README 的「故障排查」一节。
 *
 * @module dsh-submodel
 */
import z from '@deepseek-ai/schemastery';
import {
  CHILD_FORBIDDEN_TOOLS,
  ROUTING_ORDER,
  ROUTING_SECTION,
  childDelegationRefusal,
  modelFromAssembly,
  roleOf,
  routingTextFor,
} from './policy.js';
import { createDelegateTool, findNativeSubagent } from './delegation.js';

export const name = 'dsh-submodel';

/** 用到的服务必须列全：apply 会等到它们可用才执行。 */
export const inject = ['tools', 'systemPrompt'];

export const Config = z.object({
  /** 自动策略总开关。默认开启：公开版的目标就是"装上一次配好"。 */
  enabled: z.boolean().default(true),
  /** 只对这一个 composition 生效；其他 preset 不安装任何东西。 */
  preset: z.string().default('standard'),
  /** 能力门控工具名：该 scope 不可见时策略段不渲染（工具仍按注册门控安装）。 */
  toolName: z.string().default('list_subagent_models'),
  /** 段顺序；默认紧接 TOOL_SUBAGENT(2800)。 */
  order: z.number().default(ROUTING_ORDER),
  /**
   * 执行路由（非 Flash 主脑的默认派工目标）。**唯一配置源**：执行期注入的 pair 由它派生，
   * 正文里的执行路由也只经占位符从它渲染，不允许 YAML/JS 双写两个不同的路由名。
   */
  executor: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default('max'),
  }).default({ provider: '', model: '', reasoningEffort: 'max' }),
  /**
   * 专家路由：升级时允许显式点名的 `{label, provider, model, reasoningEffort?}` 列表。
   * 空数组时正文给出"未配置专家路由"提示，不渲染任何具体路由名。
   */
  experts: z.array(z.object({
    label: z.string(),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().default('max'),
  })).default([]),
  /**
   * 正文覆盖：任一项非空时**整段替换**内置模板（替换后不再插值），方便用户写自己的话术。
   */
  texts: z.object({
    economize: z.string().default(''),
    boss: z.string().default(''),
    child: z.string().default(''),
  }).default({ economize: '', boss: '', child: '' }),
  /**
   * 是否安装"非 Flash 顶层用原生 subagent 时必须给完整显式 pair"的 guard。
   * 默认开启；关掉后原生 subagent 的行为完全交给宿主。
   */
  guardNativeSubagent: z.boolean().default(true),
});

/** 判断一个 agent 是否属于本插件负责的 composition。 */
function belongsToComposition(agent, presetId, presetService) {
  if (presetService === undefined) return false;
  try {
    return presetService.composedPreset(agent.ctx) === presetId;
  } catch {
    // 组合正在解散时 composedPreset 可能抛；视为"不属于"，走卸载路径，
    // 不把异常抛进事件回调。
    return false;
  }
}

export function apply(ctx, config) {
  const enabled = config.enabled === true;
  const presetId = config.preset ?? 'standard';
  const toolName = config.toolName ?? 'list_subagent_models';
  const order = config.order ?? ROUTING_ORDER;
  const executor = {
    provider: config.executor?.provider ?? '',
    model: config.executor?.model ?? '',
    reasoningEffort: config.executor?.reasoningEffort ?? 'max',
  };
  const experts = Array.isArray(config.experts) ? config.experts : [];
  const texts = {
    economize: config.texts?.economize ?? '',
    boss: config.texts?.boss ?? '',
    child: config.texts?.child ?? '',
  };
  const guardNativeSubagent = config.guardNativeSubagent !== false;
  /** 每次 assembly 现渲染正文用的运行期上下文（纯函数层只认它）。 */
  const renderContext = { executor, experts, texts };

  /** 每个 agent 的 assembly listener 装的文本解析器：`(resolved) => string|null`。 */
  const textResolvers = new WeakMap();

  // ── 全局唯一的段（只注册一次，绝不重复注册同名段） ─────────────────────────
  ctx.systemPrompt.section({
    name: ROUTING_SECTION,
    order,
    // enabled 时正文完全交给 per-agent listener；enabled=false 时保持空段，
    // 不注册任何工具/guard（与"关闭即无感"一致）。
    text: () => '',
  });

  if (!enabled) {
    ctx.logger.info('dsh-submodel: enabled=false，策略未启用（只注册空段，不安装任何工具/guard）');
    return;
  }

  // ── fail-fast（只记日志、绝不抛） ──────────────────────────────────────────
  if (executor.provider === '' || executor.model === '') {
    ctx.logger.error('dsh-submodel: config.executor.provider/model 未配置，自动委派不可用；请按 README 配置');
  }
  ctx.logger.info(
    `dsh-submodel: 自动策略已启用（preset=${presetId}, executor=${executor.provider || '(未配置)'}/${executor.model || '(未配置)'}, experts=${experts.length}）`,
  );

  // ── 逐 agent 安装 ──────────────────────────────────────────────────────────
  const installed = new WeakMap();
  const installing = new WeakSet();
  const pendingInstalls = new WeakMap();

  /** 每 agent 一次的诊断集合（plan §4.3：不得静默失效）。 */
  const warnedNoPresets = new WeakSet();
  const warnedNoNativeSubagent = new WeakSet();
  const informedNoModelSelection = new WeakSet();

  const presetService = () => ctx.get('agentPresets');
  const agentsService = () => ctx.get('agents');

  /**
   * 是否属于本插件的 composition。服务缺失时**每个 agent 记一次 warn**，
   * 让"策略不生效"可诊断，而不是静默跳过。
   */
  const isOurs = (agent) => {
    const service = presetService();
    if (service === undefined) {
      if (!warnedNoPresets.has(agent)) {
        warnedNoPresets.add(agent);
        ctx.logger.warn('dsh-submodel: 当前 profile 无 agentPresets 服务，策略不生效');
      }
      return false;
    }
    return belongsToComposition(agent, presetId, service);
  };

  /** 卸载一个 agent 上本插件装的全部东西（只动记录过的项）。 */
  const uninstallAgent = async (agent, reason) => {
    const record = installed.get(agent);
    textResolvers.delete(agent);
    if (record === undefined) return;
    installed.delete(agent);
    for (const dispose of [...record.disposers].reverse()) {
      try {
        await dispose();
      } catch (error) {
        ctx.logger.warn(
          `dsh-submodel: failed to dispose one registration for agent "${agent.id}" (${reason}): ${String(error)}`,
        );
      }
    }
    ctx.logger.info(`dsh-submodel: removed own install from agent "${agent.id}" (${reason})`);
  };

  /**
   * 为 agent 安装自动能力。幂等：已装直接返回；正在装共用同一 Promise。
   */
  const installAgent = async (agent) => {
    if (installed.has(agent)) return;
    const existing = pendingInstalls.get(agent);
    if (existing !== undefined) return existing;
    if (installing.has(agent)) return undefined;
    installing.add(agent);
    const task = (async () => {
      const scopedCtx = agent.ctx;
      const disposers = [];
      try {
        // 观看作用域＝**agent 对象本身**：`tools.view(agent)` 才是模型实际拿到的工具目录。
        // 传 `agent.ctx` 会退化成 global 视图，永远查不到 subagent。
        //
        // **判据必须在 try 内**：原生 subagent 在 `agent/created` 那一刻可能还没注册好，
        // 此时要**早退但清掉 installing 标记**——否则该 agent 被永久标记为"正在安装"，
        // 后续 reconcile 全部在守卫处返回，永远不再补装。
        const nativeDefinition = findNativeSubagent(ctx.tools, agent);
        if (nativeDefinition === undefined) {
          if (!warnedNoNativeSubagent.has(agent)) {
            warnedNoNativeSubagent.add(agent);
            ctx.logger.warn('dsh-submodel: 原生 subagent 未暴露 provider/model，delegate_task 不安装');
          }
          return; // 无选模能力 → 什么都不装，等下一次 tools/change / pre-step 重试
        }

        // **关键**：注册必须经 **agent 自己的 ctx**——既不能走插件顶层 ctx，也不能自建 scope。
        // 经 `agent.ctx.tools` 注册时 traceable service 把 effect 落到 `scopeOf(agent.ctx)`，
        // 既对该 agent 可见，也随 agent 一起释放。
        const tools = agent.ctx.tools;

        // ① 角色 guard：子代硬边界。**返回字符串即拒绝**（不是抛异常）。
        const guard = (exec) => {
          if (exec?.agent !== agent) return undefined;
          const toolCallName = exec?.name;
          if (typeof toolCallName !== 'string') return undefined;
          const callerRole = roleOf(agent.session?.requestHeader?.(), agent.options);
          if (callerRole !== 'child') return undefined;
          const forbidden = CHILD_FORBIDDEN_TOOLS.includes(toolCallName) || toolCallName.startsWith('subagent');
          if (!forbidden) return undefined;
          return `dsh-submodel: tool "${toolCallName}" is unavailable to a delegated subagent. ${childDelegationRefusal()}`;
        };
        disposers.push(tools.guard(guard));

        // ② 执行期硬边界的补充：非 Flash 顶层用原生 subagent 但没给完整显式 pair 时，
        //    拒绝并指向 delegate_task，防止模型绕开默认执行路由。
        const nativeGuard = (exec) => {
          if (exec?.agent !== agent) return undefined;
          if (exec?.name !== 'subagent') return undefined;
          const callerRole = roleOf(agent.session?.requestHeader?.(), agent.options);
          if (callerRole !== 'root') return undefined;
          const model = agent.session?.requestHeader?.()?.config?.model ?? agent.options?.model;
          if (typeof model === 'string' && model.toLowerCase().endsWith('flash')) return undefined; // Flash 顶层原生调用不改变行为
          const args = exec.arguments ?? {};
          const hasProvider = args.provider !== undefined && args.provider !== null && args.provider !== '';
          const hasModel = args.model !== undefined && args.model !== null && args.model !== '';
          if (hasProvider && hasModel) return undefined; // 完整显式 pair：放行
          return 'dsh-submodel: the native `subagent` tool needs an explicit and COMPLETE provider/model pair here. Omit the raw tool and use `delegate_task` for ordinary delegation (it applies the configured executor route), or name both provider and model.';
        };
        if (guardNativeSubagent) disposers.push(tools.guard(nativeGuard));

        // ③ assembly listener：先 await next()，再只替换自有段。
        const listener = async (assembly, context, next) => {
          const resolved = await next();
          try {
            const resolver = textResolvers.get(agent);
            const text = resolver === undefined ? null : resolver(resolved);
            if (text === null) return resolved;
            return {
              ...resolved,
              sections: resolved.sections.map((section) =>
                section.name === ROUTING_SECTION
                  ? { name: ROUTING_SECTION, text, interpolate: false }
                  : section,
              ),
            };
          } catch (error) {
            ctx.logger.warn(`dsh-submodel: assembly section left unchanged for agent "${agent.id}": ${String(error)}`);
            return resolved;
          }
        };
        disposers.push(scopedCtx.on('system-prompt/assemble', listener));

        // ④ 只有顶层注册统一委派入口（子代不再有委派能力）。
        const callerRole = roleOf(agent.session?.requestHeader?.(), agent.options);
        if (callerRole === 'root') {
          disposers.push(
            tools.register(createDelegateTool({ ctx: agent.ctx, nativeDefinition, executor, logger: ctx.logger })),
          );
        }

        // 正文解析器：角色固定，模式每次 assembly 现判。
        // `list_subagent_models` 不可见时**只门控正文段**（info 一次/agent），
        // 工具仍按上面的注册门控安装。
        textResolvers.set(agent, (resolved) => {
          const role = roleOf(agent.session?.requestHeader?.(), agent.options);
          if (role === 'child') return routingTextFor('child', '', renderContext);
          if (ctx.tools.get(toolName, agent) === undefined) {
            if (!informedNoModelSelection.has(agent)) {
              informedNoModelSelection.add(agent);
              ctx.logger.info(
                'dsh-submodel: 本会话未启用官方 subagent 模型选择，策略段不渲染；请在设置中启用 subagent-model-selection',
              );
            }
            return null;
          }
          return routingTextFor('root', resolveAssemblyModel(ctx, agent, resolved), renderContext);
        });

        installed.set(agent, { disposers });
        ctx.logger.info(`dsh-submodel: installed automatic routing on agent "${agent.id}" (role=${callerRole})`);
      } catch (error) {
        for (const dispose of [...disposers].reverse()) {
          try {
            await dispose();
          } catch {
            /* 清理失败不掩盖原始错误 */
          }
        }
        ctx.logger.error(`dsh-submodel: failed to install automatic routing on agent "${agent.id}": ${String(error)}`);
        throw error;
      } finally {
        installing.delete(agent);
      }
    })();
    pendingInstalls.set(agent, task);
    try {
      await task;
    } finally {
      pendingInstalls.delete(agent);
    }
  };

  /** 全量核对：属于本 composition 的装上，不属于的卸掉。 */
  const reconcile = () => {
    const agents = agentsService();
    if (agents === undefined) return;
    for (const candidate of agents.list()) {
      if (isOurs(candidate)) {
        installAgent(candidate).catch((error) => {
          ctx.logger.error(`dsh-submodel: reconcile install failed for "${candidate.id}": ${String(error)}`);
        });
      } else {
        void uninstallAgent(candidate, 'composition mismatch');
      }
    }
  };

  ctx.on('agent/created', async ({ agent: created }) => {
    if (!isOurs(created)) return;
    try {
      await installAgent(created);
    } catch (error) {
      // cordis 的事件发射不等待、也不捕获监听器返回的 Promise：这里必须自己兜住，
      // 否则一次安装失败会变成 unhandled rejection（纯 Node CLI 下默认终止进程）。
      // reconcile / pre-step 两条通道同样兜底，保证失败只上报、不炸宿主。
      ctx.logger.error(`dsh-submodel: agent/created install failed for "${created.id}": ${String(error)}`);
    }
  });
  ctx.on('agent/disposed', ({ agent: disposed }) => {
    void uninstallAgent(disposed, 'agent disposed');
  });
  ctx.on('tools/change', reconcile);
  /**
   * 兜底重试（每一步开始前再核一次）。
   *
   * 原生 `subagent` 在 `agent/created` 那一刻**可能还没注册好**，而此后**不一定再有
   * `tools/change`** → 只靠 `tools/change` 重试会永久漏装。`agent/pre-step` 是每个 agent
   * 每一步都会过的 waterfall，天然覆盖"最迟在这一步装上"；`installAgent` 幂等，已装时只是
   * 一次 WeakMap 命中即返回。**必须是 waterfall 监听器：不接管决策就返回 `next()`。**
   */
  ctx.on('agent/pre-step', ({ agent: stepping }, next) => {
    if (stepping !== undefined && !installed.has(stepping) && isOurs(stepping)) {
      void installAgent(stepping).catch((error) => {
        ctx.logger.error(`dsh-submodel: pre-step install failed for "${stepping.id}": ${String(error)}`);
      });
    }
    return next();
  });
  reconcile();

  // 根插件 cleanup：等自有安装全部卸载，再删状态。
  //
  // cordis 的插件拆卸通知是 `internal/plugin` 事件，listener 的 Promise 是 fire-and-forget；
  // 并没有名为 `dispose` 的事件被发射——因此原来的 `ctx.on('dispose', …)` 清理回调**永不执行**。
  // 两个通道都保留——谁先来谁触发，幂等。
  const cleanupAll = () => {
    if (uninstallAllTask !== undefined) return uninstallAllTask;
    const agents = agentsService();
    if (agents === undefined) return undefined;
    const tasks = [];
    for (const candidate of agents.list()) {
      tasks.push(uninstallAgent(candidate, 'plugin cleanup'));
      textResolvers.delete(candidate);
    }
    uninstallAllTask = Promise.all(tasks).finally(() => { uninstallAllTask = undefined; });
    return uninstallAllTask;
  };
  let uninstallAllTask;
  ctx.on('dispose', cleanupAll);
  ctx.on('internal/plugin', (fiber) => {
    // 只在"自己这条 fiber 被拆掉"的那一刻触发（该事件正是 emitPluginDisposed 的载荷）。
    if (fiber !== ctx.fiber) return;
    void cleanupAll();
  });
}

/**
 * 解析"本次 assembly 用的主模型"。
 *
 * 顺序（必须对齐 GUI 即将发起的那笔请求，不能用过期的创建期值）：
 * 1. **session-local selection**——GUI 的 `selectModel` 走 `installModelSelection(agent.ctx, ...)`，
 *    这是唯一能反映"还没提交的新选择"的通道；
 * 2. `assembly.variables.model`——宿主的变量（注意它源自 `context.agent.options.model`，
 *    即创建期值，仅作回退）；
 * 3. `agent.options.model`——最后的兜底。
 *
 * 三条都拿不到时**明确报错**，不猜模型（猜错会把整段策略换成另一套且不报错）。
 *
 * @param ctx - 插件顶层 ctx（用于取 sessionController）。
 * @param agent - 目标 agent。
 * @param assembly - 已完成 next() 的 assembly。
 * @returns 模型 ID。
 */
function resolveAssemblyModel(ctx, agent, assembly) {
  try {
    const controller = ctx.get('sessionController');
    const selection = controller?.agents?.selectionFor?.(agent)?.current;
    if (typeof selection?.model === 'string' && selection.model !== '') return selection.model;
  } catch {
    // selectionFor 在投影未注册等边界会抛；回退到宿主变量，不中断 assembly。
  }
  const fromAssembly = assemblyModelOrUndefined(assembly);
  if (fromAssembly !== undefined) return fromAssembly;
  const fromOptions = agent?.options?.model;
  if (typeof fromOptions === 'string' && fromOptions !== '') return fromOptions;
  return modelFromAssembly(assembly); // 抛出明确配置错误
}

/** 宽松取 `assembly.variables.model`；缺失返回 undefined（不抛）。 */
function assemblyModelOrUndefined(assembly) {
  const model = assembly?.variables?.model;
  return typeof model === 'string' && model !== '' ? model : undefined;
}
