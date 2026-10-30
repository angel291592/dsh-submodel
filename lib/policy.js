/**
 * dsh-submodel / policy.js —— 纯函数层：角色与模式判定、统一入口的路由默认值、正文模板与渲染。
 *
 * 这里是**没有副作用、不 import 任何 runtime helper** 的一层，唯一目的就是能被单测直接喂输入、
 * 断言输出。宿主对象（tool 定义、Service、fiber）一律不进这个文件——否则纯函数测试就得先造
 * 一整套假 Host，测试本身会变成对 mock 的测试。
 *
 * 两条正交的判定（不要合并，它们回答不同的问题）：
 *
 * 1. **模式（mode）**：只由「本次 assembly 的主模型 ID 是否以 `flash` 结尾」决定。
 *    用户在 GUI 里选的是主模型；主模型是 Flash → 走 `economize`（自己干日常，委派继承自己）；
 *    不是 Flash → 走 `boss`（强主脑理解/判断/写作，可验证的执行块默认派执行路由）。
 *    **只看模型 id，不看 provider、显示名或价格**——这是用户约定的唯一规则。
 *
 * 2. **角色（role）**：`root` 还是 `child`，由 header 的 `origin`/`delegationDepth` 判定。
 *    子代是执行/专家角色，**不再**按 Flash 后缀切换主脑策略；子代永远禁止再委派。
 *
 * 为什么两个时点分别用不同来源（别改成"都用同一个"）：
 * - **提示词阶段**用 `assembly.variables.model`——它描述"GUI 即将发起的这笔请求"，
 *   首轮和刚换模都能立刻对齐；
 * - **执行阶段**用"最新已接受的 request header config"——它描述"正在发起这笔工具调用的主脑"，
 *   不会读到 GUI 里那个还没提交的 pending 选择。
 * 用错任一个都会在"刚换模但还没发请求"的窗口里判错模式。
 *
 * **正文与路由解耦**：本文件内置的模板里**不得出现任何具体 provider/model 名**。执行路由与
 * 专家路由只经 `{{executorRoute}}` / `{{expertRoutes}}` 占位符注入（见 renderTemplate），
 * 这样同一份代码既能在任意用户的模型体系下工作，也不会把某个部署的私有路由泄进公版正文。
 *
 * @module dsh-submodel/policy
 */

/** 模式取值：Flash 主脑（低成本主脑＋专家）/ 非 Flash 主脑（强主脑＋执行路由）。 */
export const MODE_ECONOMIZE = 'economize';
export const MODE_BOSS = 'boss';

/** 统一委派入口的工具名（唯一顶层注册）。 */
export const DELEGATE_TOOL_NAME = 'delegate_task';

/** 本模块全局注册的唯一提示词段名。 */
export const ROUTING_SECTION = 'tool:model-routing';

/** 段顺序：紧接 SECTION_ORDERS.TOOL_SUBAGENT（2800）、TOOL_REPORT（2900）之前。 */
export const ROUTING_ORDER = 2850;

/** 递归限制要隐去的工具面（子代硬边界）。 */
export const CHILD_FORBIDDEN_TOOLS = Object.freeze([
  DELEGATE_TOOL_NAME,
  'subagent',
  'subagent_fork',
  'workflow',
  'spawn_teammate',
]);

/**
 * 唯一规则：模型 ID 以 `flash` 结尾即 Flash 模式。
 * 大小写不敏感、必须是**后缀**（`flash-lite` 不算），空值/非字符串不算。
 * @param model - 模型 ID（可能来自 GUI 选择、header、或 undefined）。
 * @returns 是否为 Flash 主脑。
 */
export function isFlashModel(model) {
  return typeof model === 'string' && model.toLowerCase().endsWith('flash');
}

/**
 * 由模型 ID 判定本次顶层模式。
 * @param model - 模型 ID。
 * @returns {MODE_ECONOMIZE} 或 {MODE_BOSS}。
 */
export function modeForModel(model) {
  return isFlashModel(model) ? MODE_ECONOMIZE : MODE_BOSS;
}

/**
 * 判定调用者角色。**子代**的判据是 header 的 `origin === 'subagent'` 或正的 delegationDepth；
 * 刻意不用 `parentSession`（普通用户 fork 也带 parentSession，那不是子代）。
 * @param header - session header（可为 undefined）。
 * @param options - agent options（作为 depth 的兜底来源，可为 undefined）。
 * @returns {'child'|'root'}。
 */
export function roleOf(header, options) {
  if (header !== undefined && header !== null) {
    if (header.origin === 'subagent') return 'child';
    const depth = header.delegationDepth;
    if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return 'child';
  }
  const optionDepth = options?.subagentDepth;
  if (typeof optionDepth === 'number' && Number.isFinite(optionDepth) && optionDepth > 0) return 'child';
  return 'root';
}

