/**
 * dsh-submodel / delegation.js —— 统一委派入口 `delegate_task`。
 *
 * ## 为什么是"再调一次原生 subagent"，而不是自己创建子代
 *
 * 原生的创建校验（allowlist / LLM preflight / permission / depth / persona / toolFilter）
 * 全部发生在 `@deepseek-ai/dsh-tool-subagent` 的 `execute` 内部，**在创建孩子之前**
 * （0.2.2：`dsh-tool-subagent/lib/index.js` 的 `subagent` 工具定义里，`execute(args, exec)`
 * 先读 policy、再 assert 允许路由、再 preflight、最后才 `ctx.subagents.startActivation(...)`）。
 * 绕过它去 `subagents.startActivation(...)` 就等于同时绕过授权与预检——那正是本模块**不能**做的事。
 *
 * 所以本工具只做两件事：**改参数** + **经公开 `ctx.tools.execute` 发起一次真正的原生调用**。
 *
 * ## 0.2.2 的四个契约（都已在本机安装版源码确认，别按 0.2.1 的记忆改）
 *
 * 1. **工具执行 API 是批量签名**（0.2.2 起的硬变更）：`ctx.tools.execute(input)`，
 *    `input = {calls:[{id,name,arguments}], signal, agent?, toolSet?, log?, maxParallelToolCalls?}`
 *    （`dsh-tools/lib/pipeline.js` 的 `executeToolBatch` 解构即证）。返回
 *    `{results:[{callId,result}], additionalContexts, concluded}`；
 *    `arguments` 必须是 **JSON 文本**（pipeline 里 `parseArguments` 会 `JSON.parse`），
 *    单次调用就是"只含一个 call 的批量"。
 * 2. **没有 `parent` / `rootCallId` 通道**：批量 API 不暴露它们，`exec` 里也没有 turn/step。
 *    因此嵌套调用在事件归属上与顶层调用无法区分（`parent` 现在只有 PTC 内部用）。
 *    本模块**不传 `log`**：0.2.1 的 `execute` 同样不写 `tool/call`/`tool/result`，不传才与旧行为一致。
 * 3. **body 的返回值一律被当成"成功 value"**（`dsh-tools/lib/pipeline.js` 的
 *    `createSuccessResult` / `normalizeDispatchResult`）：直接 return 一个 `isError:true` 的结果
 *    **不会**变成错误——外层仍是成功。所以取到的 result `isError` 时必须**抛 Error**，
 *    由外层统一 materialize 成失败结果。
 * 4. **同层同名注册会冲突**：所以本工具叫 `delegate_task`，不叫 `subagent`，也不能去 shadow 它。
 *
 * @module dsh-submodel/delegation
 */
import {
  DELEGATE_TOOL_NAME,
  classifyExplicitRoute,
  modeForRoute,
  resolveCallerRole,
  resolveDelegationArgs,
  routeKey,
} from './policy.js';

/** 子调用 callId 的后缀：既能被日志一眼认出，又不会和原生 callId 撞（原生用随机 id）。 */
const NESTED_CALL_SUFFIX = ':delegate';

/** 子调用固定走原生 `subagent` 工具名。 */
const NESTED_TOOL_NAME = 'subagent';

/**
 * 宿主拒绝显式路由时的追加提示：这是"宿主授权表没配置"的典型症状，不给出路模型只会重试。
 * 与原生错误同语言（英文），并点名两个修复入口。
 */
const SESSION_ROUTE_HINT =
  'hint: enable the host subagent model selection setting and add this route to its `allowedModels`, ' +
  'or run `configure_submodel` (or follow the README two-step configuration) to write both the plugin config and the host authorization.';

/**
 * 从原生 `subagent` 的工具定义深拷贝参数 schema。
 *
 * **必须是"每次安装时从本轮 native 定义取"**，不能把 schema 写死在源码里：native 定义
 * 会随 DSH 升级增删参数，写死就等于把新参数悄悄丢掉。`parameters` 是结构化 JSON Schema
 * （普通对象），可安全深拷贝。
 *
 * @param nativeDefinition - 本会话可见的原生 subagent 工具定义。
 * @returns 参数 schema 深拷贝。
 */
export function cloneNativeParameters(nativeDefinition) {
  const parameters = nativeDefinition?.parameters;
  if (parameters === undefined || parameters === null || typeof parameters !== 'object') {
    throw new Error('delegate_task: the native `subagent` definition exposes no parameters to clone');
  }
  return structuredClone(parameters);
}

