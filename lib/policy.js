/**
 * dsh-submodel / policy.js —— 纯函数层：角色与模式判定、统一入口的路由默认值、正文模板与渲染。
 *
 * 这里是**没有副作用、不 import 任何 runtime helper** 的一层，唯一目的就是能被单测直接喂输入、
 * 断言输出。宿主对象（tool 定义、Service、fiber）一律不进这个文件——否则纯函数测试就得先造
 * 一整套假 Host，测试本身会变成对 mock 的测试。
 *
 * 两条正交的判定（不要合并，它们回答不同的问题）：
 *
 * 1. **模式（mode）**：由「本次请求的路由是否属于经济路由」决定（见 `isEconomyRoute`）。
 *    主模型就是配置的执行路由 → 走 `economize`（自己干日常，委派继承自己）；
 *    否则走 `boss`（强主脑理解/判断/写作，可验证的执行块默认派执行路由）。
 *    经济路由的来源：① 与 `cfg.executor` 完全相同的 provider+model；② 命中 `cfg.economyRoutes`
 *    列表；③ 未配置 `economyRoutes` 时保留旧规则「模型 ID 以 `flash` 结尾」作兼容。
 *    **不看显示名或价格**（宿主元数据没有价格字段），只看路由与配置的显式匹配。
 *
 * 2. **角色（role）**：`root` 还是 `child`，由 `agent.session.header` 的 `origin`/`delegationDepth`
 *    判定，`agent.options.subagentDepth` 兜底（与宿主 `delegationDepthOf` 同口径）。
 *    子代是执行/专家角色，**不再**按主脑模式切换策略；子代永远禁止再委派。
 *
 * 为什么两个时点分别用不同来源（别改成"都用同一个"）：
 * - **提示词阶段**用 `assembly.variables.provider/model`——它描述"GUI 即将发起的这笔请求"，
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
 * 旧规则（legacy 兼容）：模型 ID 以 `flash` 结尾即视作经济路由。
 * 只在 `cfg.economyRoutes` 为空时参与判定（见 `isEconomyRoute`）。
 * 大小写不敏感、必须是**后缀**（`flash-lite` 不算），空值/非字符串不算。
 * @param model - 模型 ID（可能来自 GUI 选择、header、或 undefined）。
 * @returns 是否命中旧 Flash 后缀规则。
 */
export function isFlashModel(model) {
  return typeof model === 'string' && model.toLowerCase().endsWith('flash');
}

/**
 * 稳定的路由身份键：`provider\0model`，用于去重与比较。
 * @param route - `{provider, model}`（字段可为空）。
 * @returns 字符串键。
 */
export function routeKey(route) {
  return `${route?.provider ?? ''}\0${route?.model ?? ''}`;
}

/**
 * 判定一条路由是否属于「经济路由」（economize 模式）。
 *
 * 顺序：
 * 1. 与 `cfg.executor` 的 provider+model 完全相等 → 是；
 * 2. 命中 `cfg.economyRoutes`：双方 provider 都非空时两者都比，任一方为空时只比 model → 是；
 * 3. `cfg.economyRoutes` 为空时回退旧规则：模型 ID 以 `flash` 结尾 → 是；
 * 4. 否则不是。
 *
 * @param route - 待判定的 `{provider, model}`；model 缺失/空时返回 false。
 * @param cfg - 运行期配置（至少含 `executor` / `economyRoutes`）。
 * @returns 是否为经济路由。
 */
export function isEconomyRoute(route, cfg) {
  if (!route || typeof route.model !== 'string' || route.model === '') return false;
  const executor = cfg?.executor;
  if (executor?.provider && executor?.model && executor.provider === route.provider && executor.model === route.model) {
    return true;
  }
  const economyRoutes = Array.isArray(cfg?.economyRoutes) ? cfg.economyRoutes : [];
  if (
    economyRoutes.some(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        row.model === route.model &&
        (row.provider === '' || row.provider === undefined || route.provider === '' || row.provider === route.provider),
    )
  ) {
    return true;
  }
  return economyRoutes.length === 0 && isFlashModel(route.model);
}

/**
 * 由本次请求的路由判定本次顶层模式。
 * @param route - `{provider, model}`（来自 assembly 变量或 request header config）。
 * @param cfg - 运行期配置（至少含 `executor` / `economyRoutes`）。
 * @returns {MODE_ECONOMIZE} 或 {MODE_BOSS}。
 */
export function modeForRoute(route, cfg) {
  return isEconomyRoute(route, cfg) ? MODE_ECONOMIZE : MODE_BOSS;
}