/**
 * 从 execution context 判定角色。`exec.agent` 是唯一权威来源：
 * 它必须存在且是 live Agent（有 session.requestHeader 与 options）。
 * @param exec - 工具执行输入（含 agent）。
 * @returns {{ok: true, role: 'root'|'child', header: object|undefined, agent: object}}
 *          或 `{ok: false, reason: string}`。
 */
export function resolveCallerRole(exec) {
  const agent = exec?.agent;
  if (agent === undefined || agent === null) {
    return { ok: false, reason: 'delegate_task requires a calling agent (exec.agent was undefined)' };
  }
  if (typeof agent.session?.requestHeader !== 'function') {
    return { ok: false, reason: 'delegate_task requires a live Agent with a session header (exec.agent looked stale)' };
  }
  const header = agent.session.requestHeader();
  const role = roleOf(header, agent.options);
  return { ok: true, role, header, agent };
}

/**
 * 显式路由的成对性校验。**只给一个必须立即失败**，绝不偷偷补另一个（那会让"我只想换模型"
 * 变成"换到某条我从没授权的渠道"）。
 * @param args - 工具入参（含可选 provider/model/reasoning_effort）。
 * @returns `{kind:'none'}` / `{kind:'pair', provider, model}` / `{kind:'invalid', reason}`。
 */
export function classifyExplicitRoute(args) {
  const provider = args?.provider;
  const model = args?.model;
  const hasProvider = provider !== undefined && provider !== null && provider !== '';
  const hasModel = model !== undefined && model !== null && model !== '';
  if (hasProvider && hasModel) {
    return { kind: 'pair', provider: String(provider), model: String(model) };
  }
  if (hasProvider || hasModel) {
    const given = hasProvider ? `provider "${String(provider)}"` : `model "${String(model)}"`;
    const missing = hasProvider ? 'model' : 'provider';
    return {
      kind: 'invalid',
      reason: `delegate_task received ${given} without ${missing}: an explicit child route must name provider AND model together`,
    };
  }
  return { kind: 'none' };
}

/**
 * 计算这次委派的最终子代参数。
 *
 * 规则（四类分支都要覆盖）：
 * - **完整显式 pair**：原样保留，**不注入策略 effort**（让原生规则决定继承兼容 effort 或清掉不兼容的）；
 * - **只给一个**：失败（见 classifyExplicitRoute）；
 * - **无显式路由 + Flash 主脑**：不补任何 provider/model（子代继承当前 Flash）；
 * - **无显式路由 + 非 Flash 主脑**：补配置的 executor pair；未给 reasoning_effort 时补 max，
 *   给了就保留——max 仅作缺省，不覆盖调用方已指定的档位。
 *
 * 专家路由完全由配置决定：本函数不认识任何具体 provider/model 名，也不做"某条路由只能兜底"
 * 之类的硬编码特判（那会把某个部署的私有约定写进公版代码）。
 *
 * @param args - 原始工具入参（**只读，不修改**）。
 * @param mode - modeForModel 的结果。
 * @param executor - 配置的 `{provider, model, reasoningEffort}`。
 * @returns `{ok:true, args: newArgs, applied: 'explicit'|'executor'|'inherit'}` 或 `{ok:false, reason}`。
 */
export function resolveDelegationArgs(args, mode, executor) {
  const route = classifyExplicitRoute(args);
  if (route.kind === 'invalid') return { ok: false, reason: route.reason };
  // 派生新对象：原 exec/arguments 由 tools runtime 冻结，改不得。
  const next = { ...args };
  if (route.kind === 'pair') return { ok: true, args: next, applied: 'explicit' };
  if (mode !== MODE_BOSS) {
    return { ok: true, args: next, applied: 'inherit' };
  }
  if (executor === undefined || executor === null || !executor.provider || !executor.model) {
    return { ok: false, reason: 'non-Flash delegation has no configured executor route (config.executor.provider/model is required)' };
  }
  next.provider = executor.provider;
  next.model = executor.model;
  if (next.reasoning_effort === undefined || next.reasoning_effort === null || next.reasoning_effort === '') {
    // 只在"没给"时补默认；给了就保留调用方/配置的原值。
    next.reasoning_effort = executor.reasoningEffort ?? 'max';
  }
  return { ok: true, args: next, applied: 'executor' };
}

// ── 正文模板与渲染 ────────────────────────────────────────────────────────────