/**
 * 检查本会话是否具备"能选模的委派能力"：原生 subagent 可见 + 参数里真的有 provider/model。
 * 缺任一项就不装 `delegate_task`——装了也是个只会失败的入口。
 *
 * **判据读 `parameters.properties`，不是 `parameters` 顶层**：宿主 `defineTool` 交付的是
 * JSON Schema（`{type:'object', properties:{…}, required:[…]}`）。2026-10-05 真实宿主实测：
 * `hasTopLevelProvider=false` / `hasPropertiesProvider=true`；读顶层会恒为 false，于是本函数
 * 永远返回 undefined、整条安装路径静默跳过（四个工具一个都不出现）。
 *
 * **0.2.2 复验（2026-11-10）**：`provider`/`model` 参数只在 `dsh-tool-subagent` 的
 * `modelSelection:true` 时才加入 schema（Config 默认 false）。Desktop/Web preset 为 spawn
 * 启用该开关，所以本机判据仍然成立；但它是**弱判据**——换了 `toolName` 或关掉
 * `modelSelection` 的部署里会判不出，那时宁可不装。
 *
 * @param tools - 工具注册表（ctx.tools）。
 * @param scope - 观看作用域：**传 agent 对象本身**。宿主自己的调用范式就是这样
 *   （`dsh-tool-subagent/lib/index.js` 的系统提示段也写 `ctx.tools.get(tool.name, context.scope)`）。
 * @returns 原生定义或 undefined。
 */
export function findNativeSubagent(tools, scope) {
  const definition = tools.get?.(NESTED_TOOL_NAME, scope);
  if (definition === undefined) return undefined;
  const properties = definition.parameters?.properties;
  const hasRouteParams = properties?.provider !== undefined && properties?.model !== undefined;
  return hasRouteParams ? definition : undefined;
}

/**
 * 组装嵌套调用要用的批量输入。**纯计算**，便于单测。
 *
 * 0.2.2 只认批量形状：`calls[].arguments` 是 JSON 文本，返回结果按 `callId` 对回。
 * `toolSet` 只在存在时透传（与当前步的准入集一致；`toolSet.view(scope)` 在 scope 不匹配时
 * 返回空 Map，所以 `agent` 必须是本步 resolve 时的同一个 agent 对象）。
 *
 * @param outerExec - 外层（delegate_task 自己的）exec。
 * @param newArgs - 已解析好的子代参数。
 * @returns `ToolBatchInput` 片段（可直接交给 `ctx.tools.execute`）。
 */
export function buildNestedCall(outerExec, newArgs) {
  return {
    calls: [
      {
        id: `${outerExec.callId}${NESTED_CALL_SUFFIX}`,
        name: NESTED_TOOL_NAME,
        arguments: JSON.stringify(newArgs),
      },
    ],
    agent: outerExec.agent,
    signal: outerExec.signal,
    ...(outerExec.toolSet === undefined ? {} : { toolSet: outerExec.toolSet }),
  };
}

/**
 * 从批量结果里取本次子调用的 result。找不到返回 undefined（调用方必须当失败处理）。
 * @param batch - `ctx.tools.execute` 的返回值。
 * @param callId - 本模块派生的子调用 id。
 * @returns 子调用的 result 快照或 undefined。
 */
export function resultOfNestedCall(batch, callId) {
  const results = batch?.results;
  if (!Array.isArray(results)) return undefined;
  return results.find((entry) => entry?.callId === callId)?.result;
}

/**
 * 把子的失败结果转成一段**可读诊断**（保留原始信息，不吞）。
 * @param inner - 原生调用返回的结果快照。
 * @returns 错误文本。
 */