/**
 * 判定调用者角色。**子代**的判据（按优先级）：`session.header.origin === 'subagent'`、
 * `session.header.delegationDepth > 0`、`options.subagentDepth > 0`（冷恢复兜底）。
 * 刻意不用 `parentSession`（普通用户 fork 也带 parentSession，那不是子代）；
 * `session` 缺失时只用 options 判据，不抛。
 * @param agent - live agent（含 `session.header` 与 `options`），可为 undefined。
 * @returns {'child'|'root'}。
 */
export function roleOf(agent) {
  const header = agent?.session?.header;
  if (header !== undefined && header !== null) {
    if (header.origin === 'subagent') return 'child';
    const depth = header.delegationDepth;
    if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return 'child';
  }
  const optionDepth = agent?.options?.subagentDepth;
  if (typeof optionDepth === 'number' && Number.isFinite(optionDepth) && optionDepth > 0) return 'child';
  return 'root';
}

/**
 * 从 execution context 判定角色。`exec.agent` 是唯一权威来源：
 * 它必须存在且是 live Agent（有 session.requestHeader）。
 *
 * `header` 在这里取的是 `session.requestHeader()`（执行期 header，含 `config`）；
 * 角色判定本身走 `roleOf(agent)`——它读 `session.header`（durable header），
 * 两者不是同一份数据，别合并。
 *
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
  const role = roleOf(agent);
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
 * - **无显式路由 + economize 模式**：不补任何 provider/model（子代继承当前经济路由）；
 * - **无显式路由 + boss 模式**：补配置的 executor pair；未给 reasoning_effort 时补 max，
 *   给了就保留——max 仅作缺省，不覆盖调用方已指定的档位。
 *
 * 专家路由完全由配置决定：本函数不认识任何具体 provider/model 名，也不做"某条路由只能兜底"
 * 之类的硬编码特判（那会把某个部署的私有约定写进公版代码）。
 *
 * @param args - 原始工具入参（**只读，不修改**）。
 * @param mode - modeForRoute 的结果。
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
    return { ok: false, reason: 'boss-mode delegation has no configured executor route (config.executor.provider/model is required)' };
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

调用方式：普通任务统一走 \`delegate_task\`，它的参数与原生 \`subagent\` 相同，启动后立即返回子会话 id，完成时由运行时通知；不要反复轮询，查看/追加/停止子代理用 \`list_agents\` / \`send_message\` / \`interrupt_agent\`。\`provider\` 与 \`model\` 必须**成对**传，只给一个会立即失败。不确定有哪些授权路由时先调 \`list_subagent_models\`。\`reasoning_effort\` 以各路由支持的档位为准，不传时用配置缺省，显式档位优先。三个都不传就继承主模型路由，即默认路径。升级前先把证据收齐，并把已知事实、约束、已试过的方案写进 prompt——子智能体看不到本会话历史。

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
\`delegate_task\` 启动后立即返回子会话 id，完成时由运行时通知；不要反复轮询。需要查看在线子代理、追加消息或停止时，用 \`list_agents\` / \`send_message\` / \`interrupt_agent\`。

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
 * @param route - 本次请求的 `{provider, model}`（子代忽略）。
 * @param renderContext - `{executor, economyRoutes, experts, texts}`；纯函数调用时可省略。
 * @returns 该段应渲染的文本。
 */
export function routingTextFor(role, route, renderContext) {
  const context = renderContext ?? {};
  const texts = context.texts ?? {};
  if (role === 'child') {
    const override = typeof texts.child === 'string' ? texts.child : '';
    return override !== '' ? override : CHILD_TEXT;
  }
  const mode = modeForRoute(route, context);
  const override = mode === MODE_ECONOMIZE ? texts.economize : texts.boss;
  if (typeof override === 'string' && override !== '') return override;
  const template = mode === MODE_ECONOMIZE ? ECONOMIZE_TEMPLATE : BOSS_TEMPLATE;
  return renderTemplate(template, context);
}

/**
 * 取本次 assembly 的路由。`provider`/`model` 两个变量由宿主 agent-loop 注册
 * （`systemPrompt.variable("provider"/"model")`）；model 缺失/空值必须**明确报错**，
 * 不许猜模型（猜错会把整段策略换成另一套，而且不报错）。
 * @param assembly - 已完成 `await next()` 的提示词 assembly。
 * @returns `{provider, model}`（provider 缺失时为空串）。
 * @throws 当 `assembly.variables.model` 缺失或为空时。
 */