/** 顶层 Flash（economize）：主脑自己干日常，委派继承自己，只在瓶颈时显式点名专家。 */
const ECONOMIZE_TEMPLATE = `## 模型路由：Flash 主脑（主脑自己干，瓶颈才升级）

当前主模型是 Flash 档。默认路径＝**你自己完成**：事实性查证、读写代码、跑命令与测试、检索汇总、拆解编排，以及把可并行的取证/执行子任务交给 \`delegate_task\`（**不传 provider/model**，子代继承当前 Flash 路由，省 token）。这些任务不要动用专家模型。

只有下面两种情况才升级；需要升级时再按领域**显式**选模型：
1. 问题本身属于**复杂代码/逻辑判断**——跨模块契约、状态机、并发与时序、不可逆数据变更、多方案权衡，且你自己无法自证；
2. 任务本身超出你的执行上限（反复失败、需要更强推理才能推进）。

已配置的专家路由（升级时从这里点名，\`provider\` 与 \`model\` 必须成对传）：
{{expertRoutes}}

**"需要独立审查/复核"本身不是升级理由**。复核默认交给普通子代理（\`delegate_task\` 不传 \`provider\`/\`model\`，子代继承当前路由）；只有当**被复核的东西本身**满足上面第 1 条时才点名专家。

调用方式：普通任务统一走 \`delegate_task\`，它的参数与原生 \`subagent\` 相同；\`provider\` 与 \`model\` 必须**成对**传，只给一个会立即失败。不确定有哪些授权路由时先调 \`list_subagent_models\`。\`reasoning_effort\` 以各路由支持的档位为准，不传时用配置缺省，显式档位优先。三个都不传就继承主模型路由，即默认路径。升级前先把证据收齐，并把已知事实、约束、已试过的方案写进 prompt——子智能体看不到本会话历史。

需要多方校验或讨论时：在同一条消息里并发起两个 \`delegate_task\`，给**完全相同**的 brief 且**彼此不可见**，然后由你自己比对分歧、下判断；只有在出现实质分歧时，才把对方的**理由**回传给各自，要求逐条反驳或让步。

纪律：专家结论必须被明确处置——要么采纳，要么写出驳回理由及依据，不得静默忽略。子智能体失败或超时时，明确标注"未获得专家意见"并降级为自证，不得假装已咨询过。`;

/** 顶层非 Flash（boss）：主脑负责理解/判断/写作，可验证的执行块默认派执行路由。 */
const BOSS_TEMPLATE = `## 模型路由：强主脑（你负责判断，可验证的执行块默认派执行路由）

当前主模型是强主脑档。**理解、拆解、关键判断、关键代码与最终写作由你自己完成**——不要把这些外包出去。

可验证的**执行块**默认用 \`delegate_task\` 派给配置的执行路由（**不传 provider/model**：会自动补 \`{{executorRoute}}\`，未点名档位时用配置缺省，显式档位优先）：检索、读取、批量命令、结构化的资料整理、边界清晰的局部实现。不是每一个 \`read\`/\`pwd\` 都要派工——**按"块"委派并收回原始证据**，别把关键推理整体外包。

需要更强模型时**显式**点名——判据是**问题本身的复杂度**，不是"要不要复核"（\`provider\` 与 \`model\` 必须成对传，只给一个立即失败；完整显式路线不会被改写）：
1. 问题本身属于**复杂代码/逻辑判断**——跨模块契约、状态机、并发与时序、不可逆数据变更、多方案权衡，且你自己无法自证；
2. 任务本身超出你的执行上限（反复失败、需要更强推理才能推进）。

已配置的专家路由：
{{expertRoutes}}

不确定有哪些授权路由时先调 \`list_subagent_models\`。

**"需要独立审查/复核"本身不是升级理由**。复核默认交给普通子代理（\`delegate_task\` 不传 \`provider\`/\`model\`，走配置的执行路由）；只有当**被复核的东西本身**满足上面第 1 条时才点名专家。
派出子代理后不要反复轮询：\`delegate_task\` 前台调用会直接返回结果；需要查看在线子代理、追加消息或停止时，用 \`list_agents\` / \`send_message\` / \`interrupt_agent\`。

原生 \`subagent\` 仍是**显式专家入口**：在本模式下，它若不带**完整**的 provider/model 对会被拒绝并指向 \`delegate_task\`——这是为了不让"顺手用 subagent"绕过执行路由默认值。

子代回来后按证据复核，不要只读它的结论。子智能体失败或超时时，明确标注"未获得该路线的结果"并降级为自证，不得假装已咨询过。`;