export function describeInnerFailure(inner) {
  const parts = [];
  const message = inner?.error?.message;
  if (typeof message === 'string' && message !== '') parts.push(message);
  const info = inner?.error?.info;
  if (info !== undefined && info !== null) {
    try {
      parts.push(typeof info === 'string' ? info : JSON.stringify(info));
    } catch {
      parts.push('[unserializable error.info]');
    }
  }
  const content = Array.isArray(inner?.content) ? inner.content : [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  if (parts.length === 0) parts.push('the nested subagent call failed without a diagnostic');
  const text = parts.join('\n');
  // 宿主对"未授权路由"的拒绝是 0.2.x 最常见的失败；原样返回会让模型只是重试，补一句修复入口。
  if (text.includes('is not allowed for this Session')) return `${text}\n${SESSION_ROUTE_HINT}`;
  return text;
}

/**
 * 把批量执行器抛出的内部错误转成可读诊断。
 *
 * 0.2.2 的 `executeToolBatch` 只把**调度器内部失败**包成 `ToolBatchExecutionError`，
 * message 固定是 "Tool batch execution failed"，根因在 `cause` 里——不把 cause 带出来，
 * 模型就只会看到那句通用文案。
 * @param error - 抛出的错误。
 * @returns 诊断文本。
 */
export function describeBatchFailure(error) {
  const parts = [String(error?.message ?? error)];
  let cause = error?.cause;
  for (let depth = 0; cause !== undefined && cause !== null && depth < 3; depth += 1) {
    const message = typeof cause?.message === 'string' ? cause.message : String(cause);
    if (message !== '') parts.push(`caused by: ${message}`);
    cause = cause?.cause;
  }
  return parts.join('\n');
}

/**
 * 创建 `delegate_task` 的工具定义。
 *
 * @param options - 依赖注入（全部来自 live agent 的 scope）：
 *   - `ctx`：该 agent 的 runtime context（提供 tools）
 *   - `nativeDefinition`：本轮原生 subagent 定义（参数与 output 的来源）
 *   - `executor`：配置的执行路由 `{provider, model, reasoningEffort}`
 *   - `economyRoutes`：配置的经济路由列表（执行期模式判定用）
 *   - `logger`：日志器
 * @returns 可直接 `ctx.tools.register(...)` 的工具定义。
 */
export function createDelegateTool({ ctx, nativeDefinition, executor, experts = [], modelGroups, economyRoutes = [], watchdog, logger }) {
  const routingPolicy = { executor, modelGroups, economyRoutes: Array.isArray(economyRoutes) ? economyRoutes : [] };
  const parameters = cloneNativeParameters(nativeDefinition);
  // output 同样复用原生 schema/render，保持 runId/agentId 与 foreground/continuable 格式一致。
  const output = nativeDefinition.output;
  if (output === undefined || output === null) {
    throw new Error('delegate_task: the native `subagent` definition exposes no output contract to reuse');
  }

  return {
    name: DELEGATE_TOOL_NAME,
    description:
      'Start an independent subagent and get its name. The runtime delivers a completion notice. ' +
      'Omit provider and model for ordinary delegation, or supply both to select a model.',
    parameters,
    output,
    async execute(args, exec) {
      const caller = resolveCallerRole(exec);
      if (!caller.ok) throw new Error('This delegation needs an active main conversation.');
      if (caller.role !== 'root') throw new Error('Only the main conversation can delegate work.');

      const accepted = caller.header?.config ?? caller.agent.options ?? {};
      const route = {
        provider: typeof accepted.provider === 'string' ? accepted.provider : '',
        model: typeof accepted.model === 'string' ? accepted.model : '',
      };
      const mode = modeForRoute(route, routingPolicy);
      const resolved = resolveDelegationArgs(args, mode, executor, modelGroups);
      if (!resolved.ok) {
        throw new Error(classifyExplicitRoute(args).kind === 'invalid'
          ? 'To select a model, provide both its provider and model.'
          : 'Choose an execution model in the plugin settings or run the setup tool.');
      }

      const childRoute = resolved.applied === 'inherit' ? route : resolved.args;
      const childKey = routeKey(childRoute);
      const explicitExpert = resolved.applied === 'explicit' && experts.some(expert => routeKey(expert) === childKey);
      const isExecutor = modelGroups ? modelGroups.executors.some(model => routeKey(model) === childKey)
        : childKey === routeKey(executor);
      const tier = explicitExpert ? 'expert' : isExecutor ? 'executor' : undefined;
      let ticket;
      try { ticket = watchdog?.begin(resolved.args, childRoute, tier, exec); }
      catch { logger?.warn?.('dsh-submodel: monitoring could not start'); }
      let receipt;
      try {
        const nested = buildNestedCall(exec, ticket?.args ?? resolved.args);
        let batch;
        try { batch = await ctx.tools.execute(nested); }
        catch {
          throw new Error('Delegation could not start. Check the subagent panel before trying again.');
        }
        const inner = resultOfNestedCall(batch, nested.calls[0].id);
        if (inner === undefined) {
          throw new Error('Delegation returned no confirmation. Check the subagent panel before trying again.');
        }
        if (inner.isError === true) {
          if (describeInnerFailure(inner).includes('is not allowed for this Session')) {
            throw new Error('This model is not allowed for the current conversation. Check the subagent settings and start a new conversation.');
          }
          throw new Error('Delegation was refused. Check model availability and permission in the subagent settings.');
        }
        receipt = inner.value;
        for (const context of inner.additionalContexts ?? []) exec.deferContext(context);
        if (inner.concludesTurn === true) exec.concludeTurn();
        return receipt;
      } finally {
        try { watchdog?.finish(ticket, receipt); }
        catch { logger?.warn?.('dsh-submodel: monitoring could not confirm the start'); }
      }
    },
  };
}