export function routeFromAssembly(assembly) {
  const model = assembly?.variables?.model;
  if (typeof model !== 'string' || model === '') {
    throw new Error('dsh-submodel: system-prompt assembly has no `variables.model`; cannot classify the top-level mode without it');
  }
  const provider = assembly?.variables?.provider;
  return { provider: typeof provider === 'string' ? provider : '', model };
}

/**
 * 构建普通子代的"适用范围"说明，供 guard 拒绝时给出可读诊断。
 * @returns 一句面向模型的说明。
 */
export function childDelegationRefusal() {
  return 'this session is a delegated subagent: it cannot delegate further. Report the limitation to your parent instead of retrying.';
}

// ── 自动配置向导（`configure_submodel`）的纯函数层 ─────────────────────────────
//
// 这里只做**确定性推导**：候选排序、三问结构、答案解析、两处配置的合并。
// 宿主服务（llm / userQuestions / configEditor）一律留在 setup.js，本文件保持零 import，
// 这样向导最容易出错的部分（解析与写回值）可以纯函数单测。

/** 自动配置向导的工具名（root + autoConfigure + executor 未配置时唯一顶层注册）。 */
export const SETUP_TOOL_NAME = 'configure_submodel';

/** 向导三问的稳定 id（回答按 id 回填）。 */
export const SETUP_QUESTION_EXECUTOR = 'executor';
export const SETUP_QUESTION_EXPERTS = 'experts';
export const SETUP_QUESTION_AUTHORIZE = 'authorize';

/** 宿主「子代理模型选择」授权表的配置行 id。 */
export const HOST_SELECTION_ENTRY_ID = 'subagent-model-selection-settings';

/** 省钱/快档模型关键词（只用于预填顺序，不替用户决定）。 */
export const ECONOMY_KEYWORDS = Object.freeze([
  'flash',
  'lite',
  'mini',
  'nano',
  'air',
  'small',
  'fast',
  'turbo',
  'haiku',
]);

/** 强推理/专家模型关键词（只用于预填顺序，不替用户决定）。 */
export const STRONG_KEYWORDS = Object.freeze([
  'opus',
  'pro',
  'max',
  'ultra',
  'reason',
  'deep',
  'sonnet',
  'o3',
  'o4',
  'r1',
  'gpt-6',
]);

/** 路由的展示标签：`provider/model`（也是 options 的 label，回答时按它回填）。 */
function routeLabel(route) {
  return `${route.provider}/${route.model}`;
}

/** 把文字拆成路由：只接受 `provider/model`（第一个 `/` 之前是 provider）。 */
function splitRouteLabel(text) {
  if (typeof text !== 'string') return undefined;
  const value = text.trim();
  const index = value.indexOf('/');
  if (index <= 0 || index === value.length - 1) return undefined;
  const provider = value.slice(0, index).trim();
  const model = value.slice(index + 1).trim();
  if (provider === '' || model === '') return undefined;
  return { provider, model };
}

/** 候选的确定性排序：分高优先，再按命中数与 provider/model 字典序兜底。 */
function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.economyHits !== a.economyHits) return b.economyHits - a.economyHits;
  if (b.strongHits !== a.strongHits) return b.strongHits - a.strongHits;
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.model !== b.model) return a.model < b.model ? -1 : 1;
  return 0;
}

/**
 * 把 `llm.listProviders()/listModels()` 的结果整理成向导候选。
 *
 * 打分只用于**预填顺序**（宿主模型元数据没有价格字段，无法可靠推断贵贱）：
 * - 经济关键词命中数 + 强推理关键词命中数 → 分组（economy / strong / unknown）；
 * - 命中宿主 `allowedModels` +3（已授权的路由优先出现，少一次手动授权）；
 * - 关键词只看 `model` 与 `name`，不看 `description`（描述里常见 "provider" 之类的误命中）。
 *
 * @param pack - `[{provider, model, name?, description?}]`（来自 llm 服务）。
 * @param host - `{enabled, allowedModels:[{provider, model}]}` 或 undefined。
 * @returns 候选数组（已排序）；每项 `{provider, model, name, description, group, economyHits, strongHits, authorized, score}`。
 */
