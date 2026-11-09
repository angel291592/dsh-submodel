/**
 * flash-routing-fixture.mjs —— 模型路由新模块的确定性断言 fixture。
 *
 * 约束（plan §5 V1）：
 * - **只测新模块**，不访问生产环境、不访问网络、不触发真实 LLM；
 * - 主模块（`lib/index.js`）经 `import()` 加载时**不得有副作用**——它的 `apply` 只在被调用时
 *   才注册东西，`import` 本身只取常量/纯函数；
 * - 所有结论用**机器 assert**，不靠 print。
 *
 * 用法（stdout 为 JSON，退出码非 0 即失败）：
 *   node flash-routing-fixture.mjs <插件 lib 目录绝对路径>
 *
 * 由 `test_flash_routing.py`（stdlib unittest）驱动，两者都进入常驻测试。
 */
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const libDir = process.argv[2];
if (!libDir) {
  console.error('usage: node flash-routing-fixture.mjs <plugin lib dir>');
  process.exit(2);
}

/**
 * 极简断言收集器：每条都记录成 {name, ok, detail}，最后统一输出。
 *
 * **必须 await**：否则 async 用例返回的 Promise 会被当成"成功 detail"直接记绿，
 * 里面的断言根本没跑——那正是假绿。这里显式 await 回调并把 rejection 记成失败。
 */
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (error) {
    results.push({ name, ok: false, detail: `${error.name}: ${error.message}` });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message ?? 'assertion failed');
}
function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ?? 'not equal'}: got ${a}, want ${b}`);
}
function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message ?? 'expected a throw, got none');
}

const policyUrl = pathToFileURL(resolvePath(libDir, 'policy.js')).href;
const delegationUrl = pathToFileURL(resolvePath(libDir, 'delegation.js')).href;
const entryUrl = pathToFileURL(resolvePath(libDir, 'index.js')).href;

const policy = await import(policyUrl);
const delegation = await import(delegationUrl);
const entry = await import(entryUrl);

/**
 * 真实原生 `subagent` 定义的 parameters 形状（2026-10-05 在运行中的宿主里实测）。
 *
 * 宿主 `defineTool` 交付的是 JSON Schema：`provider` / `model` 在 `properties` 下，
 * 顶层没有这两个键（实测 `hasTopLevelProvider=false` / `hasPropertiesProvider=true`）。
 * mock 必须与宿主一致——旧 mock 写成顶层 `{provider, model}`，正是它让 fixture 放过了
 * 那个"四个工具一个都装不上"的契约误判。
 */
const NATIVE_SUBAGENT_PARAMETERS = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    prompt: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    reasoning_effort: { type: 'string' },
    run_in_background: { type: 'boolean' },
  },
  required: ['description', 'prompt'],
};

/** 原生 subagent 定义替身：parameters 用真实 JSON Schema 形状。 */
function nativeSubagentDefinition() {
  return {
    parameters: structuredClone(NATIVE_SUBAGENT_PARAMETERS),
    output: { schema: { type: 'object' }, render: () => [] },
  };
}

/**
 * fixture 用的「agent 自己的 ctx」替身。
 *
 * 生产实现经 **agent 自己的 ctx** 注册（宿主官方指引：`dsh-tools:2634` 的重复注册报错原文
 * "register through that agent's `agent.ctx` instead"），不再自建 scope。所以这里给出
 * `{get, tools, on}` 三件套，并把每个注册的 disposer 包一层记进 `disposedRegistrations`——
 * 这样"卸载时确实回收了该 agent 上的注册"仍被真实断言，而不是被替身抹平。
 *
 * @param shared - `{get, tools, on, disposedRegistrations}` 收集器。
 * @returns 可直接挂到 candidate agent 上的 ctx 替身。
 */
function makeAgentCtx(shared) {
  const record = (label, disposer) => () => {
    shared.disposedRegistrations?.push(label);
    return disposer?.();
  };
  return {
    get: shared.get,
    tools: {
      ...shared.tools,
      register: (definition) => record(definition.name, shared.tools.register(definition)),
      guard: (guard) => record('guard', shared.tools.guard(guard)),
    },
    on: (event, callback) => record(event, shared.on(event, callback)),
  };
}

/**
 * 宿主 `dsh-tools` 的 `assertSupportedJsonSchema` 子集（镜像实现，用于常驻守护）。
 *
 * 为什么必须常驻：`tools.register` 会**校验 `output.schema`**（`dsh-tools:2882`），违规直接抛
 * `JsonSchemaError`。2026-10-05 真实宿主实测：把 `required: true` 写在 `type:"string"` 上时，
 * 三个控制工具全部注册失败 → 整个安装 try 块抛异常 → 清理后**零注册**（四个工具全无）。
 * 旧 fixture 把 `register` mock 成 no-op，这类错误完全不可见——所以这里按宿主规则自己校验。
 *
 * 规则取自 `dsh-tools:163-260`：关键字白名单 `type/oneOf/properties/required/additionalProperties/
 * items/enum/const` + 注解 `description/title/default/examples`；`type` 必须是单一字符串；
 * `required` 只允许出现在 `object` 上且为**字符串数组**并命名已声明属性；`items` 只允许在 `array` 上。
 */
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);
const SUPPORTED_SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const KEYWORD_ALLOWED_TYPES = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
};

/** 收集违反宿主子集的诊断（空数组＝合法）。 */
function schemaViolations(schema, path = 'schema', out = []) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    out.push(`${path} must be a schema object`);
    return out;
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) out.push(`${path}.${key} is not a supported keyword`);
  }
  const hasType = Object.hasOwn(schema, 'type');
  const hasOneOf = Object.hasOwn(schema, 'oneOf');
  if (hasType && hasOneOf) {
    out.push(`${path} cannot declare both type and oneOf`);
    return out;
  }
  if (hasOneOf) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) {
      out.push(`${path}.oneOf must be an array of at least two schemas`);
    } else {
      schema.oneOf.forEach((entry, index) => schemaViolations(entry, `${path}.oneOf[${index}]`, out));
    }
    return out;
  }
  if (!hasType) {
    out.push(`${path} must declare type or oneOf`);
    return out;
  }
  const type = schema.type;
  if (typeof type !== 'string' || !SUPPORTED_SCHEMA_TYPES.includes(type)) {
    out.push(`${path}.type must be one of ${SUPPORTED_SCHEMA_TYPES.join('/')}`);
    return out;
  }
  for (const [key, allowed] of Object.entries(KEYWORD_ALLOWED_TYPES)) {
    if (Object.hasOwn(schema, key) && !allowed.includes(type)) {
      out.push(`${path}.${key} is not supported on type "${type}"`);
    }
  }
  if (type === 'object') {
    if (Object.hasOwn(schema, 'properties')) {
      const properties = schema.properties;
      if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
        out.push(`${path}.properties must be an object of schemas`);
      } else {
        for (const [key, entry] of Object.entries(properties)) {
          schemaViolations(entry, `${path}.properties.${key}`, out);
        }
        if (Object.hasOwn(schema, 'required')) {
          if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== 'string')) {
            out.push(`${path}.required must be an array of strings`);
          } else {
            for (const key of schema.required) {
              if (!Object.hasOwn(properties, key)) out.push(`${path}.required names "${key}" which is not in properties`);
            }
          }
        }
      }
    }
    if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
      out.push(`${path}.additionalProperties must be a boolean`);
    }
  }
  if (type === 'array' && Object.hasOwn(schema, 'items')) schemaViolations(schema.items, `${path}.items`, out);
  return out;
}

/** 断言 schema 落在宿主支持的子集内（否则 register 会抛 JsonSchemaError）。 */
function assertSupportedSchema(schema, label) {
  const violations = schemaViolations(schema);
  assert(violations.length === 0, `${label} 不是宿主支持的 JSON Schema 子集: ${violations.join('; ')}`);
}

/**
 * 断言值是**无损 JSON 值**（镜像宿主 `dsh-util-values` 的 `isJsonValue` 判据）。
 *
 * 为什么必须单独守**值**：`assertSupportedSchema` 只校验 schema，不校验值。宿主对工具返回值
 * 还有一道无损 JSON 校验，`snapshotToolValue` 会对不合规的值抛 ToolOutputError——整个工具返回值
 * 变成错误结果。2026-10-19 实测：`{..., note: undefined}` → `isJsonValue=false`；**不带该键** → true。
 * 即"键存在但值为 undefined"过不了，而 `value.note === undefined` 这种断言对两种形状**都成立**，
 * 所以坏形状曾经从测试里逃逸（`list_subagents` / `wait_subagents` 恰好在"有子代 running"这个
 * 主用例下把错误结果交给模型）。
 *
 * 规则：`null` / 数组 / 仅含无损值的对象 / string·number·boolean 合法；对象**自有可枚举键**的
 * 值不得是 `undefined`，也不得是函数、symbol、bigint。
 */
function assertLosslessJsonValue(value, path = 'value') {
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLosslessJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assert(
        value[key] !== undefined,
        `${path}.${key} 的值是 undefined——宿主的无损 JSON 校验会拒绝整个工具返回值（键存在即为违规）`,
      );
      assertLosslessJsonValue(value[key], `${path}.${key}`);
    }
    return;
  }
  assert(['string', 'number', 'boolean'].includes(typeof value), `${path} 不是无损 JSON 值（${typeof value}）`);
}

// ── 1. 唯一规则：模型 ID 以 flash 结尾 ────────────────────────────────────────
await check('isFlashModel: 小写后缀命中', () => {
  assert(policy.isFlashModel('deepseek-flash') === true);
});
await check('isFlashModel: 大写后缀命中（大小写不敏感）', () => {
  assert(policy.isFlashModel('DeepSeek-FLASH') === true);
  assert(policy.isFlashModel('deepseek-Flash') === true);
});
await check('isFlashModel: 非后缀不误命中', () => {
  assert(policy.isFlashModel('flash-lite') === false, 'flash-lite 不是后缀');
  assert(policy.isFlashModel('flash') === true, 'flash 本身是后缀');
  assert(policy.isFlashModel('deepseek-v4.1-flashx') === false);
  assert(policy.isFlashModel('gpt-6.1-sol') === false);
});
await check('isFlashModel: provider 名不参与判断', () => {
  // 唯一规则只看 model id；这些是 provider 名/其他标识，不该被当成 Flash。
  assert(policy.isFlashModel('opencode-go') === false);
  assert(policy.isFlashModel('deepseek-account') === false);
  assert(policy.isFlashModel('p-opus') === false);
});
await check('isFlashModel: 空值/非字符串安全', () => {
  assert(policy.isFlashModel(undefined) === false);
  assert(policy.isFlashModel(null) === false);
  assert(policy.isFlashModel('') === false);
  assert(policy.isFlashModel(123) === false);
});
await check('modeForModel: Flash→economize，其余→boss', () => {
  assert(policy.modeForModel('deepseek-flash') === 'economize');
  assert(policy.modeForModel('claude-opus-5-5') === 'boss');
  assert(policy.modeForModel(undefined) === 'boss');
});

// ── 2. 角色判定：child 的 origin/depth 防伪装 ─────────────────────────────────
await check('roleOf: origin=subagent 判 child', () => {
  assert(policy.roleOf({ origin: 'subagent', delegationDepth: 1 }, {}) === 'child');
});
await check('roleOf: 正 delegationDepth 判 child', () => {
  assert(policy.roleOf({ delegationDepth: 2 }, {}) === 'child');
  assert(policy.roleOf({}, { subagentDepth: 1 }) === 'child');
});
await check('roleOf: 顶层（无 origin/无正 depth）判 root', () => {
  assert(policy.roleOf({}, {}) === 'root');
  assert(policy.roleOf({ delegationDepth: 0 }, {}) === 'root');
  assert(policy.roleOf(undefined, undefined) === 'root');
});
await check('roleOf: parentSession 单独不判 child（普通 fork 不是子代）', () => {
  assert(policy.roleOf({ parentSession: 'sess-abc' }, {}) === 'root', 'parentSession 不能单独当子代依据');
});
await check('resolveCallerRole: 无 agent 明确失败', () => {
  const r = policy.resolveCallerRole({});
  assert(r.ok === false, 'exec.agent 缺失必须失败');
  assert(/calling agent/.test(r.reason));
});
await check('resolveCallerRole: 过期 agent（无 requestHeader）失败', () => {
  const r = policy.resolveCallerRole({ agent: { id: 'a', session: {}, options: {} } });
  assert(r.ok === false, '无 session.requestHeader 视为过期身份');
});
await check('resolveCallerRole: live root 成功', () => {
  const agent = { id: 'a', options: { model: 'gpt-6.1-sol' }, session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) } };
  const r = policy.resolveCallerRole({ agent });
  assert(r.ok === true);
  assert(r.role === 'root');
});

// ── 3. 显式 pair 的完整性与路由默认值 ────────────────────────────────────────
await check('classifyExplicitRoute: 完整 pair', () => {
  assertEqual(policy.classifyExplicitRoute({ provider: 'p-opus', model: 'claude-opus-5-5' }), {
    kind: 'pair', provider: 'p-opus', model: 'claude-opus-5-5',
  });
});
await check('classifyExplicitRoute: 只有 provider 立即失败', () => {
  const r = policy.classifyExplicitRoute({ provider: 'p-opus' });
  assert(r.kind === 'invalid');
  assert(/model/.test(r.reason));
});
await check('classifyExplicitRoute: 只有 model 立即失败', () => {
  const r = policy.classifyExplicitRoute({ model: 'claude-opus-5-5' });
  assert(r.kind === 'invalid');
  assert(/provider/.test(r.reason));
});
await check('classifyExplicitRoute: 都没有 = none', () => {
  assertEqual(policy.classifyExplicitRoute({ prompt: 'x' }), { kind: 'none' });
});

const EXECUTOR = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' };

await check('resolveDelegationArgs: Flash 模式不补任何 route', () => {
  const r = policy.resolveDelegationArgs({ prompt: 'x' }, 'economize', EXECUTOR);
  assert(r.ok === true);
  assert(r.applied === 'inherit');
  assert(r.args.provider === undefined, 'Flash 不该注入 provider');
  assert(r.args.model === undefined, 'Flash 不该注入 model');
});
await check('resolveDelegationArgs: 非 Flash 尊重 executor 显式配置 low', () => {
  const r = policy.resolveDelegationArgs({ prompt: 'x' }, 'boss', EXECUTOR);
  assert(r.ok === true);
  assert(r.applied === 'executor');
  assertEqual([r.args.provider, r.args.model, r.args.reasoning_effort], ['opencode-go', 'deepseek-v4.1-flash', 'low']);
});
await check('resolveDelegationArgs: executor 未配置 effort 时缺省 max', () => {
  const resolved = policy.resolveDelegationArgs({ prompt: 'x' }, 'boss', { provider: EXECUTOR.provider, model: EXECUTOR.model });
  assert(resolved.ok === true);
  assertEqual(resolved.args.reasoning_effort, 'max');
});
await check('resolveDelegationArgs: 显式 low/off/high/xhigh 不被 max 缺省覆盖', () => {
  for (const effort of ['low', 'off', 'high', 'xhigh']) {
    const resolved = policy.resolveDelegationArgs({ prompt: 'x', reasoning_effort: effort }, 'boss', { ...EXECUTOR, reasoningEffort: 'max' });
    assert(resolved.ok === true);
    assertEqual(resolved.args.reasoning_effort, effort);
  }
});
await check('resolveDelegationArgs: 非 Flash 显式给了 effort 就保留', () => {
  const r = policy.resolveDelegationArgs({ prompt: 'x', reasoning_effort: 'max' }, 'boss', EXECUTOR);
  assertEqual(r.args.reasoning_effort, 'max', '给了 effort 必须保留');
  assertEqual(r.args.provider, 'opencode-go', 'route 仍补 executor');
});
await check('resolveDelegationArgs: 完整显式 pair 不被改写、不注入 effort', () => {
  const r = policy.resolveDelegationArgs(
    { prompt: 'x', provider: 'p-opus', model: 'claude-opus-5-5' },
    'boss',
    EXECUTOR,
  );
  assert(r.applied === 'explicit');
  assertEqual([r.args.provider, r.args.model], ['p-opus', 'claude-opus-5-5']);
  assert(r.args.reasoning_effort === undefined, '完整显式路线不注入策略 effort');
});
await check('resolveDelegationArgs: half pair 失败，不偷偷补 Go', () => {
  const r = policy.resolveDelegationArgs({ prompt: 'x', provider: 'p-opus' }, 'boss', EXECUTOR);
  assert(r.ok === false, 'half pair 必须失败');
  assert(r.reason.includes('model'));
});
await check('resolveDelegationArgs: 非 Flash 但 executor 未配置 → 明确失败', () => {
  const r = policy.resolveDelegationArgs({ prompt: 'x' }, 'boss', { provider: '', model: '', reasoningEffort: 'low' });
  assert(r.ok === false, '没有 executor 配置时必须失败而不是静默继承');
});
await check('resolveDelegationArgs: 输入不被修改（Frozen input 不变）', () => {
  const original = Object.freeze({ prompt: 'x' });
  const r = policy.resolveDelegationArgs(original, 'boss', EXECUTOR);
  assert(r.ok === true);
  assertEqual(Object.keys(original), ['prompt'], '原参数对象不得被改写');
  assert(original.provider === undefined);
  assert(r.args !== original, '必须返回派生对象，不是同一个引用');
});

// ── 4. assembly 模型解析：必须选"新选择"而不是过期的 options ─────────────────
await check('modelFromAssembly: 正常取值', () => {
  assertEqual(policy.modelFromAssembly({ variables: { model: 'deepseek-flash' } }), 'deepseek-flash');
});
await check('modelFromAssembly: 缺失/空值明确报错，不猜模型', () => {
  assertThrows(() => policy.modelFromAssembly({ variables: {} }), '缺 model 必须抛错');
  assertThrows(() => policy.modelFromAssembly({ variables: { model: '' } }), '空 model 必须抛错');
  assertThrows(() => policy.modelFromAssembly({}), '无 variables 必须抛错');
});
await check('routingTextFor: 两种顶层模式文本不同且都含关键内容', () => {
  const renderContext = { executor: EXECUTOR, experts: [], texts: {} };
  const eco = policy.routingTextFor('root', 'deepseek-flash', renderContext);
  const boss = policy.routingTextFor('root', 'gpt-6.1-sol', renderContext);
  assert(eco !== boss, '两模式正文必须不同');
  assert(eco.includes('delegate_task') && boss.includes('delegate_task'));
  assert(!eco.includes(EXECUTOR.provider), 'Flash 段不该硬编码执行路由');
  assert(boss.includes(EXECUTOR.provider) && boss.includes(EXECUTOR.model), 'boss 段应通过占位符注入执行路由');
});
await check('routingTextFor: 子代文案不含主脑升级策略，且写明禁止再委派', () => {
  const child = policy.routingTextFor('child', 'gpt-6.1-sol');
  assert(child !== policy.routingTextFor('root', 'gpt-6.1-sol', { executor: EXECUTOR, experts: [], texts: { economize: '', boss: '', child: '' } }), 'child 不能复用 boss 文本');
  assert(child.includes('delegate_task'), '要写明哪些能力不可用');
  assert(!child.includes('p-opus'), 'child 段不得包含主脑升级策略（不得出现 p-opus 路由）');
});

// ── 5. 嵌套调用：0.2.2 的批量执行形状 ───────────────────────────────────────
await check('buildNestedCall: 批量形状 + arguments 是 JSON 文本 + agent/signal 透传', () => {
  const outerExec = { callId: 'C1', signal: 'sig', agent: 'ag' };
  const nested = delegation.buildNestedCall(outerExec, { prompt: 'x', provider: 'p-opus' });
  assertEqual(nested.calls.length, 1, '必须是"只含一个 call 的批量"');
  assertEqual(nested.calls[0].id, 'C1:delegate');
  assertEqual(nested.calls[0].name, 'subagent', '必须调用原生 subagent');
  assertEqual(typeof nested.calls[0].arguments, 'string', 'arguments 必须是 JSON 文本');
  assertEqual(JSON.parse(nested.calls[0].arguments), { prompt: 'x', provider: 'p-opus' });
  assertEqual(nested.signal, 'sig', 'signal 必须同一条（取消要能传播）');
  assertEqual(nested.agent, 'ag');
  assert(!('parent' in nested) && !('rootCallId' in nested), '0.2.2 批量 API 没有 parent/rootCallId 通道');
});
await check('buildNestedCall: toolSet 仅在存在时透传', () => {
  const withToolSet = delegation.buildNestedCall({ callId: 'C1', signal: 's', agent: 'a', toolSet: 'ts' }, {});
  assertEqual(withToolSet.toolSet, 'ts');
  const without = delegation.buildNestedCall({ callId: 'C1', signal: 's', agent: 'a' }, {});
  assert(!('toolSet' in without), '没有 toolSet 时不得凭空造一个');
});
await check('resultOfNestedCall: 按 callId 取 result', () => {
  const result = { isError: false, value: { subagentId: 'child-1' } };
  const batch = { results: [{ callId: 'C1:delegate', result }], additionalContexts: [], concluded: false };
  assertEqual(delegation.resultOfNestedCall(batch, 'C1:delegate'), result);
  assertEqual(delegation.resultOfNestedCall({ results: [] }, 'C1:delegate'), undefined);
  assertEqual(delegation.resultOfNestedCall(undefined, 'C1:delegate'), undefined);
});
await check('describeBatchFailure: 带出 cause 链（不再只剩通用文案）', () => {
  const text = delegation.describeBatchFailure(new Error('Tool batch execution failed', {
    cause: new TypeError('signal is undefined'),
  }));
  assert(text.includes('Tool batch execution failed'), '必须含外层文案');
  assert(text.includes('signal is undefined'), '必须含根因');
});

// ── 6. inner error 不得被当成成功 ────────────────────────────────────────────
await check('describeInnerFailure: 保留 message/info/content 的可读诊断', () => {
  const text = delegation.describeInnerFailure({
    isError: true,
    error: { message: 'route not allowed', info: { code: 'X' } },
    content: [{ type: 'text', text: 'partial result' }],
  });
  assert(text.includes('route not allowed'), '必须含 error.message');
  assert(text.includes('"code":"X"') || text.includes('"code": "X"'), '必须含 error.info');
  assert(text.includes('partial result'), '必须保留部分结果文字');
});
await check('describeInnerFailure: 空错误也要有兜底文本', () => {
  const text = delegation.describeInnerFailure({});
  assert(text.length > 0);
});
await check('createDelegateTool: 子调用 isError 时抛出（不当成功 value）', async () => {
  // 0.2.2 的批量返回值：{results:[{callId, result}]}；失败信息在 result 里。
  const ctx = {
    tools: {
      execute: async () => ({
        results: [{ callId: 'C1:delegate', result: { isError: true, error: { message: 'child route denied' }, content: [] } }],
        additionalContexts: [],
        concluded: false,
      }),
    },
  };
  const nativeDefinition = {
    parameters: structuredClone(NATIVE_SUBAGENT_PARAMETERS),
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'x' }] },
  };
  const tool = delegation.createDelegateTool({
    ctx,
    nativeDefinition,
    executor: EXECUTOR,
    logger: { info() {} },
  });
  const exec = {
    callId: 'C1',
    signal: undefined,
    agent: {
      id: 'a',
      options: { model: 'gpt-6.1-sol' },
      session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    },
    deferContext() { throw new Error('must not defer on failure'); },
    concludeTurn() { throw new Error('must not conclude on failure'); },
  };
  let threw = false;
  try {
    await tool.execute({ prompt: 'x' }, exec);
  } catch (error) {
    threw = true;
    assert(/child route denied/.test(error.message), '错误必须带上子调用的可读诊断');
  }
  assert(threw, '子调用 isError 必须抛出，不能作为成功 value 返回');
});
await check('createDelegateTool: 成功时只返回 result.value 并转移延迟上下文', async () => {
  const deferred = [];
  const ctx = {
    tools: {
      execute: async (input) => {
        // 断言嵌套调用符合 0.2.2 批量契约。
        assertEqual(Array.isArray(input.calls), true, '入参必须是批量形状');
        assertEqual(input.calls.length, 1);
        assertEqual(input.calls[0].name, 'subagent');
        assertEqual(input.calls[0].id, 'C1:delegate');
        assertEqual(typeof input.calls[0].arguments, 'string', 'arguments 必须是 JSON 文本');
        const parsed = JSON.parse(input.calls[0].arguments);
        assert(parsed.provider === 'opencode-go', '非 Flash 应注入 Go pair');
        assert(parsed.reasoning_effort === 'low');
        assert(!('parent' in input) && !('rootCallId' in input), '不得再传 parent/rootCallId');
        return {
          results: [{
            callId: 'C1:delegate',
            result: {
              isError: false,
              value: { kind: 'foreground', runId: 'run-1', output: [] },
              additionalContexts: ['ctx-1'],
              concludesTurn: true,
            },
          }],
          additionalContexts: ['ctx-1'],
          concluded: true,
        };
      },
    },
  };
  const nativeDefinition = {
    parameters: structuredClone(NATIVE_SUBAGENT_PARAMETERS),
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'x' }] },
  };
  const tool = delegation.createDelegateTool({ ctx, nativeDefinition, executor: EXECUTOR, logger: { info() {} } });
  let concluded = false;
  const exec = {
    callId: 'C1',
    signal: undefined,
    agent: {
      id: 'a',
      options: { model: 'gpt-6.1-sol' },
      session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    },
    deferContext: (c) => deferred.push(c),
    concludeTurn: () => { concluded = true; },
  };
  const value = await tool.execute({ prompt: 'x' }, exec);
  assertEqual(value, { kind: 'foreground', runId: 'run-1', output: [] }, '成功只返回 result.value');
  assertEqual(deferred, ['ctx-1'], 'additionalContexts 必须转移到 deferContext');
  assert(concluded === true, 'concludesTurn 为 true 才调用 concludeTurn');
});
await check('createDelegateTool: 子代调用被拒绝（只有顶层可用）', async () => {
  const tool = delegation.createDelegateTool({
    ctx: { tools: { execute: async () => ({ isError: false, value: {} }) } },
    nativeDefinition: { parameters: {}, output: { schema: { type: 'object' }, render: () => [] } },
    executor: EXECUTOR,
    logger: { info() {} },
  });
  const exec = {
    callId: 'C1', token: 't',
    agent: {
      id: 'child',
      options: {},
      session: { requestHeader: () => ({ origin: 'subagent', delegationDepth: 1, config: {} }) },
    },
    deferContext() {}, concludeTurn() {},
  };
  let threw = false;
  try {
    await tool.execute({ prompt: 'x' }, exec);
  } catch (error) {
    threw = true;
    assert(/top-level/.test(error.message));
  }
  assert(threw, '子代调用 delegate_task 必须失败');
});
await check('cloneNativeParameters: 深拷贝，改副本不影响原定义', () => {
  const native = { parameters: { prompt: { type: 'string' }, provider: { type: 'string' } } };
  const cloned = delegation.cloneNativeParameters(native);
  cloned.prompt.type = 'number';
  assertEqual(native.parameters.prompt.type, 'string', '必须是深拷贝');
  assert(cloned.provider !== undefined && cloned.model === undefined, '保留原有参数集合');
});
await check('cloneNativeParameters: 无参数时明确失败', () => {
  assertThrows(() => delegation.cloneNativeParameters({}), '无 parameters 必须失败');
});
await check('findNativeSubagent: 真实 JSON Schema 形状 → 返回定义', () => {
  const definition = nativeSubagentDefinition();
  const tools = { get: () => definition };
  assert(delegation.findNativeSubagent(tools, 'agent') === definition, '真值在 parameters.properties 下，必须命中');
});
await check('findNativeSubagent: 只有顶层 provider/model（旧误判形状）→ 不合格', () => {
  const tools = { get: () => ({ parameters: { prompt: {}, provider: {}, model: {} }, output: {} }) };
  assert(
    delegation.findNativeSubagent(tools, 'agent') === undefined,
    '顶层 provider/model 不是宿主契约，必须判为无选模能力',
  );
});
await check('findNativeSubagent: 缺 provider/model 参数 → 视为无能力', () => {
  const tools = { get: () => ({ parameters: { type: 'object', properties: { prompt: {} } } }) };
  assert(delegation.findNativeSubagent(tools, 'agent') === undefined, '无 provider/model 参数即不合格');
});
await check('findNativeSubagent: 工具不可见 → undefined', () => {
  const tools = { get: () => undefined };
  assert(delegation.findNativeSubagent(tools, 'agent') === undefined);
});

// ── 7. 插件 Config 与导入无副作用 ───────────────────────────────────────────
await check('index.js Config: 默认值（enabled=true、preset=standard、executor 空、无专家）', () => {
  const parsed = entry.Config({});
  assert(parsed.enabled === true, '公开版默认开启自动策略（缺前置时用日志 fail-fast，不静默）');
  assert(parsed.preset === 'standard');
  assert(parsed.toolName === 'list_subagent_models');
  assert(parsed.order === 2850);
  assertEqual([parsed.executor.provider, parsed.executor.model, parsed.executor.reasoningEffort], ['', '', 'max']);
  assertEqual(parsed.experts, [], '专家路由默认空，正文不渲染任何具体路由名');
  assertEqual(parsed.texts, { economize: '', boss: '', child: '' });
  assert(parsed.guardNativeSubagent === true);
});
await check('index.js 导入无副作用，且导出 apply/name/inject', () => {
  assert(typeof entry.apply === 'function');
  assert(entry.name === 'dsh-submodel');
  assertEqual(entry.inject, ['tools', 'systemPrompt']);
});
await check('policy 常量与 plan 一致', () => {
  assertEqual(policy.ROUTING_SECTION, 'tool:model-routing');
  assertEqual(policy.ROUTING_ORDER, 2850);
  assertEqual(policy.DELEGATE_TOOL_NAME, 'delegate_task');
  assert(policy.CHILD_FORBIDDEN_TOOLS.includes('workflow'));
  assert(policy.CHILD_FORBIDDEN_TOOLS.includes('spawn_teammate'));
  assert(policy.CHILD_FORBIDDEN_TOOLS.includes('subagent_fork'));
});

// ── 8. enabled=false 时保持关闭即无感；guard 用返回值拒绝 ────────────────────────
await check('apply(enabled=false): 只注册一个空段，不注册任何工具/guard', () => {
  const sections = [];
  const guards = [];
  const registered = [];
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { get: () => undefined, register: (d) => { registered.push(d.name); return () => {}; }, guard: (g) => { guards.push(g); return () => {}; } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    on: () => () => {},
    get: () => undefined,
  };
  entry.apply(fakeCtx, entry.Config({ enabled: false }));
  assertEqual(sections.length, 1, 'enabled=false 只应注册一个段');
  assertEqual(sections[0].name, 'tool:model-routing');
  assertEqual(registered, [], 'enabled=false 不得注册任何新工具');
  assertEqual(guards, [], 'enabled=false 不得注册 guard');
  assertEqual(sections[0].text({ scope: 's' }), '', 'enabled=false 时正文段为空');
});
await check('apply(enabled=true): 静态段为空串（正文交给 per-agent listener）', () => {
  const sections = [];
  const listened = [];
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      get: () => undefined,
      register: () => () => {},
      guard: () => () => {},
    },
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    on: (event) => { listened.push(event); return () => {}; },
    get: () => undefined,
  };
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  assertEqual(sections.length, 1, '只能有一个同名段，不能重复注册');
  assertEqual(sections[0].text({ scope: 's' }), '', 'enabled=true 时静态段必须为空，避免双份正文');
  for (const expected of ['agent/created', 'agent/disposed', 'tools/change', 'dispose']) {
    assert(listened.includes(expected), `必须监听 ${expected}`);
  }
});
await check('apply(enabled=true): 非 standard composition 不装（composition 判定）', () => {
  const registered = [];
  const listened = [];
  const candidate = {
    id: 'other',
    ctx: {},
    session: { requestHeader: () => ({ config: { model: 'gpt-6.1-sol' } }) },
    options: {},
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { get: () => ({ parameters: { type: 'object', properties: { provider: {}, model: {} } } }), register: (d) => { registered.push(d.name); return () => {}; }, guard: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on: (event) => { listened.push(event); return () => {}; },
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'ptc' }; // 不是 standard
      return undefined;
    },
  };
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  assertEqual(registered, [], '非 standard composition 不得安装任何工具');
});
await check('apply(enabled=true): 合格 standard root 只装 delegate_task（控制工具由官方提供）', async () => {
  const registered = [];
  const registeredDefinitions = [];
  const guards = [];
  const sections = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root',
    ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: (d) => { registered.push(d.name); registeredDefinitions.push(d); return () => {}; },
    guard: (g) => { guards.push(g); return () => {}; },
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    on: () => () => {},
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true, executor: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' } }));
  // 安装是 async 的（reconcile → installAgent），让微任务跑完。
  await new Promise((r) => setTimeout(r, 50));
  assert(registered.includes('delegate_task'), `顶层必须注册 delegate_task，实际: ${registered.join(',')}`);
  for (const name of ['send_subagent_message', 'interrupt_subagent', 'list_subagents']) {
    assert(!registered.includes(name), `本包不发布控制工具（官方已提供），不得注册 ${name}`);
  }
  assert(guards.length >= 1, '必须注册角色 guard');
  assert(disposedRegistrations.length === 0, '未卸载前不该有任何注册被回收');
  // 宿主 register 会校验 output.schema（非法即抛 JsonSchemaError）；这里按同一套子集守护。
  assertEqual(registeredDefinitions.length, 1, `只应注册 1 个工具定义（delegate_task），实际 ${registeredDefinitions.length}`);
  for (const definition of registeredDefinitions) {
    assertSupportedSchema(definition.parameters, `${definition.name}.parameters`);
    assertSupportedSchema(definition.output.schema, `${definition.name}.output.schema`);
  }
});
await check('assembly: sessionController.agents.selectionFor 优先于旧值且换模即时切换正文', async () => {
  const assemblyListeners = [];
  const lookedUpServices = [];
  const disposedRegistrations = [];
  const selection = { current: { provider: 'p-gpt', model: 'gpt-6.1-sol' } };
  let accepted = { id: 'selection-root', config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } };
  const candidate = {
    id: 'selection-root',
    ctx: {},
    session: { requestHeader: () => accepted },
    options: { model: 'deepseek-v4.1-flash' },
  };
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: () => () => {},
    guard: () => () => {},
  };
  const controller = {
    agents: {
      selectionFor: (target) => {
        assert(target === candidate, 'selectionFor 必须使用正在 assembly 的 agent');
        return selection;
      },
    },
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    get: (name) => {
      lookedUpServices.push(name);
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      if (name === 'sessionController') return controller;
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({
    get: fakeCtx.get,
    tools,
    on: (event, listener) => {
      if (event === 'system-prompt/assemble') assemblyListeners.push(listener);
      return () => {};
    },
    disposedRegistrations,
  });
  entry.apply(fakeCtx, entry.Config({ enabled: true, executor: EXECUTOR }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEqual(assemblyListeners.length, 1);
  const unchangedSection = Object.freeze({ name: 'unrelated-section', text: 'unchanged' });
  const assembly = Object.freeze({
    variables: Object.freeze({ model: 'deepseek-v4.1-flash' }),
    sections: Object.freeze([Object.freeze({ name: 'tool:model-routing', text: '' }), unchangedSection]),
  });
  const listener = assemblyListeners[0];
  const boss = await listener(assembly, { agent: candidate, scope: candidate }, async () => assembly);
  assertEqual(boss.sections[0].text, policy.routingTextFor('root', 'gpt-6.1-sol', { executor: EXECUTOR, experts: [], texts: { economize: '', boss: '', child: '' } }), '真实服务形状下新 GPT 选择必须覆盖旧 Flash');
  assert(boss.variables === assembly.variables && boss.sections[1] === unchangedSection, '不能修改变量或无关段');
  assertEqual(boss.sections[0].interpolate, false);
  accepted = { id: candidate.id, config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } };
  selection.current = { provider: 'deepseek-account', model: 'deepseek-flash' };
  const staleBossAssembly = { ...assembly, variables: { model: 'gpt-6.1-sol' } };
  const economize = await listener(staleBossAssembly, { agent: candidate, scope: candidate }, async () => staleBossAssembly);
  assertEqual(economize.sections[0].text, policy.routingTextFor('root', 'deepseek-flash', { executor: EXECUTOR, experts: [], texts: { economize: '', boss: '', child: '' } }), '同 agent 新 Flash 选择必须覆盖旧 GPT');
  assert(economize.sections[1] === unchangedSection, '换模不能修改无关段');
  selection.current = undefined;
  const fallback = await listener(staleBossAssembly, { agent: candidate, scope: candidate }, async () => staleBossAssembly);
  assertEqual(fallback.sections[0].text, policy.routingTextFor('root', 'gpt-6.1-sol', { executor: EXECUTOR, experts: [], texts: { economize: '', boss: '', child: '' } }), '无 session-local selection 时保留 assembly 变量回退');
  assert(lookedUpServices.includes('sessionController'), '必须查询真实 sessionController 服务');
  assert(!lookedUpServices.includes('apiSessionController'), '不得查询不存在的 apiSessionController 服务');
});
await check('schema 子集守护：能抓住旧的非法写法（否则该守护形同虚设）', () => {
  // 旧实现正是这三处非法写法，2026-10-05 在真实宿主里让整个安装零注册。
  const requiredOnString = { type: 'object', properties: { messageId: { type: 'string', required: true } } };
  assert(schemaViolations(requiredOnString).length > 0, '必须抓到 required 用在 string 节点上');
  const requiredOnArray = {
    type: 'object',
    properties: { agents: { type: 'array', required: true, items: { type: 'object', properties: {} } } },
  };
  assert(schemaViolations(requiredOnArray).length > 0, '必须抓到 required 用在 array 节点上');
  assert(
    schemaViolations({ type: 'object', properties: { ok: { type: 'string' } }, required: ['nope'] }).length > 0,
    '必须抓到 required 命名了未声明的属性',
  );
  assert(schemaViolations({ type: 'object', properties: { ok: { type: 'string' } }, required: 'ok' }).length > 0, '必须抓到 required 不是数组');
  assert(schemaViolations({ type: 'object', items: { type: 'string' } }).length > 0, '必须抓到 items 用在 object 上');
  assert(schemaViolations({ type: 'object', properties: { ok: { type: 'string' } }, required: ['ok'] }).length === 0, '合法形状不得误报');
});
await check('值层面守护：能抓住 note: undefined 这种坏形状（否则该守护形同虚设）', () => {
  // 缺陷 A 的原始形状：schema 完全合法，坏在**值**上——只有值层面的守护才抓得到。
  assertThrows(
    () => assertLosslessJsonValue({ agents: [{ agentId: 'c1', label: 'job', status: 'running', note: undefined }] }),
    '必须抓到"键存在但值为 undefined"',
  );
  assertThrows(() => assertLosslessJsonValue({ agents: [{ ok: 1, bad: () => {} }] }), '必须抓到函数值');
  assertThrows(() => assertLosslessJsonValue([{ ok: 1, bad: 10n }]), '必须抓到 bigint 值');
  assertLosslessJsonValue({ agents: [{ agentId: 'c1', label: 'job', status: 'running' }] }, 'value'); // 合法形状不得误报
  assertLosslessJsonValue({ agents: [{ agentId: 'c1', label: 'job', status: 'inactive', note: 'x' }] }, 'value');
});
await check('能力暂时缺失不得锁死：后续 tools/change 必须能补装', async () => {
  // 真实宿主里 `agent/created` 那一刻原生 subagent 可能还没注册好（实测 found=false）。
  // 旧实现在判据为假时**早退且泄漏 installing 标记** → 该 agent 被永久判为"正在安装"，
  // 之后所有 reconcile 全部被守卫挡掉、永不补装（实测 104 次 reconcile 全 isInstalling:true）。
  const registered = [];
  const guards = [];
  const listeners = [];
  const disposedRegistrations = [];
  let nativeAvailable = false; // ← 能力先缺失，稍后出现
  const candidate = {
    id: 'std-root',
    ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  const tools = {
    get: () => (nativeAvailable ? nativeSubagentDefinition() : undefined),
    register: (d) => { registered.push(d.name); return () => {}; },
    guard: (g) => { guards.push(g); return () => {}; },
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: (event, cb) => { listeners.push([event, cb]); return () => {}; },
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true, executor: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' } }));

  // ① 能力缺失时创建：允许不装，但**不得锁死**
  for (const [event, cb] of listeners) if (event === 'agent/created') await cb({ agent: candidate });
  await new Promise((r) => setTimeout(r, 30));
  assertEqual(registered, [], '能力缺失时不该注册任何工具');

  // ② 能力出现后 reconcile（真实宿主由原生工具注册触发的 tools/change）：必须补装
  nativeAvailable = true;
  for (const [event, cb] of listeners) if (event === 'tools/change') await cb();
  await new Promise((r) => setTimeout(r, 50));
  assert(registered.includes('delegate_task'), `能力出现后必须补装 delegate_task（实际: ${registered.join(',') || '空'}）`);
  assert(guards.length >= 1, '补装时也必须注册角色 guard');
});
await check('能力出现后 agent/pre-step 也必须补装（不依赖 tools/change）', async () => {
  // 实测：`agent/created` 之后**不一定再有 `tools/change`**，只靠它重试会永久漏装；
  // `agent/pre-step` 是每个 agent 每一步都过的 waterfall，必须能兜底，且必须返回 next()。
  const registered = [];
  const listeners = [];
  const disposedRegistrations = [];
  let nativeAvailable = false;
  const candidate = {
    id: 'std-root',
    ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  const tools = {
    get: () => (nativeAvailable ? nativeSubagentDefinition() : undefined),
    register: (d) => { registered.push(d.name); return () => {}; },
    guard: () => () => {},
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: (event, cb) => { listeners.push([event, cb]); return () => {}; },
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true }));

  for (const [event, cb] of listeners) if (event === 'agent/created') await cb({ agent: candidate });
  await new Promise((r) => setTimeout(r, 30));
  assertEqual(registered, [], '能力缺失时不该注册任何工具');

  nativeAvailable = true;
  let nextCalled = false;
  for (const [event, cb] of listeners) {
    if (event === 'agent/pre-step') await cb({ agent: candidate, messages: [], step: 1 }, () => { nextCalled = true; });
  }
  await new Promise((r) => setTimeout(r, 50));
  assert(nextCalled, 'agent/pre-step 监听器必须返回 next()（waterfall 纪律，不得接管决策）');
  assert(registered.includes('delegate_task'), `pre-step 兜底必须补装 delegate_task（实际: ${registered.join(',') || '空'}）`);
});
await check('子代 guard：对禁止工具返回字符串理由（不是抛异常）', async () => {
  const guards = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root',
    ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: () => () => {},
    guard: (g) => { guards.push(g); return () => {}; },
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  await new Promise((r) => setTimeout(r, 50));
  // guard 闭包按 agent 的实时 header 判定，所以这里让同一个 agent 对象"现在"看起来是子代。
  const childAgent = candidate;
  const originalHeader = childAgent.session.requestHeader;
  childAgent.session.requestHeader = () => ({ origin: 'subagent', delegationDepth: 1, config: { model: 'deepseek-v4.1-flash' } });
  childAgent.options = { subagentDepth: 1 };
  const reasons = [];
  try {
    for (const g of guards) {
      let r;
      try {
        r = g({ name: 'workflow', agent: childAgent, arguments: {} });
      } catch (error) {
        throw new Error(`guard 必须用返回值拒绝，抛异常会把 guard 故障和策略拒绝混为一谈: ${error.message}`);
      }
      if (typeof r === 'string') reasons.push(r);
    }
  } finally {
    childAgent.session.requestHeader = originalHeader;
    childAgent.options = { model: 'gpt-6.1-sol' };
  }
  assert(reasons.length >= 1, '子代调用 workflow 必须被 guard 用字符串理由拒绝');
  assert(/unavailable to a delegated subagent/.test(reasons[0]));
});
await check('子代 guard：允许非禁止工具（不误伤 read）', async () => {
  const guards = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root', ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: () => () => {},
    guard: (g) => { guards.push(g); return () => {}; },
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  await new Promise((r) => setTimeout(r, 50));
  const childAgent = candidate;
  const originalHeader = childAgent.session.requestHeader;
  childAgent.session.requestHeader = () => ({ origin: 'subagent', delegationDepth: 1, config: {} });
  childAgent.options = { subagentDepth: 1 };
  try {
    for (const g of guards) {
      const r = g({ name: 'read', agent: childAgent, arguments: {} });
      assert(r === undefined, `guard 不得拦截 read，实际返回: ${String(r)}`);
    }
  } finally {
    childAgent.session.requestHeader = originalHeader;
    childAgent.options = { model: 'gpt-6.1-sol' };
  }
});
await check('非 Flash root 的 native subagent guard：half pair 被拒、完整 pair 放行', async () => {
  const guards = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root', ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: () => () => {},
    guard: (g) => { guards.push(g); return () => {}; },
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  await new Promise((r) => setTimeout(r, 50));
  const collect = (args) => {
    const out = [];
    for (const g of guards) {
      const r = g({ name: 'subagent', agent: candidate, arguments: args });
      if (typeof r === 'string') out.push(r);
    }
    return out;
  };
  const halfPair = collect({ provider: 'p-opus' });
  assert(halfPair.length >= 1, '非 Flash 顶层用 native subagent 且只给 provider 时必须被拒');
  assert(/delegate_task/.test(halfPair[0]), '拒绝理由必须指向 delegate_task');
  assertEqual(collect({ provider: 'p-opus', model: 'claude-opus-5-5' }), [], '完整显式 pair 必须放行');
  // plan 2.4：非 Flash 顶层"无完整显式 pair"一律拒绝并指向 delegate_task（防绕过默认 Go）。
  const noRoute = collect({ prompt: 'x' });
  assert(noRoute.length >= 1, '非 Flash 顶层用 native subagent 且完全不给 route 时必须被拒');
  assert(/delegate_task/.test(noRoute[0]), '无 route 的拒绝理由同样必须指向 delegate_task');
  // 只有 model、没有 provider 也是 half pair → 同样拒绝。
  const halfPair2 = collect({ model: 'claude-opus-5-5' });
  assert(halfPair2.length >= 1, '只给 model 也必须被拒');
});

// ── 9. 重入 / 卸载 / 失败清理 ───────────────────────────────────────────────
await check('重复 reconcile 不产生重复注册（幂等）', async () => {
  const registered = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root', ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  const listeners = [];
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: (d) => { registered.push(d.name); return () => {}; },
    guard: () => () => {},
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: (event, cb) => { listeners.push([event, cb]); return () => {}; },
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  await new Promise((r) => setTimeout(r, 50));
  const firstCount = registered.length;
  for (const [event, cb] of listeners) if (event === 'tools/change') cb();
  for (const [event, cb] of listeners) if (event === 'tools/change') cb();
  await new Promise((r) => setTimeout(r, 50));
  assertEqual(registered.length, firstCount, '重入不得重复注册（同一 agent 只能装一次）');
});
await check('agent/disposed 后工具被卸载，且再次安装不报错', async () => {
  const registered = [];
  const disposedNames = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root', ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  const listeners = [];
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: (d) => { registered.push(d.name); return () => { disposedNames.push(d.name); }; },
    guard: () => () => {},
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: (event, cb) => { listeners.push([event, cb]); return () => {}; },
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert(registered.includes('delegate_task'));
  for (const [event, cb] of listeners) if (event === 'agent/disposed') await cb({ agent: candidate });
  await new Promise((r) => setTimeout(r, 30));
  assert(disposedNames.includes('delegate_task'), 'dispose 必须卸载 delegate_task');
  assert(registered.every((name) => disposedNames.includes(name)), 'dispose 必须回收该 agent 的全部注册');
});
await check('安装失败时清理部分注册并上报（不吞异常）', async () => {
  const disposed = [];
  const errors = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root', ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  let registeredCount = 0;
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: () => {
      registeredCount += 1;
      if (registeredCount === 1) throw new Error('boom: simulated register failure');
      return () => { disposed.push('x'); };
    },
    guard: () => () => {},
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error: (m) => errors.push(m) },
    tools,
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  await new Promise((r) => setTimeout(r, 60));
  assert(disposedRegistrations.length >= 1, '失败路径必须回收已完成的注册（否则泄漏）');
  assert(errors.some((m) => /failed to install/.test(m)), '失败必须上报，不得静默吞掉');
});
await check('plugin dispose 卸载所有 owned 安装', async () => {
  const disposed = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root', ctx: {},
    session: { requestHeader: () => ({ id: 's1', config: { provider: 'p-gpt', model: 'gpt-6.1-sol' } }) },
    options: { model: 'gpt-6.1-sol' },
  };
  const listeners = [];
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: (d) => { return () => { disposed.push(d.name); }; },
    guard: () => () => {},
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: (event, cb) => { listeners.push([event, cb]); return () => {}; },
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = makeAgentCtx({ get: fakeCtx.get, tools, on: () => () => {}, disposedRegistrations });
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  await new Promise((r) => setTimeout(r, 50));
  for (const [event, cb] of listeners) if (event === 'dispose') await cb();
  await new Promise((r) => setTimeout(r, 30));
  assert(disposed.length >= 1, `cleanup 应卸载全部自有注册，实际 ${disposed.length}`);
  assert(disposedRegistrations.length >= 4, 'cleanup 必须回收该 agent 上的注册');
});

// ── 10. 正文模板化 / 渲染 / fail-fast 文案 ────────────────────────────────────
await check('策略正文：升级判据是"问题复杂度"，审查不是理由，且只引用官方工具名', () => {
  const renderContext = { executor: EXECUTOR, experts: [], texts: {} };
  for (const model of ['deepseek-flash', 'gpt-6.1-sol']) {
    const text = policy.routingTextFor('root', model, renderContext);
    assert(text.includes('复杂代码/逻辑判断'), '升级判据必须是"问题本身的复杂度"');
    assert(text.includes('需要独立审查/复核'), '必须写明"审查/复核"本身不是升级理由');
    for (const banned of ['list_subagents', 'wait_subagents', 'send_subagent_message', 'interrupt_subagent']) {
      assert(!text.includes(banned), `正文不得出现本包不发布的工具名 ${banned}`);
    }
    assert(!text.includes('m-opus'), '正文不得出现本机兜底路由名');
  }
  const boss = policy.routingTextFor('root', 'gpt-6.1-sol', renderContext);
  for (const official of ['list_agents', 'send_message', 'interrupt_agent']) {
    assert(boss.includes(official), `boss 段必须引用官方控制工具 ${official}`);
  }
  assert(!policy.routingTextFor('child', 'gpt-6.1-sol').includes('p-opus'), 'child 段仍不得包含主脑升级策略');
});
await check('renderExpertRoutes: 逐行渲染，空数组给"未配置"提示', () => {
  const empty = policy.renderExpertRoutes([]);
  assert(empty.includes('未配置专家路由'), '空数组必须给提示行');
  assert(empty.includes('provider/model'), '提示行要指向显式传 provider/model');
  assertEqual(policy.renderExpertRoutes(undefined), empty, '非数组按空处理');
  const one = policy.renderExpertRoutes([{ label: '代码专家', provider: 'p-opus', model: 'claude-opus-5-5', reasoningEffort: 'max' }]);
  assert(one.includes('代码专家'));
  assert(one.includes('provider: "p-opus"'));
  assert(one.includes('model: "claude-opus-5-5"'));
  assertEqual(one.split('\n').length, 1, '一条路由一行');
  const two = policy.renderExpertRoutes([
    { label: 'A', provider: 'pa', model: 'ma' },
    { label: 'B', provider: 'pb', model: 'mb' },
  ]);
  assertEqual(two.split('\n').length, 2, '两条路由两行');
});
await check('renderTemplate: 只替换两个占位符，executor 空为（未配置）', () => {
  const out = policy.renderTemplate('A{{executorRoute}}B{{expertRoutes}}C{{unknown}}', {
    executor: { provider: 'route-a', model: 'model-a' },
    experts: [],
  });
  assert(out.startsWith('A'), '模板前缀必须保留');
  assert(out.includes('provider: "route-a"') && out.includes('model: "model-a"'));
  assert(out.includes('未配置专家路由'));
  assert(out.includes('{{unknown}}'), '未知占位符必须原样保留');
  assert(policy.renderTemplate('x{{executorRoute}}y', {}).includes('（未配置）'), 'executor 未配置时给可读占位');
});
await check('routingTextFor: texts 非空时整段替换且不再插值', () => {
  const custom = policy.routingTextFor('root', 'gpt-6.1-sol', {
    executor: { provider: 'route-a', model: 'model-a' },
    experts: [],
    texts: { boss: 'CUSTOM {{executorRoute}}' },
  });
  assertEqual(custom, 'CUSTOM {{executorRoute}}', '用户覆盖正文后不得再插值');
  assertEqual(policy.routingTextFor('child', 'x', { texts: { child: 'CHILD CUSTOM' } }), 'CHILD CUSTOM');
  assertEqual(
    policy.routingTextFor('root', 'gpt-6.1-sol', { texts: { economize: 'ECO CUSTOM' } }),
    policy.routingTextFor('root', 'gpt-6.1-sol'),
    '非当前模式的覆盖不生效',
  );
});
await check('内置模板不含任何具体渠道/模型名（路由只经占位符注入）', () => {
  const renderContext = {
    executor: { provider: 'route-a', model: 'model-a' },
    experts: [{ label: '专家A', provider: 'route-b', model: 'model-b' }],
    texts: {},
  };
  for (const model of ['deepseek-flash', 'gpt-6.1-sol']) {
    const text = policy.routingTextFor('root', model, renderContext);
    for (const leaked of ['p-opus', 'p-gpt', 'm-opus', 'opencode-go', 'deepseek-account', 'claude-opus-5-5', 'deepseek-v4.1-flash']) {
      assert(!text.includes(leaked), `模板不得含本机路由名 ${leaked}`);
    }
  }
});
await check('apply fail-fast: executor 未配置时记 error 日志且不抛', () => {
  const errors = [];
  const fakeCtx = {
    logger: { info() {}, warn() {}, error: (m) => errors.push(m) },
    tools: { get: () => undefined, register: () => () => {}, guard: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    get: () => undefined,
  };
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  assert(errors.some((m) => m.includes('config.executor.provider/model') && m.includes('未配置')), `实际 error: ${errors.join(' | ')}`);
});
await check('apply fail-fast: 无 agentPresets 服务时每 agent 一次 warn（不静默）', async () => {
  const warns = [];
  const listeners = [];
  const candidate = { id: 'c1', ctx: {}, session: { requestHeader: () => ({ config: { model: 'gpt-6.1-sol' } }) }, options: {} };
  const fakeCtx = {
    logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    tools: { get: () => undefined, register: () => () => {}, guard: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on: (event, cb) => { listeners.push([event, cb]); return () => {}; },
    get: (name) => (name === 'agents' ? { list: () => [candidate] } : undefined),
  };
  candidate.ctx = { get: fakeCtx.get, tools: fakeCtx.tools, on: () => () => {} };
  entry.apply(fakeCtx, entry.Config({ enabled: true }));
  await new Promise((r) => setTimeout(r, 30));
  assertEqual(warns.filter((m) => m.includes('无 agentPresets')).length, 1, '每 agent 一次');
  for (const [event, cb] of listeners) if (event === 'tools/change') cb();
  await new Promise((r) => setTimeout(r, 30));
  assertEqual(warns.filter((m) => m.includes('无 agentPresets')).length, 1, '重复 reconcile 不得重复 warn');
});
await check('apply fail-fast: 原生 subagent 无 provider/model 时 warn 一次且不装 delegate_task', async () => {
  const warns = [];
  const registered = [];
  const candidate = { id: 'c1', ctx: {}, session: { requestHeader: () => ({ config: { model: 'gpt-6.1-sol' } }) }, options: {} };
  const tools = {
    get: (name) => (name === 'subagent'
      ? { parameters: { type: 'object', properties: { prompt: { type: 'string' } } }, output: {} }
      : undefined),
    register: (d) => { registered.push(d.name); return () => {}; },
    guard: () => () => {},
  };
  const fakeCtx = {
    logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = { get: fakeCtx.get, tools, on: () => () => {} };
  entry.apply(fakeCtx, entry.Config({ enabled: true, executor: EXECUTOR }));
  await new Promise((r) => setTimeout(r, 50));
  assertEqual(registered, [], '原生 subagent 无选模能力时不得注册 delegate_task');
  assertEqual(warns.filter((m) => m.includes('未暴露 provider/model')).length, 1, '每 agent 一次 warn');
});
await check('apply fail-fast: list_subagent_models 不可见时 info 一次且策略段不渲染', async () => {
  const infos = [];
  const assemblyListeners = [];
  const candidate = { id: 'c1', ctx: {}, session: { requestHeader: () => ({ config: { model: 'gpt-6.1-sol' } }) }, options: { model: 'gpt-6.1-sol' } };
  const tools = {
    get: (name) => (name === 'subagent' ? nativeSubagentDefinition() : undefined),
    register: () => () => {},
    guard: () => () => {},
  };
  const fakeCtx = {
    logger: { info: (m) => infos.push(m), warn() {}, error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
      return undefined;
    },
  };
  candidate.ctx = {
    get: fakeCtx.get,
    tools,
    on: (event, listener) => {
      if (event === 'system-prompt/assemble') assemblyListeners.push(listener);
      return () => {};
    },
  };
  entry.apply(fakeCtx, entry.Config({ enabled: true, executor: EXECUTOR }));
  await new Promise((r) => setTimeout(r, 50));
  assertEqual(assemblyListeners.length, 1);
  const assembly = Object.freeze({
    variables: Object.freeze({ model: 'gpt-6.1-sol' }),
    sections: Object.freeze([Object.freeze({ name: 'tool:model-routing', text: '' })]),
  });
  const listener = assemblyListeners[0];
  const first = await listener(assembly, { agent: candidate, scope: candidate }, async () => assembly);
  const second = await listener(assembly, { agent: candidate, scope: candidate }, async () => assembly);
  assertEqual(first.sections[0].text, '', '工具不可见时策略段不得渲染');
  assertEqual(second.sections[0].text, '');
  assertEqual(infos.filter((m) => m.includes('未启用官方 subagent 模型选择')).length, 1, '每 agent 一次 info');
});

// ── 输出 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
process.stdout.write(`${JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
