/**
 * dsh-submodel / delegation.js —— 统一委派入口 `delegate_task`。
 *
 * ## 为什么是"再调一次原生 subagent"，而不是自己创建子代
 *
 * 原生的创建校验（allowlist / LLM preflight / permission / depth / persona / toolFilter）
 * 全部发生在 `@deepseek-ai/dsh-tool-subagent` 的 `execute` 内部，**在创建孩子之前**
 * （`dsh-tool-subagent/lib/index.js:491-506`）。绕过它去 `subagents.startContinuable(...)`
 * 就等于同时绕过授权与预检——那正是本模块**不能**做的事。
 *
 * 所以本工具只做两件事：**改参数** + **经公开 `ctx.tools.execute` 发起一次真正的原生调用**
 * （`dsh-tools/lib/index.js:3116` 是公开入口）。这样原生的一切校验照旧生效。
 *
 * ## 三个必须遵守的坑（都已在源码确认，别踩）
 *
 * 1. **同层同名注册会冲突**（`dsh-tools:2878`），所以本工具叫 `delegate_task`，
 *    不叫 `subagent`，也不能去 shadow 它。
 * 2. **body 的返回值一律被当成"成功 value"**（`dsh-tools:3540`）：直接 return 一个
 *    `isError:true` 的子结果**不会**变成错误——外层仍是成功。所以 inner.isError 时
 *    **必须抛 Error**，由外层统一materialize 成失败结果。
 * 3. **嵌套调用要带全 token 链**：`callId`（派生）、`rootCallId`（继承）、`parent`（exec.token）、
 *    同一个 `signal`。漏掉任一项，原生的事件归属或取消传播就会错位。
 *
 * @module dsh-submodel/delegation
 */
import {
  DELEGATE_TOOL_NAME,
  MODE_BOSS,
  resolveCallerRole,
  resolveDelegationArgs,
} from './policy.js';

/** 子调用 callId 的后缀：既能被日志一眼认出，又不会和原生 callId 撞（原生用随机 id）。 */
const NESTED_CALL_SUFFIX = ':delegate';

/**
 * 从原生 `subagent` 的工具定义深拷贝参数 schema。
 *
 * **必须是"每次安装时从本轮 native 定义取"**，不能把 schema 写死在源码里：native 定义
 * 会随 DSH 升级增删参数，写死就等于把新参数悄悄丢掉。`parameters` 是结构化的普通对象
 * （`structuredClone` 在 `dsh-system-prompt:327` 也是这么拷的），可安全深拷贝。
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
 * @param tools - 工具注册表（ctx.tools）。
 * @param scope - 观看作用域：**传 agent 对象本身**。宿主自己的调用范式就是这样
 *   （`dsh-file-reference-local:346` 的 `agent.ctx.tools.get("read", agent)`、`dsh-tools:3140`
 *   的 `this.get(name, agent)`）；传 `agent.ctx` 会退化成 global 视图，永远查不到 scoped 工具。
 * @returns 原生定义或 undefined。
 */
export function findNativeSubagent(tools, scope) {
  const definition = tools.get?.('subagent', scope);
  if (definition === undefined) return undefined;
  const properties = definition.parameters?.properties;
  const hasRouteParams = properties?.provider !== undefined && properties?.model !== undefined;
  return hasRouteParams ? definition : undefined;
}

/**
 * 组装嵌套调用要用的子参数与 token 链。**纯计算**，便于单测。
 * @param outerExec - 外层（delegate_task 自己的）exec。
 * @param newArgs - 已解析好的子代参数。
 * @returns `{callId, rootCallId, name, arguments, agent, parent, signal}`。
 */
export function buildNestedCall(outerExec, newArgs) {
  return {
    callId: `${outerExec.callId}${NESTED_CALL_SUFFIX}`,
    rootCallId: outerExec.rootCallId ?? outerExec.callId,
    name: 'subagent',
    arguments: newArgs,
    agent: outerExec.agent,
    parent: outerExec.token,
    signal: outerExec.signal,
  };
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
  return parts.join('\n');
}

/**
 * 创建 `delegate_task` 的工具定义。
 *
 * @param options - 依赖注入（全部来自 live agent 的 scope）：
 *   - `ctx`：该 agent 的 runtime context（提供 tools/subagents）
 *   - `nativeDefinition`：本轮原生 subagent 定义（参数与 output 的来源）
 *   - `executor`：配置的执行路由 `{provider, model, reasoningEffort}`
 *   - `logger`：日志器
 * @returns 可直接 `ctx.tools.register(...)` 的工具定义。
 */
export function createDelegateTool({ ctx, nativeDefinition, executor, logger }) {
  const parameters = cloneNativeParameters(nativeDefinition);
  // output 同样复用原生 schema/render，保持 runId/agentId 与 foreground/continuable 格式一致。
  const output = nativeDefinition.output;
  if (output === undefined || output === null) {
    throw new Error('delegate_task: the native `subagent` definition exposes no output contract to reuse');
  }

  return {
    name: DELEGATE_TOOL_NAME,
    description:
      'Delegate one independent task to a subagent and return its result. ' +
      'Parameters are identical to the native `subagent` tool. Omit provider/model to inherit the ' +
      'current route (Flash) or use the configured cheap executor route (non-Flash). ' +
      'An explicit route must name provider AND model together. ' +
      'Prefer this over the raw `subagent` tool for ordinary delegation.',
    parameters,
    output,
    async execute(args, exec) {
      // ① 调用方身份必须是 live Agent，且必须是合格 standard 顶层。
      const caller = resolveCallerRole(exec);
      if (!caller.ok) throw new Error(caller.reason);
      if (caller.role !== 'root') throw new Error(`delegate_task is only available to a top-level agent (got role "${caller.role}")`);

      // ② 同步快照执行期模式，再 await：描述"当前发起这笔调用的主脑"，
      //    不读 GUI 里可能中途变化的 pending selection。
      const accepted = caller.header?.config ?? caller.agent.options ?? {};
      const mode = (() => {
        const model = accepted.model;
        return typeof model === 'string' && model.toLowerCase().endsWith('flash') ? 'economize' : MODE_BOSS;
      })();

      // ③ 解析最终子代参数（原 exec/arguments 不可变，派生新对象）。
      const resolved = resolveDelegationArgs(args, mode, executor);
      if (!resolved.ok) throw new Error(resolved.reason);

      logger.info(
        `dsh-submodel: delegate_task session=${caller.header?.id ?? '?'} call=${exec.callId} mode=${mode} ` +
          `route=${resolved.applied} -> ${resolved.args.provider ?? '(inherit)'}/${resolved.args.model ?? '(inherit)'}`,
      );

      // ④ 发起一次真正的原生调用：保留它的全部校验与事件链。
      const nested = buildNestedCall(exec, resolved.args);
      const inner = await ctx.tools.execute(nested);

      // ⑤ inner.isError 必须**抛出**：body 返回 error 对象会被当成功 value（dsh-tools:3540）。
      if (inner?.isError === true) {
        throw new Error(describeInnerFailure(inner));
      }

      // ⑥ 转移延迟上下文 / 结论标记，再只返回 inner.value。
      for (const context of inner?.additionalContexts ?? []) exec.deferContext(context);
      if (inner?.concludesTurn === true) exec.concludeTurn();

      return inner.value;
    },
  };
}