export function deriveSetupCandidates(pack, host) {
  const allowed = new Set(
    (Array.isArray(host?.allowedModels) ? host.allowedModels : [])
      .filter((route) => route !== null && typeof route === 'object')
      .map((route) => routeKey(route)),
  );
  const candidates = [];
  for (const entry of Array.isArray(pack) ? pack : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const provider = typeof entry.provider === 'string' ? entry.provider : '';
    const model = typeof entry.model === 'string' ? entry.model : '';
    if (model === '') continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const description = typeof entry.description === 'string' ? entry.description : '';
    const haystack = `${model} ${name}`.toLowerCase();
    const economyHits = ECONOMY_KEYWORDS.filter((keyword) => haystack.includes(keyword)).length;
    const strongHits = STRONG_KEYWORDS.filter((keyword) => haystack.includes(keyword)).length;
    const authorized = allowed.has(routeKey({ provider, model }));
    // 平票时归经济组：强推理关键词含 `deep`，而 `deepseek-flash` 这类名字会同时命中
    // `deep`（来自 deepseek）与 `flash`。若不把平票判成 economy，两者会互相抵消成 unknown，
    // 结果这个最常见的执行路由既不进 executor 候选、也不进 experts 候选（只能手打 custom）。
    const group = strongHits > economyHits ? 'strong' : economyHits > 0 ? 'economy' : 'unknown';
    candidates.push({
      provider,
      model,
      name,
      description,
      group,
      economyHits,
      strongHits,
      authorized,
      score: economyHits + strongHits + (authorized ? 3 : 0),
    });
  }
  candidates.sort(compareCandidates);
  return candidates;
}

/** 把一个候选渲染成问题选项（label 即回填键 `provider/model`）。 */
function candidateOption(candidate) {
  const detail = [candidate.name, candidate.description].filter((part) => typeof part === 'string' && part !== '').join(' — ');
  return {
    label: routeLabel(candidate),
    ...(detail === '' ? {} : { description: detail }),
  };
}

/**
 * 由候选构造向导的三问（中文；单选/多选/单选）。
 *
 * - `executor`：经济组前 8；不足时用强推理组补齐；
 * - `experts`：强推理组前 10（可跳过；自定义文本可补一条 `provider/model`）；
 * - `authorize`：是否同时写宿主授权表（`yes` 推荐 / `no`）。
 *
 * @param candidates - `deriveSetupCandidates` 的结果。
 * @returns 问题数组（顺序稳定）。
 */
export function buildSetupQuestions(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const executorCandidates = list.filter((candidate) => candidate.group === 'economy').slice(0, 8);
  if (executorCandidates.length < 8) {
    executorCandidates.push(
      ...list.filter((candidate) => candidate.group === 'strong').slice(0, 8 - executorCandidates.length),
    );
  }
  const expertCandidates = list.filter((candidate) => candidate.group === 'strong').slice(0, 10);
  return [
    {
      id: SETUP_QUESTION_EXECUTOR,
      question: '选择「执行路由」：日常执行、批量检索与可并行的子任务默认派给它（便宜/快的模型）。',
      options: executorCandidates.map(candidateOption),
      multiSelect: false,
    },
    {
      id: SETUP_QUESTION_EXPERTS,
      question: '选择「专家路由」：需要更强推理时才升级用，可多选；不需要可直接跳过。',
      options: expertCandidates.map(candidateOption),
      multiSelect: true,
    },
    {
      id: SETUP_QUESTION_AUTHORIZE,
      question: '是否同时把以上路由写入宿主「子代理模型选择」授权表？',
      options: [
        {
          label: 'yes',
          description: '推荐：同时写宿主授权，新会话即可直接派工（不写的话首次派工会被宿主拒绝）。',
        },
        {
          label: 'no',
          description: '只写本插件配置；之后需要按 README 手动补宿主授权，否则派工报 is not allowed for this Session。',
        },
      ],
      multiSelect: false,
    },
  ];
}

/**
 * 解析向导回答。`selected` 必须是候选里出现过的选项标签；`custom` 只接受
 * `provider/model` 形式（存在性由 setup.js 用 `llm.resolveModelInfo` 再校验）。
 *
 * 跳过语义（与官方 `ask_user_question` 一致）：`selected` 为空且无 `custom` 表示用户跳过——
 * executor 是必填所以报错，experts 视为不配，authorize 视为 `false`（不写宿主授权）。
 *
 * @param answers - `userQuestions.ask` 返回的 `answers` 数组。
 * @param candidates - `deriveSetupCandidates` 的结果（用于校验 selected 属于候选）。
 * @returns `{ok:true, executor, experts, authorize, customRoutes}` 或 `{ok:false, reason}`。
 */