/** 子代正文：**固定执行职责**，不含任何主脑升级策略（子代不再切换主脑策略，也禁止再派工）。 */
const CHILD_TEXT = `## 你的角色：被委派的执行 / 专家子智能体

你没有再次委派的能力：\`delegate_task\`、\`subagent\`、\`subagent_fork\`、\`workflow\`、\`spawn_teammate\` 在本会话都不可用，调用会被拒绝。任务超出你的能力或权限时，**不要重试被拒绝的操作**，直接在回复里说明限制，交给父代处理。

你收到的是一次**边界清晰的任务**，不是整个会话的上下文。请：
1. 只做被要求的事，不擅自扩大范围、不顺手重构；
2. 需要读文件/跑命令就实际去读、去跑——**不要凭记忆或推断作答**；
3. 汇报时给出**原始证据**：实际读了哪个文件（绝对路径）、实际命令与关键输出、关键行号，以及你验证过什么、没验证什么；
4. 结论与证据分开写。不确定就明说"不确定"，不要用更像样的措辞掩盖没验证的部分。`;

/** 执行路由的渲染形式；未配置时给可读占位而不是空串。 */
function renderExecutorRoute(executor) {
  if (executor === undefined || executor === null || !executor.provider || !executor.model) return '（未配置）';
  return `provider: "${executor.provider}", model: "${executor.model}"`;
}

/**
 * 把配置的专家路由渲染成正文里的一段列表。
 * @param experts - 配置的专家数组（每项 `{label, provider, model, reasoningEffort?}`）。
 * @returns 逐行列表；空数组返回"未配置"提示行（不渲染空段）。
 */
export function renderExpertRoutes(experts) {
  const list = Array.isArray(experts) ? experts : [];
  const rows = list
    .filter((expert) => expert !== undefined && expert !== null)
    .map((expert) => `- \`${expert.label ?? ''}\` → \`provider: "${expert.provider ?? ''}"\`, \`model: "${expert.model ?? ''}"\``);
  if (rows.length === 0) return '- （未配置专家路由；升级时请显式传 provider/model）';
  return rows.join('\n');
}

/**
 * 用运行期配置渲染模板：只替换 `{{executorRoute}}` 与 `{{expertRoutes}}`，其余原样保留。
 * @param template - 内置模板字符串。
 * @param renderContext - `{executor, experts, texts}`（缺字段按空处理）。
 * @returns 渲染后的正文。
 */
export function renderTemplate(template, renderContext) {
  const context = renderContext ?? {};
  const executorRoute = renderExecutorRoute(context.executor);
  const expertRoutes = renderExpertRoutes(context.experts);
  return String(template)
    .split('{{executorRoute}}').join(executorRoute)
    .split('{{expertRoutes}}').join(expertRoutes);
}

/**
 * 按角色与模式取本段正文。子代永远走固定执行职责文本。
 *
 * `renderContext.texts.*` 非空时**整段替换**内置模板（替换后不再插值，用户写什么就是什么）；
 * 为空时用内置模板 + 占位符渲染。
 *
 * @param role - 'root' 或 'child'。
 * @param model - 本次 assembly 的模型 ID。
 * @param renderContext - `{executor, experts, texts}`；纯函数调用时可省略。
 * @returns 该段应渲染的文本。
 */
export function routingTextFor(role, model, renderContext) {
  const context = renderContext ?? {};
  const texts = context.texts ?? {};
  if (role === 'child') {
    const override = typeof texts.child === 'string' ? texts.child : '';
    return override !== '' ? override : CHILD_TEXT;
  }
  const mode = modeForModel(model);
  const override = mode === MODE_ECONOMIZE ? texts.economize : texts.boss;
  if (typeof override === 'string' && override !== '') return override;
  const template = mode === MODE_ECONOMIZE ? ECONOMIZE_TEMPLATE : BOSS_TEMPLATE;
  return renderTemplate(template, context);
}

/**
 * 取本次 assembly 的主模型。缺失/空值必须**明确报错**，不许猜模型
 * （猜错会把整段策略换成另一套，而且不报错）。
 * @param assembly - 已完成 `await next()` 的提示词 assembly。
 * @returns 模型 ID 字符串。
 * @throws 当 `assembly.variables.model` 缺失或为空时。
 */
export function modelFromAssembly(assembly) {
  const model = assembly?.variables?.model;
  if (typeof model !== 'string' || model === '') {
    throw new Error('dsh-submodel: system-prompt assembly has no `variables.model`; cannot classify the top-level mode without it');
  }
  return model;
}

/**
 * 构建普通子代的"适用范围"说明，供 guard 拒绝时给出可读诊断。
 * @returns 一句面向模型的说明。
 */
export function childDelegationRefusal() {
  return 'this session is a delegated subagent: it cannot delegate further. Report the limitation to your parent instead of retrying.';
}