export function parseSetupAnswers(answers, candidates) {
  const list = Array.isArray(answers) ? answers : [];
  const known = new Set((Array.isArray(candidates) ? candidates : []).map((candidate) => routeKey(candidate)));
  const byId = new Map();
  for (const answer of list) {
    if (answer === null || typeof answer !== 'object') continue;
    if (typeof answer.id === 'string') byId.set(answer.id, answer);
  }
  const customRoutes = [];

  const parseSelectedRoute = (label) => {
    const route = splitRouteLabel(label);
    if (route === undefined) return { ok: false, reason: `选项不是 provider/model 形式：${String(label)}` };
    if (!known.has(routeKey(route))) return { ok: false, reason: `选项不在候选列表：${String(label)}` };
    return { ok: true, route };
  };

  // ① 执行路由（必填单选）：custom 覆盖 selected。
  const executorAnswer = byId.get(SETUP_QUESTION_EXECUTOR);
  let executor;
  const executorCustom = typeof executorAnswer?.custom === 'string' ? executorAnswer.custom.trim() : '';
  if (executorCustom !== '') {
    const route = splitRouteLabel(executorCustom);
    if (route === undefined) return { ok: false, reason: `执行路由必须是 provider/model 形式：${executorCustom}` };
    executor = route;
    customRoutes.push(route);
  } else {
    const selected = Array.isArray(executorAnswer?.selected) ? executorAnswer.selected : [];
    if (selected.length === 0) return { ok: false, reason: '未选择执行路由' };
    const parsed = parseSelectedRoute(selected[0]);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    executor = parsed.route;
  }

  // ② 专家路由（可多选；custom 可补一条）。
  const expertsAnswer = byId.get(SETUP_QUESTION_EXPERTS);
  const selectedExperts = Array.isArray(expertsAnswer?.selected) ? expertsAnswer.selected : [];
  const experts = [];
  for (const label of selectedExperts) {
    const parsed = parseSelectedRoute(label);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    experts.push(parsed.route);
  }
  const expertsCustom = typeof expertsAnswer?.custom === 'string' ? expertsAnswer.custom.trim() : '';
  if (expertsCustom !== '') {
    const route = splitRouteLabel(expertsCustom);
    if (route === undefined) return { ok: false, reason: `专家路由必须是 provider/model 形式：${expertsCustom}` };
    experts.push(route);
    customRoutes.push(route);
  }
  const seen = new Set();
  const dedupedExperts = [];
  for (const route of experts) {
    const key = routeKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedExperts.push(route);
  }

  // ③ 宿主授权（跳过视为不写；非法标签报错）。
  const authorizeAnswer = byId.get(SETUP_QUESTION_AUTHORIZE);
  const authorizeSelected = Array.isArray(authorizeAnswer?.selected) ? authorizeAnswer.selected : [];
  let authorize = false;
  if (authorizeSelected.length > 0) {
    const label = authorizeSelected[0];
    if (label !== 'yes' && label !== 'no') return { ok: false, reason: `无法识别的授权选项：${String(label)}` };
    authorize = label === 'yes';
  }

  return { ok: true, executor, experts: dedupedExperts, authorize, customRoutes };
}

/**
 * 合并出写入本插件配置行的下一个原始配置：保留其他字段，覆写 executor / experts / economyRoutes。
 * @param current - 插件行当前原始配置（`configEditor.edit` 的 curr）。
 * @param selection - `parseSetupAnswers` 的 selection。
 * @returns 下一个原始配置对象。
 */
export function composeNextPluginConfig(current, selection) {
  const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const executor = {
    provider: selection.executor.provider,
    model: selection.executor.model,
    reasoningEffort: 'max',
  };
  const experts = (Array.isArray(selection.experts) ? selection.experts : []).map((route) => ({
    label: routeLabel(route),
    provider: route.provider,
    model: route.model,
  }));
  return {
    ...base,
    executor,
    experts,
    economyRoutes: [{ provider: executor.provider, model: executor.model }],
  };
}

/**
 * 合并出写入宿主授权行的下一个原始配置：去重合并且保留原有顺序。
 * @param current - 宿主行当前原始配置（`configEditor.edit` 的 curr）。
 * @param routes - 本次要授权的路由数组（executor + experts）。
 * @returns 下一个原始配置对象（`enabled: true` + 合并后的 `allowedModels`）。
 */
export function composeNextHostConfig(current, routes) {
  const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const existing = Array.isArray(base.allowedModels) ? base.allowedModels : [];
  const merged = [];
  const seen = new Set();
  for (const route of [...existing, ...(Array.isArray(routes) ? routes : [])]) {
    if (route === null || typeof route !== 'object') continue;
    const provider = typeof route.provider === 'string' ? route.provider : '';
    const model = typeof route.model === 'string' ? route.model : '';
    if (provider === '' || model === '') continue;
    const key = routeKey({ provider, model });
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ provider, model });
  }
  return { ...base, enabled: true, allowedModels: merged };
}
