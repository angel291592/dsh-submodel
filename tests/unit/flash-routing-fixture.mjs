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
import { deepStrictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const setupUrl = pathToFileURL(resolvePath(libDir, 'setup.js')).href;
const teamFitUrl = pathToFileURL(resolvePath(libDir, 'team-fit.js')).href;
const entryUrl = pathToFileURL(resolvePath(libDir, 'index.js')).href;

const policy = await import(policyUrl);
const delegation = await import(delegationUrl);
const setup = await import(setupUrl);
const teamFit = await import(teamFitUrl);
const entry = await import(entryUrl);
const { installWatchdog, sumUsage } = await import(pathToFileURL(resolvePath(libDir, 'watchdog.js')).href);
const { default: schema } = await import('@deepseek-ai/schemastery');

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
 * 构造 fake agent 的 `session` 替身。**两份 header 数据别合并**（生产实现故意分开读）：
 *
 * - `header` 是 **durable session header**，也是 `roleOf(agent)` 的唯一角色判据：
 *   宿主 `dsh-session` 只允许 `origin` 为 `'subagent'` 或省略，`delegationDepth` 为非负安全整数；
 *   顶层会话用 `{}` / `{ delegationDepth: 0 }`，子代用 `{ origin: 'subagent', delegationDepth: 1 }`。
 * - `requestHeader()` 是 0.2.2 的 `EpochHeader`（`{config, tools}`，**没有** origin/depth），
 *   只供执行期读路由，不能拿来判角色。
 *
 * @param header - durable header（roleOf 判据）。
 * @param requestHeader - 执行期 header 读取器。
 * @returns `{ header, requestHeader }`。
 */
function makeSession(header, requestHeader = () => ({})) {
  return { header, requestHeader };
}

/** 顶层 fake agent 的 session（宿主里根会话没有 origin，depth 为 0）。 */
function rootSession(requestHeader) {
  return makeSession({ delegationDepth: 0 }, requestHeader);
}

/** 子代 fake agent 的 session（宿主唯一的 origin 取值就是 'subagent'）。 */
function childSession(requestHeader, depth = 1) {
  return makeSession({ origin: 'subagent', delegationDepth: depth }, requestHeader);
}

/**
 * fixture 用的「agent 自己的 ctx」替身。
 *
 * 生产实现经 **agent 自己的 ctx** 注册（宿主官方指引：`dsh-tools:2634` 的重复注册报错原文
 * "register through that agent's `agent.ctx` instead"），不再自建 scope。所以这里给出
 * `{get, tools, on}` 三件套，并把每个注册的 disposer 包一层记进 `disposedRegistrations`——
 * 这样"卸载时确实回收了该 agent 上的注册"仍被真实断言，而不是被替身抹平。
 *
 * 注意：本 helper 只造 ctx；**agent 对象本身的 durable `session.header`** 由各 case 用
 * `rootSession(...)` / `childSession(...)` 提供（roleOf 的新判据）。
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
  assert(policy.isFlashModel('example-v4-flashx') === false);
  assert(policy.isFlashModel('example-main') === false);
});
await check('isFlashModel: provider 名不参与判断', () => {
  // 唯一规则只看 model id；这些是 provider 名/其他标识，不该被当成 Flash。
  assert(policy.isFlashModel('fixture-executor') === false);
  assert(policy.isFlashModel('fixture-account') === false);
  assert(policy.isFlashModel('fixture-expert') === false);
});
await check('isFlashModel: 空值/非字符串安全', () => {
  assert(policy.isFlashModel(undefined) === false);
  assert(policy.isFlashModel(null) === false);
  assert(policy.isFlashModel('') === false);
  assert(policy.isFlashModel(123) === false);
});
// ── 1b. 模式判定：路由匹配取代 flash 后缀（后缀只是 economyRoutes 为空时的 legacy 回退）──
// 判定口径（plan §2.2）：① executor 的 provider+model 完全相等；② 命中 economyRoutes
// （双方 provider 都非空时都比，任一方为空时只比 model）；③ economyRoutes 为空时回退 flash 后缀。
const MODE_CFG = Object.freeze({
  executor: Object.freeze({ provider: 'exec-provider', model: 'exec-model', reasoningEffort: 'max' }),
  economyRoutes: Object.freeze([]),
});

await check('modeForRoute: 与 executor 的 provider+model 完全相等 → economize', () => {
  assertEqual(policy.modeForRoute({ provider: 'exec-provider', model: 'exec-model' }, MODE_CFG), 'economize');
  assertEqual(policy.modeForRoute({ provider: 'exec-provider', model: 'exec-model' }, MODE_CFG), policy.MODE_ECONOMIZE);
});

await check('modeForRoute: 命中 economyRoutes（provider+model 都比）→ economize', () => {
  const cfg = { executor: { provider: '', model: '' }, economyRoutes: [{ provider: 'eco-provider', model: 'eco-model' }] };
  assertEqual(policy.modeForRoute({ provider: 'eco-provider', model: 'eco-model' }, cfg), 'economize');
  assertEqual(policy.modeForRoute({ provider: 'other-provider', model: 'eco-model' }, cfg), 'boss', 'provider 不同且两边都非空 → 不命中');
  assertEqual(policy.modeForRoute({ provider: 'eco-provider', model: 'other-model' }, cfg), 'boss', 'model 不同 → 不命中');
});

await check('modeForRoute: 仅 model 命中（任一方 provider 为空）→ economize', () => {
  const cfgNoProvider = { economyRoutes: [{ provider: '', model: 'eco-model' }] };
  assertEqual(policy.modeForRoute({ provider: 'any-provider', model: 'eco-model' }, cfgNoProvider), 'economize', '条目 provider 为空 → 只比 model');
  const cfgWithProvider = { economyRoutes: [{ provider: 'eco-provider', model: 'eco-model' }] };
  assertEqual(policy.modeForRoute({ provider: '', model: 'eco-model' }, cfgWithProvider), 'economize', 'route provider 为空 → 只比 model');
});

await check('modeForRoute: 不命中 → boss（含 model 缺失/空）', () => {
  assertEqual(policy.modeForRoute({ provider: 'other-provider', model: 'other-model' }, MODE_CFG), 'boss');
  assertEqual(policy.modeForRoute({ provider: 'exec-provider', model: 'other-model' }, MODE_CFG), 'boss');
  assertEqual(policy.modeForRoute({ provider: 'exec-provider', model: '' }, MODE_CFG), 'boss', '空 model 不猜模式');
  assertEqual(policy.modeForRoute({ provider: 'exec-provider' }, MODE_CFG), 'boss');
  assertEqual(policy.modeForRoute(undefined, MODE_CFG), 'boss');
  assertEqual(policy.modeForRoute({ provider: 'exec-provider', model: 'exec-model' }, undefined), 'boss', '无 cfg 时不命中');
});

await check('modeForRoute: economyRoutes 为空时保留 flash 后缀兼容（legacy）', () => {
  const cfg = { executor: { provider: '', model: '' }, economyRoutes: [] };
  assertEqual(policy.modeForRoute({ provider: 'any-provider', model: 'deepseek-flash' }, cfg), 'economize');
  assertEqual(policy.modeForRoute({ provider: 'any-provider', model: 'DEEPSEEK-FLASH' }, cfg), 'economize', '大小写不敏感');
  assertEqual(policy.modeForRoute({ provider: 'any-provider', model: 'flash-lite' }, cfg), 'boss', '后缀才算');
});

await check('modeForRoute: economyRoutes 非空时 flash 后缀失效（旧规则不再参与）', () => {
  const cfg = { executor: { provider: '', model: '' }, economyRoutes: [{ provider: '', model: 'explicit-model' }] };
  assertEqual(policy.modeForRoute({ provider: 'any-provider', model: 'deepseek-flash' }, cfg), 'boss', '配了显式列表就不再用后缀猜');
  assertEqual(policy.modeForRoute({ provider: 'any-provider', model: 'explicit-model' }, cfg), 'economize');
});

// ── 2. 角色判定：durable session header（origin/depth）+ options 冷恢复兜底 ────────
// 旧实现读 EpochHeader（0.2.2 的 requestHeader 里没有 origin/depth），导致冷恢复子代
// 永远判成 root；新实现读 agent.session.header，并允许 options.subagentDepth 兜底。
await check('roleOf: header.origin=subagent 判 child', () => {
  assertEqual(policy.roleOf({ session: makeSession({ origin: 'subagent' }) }), 'child');
  assertEqual(policy.roleOf({ session: makeSession({ origin: 'subagent', delegationDepth: 0 }) }), 'child', 'origin 命中即可，不要求 depth');
});
await check('roleOf: header.delegationDepth > 0 判 child', () => {
  for (const depth of [1, 2, 7]) {
    assertEqual(policy.roleOf({ session: makeSession({ delegationDepth: depth }) }), 'child', `depth=${depth} 应判 child`);
  }
  assertEqual(policy.roleOf({ session: makeSession({ origin: 'anything-else', delegationDepth: 1 }) }), 'child', 'depth 判据独立于 origin 的非法值');
});
await check('roleOf: options.subagentDepth > 0 判 child（冷恢复没有 header.depth 时的兜底）', () => {
  assertEqual(policy.roleOf({ options: { subagentDepth: 1 } }), 'child');
  assertEqual(policy.roleOf({ options: { subagentDepth: 3 } }), 'child');
});
await check('roleOf: 顶层（无 origin、无正 depth）判 root', () => {
  assertEqual(policy.roleOf({ session: makeSession({}), options: {} }), 'root');
  assertEqual(policy.roleOf({ session: makeSession({ delegationDepth: 0 }), options: { subagentDepth: 0 } }), 'root');
  assertEqual(policy.roleOf(undefined), 'root');
  assertEqual(policy.roleOf({}), 'root');
  // 普通 fork 带 parentSession，但没有 subagent origin/正 depth —— 不是子代。
  assertEqual(policy.roleOf({ session: makeSession({ parentSession: 'sess-abc' }) }), 'root', 'parentSession 不能单独当子代依据');
});
await check('roleOf: 优先级 origin > header.depth > options.depth（任一命中即 child）', () => {
  assertEqual(
    policy.roleOf({ session: makeSession({ origin: 'subagent', delegationDepth: 0 }), options: { subagentDepth: 0 } }),
    'child',
    'origin=subagent 优先，其它判据为 0 也不影响',
  );
  assertEqual(
    policy.roleOf({ session: makeSession({ delegationDepth: 1 }), options: { subagentDepth: 0 } }),
    'child',
    'header.depth 次之',
  );
  assertEqual(
    policy.roleOf({ session: makeSession({ delegationDepth: 0 }), options: { subagentDepth: 2 } }),
    'child',
    'options 兜底第三',
  );
});
await check('roleOf: session 缺失时只用 options（不抛）', () => {
  assertEqual(policy.roleOf({ options: { subagentDepth: 1 } }), 'child');
  assertEqual(policy.roleOf({ options: {} }), 'root');
  assertEqual(policy.roleOf({ session: undefined, options: { subagentDepth: 0 } }), 'root');
  assertEqual(policy.roleOf({ session: null, options: { subagentDepth: 2 } }), 'child');
});
await check('roleOf: 非法 depth 值不判 child', () => {
  for (const bad of ['1', NaN, Infinity, -Infinity, -1, null, true, {}]) {
    assertEqual(
      policy.roleOf({ session: makeSession({ delegationDepth: bad }), options: {} }),
      'root',
      `header.delegationDepth=${String(bad)} 不该判 child`,
    );
    assertEqual(policy.roleOf({ options: { subagentDepth: bad } }), 'root', `options.subagentDepth=${String(bad)} 不该判 child`);
  }
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
await check('resolveCallerRole: live root 成功（角色来自 durable header）', () => {
  const agent = {
    id: 'a',
    options: { model: 'example-main' },
    session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
  };
  const r = policy.resolveCallerRole({ agent });
  assert(r.ok === true);
  assert(r.role === 'root');
  assert(r.agent === agent, 'resolveCallerRole 必须回传 agent');
  assertEqual(r.header.id, 's1', 'header 取的是 session.requestHeader()（执行期 header）');
});

// ── 3. 显式 pair 的完整性与路由默认值 ────────────────────────────────────────
await check('classifyExplicitRoute: 完整 pair', () => {
  assertEqual(policy.classifyExplicitRoute({ provider: 'fixture-expert', model: 'example-opus' }), {
    kind: 'pair', provider: 'fixture-expert', model: 'example-opus',
  });
});
await check('classifyExplicitRoute: 只有 provider 立即失败', () => {
  const r = policy.classifyExplicitRoute({ provider: 'fixture-expert' });
  assert(r.kind === 'invalid');
  assert(/model/.test(r.reason));
});
await check('classifyExplicitRoute: 只有 model 立即失败', () => {
  const r = policy.classifyExplicitRoute({ model: 'example-opus' });
  assert(r.kind === 'invalid');
  assert(/provider/.test(r.reason));
});
await check('classifyExplicitRoute: 都没有 = none', () => {
  assertEqual(policy.classifyExplicitRoute({ prompt: 'x' }), { kind: 'none' });
});

const EXECUTOR = { provider: 'fixture-executor', model: 'example-v4-flash', reasoningEffort: 'low' };

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
  assertEqual([r.args.provider, r.args.model, r.args.reasoning_effort], ['fixture-executor', 'example-v4-flash', 'low']);
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
  assertEqual(r.args.provider, 'fixture-executor', 'route 仍补 executor');
});
await check('resolveDelegationArgs: 完整显式 pair 不被改写、不注入 effort', () => {
  const r = policy.resolveDelegationArgs(
    { prompt: 'x', provider: 'fixture-expert', model: 'example-opus' },
    'boss',
    EXECUTOR,
  );
  assert(r.applied === 'explicit');
  assertEqual([r.args.provider, r.args.model], ['fixture-expert', 'example-opus']);
  assert(r.args.reasoning_effort === undefined, '完整显式路线不注入策略 effort');
});
await check('resolveDelegationArgs: half pair 失败，不偷偷补 Go', () => {
  const r = policy.resolveDelegationArgs({ prompt: 'x', provider: 'fixture-expert' }, 'boss', EXECUTOR);
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

// ── 4. assembly 路由解析：变量优先、缺 model 报错、listener 回退 agent.options ────
await check('routeFromAssembly: provider+model 变量都取到', () => {
  assertEqual(policy.routeFromAssembly({ variables: { provider: 'fixture-main', model: 'example-main' } }), {
    provider: 'fixture-main',
    model: 'example-main',
  });
});
await check('routeFromAssembly: 只有 model 时 provider 为空串', () => {
  assertEqual(policy.routeFromAssembly({ variables: { model: 'deepseek-flash' } }), { provider: '', model: 'deepseek-flash' });
  assertEqual(policy.routeFromAssembly({ variables: { provider: 42, model: 'm' } }), { provider: '', model: 'm' }, '非字符串 provider 按空串处理');
});
await check('routeFromAssembly: model 缺失/空值明确报错，不猜模型', () => {
  assertThrows(() => policy.routeFromAssembly({ variables: {} }), '缺 model 必须抛错');
  assertThrows(() => policy.routeFromAssembly({ variables: { model: '' } }), '空 model 必须抛错');
  assertThrows(() => policy.routeFromAssembly({}), '无 variables 必须抛错');
  assertThrows(() => policy.routeFromAssembly(undefined), 'undefined assembly 必须抛错');
});
await check('assembly listener: variables 缺 model 时回退 agent.options；缺两处不崩且警告', async () => {
  const assemblyListeners = [];
  const lookedUpServices = [];
  const warns = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'options-root',
    ctx: {},
    // durable header 判 root；requestHeader 的 config 故意与 options 不同，证明回退读的是 options。
    session: rootSession(() => ({ id: 's-opt', config: { provider: 'header-provider', model: 'header-model' } })),
    options: { provider: 'opt-provider', model: 'opt-model' },
  };
  const tools = {
    get: (name) => (name === 'subagent' ? nativeSubagentDefinition() : name === 'list_subagent_models' ? {} : undefined),
    register: () => () => {},
    guard: () => () => {},
  };
  const fakeCtx = {
    logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    tools,
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    get: (name) => {
      lookedUpServices.push(name);
      if (name === 'agents') return { list: () => [candidate] };
      if (name === 'agentPresets') return { composedPreset: () => 'standard' };
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
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEqual(assemblyListeners.length, 1);
  const listener = assemblyListeners[0];
  const expectedFor = (route) =>
    policy.routingTextFor('root', route, { executor: EXECUTOR, experts: [], texts: { economize: '', boss: '', child: '' } });

  // ① variables 里没有 model → 回退 agent.options 的 provider/model。
  const fallbackAssembly = { variables: {}, sections: [{ name: policy.ROUTING_SECTION, text: '' }] };
  const resolved = await listener(fallbackAssembly, { agent: candidate, scope: candidate }, async () => fallbackAssembly);
  assertEqual(
    resolved.sections[0].text,
    expectedFor({ provider: 'opt-provider', model: 'opt-model' }),
    'variables 缺 model 必须回退 agent.options 路由',
  );
  assertEqual(resolved.sections[0].interpolate, false);
  assert(!lookedUpServices.includes('sessionController'), '0.2.2 没有 sessionController，不得再查询该死通道');

  // ② variables 有 model 时优先于 options（描述 GUI 即将发起的这笔请求）。
  const variablesAssembly = {
    variables: { provider: 'var-provider', model: 'var-model' },
    sections: [{ name: policy.ROUTING_SECTION, text: '' }],
  };
  const fromVariables = await listener(variablesAssembly, { agent: candidate, scope: candidate }, async () => variablesAssembly);
  assertEqual(fromVariables.sections[0].text, expectedFor({ provider: 'var-provider', model: 'var-model' }), 'assembly 变量必须优先于 agent.options');

  // ③ 两处都没有 model → routeFromAssembly 抛错，listener 只警告并保持原段（不得把 assembly 弄挂）。
  const missingAssembly = { variables: {}, sections: [{ name: policy.ROUTING_SECTION, text: 'STALE' }] };
  const originalOptions = candidate.options;
  candidate.options = {};
  let crashed = false;
  let fromMissing;
  try {
    fromMissing = await listener(missingAssembly, { agent: candidate, scope: candidate }, async () => missingAssembly);
  } catch {
    crashed = true;
  } finally {
    candidate.options = originalOptions;
  }
  assert(crashed === false, '两处都缺 model 时不得把 assembly 弄挂');
  assertEqual(fromMissing.sections[0].text, 'STALE', '缺 model 时保持原段');
  assertEqual(warns.filter((m) => m.includes('assembly section left unchanged')).length, 1, '缺 model 必须 warn 一次');
});
await check('routingTextFor: 两种顶层模式文本不同且都含关键内容', () => {
  const renderContext = { executor: EXECUTOR, experts: [], texts: {}, economyRoutes: [] };
  const eco = policy.routingTextFor('root', { provider: 'dev-provider', model: 'deepseek-flash' }, renderContext);
  const boss = policy.routingTextFor('root', { provider: 'dev-provider', model: 'example-main' }, renderContext);
  assert(eco !== boss, '两模式正文必须不同');
  assert(eco.includes('delegate_task') && boss.includes('delegate_task'));
  assert(!eco.includes(EXECUTOR.provider), 'Flash 段不该硬编码执行路由');
  assert(boss.includes(EXECUTOR.provider) && boss.includes(EXECUTOR.model), 'boss 段应通过占位符注入执行路由');
});
await check('routingTextFor: 子代文案不含主脑升级策略，且写明禁止再委派', () => {
  const child = policy.routingTextFor('child', undefined);
  assert(
    child !==
      policy.routingTextFor('root', { provider: 'dev-provider', model: 'example-main' }, { executor: EXECUTOR, experts: [], texts: { economize: '', boss: '', child: '' } }),
    'child 不能复用 boss 文本',
  );
  assert(child.includes('delegate_task'), '要写明哪些能力不可用');
  assert(!child.includes('fixture-expert'), 'child 段不得包含主脑升级策略（不得出现 fixture-expert 路由）');
});

// ── 5. 嵌套调用：0.2.2 的批量执行形状 ───────────────────────────────────────
await check('buildNestedCall: 批量形状 + arguments 是 JSON 文本 + agent/signal 透传', () => {
  const outerExec = { callId: 'C1', signal: 'sig', agent: 'ag' };
  const nested = delegation.buildNestedCall(outerExec, { prompt: 'x', provider: 'fixture-expert' });
  assertEqual(nested.calls.length, 1, '必须是"只含一个 call 的批量"');
  assertEqual(nested.calls[0].id, 'C1:delegate');
  assertEqual(nested.calls[0].name, 'subagent', '必须调用原生 subagent');
  assertEqual(typeof nested.calls[0].arguments, 'string', 'arguments 必须是 JSON 文本');
  assertEqual(JSON.parse(nested.calls[0].arguments), { prompt: 'x', provider: 'fixture-expert' });
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
  const result = { isError: false, value: { kind: 'activation', name: 'child-1' } };
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
      options: { model: 'example-main' },
      session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    },
    deferContext() { throw new Error('must not defer on failure'); },
    concludeTurn() { throw new Error('must not conclude on failure'); },
  };
  let threw = false;
  try {
    await tool.execute({ prompt: 'x' }, exec);
  } catch (error) {
    threw = true;
    assert(error.message.includes('Delegation was refused') && !error.message.includes('child route denied'));
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
        assert(parsed.provider === 'fixture-executor', '非 Flash 应注入 Go pair');
        assert(parsed.reasoning_effort === 'low');
        assert(!('parent' in input) && !('rootCallId' in input), '不得再传 parent/rootCallId');
        return {
          results: [{
            callId: 'C1:delegate',
            result: {
              isError: false,
              value: { kind: 'activation', name: 'child-1' },
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
      options: { model: 'example-main' },
      session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    },
    deferContext: (c) => deferred.push(c),
    concludeTurn: () => { concluded = true; },
  };
  const value = await tool.execute({ prompt: 'x' }, exec);
  assertEqual(value, { kind: 'activation', name: 'child-1' }, '成功只返回 result.value');
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
      session: childSession(() => ({ config: {} })),
    },
    deferContext() {}, concludeTurn() {},
  };
  let threw = false;
  try {
    await tool.execute({ prompt: 'x' }, exec);
  } catch (error) {
    threw = true;
    assert(error.message.includes('Only the main conversation'));
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
await check('index.js Config: 默认值（enabled=true、preset=standard、executor 空、无专家、向导开）', () => {
  const parsed = entry.Config({});
  assert(parsed.enabled === true, '公开版默认开启自动策略（缺前置时用日志 fail-fast，不静默）');
  assert(parsed.preset === 'standard');
  assert(parsed.toolName === 'list_subagent_models');
  assert(parsed.order === 2850);
  assertEqual([parsed.executor.get().provider, parsed.executor.get().model, parsed.executor.get().reasoningEffort], ['', '', 'max']);
  assertEqual(parsed.experts.get(), [], '专家路由默认空，正文不渲染任何具体路由名');
  assertEqual(parsed.texts, { economize: '', boss: '', child: '' });
  assert(parsed.guardNativeSubagent === true);
  assert(parsed.autoConfigure === true, '自动配置向导默认开启');
  assertEqual(parsed.economyRoutes.get(), [], '经济路由默认空 = 保留 flash 后缀兼容');
  assertEqual(parsed.teamFit, { enabled: false }, '团队队形自检默认关闭（需显式开启，关掉即回滚）');
  const configured = entry.Config({
    autoConfigure: false,
    economyRoutes: [{ provider: 'eco-provider', model: 'eco-model' }],
  });
  assert(configured.autoConfigure === false);
  assertEqual(configured.economyRoutes.get(), [{ provider: 'eco-provider', model: 'eco-model' }]);
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
    session: rootSession(() => ({ config: { model: 'example-main' } })),
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
    session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    options: { model: 'example-main' },
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
  entry.apply(fakeCtx, entry.Config({ enabled: true, executor: { provider: 'fixture-executor', model: 'example-v4-flash', reasoningEffort: 'low' } }));
  // 安装是 async 的（reconcile → installAgent），让微任务跑完。
  await new Promise((r) => setTimeout(r, 50));
  assert(registered.includes('delegate_task'), `顶层必须注册 delegate_task，实际: ${registered.join(',')}`);
  for (const name of ['send_subagent_message', 'interrupt_subagent', 'list_subagents']) {
    assert(!registered.includes(name), `本包不发布控制工具（官方已提供），不得注册 ${name}`);
  }
  assert(guards.length >= 1, '必须注册角色 guard');
  assert(disposedRegistrations.length === 0, '未卸载前不该有任何注册被回收');
  // 宿主 register 会校验 output.schema（非法即抛 JsonSchemaError）；这里按同一套子集守护。
  assertEqual(registeredDefinitions.map(row => row.name), ['delegate_task', 'configure_submodel']);
  for (const definition of registeredDefinitions) {
    assertSupportedSchema(definition.parameters, `${definition.name}.parameters`);
    assertSupportedSchema(definition.output.schema, `${definition.name}.output.schema`);
  }
});
await check('assembly: variables 变量优先于 agent.options / 过期 header，换模即时切换正文', async () => {
  const assemblyListeners = [];
  const lookedUpServices = [];
  const disposedRegistrations = [];
  let accepted = { id: 'assembly-root', config: { provider: 'fixture-executor', model: 'example-v4-flash' } };
  const candidate = {
    id: 'assembly-root',
    ctx: {},
    session: rootSession(() => accepted),
    options: { provider: 'stale-provider', model: 'stale-model' },
  };
  const tools = {
    get: (name) => (name === 'subagent' ? nativeSubagentDefinition() : name === 'list_subagent_models' ? {} : undefined),
    register: () => () => {},
    guard: () => () => {},
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
      if (name === 'sessionController') throw new Error('0.2.2 没有 sessionController：不得再查询该死通道');
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
  const makeAssembly = (variables) =>
    Object.freeze({
      variables: Object.freeze(variables),
      sections: Object.freeze([Object.freeze({ name: 'tool:model-routing', text: '' }), unchangedSection]),
    });
  const expectedFor = (route) =>
    policy.routingTextFor('root', route, { executor: EXECUTOR, experts: [], texts: { economize: '', boss: '', child: '' } });
  const listener = assemblyListeners[0];

  // assembly 变量是"GUI 即将发起的这笔请求"，必须压过 options 里的创建期旧值。
  const bossAssembly = makeAssembly({ provider: 'fixture-main', model: 'example-main' });
  const boss = await listener(bossAssembly, { agent: candidate, scope: candidate }, async () => bossAssembly);
  assertEqual(boss.sections[0].text, expectedFor({ provider: 'fixture-main', model: 'example-main' }), 'assembly 变量必须覆盖 agent.options 的旧路由');
  assert(boss.variables === bossAssembly.variables && boss.sections[1] === unchangedSection, '不能修改变量或无关段');
  assertEqual(boss.sections[0].interpolate, false);

  // 同一条 listener：换到经济路由后立刻切 economize 正文（不需要重新安装）。
  accepted = { id: candidate.id, config: { provider: 'fixture-account', model: 'deepseek-flash' } };
  const economizeAssembly = makeAssembly({ provider: 'fixture-account', model: 'deepseek-flash' });
  const economize = await listener(economizeAssembly, { agent: candidate, scope: candidate }, async () => economizeAssembly);
  assertEqual(
    economize.sections[0].text,
    expectedFor({ provider: 'fixture-account', model: 'deepseek-flash' }),
    '换到经济路由必须立即切 economize 正文',
  );
  assert(economize.sections[1] === unchangedSection, '换模不能修改无关段');
  assert(!lookedUpServices.includes('sessionController'), '不得再依赖 0.2.2 不存在的 sessionController 死通道');
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
    session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    options: { model: 'example-main' },
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
  entry.apply(fakeCtx, entry.Config({ enabled: true, executor: { provider: 'fixture-executor', model: 'example-v4-flash', reasoningEffort: 'low' } }));

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
    session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    options: { model: 'example-main' },
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
  const registered = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-child',
    ctx: {},
    // 角色只由 durable header 判定（options 里没有 subagentDepth，冷恢复场景）。
    session: childSession(() => ({ id: 's2', config: { provider: 'fixture-main', model: 'example-main' } })),
    options: { model: 'example-main' },
  };
  const tools = {
    get: () => nativeSubagentDefinition(),
    register: (d) => { registered.push(d.name); return () => {}; },
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
  entry.apply(fakeCtx, entry.Config({ enabled: true, executor: EXECUTOR }));
  await new Promise((r) => setTimeout(r, 50));
  assertEqual(registered, [], '子代不注册 delegate_task / configure_submodel');
  assert(guards.length >= 1, '子代也必须装角色 guard');
  const reasons = [];
  for (const g of guards) {
    for (const toolName of ['delegate_task', 'subagent', 'subagent_fork', 'workflow', 'spawn_teammate']) {
      let r;
      try {
        r = g({ name: toolName, agent: candidate, arguments: {} });
      } catch (error) {
        throw new Error(`guard 必须用返回值拒绝，抛异常会把 guard 故障和策略拒绝混为一谈: ${error.message}`);
      }
      if (typeof r === 'string') reasons.push(`${toolName}: ${r}`);
    }
  }
  assertEqual(reasons.length, 5, `子代的 5 个禁止工具都必须被拒绝，实际: ${reasons.join(' | ') || '空'}`);
  assert(reasons.every((r) => /unavailable to a delegated subagent/.test(r)));
  // 角色在安装时由 durable header 固定（agent 生命周期内不变）：事后篡改 header 不改变已装 guard。
  candidate.session.header = { delegationDepth: 0 };
  const afterTamper = [];
  for (const g of guards) {
    const r = g({ name: 'workflow', agent: candidate, arguments: {} });
    if (typeof r === 'string') afterTamper.push(r);
  }
  assert(afterTamper.length >= 1, '角色来自安装时的 durable header，生命周期内不变');
});
await check('子代 guard：允许非禁止工具（不误伤 read）', async () => {
  const guards = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-child', ctx: {},
    session: childSession(() => ({ id: 's2', config: {} })),
    options: { model: 'example-main' },
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
  entry.apply(fakeCtx, entry.Config({ enabled: true, executor: EXECUTOR }));
  await new Promise((r) => setTimeout(r, 50));
  for (const toolName of ['read', 'bash', 'list_agents']) {
    for (const g of guards) {
      const r = g({ name: toolName, agent: candidate, arguments: {} });
      assert(r === undefined, `guard 不得拦截 ${toolName}，实际返回: ${String(r)}`);
    }
  }
  // 只作用于本 agent：别的 agent 的 exec 不该被这个 guard 拦截。
  for (const g of guards) {
    assert(g({ name: 'workflow', agent: { id: 'other-agent' }, arguments: {} }) === undefined, 'guard 不得跨 agent 拦截');
  }
});
await check('非 Flash root 的 native subagent guard：half pair 被拒、完整 pair 放行', async () => {
  const guards = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root', ctx: {},
    session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    options: { model: 'example-main' },
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
  const halfPair = collect({ provider: 'fixture-expert' });
  assert(halfPair.length >= 1, '非 Flash 顶层用 native subagent 且只给 provider 时必须被拒');
  assert(/delegate_task/.test(halfPair[0]), '拒绝理由必须指向 delegate_task');
  assertEqual(collect({ provider: 'fixture-expert', model: 'example-opus' }), [], '完整显式 pair 必须放行');
  // plan 2.4：非 Flash 顶层"无完整显式 pair"一律拒绝并指向 delegate_task（防绕过默认 Go）。
  const noRoute = collect({ prompt: 'x' });
  assert(noRoute.length >= 1, '非 Flash 顶层用 native subagent 且完全不给 route 时必须被拒');
  assert(/delegate_task/.test(noRoute[0]), '无 route 的拒绝理由同样必须指向 delegate_task');
  // 只有 model、没有 provider 也是 half pair → 同样拒绝。
  const halfPair2 = collect({ model: 'example-opus' });
  assert(halfPair2.length >= 1, '只给 model 也必须被拒');
});

// ── 9. 重入 / 卸载 / 失败清理 ───────────────────────────────────────────────
await check('重复 reconcile 不产生重复注册（幂等）', async () => {
  const registered = [];
  const disposedRegistrations = [];
  const candidate = {
    id: 'std-root', ctx: {},
    session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    options: { model: 'example-main' },
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
    session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    options: { model: 'example-main' },
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
    session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    options: { model: 'example-main' },
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
    session: rootSession(() => ({ id: 's1', config: { provider: 'fixture-main', model: 'example-main' } })),
    options: { model: 'example-main' },
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
  const renderContext = { executor: EXECUTOR, experts: [], texts: {}, economyRoutes: [], visibleTools: ['list_agents','send_message','wait_agent','interrupt_agent'] };
  for (const route of [
    { provider: 'dev-provider', model: 'deepseek-flash' },
    { provider: 'dev-provider', model: 'example-main' },
  ]) {
    const text = policy.routingTextFor('root', route, renderContext);
    assert(text.includes('复杂代码/逻辑判断'), '升级判据必须是"问题本身的复杂度"');
    assert(text.includes('需要独立审查/复核'), '必须写明"审查/复核"本身不是升级理由');
    for (const banned of ['list_subagents', 'wait_subagents', 'send_subagent_message', 'interrupt_subagent']) {
      assert(!text.includes(banned), `正文不得出现本包不发布的工具名 ${banned}`);
    }
    assert(!text.includes('fixture-fallback'), '正文不得出现本机兜底路由名');
  }
  const boss = policy.routingTextFor('root', { provider: 'dev-provider', model: 'example-main' }, renderContext);
  for (const official of ['list_agents', 'send_message', 'wait_agent', 'interrupt_agent']) {
    assert(boss.includes(official), `boss 段必须引用官方控制工具 ${official}`);
  }
  assert(!policy.routingTextFor('root', { model: 'example-main' }, {}).includes('interrupt_agent'));
  assert(!policy.routingTextFor('child', undefined).includes('fixture-expert'), 'child 段仍不得包含主脑升级策略');
});
await check('renderExpertRoutes: 逐行渲染，空数组给"未配置"提示', () => {
  const empty = policy.renderExpertRoutes([]);
  assert(empty.includes('未配置专家路由'), '空数组必须给提示行');
  assert(empty.includes('provider/model'), '提示行要指向显式传 provider/model');
  assertEqual(policy.renderExpertRoutes(undefined), empty, '非数组按空处理');
  const one = policy.renderExpertRoutes([{ label: '代码专家', provider: 'fixture-expert', model: 'example-opus', reasoningEffort: 'max' }]);
  assert(one.includes('代码专家'));
  assert(one.includes('provider: "fixture-expert"'));
  assert(one.includes('model: "example-opus"'));
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
  const custom = policy.routingTextFor('root', { provider: 'dev-provider', model: 'example-main' }, {
    executor: { provider: 'route-a', model: 'model-a' },
    experts: [],
    texts: { boss: 'CUSTOM {{executorRoute}}' },
  });
  assertEqual(custom, 'CUSTOM {{executorRoute}}', '用户覆盖正文后不得再插值');
  assertEqual(policy.routingTextFor('child', undefined, { texts: { child: 'CHILD CUSTOM' } }), 'CHILD CUSTOM');
  assertEqual(
    policy.routingTextFor('root', { provider: 'dev-provider', model: 'example-main' }, { texts: { economize: 'ECO CUSTOM' } }),
    policy.routingTextFor('root', { provider: 'dev-provider', model: 'example-main' }),
    '非当前模式的覆盖不生效',
  );
});
await check('内置模板不含任何具体渠道/模型名（路由只经占位符注入）', () => {
  const renderContext = {
    executor: { provider: 'route-a', model: 'model-a' },
    experts: [{ label: '专家A', provider: 'route-b', model: 'model-b' }],
    texts: {},
    economyRoutes: [],
  };
  for (const route of [
    { provider: 'dev-provider', model: 'deepseek-flash' },
    { provider: 'dev-provider', model: 'example-main' },
  ]) {
    const text = policy.routingTextFor('root', route, renderContext);
    for (const leaked of ['fixture-expert', 'fixture-main', 'fixture-fallback', 'fixture-executor', 'fixture-account', 'example-opus', 'example-v4-flash']) {
      assert(!text.includes(leaked), `模板不得含本机路由名 ${leaked}`);
    }
  }
});
// ── 10b. 委派语义：启动即返回子会话 id、完成由运行时通知（plan §2.5）─────────────
await check('正文（BOSS）：含「立即返回子代理名称」与「通知」', () => {
  const boss = policy.routingTextFor('root', { provider: 'dev-provider', model: 'example-main' }, {
    executor: EXECUTOR,
    experts: [],
    texts: {},
    economyRoutes: [],
  });
  assert(boss.includes('立即返回子代理名称'), 'boss 正文必须写明"启动后立即返回子代理名称"');
  assert(boss.includes('通知'), 'boss 正文必须写明"完成时由运行时通知"');
  assert(boss.includes('等待超时只表示结果待核对'));
});
await check('正文（ECONOMIZE）：含「立即返回子代理名称」与「通知」', () => {
  const economize = policy.routingTextFor('root', { provider: 'dev-provider', model: 'deepseek-flash' }, {
    executor: EXECUTOR,
    experts: [],
    texts: {},
    economyRoutes: [],
  });
  assert(economize.includes('立即返回子代理名称'), 'Flash 正文必须写明"启动后立即返回子代理名称"');
  assert(economize.includes('通知'), 'Flash 正文必须写明"完成时由运行时通知"');
});
await check('正文（两模式）：不含过期的「直接返回结果 / return its result」', () => {
  const renderContext = { executor: EXECUTOR, experts: [], texts: {}, economyRoutes: [] };
  for (const route of [
    { provider: 'dev-provider', model: 'example-main' },
    { provider: 'dev-provider', model: 'deepseek-flash' },
  ]) {
    const text = policy.routingTextFor('root', route, renderContext);
    assert(!text.includes('直接返回结果'), '旧语义「delegate_task 前台调用会直接返回结果」必须删除');
    assert(!text.includes('return its result'), '不得出现英文旧措辞');
  }
});
await check('delegate_task 工具描述：含 "get its name"、不含 "return its result"', () => {
  const tool = delegation.createDelegateTool({
    ctx: { tools: { execute: async () => ({ results: [] }) } },
    nativeDefinition: nativeSubagentDefinition(),
    executor: EXECUTOR,
    logger: { info() {} },
  });
  assert(tool.description.includes('get its name'), `工具描述必须写明立即返回 id；实际: ${tool.description}`);
  assert(tool.description.includes('The runtime delivers a completion notice'), '工具描述必须写明完成时由运行时通知');
  assert(!tool.description.includes('return its result'), '不得出现 "return its result" 旧语义');
  assert(!tool.description.includes('(Flash)') && !tool.description.includes('(non-Flash)'), '必须删除 "(Flash)/(non-Flash)" 旧措辞');
  assert(tool.description.includes('ordinary delegation'), '无显式路由时继承当前路由的说法必须保留');
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
  const candidate = { id: 'c1', ctx: {}, session: rootSession(() => ({ config: { model: 'example-main' } })), options: {} };
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
  const candidate = { id: 'c1', ctx: {}, session: rootSession(() => ({ config: { model: 'example-main' } })), options: {} };
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
  const candidate = { id: 'c1', ctx: {}, session: rootSession(() => ({ config: { model: 'example-main' } })), options: { model: 'example-main' } };
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
    variables: Object.freeze({ model: 'example-main' }),
    sections: Object.freeze([Object.freeze({ name: 'tool:model-routing', text: '' })]),
  });
  const listener = assemblyListeners[0];
  const first = await listener(assembly, { agent: candidate, scope: candidate }, async () => assembly);
  const second = await listener(assembly, { agent: candidate, scope: candidate }, async () => assembly);
  assertEqual(first.sections[0].text, '', '工具不可见时策略段不得渲染');
  assertEqual(second.sections[0].text, '');
  assertEqual(infos.filter((m) => m.includes('未启用官方 subagent 模型选择')).length, 1, '每 agent 一次 info');
});

// ── 11. 自动配置向导：纯函数层 + 假 ctx 接线（plan §2.4/§4.5）────────────────────
// 覆盖三块：候选排序/分组、三问结构、回答解析、两处配置合并；再用假 ctx 跑完整
// entry.apply → configure_submodel.execute 接线（写两处/降级/权限/注册门控）。
const SETUP_PACK = [
  { provider: 'prov-plain', model: 'plain-model', name: 'Plain Model', description: 'cheap flash mini fast' },
  { provider: 'prov-strong', model: 'strong-pro', name: 'Strong Pro' },
  { provider: 'prov-eco', model: 'eco-lite', name: 'Economy Lite' },
  { provider: 'prov-eco', model: 'eco-flash', name: 'Economy Flash' },
  { provider: 'prov-strong', model: 'strong-opus', name: 'Strong Opus' },
];
const setupCandidates = () => policy.deriveSetupCandidates(SETUP_PACK);
const groupOf = (candidates, model) => candidates.find((c) => c.model === model)?.group;

// 纯函数 ①：候选排序 / 宿主 allowedModels +3 / 分组
await check('deriveSetupCandidates: 排序确定（分高优先→命中数→字典序），宿主 allowedModels 命中 +3', () => {
  const first = setupCandidates();
  assertEqual(
    first.map((c) => c.model),
    ['eco-flash', 'eco-lite', 'strong-opus', 'strong-pro', 'plain-model'],
    '确定性排序：分数→经济命中→强推理命中→provider/model 字典序',
  );
  assertEqual(setupCandidates().map((c) => c.model), first.map((c) => c.model), '同一输入必须给出同一顺序');
  assertEqual(first.every((c) => c.authorized === false), true, '无宿主授权时 authorized 全 false');
  const withHost = policy.deriveSetupCandidates(SETUP_PACK, {
    enabled: false,
    allowedModels: [{ provider: 'prov-plain', model: 'plain-model' }],
  });
  assertEqual(withHost[0].model, 'plain-model', '宿主已授权路由 +3，必须排到最前');
  assertEqual(withHost[0].score, 3, '0 个关键词 + 授权 3 分');
  assertEqual(withHost[0].authorized, true);
  assertEqual(withHost.filter((c) => c.authorized).length, 1);
  assertEqual(first.find((c) => c.model === 'plain-model').score, 0, '未授权时同一候选 0 分');
});
await check('deriveSetupCandidates: 分组 economy/strong/unknown，description 不参与关键词', () => {
  const candidates = setupCandidates();
  assertEqual(groupOf(candidates, 'eco-flash'), 'economy');
  assertEqual(groupOf(candidates, 'eco-lite'), 'economy');
  assertEqual(groupOf(candidates, 'strong-opus'), 'strong');
  assertEqual(groupOf(candidates, 'strong-pro'), 'strong');
  assertEqual(groupOf(candidates, 'plain-model'), 'unknown', 'description 里的 cheap/flash/mini/fast 不得参与打分');
  const plain = candidates.find((c) => c.model === 'plain-model');
  assertEqual([plain.economyHits, plain.strongHits], [0, 0], '关键词只看 model 与 name');
  assertEqual(policy.deriveSetupCandidates(undefined, undefined), [], '非数组输入安全返回空');
});
await check('deriveSetupCandidates: 同时命中 cheap 与 strong 关键词 → 平票归 economy，且进 executor 候选', () => {
  // 回归点：STRONG_KEYWORDS 含 `deep`，`deepseek-flash` 会同时命中 `deep`(strong) 与 `flash`(economy)。
  // 旧规则按"平票 = unknown"处理，导致最常见的执行路由既不进 executor 候选、也不进 experts 候选。
  const pack = [
    { provider: 'deepseek-official', model: 'deepseek-flash', name: 'DeepSeek Flash' },
    { provider: 'prov-strong', model: 'strong-opus', name: 'Strong Opus' },
  ];
  const candidates = policy.deriveSetupCandidates(pack);
  const flash = candidates.find((c) => c.provider === 'deepseek-official' && c.model === 'deepseek-flash');
  assert(flash !== undefined, '候选必须包含 deepseek-flash');
  assertEqual(flash.economyHits, 1, 'flash 命中 economy 关键词');
  assertEqual(flash.strongHits, 1, 'deepseek 里的 deep 命中 strong 关键词（本回归点的前提）');
  assertEqual(flash.group, 'economy', 'cheap/strong 平票必须归 economy，不得判成 unknown');
  const executorQuestion = policy.buildSetupQuestions(candidates).find((q) => q.id === policy.SETUP_QUESTION_EXECUTOR);
  assert(
    executorQuestion.options.some((o) => o.label === 'deepseek-official/deepseek-flash'),
    `executor 候选必须包含 deepseek-flash；实际: ${executorQuestion.options.map((o) => o.label).join(',')}`,
  );
});

// 纯函数 ②：三问结构 = executor 单选 / experts 多选 / authorize 单选
await check('buildSetupQuestions: 三问结构（id/multiSelect/选项来自候选）', () => {
  const questions = policy.buildSetupQuestions(setupCandidates());
  assertEqual(
    questions.map((q) => q.id),
    [policy.SETUP_QUESTION_EXECUTOR, policy.SETUP_QUESTION_EXPERTS, policy.SETUP_QUESTION_AUTHORIZE],
    '三问顺序与 id 必须稳定',
  );
  assertEqual(questions.map((q) => q.multiSelect), [false, true, false], 'executor/authorize 单选、experts 多选');
  assert(questions.every((q) => typeof q.question === 'string' && q.question !== ''), '每问必须有中文题干');
  const [executorQuestion, expertsQuestion, authorizeQuestion] = questions;
  assertEqual(
    executorQuestion.options.map((o) => o.label),
    ['prov-eco/eco-flash', 'prov-eco/eco-lite', 'prov-strong/strong-opus', 'prov-strong/strong-pro'],
    '经济组优先；不足 8 个时用强推理组补',
  );
  assertEqual(
    expertsQuestion.options.map((o) => o.label),
    ['prov-strong/strong-opus', 'prov-strong/strong-pro'],
    '专家选项只来自强推理组',
  );
  assertEqual(authorizeQuestion.options.map((o) => o.label), ['同时授权', '只保存偏好']);
  assert(
    executorQuestion.options.every((o) => typeof o.label === 'string' && o.label.includes('/')),
    '选项 label 就是回填键 provider/model',
  );
  assertEqual(executorQuestion.options[0].description, 'Economy Flash', '选项描述来自候选 name');
  assert(!executorQuestion.options.some((o) => o.label.includes('plain-model')), 'unknown 组不进执行路由选项');
  assertEqual(policy.buildSetupQuestions(undefined).length, 3, '非数组输入也要给出三问骨架');
});

// 纯函数 ③：回答解析
await check('parseSetupAnswers: selected 正常解析（executor/experts/authorize=yes）', () => {
  const parsed = policy.parseSetupAnswers(
    [
      { id: 'executor', selected: ['prov-eco/eco-lite'] },
      { id: 'experts', selected: ['prov-strong/strong-opus', 'prov-strong/strong-pro'] },
      { id: 'authorize', selected: ['同时授权'] },
    ],
    setupCandidates(),
  );
  assertEqual(parsed.ok, true);
  assertEqual(parsed.executor, { provider: 'prov-eco', model: 'eco-lite' });
  assertEqual(parsed.experts, [
    { provider: 'prov-strong', model: 'strong-opus' },
    { provider: 'prov-strong', model: 'strong-pro' },
  ]);
  assertEqual(parsed.authorize, true);
  assertEqual(parsed.customRoutes, []);
});
await check('parseSetupAnswers: custom provider/model 解析（覆盖 selected + 追加专家）', () => {
  const parsed = policy.parseSetupAnswers(
    [
      { id: 'executor', selected: ['prov-eco/eco-lite'], custom: 'custom-prov/custom-exec' },
      { id: 'experts', selected: ['prov-strong/strong-opus'], custom: ' custom-prov/custom-expert ' },
      { id: 'authorize', selected: ['只保存偏好'] },
    ],
    setupCandidates(),
  );
  assertEqual(parsed.ok, true);
  assertEqual(parsed.executor, { provider: 'custom-prov', model: 'custom-exec' }, 'custom 覆盖 selected');
  assertEqual(
    parsed.experts,
    [
      { provider: 'prov-strong', model: 'strong-opus' },
      { provider: 'custom-prov', model: 'custom-expert' },
    ],
    'custom 专家追加在最后',
  );
  assertEqual(parsed.authorize, false);
  assertEqual(parsed.customRoutes, [
    { provider: 'custom-prov', model: 'custom-exec' },
    { provider: 'custom-prov', model: 'custom-expert' },
  ], 'custom 路由要交给 setup.js 做 resolveModelInfo 存在性校验');
});
await check('parseSetupAnswers: custom 非法格式被拒（只接受 provider/model）', () => {
  for (const bad of ['no-slash', '/model', 'provider/']) {
    const parsed = policy.parseSetupAnswers([{ id: 'executor', custom: bad }], setupCandidates());
    assertEqual(parsed.ok, false, `custom=${bad} 必须被拒`);
    assert(/provider\/model 形式/.test(parsed.reason), `custom=${bad} 的理由应指向 provider/model 形式；实际: ${parsed.reason}`);
  }
  const expertsBad = policy.parseSetupAnswers(
    [
      { id: 'executor', selected: ['prov-eco/eco-flash'] },
      { id: 'experts', custom: 'badformat' },
    ],
    setupCandidates(),
  );
  assertEqual(expertsBad.ok, false);
  assert(/专家路由必须是 provider\/model 形式/.test(expertsBad.reason), expertsBad.reason);
});
await check('parseSetupAnswers: selected 不在候选列表 → 拒绝', () => {
  const parsed = policy.parseSetupAnswers([{ id: 'executor', selected: ['ghost-provider/ghost-model'] }], setupCandidates());
  assertEqual(parsed.ok, false);
  assert(/不在候选列表/.test(parsed.reason), parsed.reason);
  const expertsBad = policy.parseSetupAnswers(
    [
      { id: 'executor', selected: ['prov-eco/eco-flash'] },
      { id: 'experts', selected: ['prov-strong/strong-opus', 'ghost/ghost'] },
    ],
    setupCandidates(),
  );
  assertEqual(expertsBad.ok, false);
  assert(/不在候选列表/.test(expertsBad.reason), expertsBad.reason);
});
await check('parseSetupAnswers: executor 跳过报错；authorize=no/缺省=false/非法标签被拒', () => {
  const candidates = setupCandidates();
  const skipped = policy.parseSetupAnswers(
    [
      { id: 'executor', selected: [] },
      { id: 'experts', selected: [] },
      { id: 'authorize', selected: [] },
    ],
    candidates,
  );
  assertEqual(skipped.ok, false);
  assert(/未选择执行路由/.test(skipped.reason), skipped.reason);
  const noAnswers = policy.parseSetupAnswers(undefined, candidates);
  assertEqual(noAnswers.ok, false, '完全没有回答也必须拒绝（executor 必填）');
  const noAuthorize = policy.parseSetupAnswers([{ id: 'executor', selected: ['prov-eco/eco-flash'] }], candidates);
  assertEqual(noAuthorize.ok, true);
  assertEqual(noAuthorize.authorize, false, 'authorize 跳过 = 不写宿主授权');
  assertEqual(noAuthorize.experts, [], 'experts 跳过 = 不配专家');
  const authorizeNo = policy.parseSetupAnswers(
    [
      { id: 'executor', selected: ['prov-eco/eco-flash'] },
      { id: 'authorize', selected: ['只保存偏好'] },
    ],
    candidates,
  );
  assertEqual(authorizeNo.ok, true);
  assertEqual(authorizeNo.authorize, false, 'authorize=no');
  const badAuthorize = policy.parseSetupAnswers(
    [
      { id: 'executor', selected: ['prov-eco/eco-flash'] },
      { id: 'authorize', selected: ['maybe'] },
    ],
    candidates,
  );
  assertEqual(badAuthorize.ok, false);
  assert(/无法识别的授权选项/.test(badAuthorize.reason), badAuthorize.reason);
});

// 纯函数 ④：两处配置合并
await check('composeNextPluginConfig: 保存两组模型并保留旧字段', () => {
  const current = {
    enabled: true,
    preset: 'standard',
    toolName: 'list_subagent_models',
    executor: { provider: 'old-provider', model: 'old-model', reasoningEffort: 'low' },
    experts: [{ label: 'old', provider: 'old-provider', model: 'old-model' }],
    texts: { boss: 'CUSTOM' },
    economyRoutes: [{ provider: 'old-provider', model: 'old-model' }],
  };
  const next = policy.composeNextPluginConfig(current, {
    executor: { provider: 'prov-eco', model: 'eco-flash' },
    experts: [
      { provider: 'prov-strong', model: 'strong-opus' },
      { provider: 'prov-strong', model: 'strong-pro' },
    ],
  });
  assertEqual(next.enabled, true);
  assertEqual(next.preset, 'standard');
  assertEqual(next.toolName, 'list_subagent_models');
  assertEqual(next.texts, { boss: 'CUSTOM' }, '其他字段必须保留');
  assertEqual(next.executor, current.executor, '旧字段留作回退');
  assertEqual(next.experts, current.experts, '旧字段留作回退');
  deepStrictEqual(next.modelGroups, {
    executors: [{ provider: 'prov-eco', model: 'eco-flash', reasoningEffort: '', note: '' }],
    experts: [
      { provider: 'prov-strong', model: 'strong-opus', reasoningEffort: '', note: '' },
      { provider: 'prov-strong', model: 'strong-pro', reasoningEffort: '', note: '' },
    ],
  });
  assertEqual(next.economyRoutes, current.economyRoutes, '已有非空经济路由必须保留');
  assertEqual(current.executor.provider, 'old-provider', '不得原地改 current');
  assertEqual(
    policy.composeNextPluginConfig(undefined, { executor: { provider: 'p', model: 'm' }, experts: [] }).economyRoutes,
    [{ provider: 'p', model: 'm' }],
    'current 缺失也要能拼出下一份',
  );
});
await check('composeNextHostConfig: 去重合并、保留原顺序、enabled:true', () => {
  const current = {
    enabled: false,
    allowedModels: [{ provider: 'a1', model: 'm1' }, null, { provider: 'a2', model: 'm2' }, { provider: 'a1', model: 'm1' }],
    extra: 'keep',
  };
  const routes = [
    { provider: 'a2', model: 'm2' },
    { provider: 'a3', model: 'm3' },
    { provider: 'a1', model: 'm1' },
    { provider: 'a3', model: 'm3' },
    { provider: '', model: 'invalid' },
  ];
  const next = policy.composeNextHostConfig(current, routes);
  assertEqual(next.enabled, true);
  assertEqual(next.extra, 'keep', '其他字段必须保留');
  assertEqual(
    next.allowedModels,
    [
      { provider: 'a1', model: 'm1' },
      { provider: 'a2', model: 'm2' },
      { provider: 'a3', model: 'm3' },
    ],
    '原有顺序在前、新增去重在后、非法条目跳过',
  );
  assertEqual(current.allowedModels.length, 4, '不得原地改 current');
});

/**
 * 造一个「插件顶层 ctx + root agent + 向导服务替身」的世界：先 `apply` 注册向导，
 * 再用注册出来的工具定义验证 `execute` 的两处写入与全部降级路径。
 *
 * 只替身宿主服务（llm/userQuestions/configEditor/subagentModelSelection），不替身被测逻辑；
 * `configEditor.edit` 记录 `(entryId, next)` 并推进 entry 的 config，供断言写入顺序与合并值。
 */
function makeWizardWorld(options = {}) {
  const plugin = { enabled: true, preset: 'standard', ...options.config };
  const host = { enabled: false, allowedModels: options.allowedModels ?? [{ provider: 'existing', model: 'existing-model' }] };
  const rowMap = new Map([['submodel', { revision: 3, value: plugin }]]);
  if (!options.noHost) rowMap.set(policy.HOST_SELECTION_ENTRY_ID, { revision: 5, value: host });
  const edits = [];
  const asks = [];
  const tools = new Map();
  const agent = { id: 'wizard-root', session: rootSession(), options: { model: 'example-main' } };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    tools: {
      get: (name) => name === 'subagent' ? nativeSubagentDefinition() : undefined,
      register: (definition, activation) => {
        tools.set(definition.name, { definition, activation });
        return () => tools.delete(definition.name);
      },
      guard: () => () => {},
    },
    get: (name) => ({
      agents: { list: () => [agent] }, agentPresets: { composedPreset: () => 'standard' },
      settings: options.noSettings ? undefined : {
        writable: !options.readOnly,
        describe: () => [...rowMap].map(([ns, { value, revision }]) => ({ ns, revision, value: structuredClone(value) })),
        async mutate(ns, ops, expectedRevision) {
          const row = rowMap.get(ns);
          if (row.revision !== expectedRevision) throw Object.assign(new Error('STALE'), { code: 'SETTINGS_CONFLICT' });
          if (options.rejectHost && ns === policy.HOST_SELECTION_ENTRY_ID) throw new Error('private rejection');
          assert(ops.every(op => op.op === 'set' && op.path.length === 1));
          for (const op of ops) row.value[op.path[0]] = structuredClone(op.value);
          row.revision++;
          edits.push({ ns, ops, expectedRevision });
        },
      },
      llm: {
        listProviders: () => [...new Set(SETUP_PACK.map(row => row.provider))].map(id => ({ id })),
        listModels: async (provider) => SETUP_PACK.filter(row => row.provider === provider).map(row => ({ id: row.model, name: row.name })),
      },
      userQuestions: {
        async ask(request) {
          asks.push(request);
          if (options.askError) throw new Error('private diagnostic');
          const answers = request.questions.map(q => ({
            id: q.id,
            selected: q.id === 'authorize' ? (options.skip ? [] : [options.authorization ?? '同时授权'])
              : q.id === 'experts' ? q.options.map(opt => opt.label) : [q.options[0].label],
          }));
          if (request.questions[0].id === 'authorize' && options.conflict) rowMap.get(options.conflict).revision++;
          return { answers };
        },
      },
    })[name],
  };
  agent.ctx = ctx;
  entry.apply(ctx, plugin);
  const setupEntry = tools.get(policy.SETUP_TOOL_NAME);
  return {
    setupEntry, plugin, host, asks, edits,
    async run() { return setupEntry.definition.execute({}, { agent, signal: new AbortController().signal }); },
  };
}

await check('向导独立询问授权，按两个修订号写入并随执行模型保存而隐藏', async () => {
  const world = makeWizardWorld({ config: { economyRoutes: [{ model: 'retained' }] } });
  assert(world.setupEntry.activation.when());
  const result = await world.run();
  assertEqual(world.asks.map(row => row.questions.map(q => q.id)), [['executor', 'experts'], ['authorize']]);
  assertEqual(world.edits.map(row => [row.ns, row.expectedRevision]), [[policy.HOST_SELECTION_ENTRY_ID, 5], ['submodel', 3]]);
  deepStrictEqual(world.plugin.modelGroups.executors, [{ provider: 'prov-eco', model: 'eco-flash', reasoningEffort: '', note: '' }]);
  assert(!Object.hasOwn(world.plugin, 'executor'), 'the wizard writes only the new group setting');
  assertEqual(world.plugin.economyRoutes, [{ model: 'retained' }]);
  assert(world.host.enabled && world.host.allowedModels.length === 4);
  assert(result.includes('已保存模型选择') && result.includes('已保存授权'));
  assertEqual(world.setupEntry.activation.when(), false);
  assert((await world.run()).includes('已在别处更新'));
});

await check('向导保留授权：跳过、只保存偏好均只写插件行', async () => {
  for (const options of [{ skip: true }, { authorization: '只保存偏好' }]) {
    const world = makeWizardWorld({ ...options, allowedModels: [] });
    assert((await world.run()).includes('已保留原有授权'));
    assertEqual(world.edits.map(row => row.ns), ['submodel']);
    assertEqual(world.host, { enabled: false, allowedModels: [] });
  }
});

await check('向导授权冲突、缺行或拒绝后，偏好仍可独立保存', async () => {
  for (const options of [{ conflict: policy.HOST_SELECTION_ENTRY_ID }, { noHost: true }, { rejectHost: true }]) {
    const world = makeWizardWorld(options);
    const result = await world.run();
    assert(result.includes('已保存模型选择') && result.includes('授权未写入'));
    assert(!result.includes('private rejection'));
    assertEqual(world.edits.map(row => row.ns), ['submodel']);
  }
});

await check('向导偏好冲突保留已成功的授权，并说明实际结果', async () => {
  const world = makeWizardWorld({ conflict: 'submodel' });
  const result = await world.run();
  assert(result.includes('已在别处更新') && result.includes('已保存授权'));
  assertEqual(world.edits.map(row => row.ns), [policy.HOST_SELECTION_ENTRY_ID]);
  assertEqual(world.plugin.executor, undefined);
});

await check('向导无设置、只读或问答失败时给手动路径，零写入', async () => {
  for (const options of [{ noSettings: true }, { readOnly: true }, { askError: true }]) {
    const world = makeWizardWorld(options);
    const result = await world.run();
    assert(result.includes('subagent-model-selection-settings') && !result.includes('private diagnostic'));
    assertEqual(world.edits.length, 0);
  }
});

await check('Config：实时字段可重建，宿主保留严格校验，默认关闭', () => {
  const config = entry.Config({});
  assertEqual(config.watchdog.get(), { mode: 'off', tiers: ['expert'], warnTokens: 100000, graceMs: 60000, maxRetries: 1 });
  assertEqual(config.fallbacks.get(), []);
  const fields = Object.fromEntries(['executor', 'experts', 'economyRoutes', 'fallbacks', 'modelGroups', 'watchdog'].map(name => {
    const shape = new schema(entry.Config.dict[name].toJSON());
    delete shape.meta.volatile;
    return [name, shape];
  }));
  const wire = new schema(JSON.parse(JSON.stringify(schema.object(fields).toJSON())));
  assertEqual(wire({}).watchdog, config.watchdog.get());
  assertEqual(wire({}).modelGroups, 'legacy');
  const primary = { provider: 'synthetic-provider', model: 'example-a' };
  const groups = { executors: [{ ...primary, note: '代码优先', reasoningEffort: '' }], experts: [] };
  assertEqual(wire({ modelGroups: groups }).modelGroups, groups);
  assertEqual(entry.Config({ modelGroups: groups }).modelGroups.get(), groups);
  assertEqual(entry.Config({ modelGroups: { executors: [], experts: [] } }).modelGroups.get(), { executors: [], experts: [] });
  for (const invalid of [
    { modelGroups: { ...groups, executors: [...groups.executors, ...groups.executors] } },
    { modelGroups: { executors: [{ ...primary, model: ' ' }], experts: [] } },
    { modelGroups: { executors: [{ ...primary, note: 'x'.repeat(121) }], experts: [] } },
    { modelGroups: {} },
    { fallbacks: [{ primary, alternatives: [primary] }] },
    { fallbacks: [{ primary, alternatives: [] }, { primary, alternatives: [] }] },
    { fallbacks: [{ primary: { ...primary, model: ' ' }, alternatives: [] }] },
    { watchdog: { tiers: ['expert', 'expert'] } }, { watchdog: { tiers: [] } },
    { watchdog: { mode: 'unknown' } }, { watchdog: { warnTokens: 2 ** 53 } },
    { watchdog: { warnTokens: 1.5 } }, { watchdog: { graceMs: 999 } }, { watchdog: { maxRetries: 3 } },
  ]) assertThrows(() => entry.Config(invalid));
});

await check('执行模型默认推理档：省略工具参数，显式档优先', () => {
  const executor = { ...EXECUTOR, reasoningEffort: '' };
  assert(!Object.hasOwn(policy.resolveDelegationArgs({ prompt: 'x' }, 'boss', executor).args, 'reasoning_effort'));
  assertEqual(policy.resolveDelegationArgs({ prompt: 'x', reasoning_effort: 'high' }, 'boss', executor).args.reasoning_effort, 'high');
});

await check('分组显式点名补默认档位：专家行优先，点名档位优先', () => {
  const executor = { ...EXECUTOR, reasoningEffort: '' };
  const groups = {
    executors: [{ provider: 'synthetic-provider', model: 'example-exec', note: '', reasoningEffort: 'low' }],
    experts: [
      { provider: 'synthetic-provider', model: 'example-both', note: '', reasoningEffort: 'max' },
      { provider: 'synthetic-provider', model: 'example-expert', note: '', reasoningEffort: '' },
    ],
  };
  const call = (args, modelGroups = groups) => policy.resolveDelegationArgs(args, 'boss', executor, modelGroups);
  assertEqual(call({ prompt: 'x', provider: 'synthetic-provider', model: 'example-both' }).args.reasoning_effort, 'max');
  assertEqual(call({ prompt: 'x', provider: 'synthetic-provider', model: 'example-both', reasoning_effort: 'high' }).args.reasoning_effort, 'high');
  assert(!Object.hasOwn(call({ prompt: 'x', provider: 'synthetic-provider', model: 'example-expert' }).args, 'reasoning_effort'));
  assertEqual(call({ prompt: 'x', provider: 'synthetic-provider', model: 'example-exec' }).args.reasoning_effort, 'low');
  assert(!Object.hasOwn(call({ prompt: 'x', provider: 'unrelated', model: 'elsewhere' }).args, 'reasoning_effort'));
  assert(!Object.hasOwn(policy.resolveDelegationArgs(
    { prompt: 'x', provider: 'synthetic-provider', model: 'example-both' }, 'boss', executor, undefined,
  ).args, 'reasoning_effort'), 'legacy 未保存分组时不注入档位');
});

const WATCH_PRIMARY = { provider: 'synthetic-provider', model: 'example-a' };
const WATCH_BACKUP = { provider: 'synthetic-provider', model: 'example-b' };
const WATCH_USAGE = { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 };
const flush = () => new Promise(resolve => setImmediate(resolve));

function monitorFixture(options = {}) {
  const listeners = new Map();
  const timers = new Map();
  const calls = [];
  const parentMessages = [];
  const children = new Map();
  let now = 0;
  let serial = 0;
  function on(name, handler) {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  }
  function emit(name, ...values) {
    for (const handler of [...(listeners.get(name) ?? [])]) handler(...values);
  }
  const clock = {
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a,b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  }
  const parent = { id: 'parent', session: { seq: 10 }, ctx: { on }, inject: msg => parentMessages.push(msg) };
  const definition = nativeSubagentDefinition();
  const allowedModels = options.allowedModels ?? [WATCH_BACKUP];
  const grant = { enabled: !options.unauthorized, allowedModels };
  const config = { watchdog: { mode: 'retry', warnTokens: 2000, graceMs: 1000, ...options.watchdog },
    fallbacks: [{ primary: WATCH_PRIMARY, alternatives: options.choices ?? [WATCH_BACKUP] }],
    modelGroups: options.modelGroups && structuredClone(options.modelGroups),
  };
  const services = {
    agents: { get: id => id === parent.id ? parent : children.get(id) },
    subagents: { namesOf: child => ({ self: child.name }) },
    sessionProjections: {
      snapshot: session => ({ values: { tokenUsage: session.usage } }),
      stateOf: () => options.unrecorded ? null : allowedModels,
      onChanged: callback => on('usage', callback),
    },
    settings: { describe: () => [{ ns: policy.HOST_SELECTION_ENTRY_ID, value: grant }] },
    llm: { listModels: async (provider) => options.listModels ? await options.listModels() :
      allowedModels.filter(row => row.provider === provider).map(row => ({ id: row.model })) },
  };
  const ctx = { on, get: name => services[name], tools: {
    executable: () => definition,
    async execute(input) {
      calls.push(input);
      if (options.execute) return options.execute(input);
      return { results: [{ callId: input.calls[0].id, result: { isError: true } }] };
    },
  } };
  const caller = new AbortController();
  const watchdog = installWatchdog({ ctx, parent, config, nativeDefinition: definition, modelGroups: options.modelGroups, clock });
  function begin(name, route = WATCH_PRIMARY, tier = 'expert') {
    return watchdog.begin({ name, prompt: 'task', description: 'Fixture task', reasoning_effort: 'max' }, route, tier, { signal: caller.signal });
  }
  function childFor(ticket, id = 'child', route = WATCH_PRIMARY) {
    const name = ticket.args.name;
    const child = { id, name, status: 'running', session: { seq: 20, header: { parentSession: parent.id } }, notices: [] };
    child.inject = (message) => { child.notices.push(message); emit('agent/inbox/inserted', { agent: child, message }); };
    children.set(id, child);
    const life = { id, runId: 'run-' + id, provider: 'spawn', parentSessionId: parent.id, local: true };
    const signal = new AbortController();
    const log = (type, data = {}) => emit('session/event', child.session, { type, data, seq: ++child.session.seq });
    emit('subagent/start', life);
    emit('agent/inbox/inserted', { agent: child, message: { id: 'first', source: { kind: 'user' } } });
    emit('session/event', parent.session, { type: 'subagent/catalog', seq: ++parent.session.seq, data: { childId: id, name } });
    emit('agent/pre-step', { agent: child, turn: 1, step: 1, signal: signal.signal, modelSelection: route }, () => {});
    return { child, signal, log, life, receipt: { kind: 'activation', name },
      usage({ sampled = true, value = WATCH_USAGE, text = '', continuing, step = 1, report = {
        inputTokens: value.uncachedInputTokens, outputTokens: value.outputTokens,
        cacheReadTokens: value.cacheReadTokens, cacheWriteTokens: value.cacheWriteTokens,
      } } = {}) {
        child.session.usage = value;
        const message = continuing === true ? { content: [{ type: 'tool-call' }] }
          : continuing === false ? { content: [{ type: 'text', text: 'complete' }] } : undefined;
        log(continuing === undefined ? 'assistant/attempt' : 'assistant/message', { turn: 1, step, message, stream: [
          ...(sampled ? [{ type: 'chunk', chunk: { type: 'usage', usage: report } }] : []),
          ...(text ? [{ type: 'text-chunks', texts: [text] }] : []),
        ] });
        emit('usage', child.session, 'tokenUsage');
      },
      fail({ reason = 'error', code = 'RATE_LIMIT', step = 1, end = true, retryPolicy } = {}) {
        emit('agent/request-error', { agent: child, turn: 1, step, provider: route.provider, failure: { code }, retryPolicy }, () => {});
        log('turn/end', { turn: 1, reason: { kind: reason, error: { code } } });
        children.delete(child.id);
        emit('agent/disposed', { agent: child });
        if (end) {
          emit('subagent/end', { ...life, stopReason: reason });
          emit('subagent/end', { ...life, stopReason: reason });
        }
      },
    };
  }
  return { watchdog, config, grant, begin, childFor, advance, timers, calls, parentMessages, emit, caller,
    assertClean() {
      assertEqual(timers.size, 0);
      watchdog.dispose();
      assertEqual([...listeners.values()].reduce((n,set) => n + set.size, 0), 0);
    },
  };
}

await check('看护只接受全四桶和安全整数，小于阈值的自然失败只改派一次', async () => {
  assertEqual(sumUsage(WATCH_USAGE), 1000);
  assertEqual(sumUsage({ ...WATCH_USAGE, outputTokens: undefined }), undefined);
  assertEqual(sumUsage({ ...WATCH_USAGE, outputTokens: Number.MAX_SAFE_INTEGER }), undefined);
  const world = monitorFixture();
  const ticket = world.begin('ordinary');
  const run = world.childFor(ticket);
  run.usage();
  run.fail();
  world.watchdog.finish(ticket, run.receipt);
  await flush();
  assertEqual(world.calls.length, 1);
  const [{ calls: [call], toolSet }] = world.calls;
  const replacement = JSON.parse(call.arguments);
  assertEqual([call.name, replacement.provider, replacement.model], ['subagent', WATCH_BACKUP.provider, WATCH_BACKUP.model]);
  assertEqual(replacement.prompt, 'task');
  assertEqual(toolSet, undefined);
  assert(!Object.hasOwn(replacement, 'reasoning_effort'));
  world.assertClean();
});

await check('无法核实的全零或缺失用量不能触发改派，即使此前有正数记录', async () => {
  const zeroProjection = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const sampled of [true, false]) {
    for (const earlierReport of [true, false]) {
      const world = monitorFixture();
      const ticket = world.begin('ordinary');
      const run = world.childFor(ticket);
      world.watchdog.finish(ticket, run.receipt);
      if (earlierReport) run.usage();
      run.usage({ sampled, value: earlierReport ? WATCH_USAGE : zeroProjection,
        report: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
      run.fail();
      await flush();
      assertEqual(world.calls.length, 0);
      world.assertClean();
    }
  }
});

await check('看护拒绝未知用量、跨渠道、无授权、外部续聊、部分结果、工具调用、手停和链尾', async () => {
  for (const test of [
    { usage: { sampled: false } }, { usage: { text: 'partial' } },
    { options: { unrecorded: true } }, { options: { unauthorized: true } },
    { options: { choices: [{ provider: 'synthetic-other', model: 'example-stop' }] } },
    { options: { choices: [] } }, { end: { reason: 'aborted' } }, { end: { code: 'UNKNOWN' } },
    { step: run => run.log('tool/call') },
    { step: (run, world) => world.emit('agent/inbox/inserted', { agent: run.child, message: { id: 'extra', source: { kind: 'user' } } }) },
    { step: (run, world) => world.caller.abort() },
  ]) {
    const world = monitorFixture(test.options);
    const ticket = world.begin('ordinary');
    const run = world.childFor(ticket);
    world.watchdog.finish(ticket, run.receipt);
    run.usage(test.usage);
    test.step?.(run, world);
    run.fail(test.end);
    await flush();
    assertEqual(world.calls.length, 0);
    world.assertClean();
  }
});

await check('看护预算提醒只注入一次，超时只提示人工；并发续聊撤销待提示动作', async () => {
  for (const options of [{ mode: 'retry' }, { mode: 'stop' }, { mode: 'stop', follow: true }]) {
    const world = monitorFixture({ watchdog: { mode: options.mode, warnTokens: 1000 } });
    const ticket = world.begin('ordinary');
    const run = world.childFor(ticket);
    world.watchdog.finish(ticket, run.receipt);
    run.usage({ continuing: true });
    run.usage({ continuing: true });
    assertEqual(run.child.notices.length, 0);
    await flush();
    assertEqual(run.child.notices.length, 1);
    assertEqual(run.child.notices[0].source.kind, 'dsh-submodel-watchdog');
    if (options.follow) world.emit('agent/inbox/inserted', { agent: run.child, message: { id: 'follow', source: { kind: 'user' } } });
    world.advance(1000);
    assertEqual(world.parentMessages.length, options.mode === 'stop' && !options.follow ? 1 : 0);
    run.fail();
    await flush();
    assertEqual(world.calls.length, 0);
    world.assertClean();
  }
});

await check('收尾提醒排队后若子任务收到续聊或取消，就不再发送', async () => {
  for (const reason of ['followup', 'cancel', 'final-reply']) {
    const world = monitorFixture({ watchdog: { mode: 'stop', warnTokens: 1000 } });
    const ticket = world.begin('ordinary');
    const run = world.childFor(ticket);
    world.watchdog.finish(ticket, run.receipt);
    run.usage({ continuing: reason !== 'final-reply' });
    if (reason === 'cancel') run.signal.abort();
    if (reason === 'followup') world.emit('agent/inbox/inserted', { agent: run.child, message: { id: 'external', source: { kind: 'user' } } });
    await flush();
    world.advance(1000);
    if (reason === 'final-reply') run.fail({ reason: 'completed' });
    assertEqual(run.child.notices.length, 0);
    assertEqual(world.parentMessages.length, 0);
    world.assertClean();
  }
});

await check('看护同名歧义、缺 start、缺 end 与关闭动作可清理', async () => {
  const world = monitorFixture();
  const a = world.begin('same');
  const b = world.begin('same');
  const run = world.childFor(a);
  world.watchdog.finish(a, run.receipt);
  world.watchdog.finish(b, run.receipt);
  const pending = world.begin('pending');
  world.watchdog.finish(pending, { kind: 'activation', name: 'pending' });
  const missingEnd = world.begin('missing-end');
  const released = world.childFor(missingEnd, 'another');
  world.watchdog.finish(missingEnd, released.receipt);
  released.usage();
  released.fail({ end: false });
  world.advance(30000);
  const active = world.begin('active');
  assert(active);
  world.config.watchdog.mode = 'off';
  world.emit('settings/document-updated', 'submodel');
  assertEqual(world.calls.length, 0);
  world.assertClean();
});

await check('分离两个运行，失效目录检查后拒绝改派，旧结束事件不会恢复任务', async () => {
  let resolveDirectory;
  const directory = new Promise(resolve => { resolveDirectory = resolve; });
  const world = monitorFixture({ listModels: () => directory });
  const first = world.begin('one');
  const second = world.begin('two');
  const a = world.childFor(first, 'child-one');
  const b = world.childFor(second, 'child-two');
  world.watchdog.finish(first, a.receipt);
  world.watchdog.finish(second, b.receipt);
  a.usage();
  b.usage();
  a.fail();
  assertEqual(world.calls.length, 0);
  world.grant.enabled = false;
  b.fail();
  resolveDirectory([{ id: WATCH_BACKUP.model }]);
  await flush();
  world.emit('subagent/end', { ...a.life, stopReason: 'error' });
  world.emit('subagent/start', { ...a.life, runId: 'reopened' });
  assertEqual(world.calls.length, 0);
  world.assertClean();
});

await check('看护取消尚未返回的改派调用时，同时释放旧尝试的资源', async () => {
  let enterDispatch;
  const entered = new Promise(resolve => { enterDispatch = resolve; });
  let finishDispatch;
  const receipt = new Promise(resolve => { finishDispatch = resolve; });
  const world = monitorFixture({ execute: () => { enterDispatch(); return receipt; } });
  const ticket = world.begin('ordinary');
  const attempt = world.childFor(ticket);
  world.watchdog.finish(ticket, attempt.receipt);
  attempt.usage();
  attempt.fail();
  await entered;
  world.caller.abort();
  assertEqual(world.calls[0].signal.aborted, true);
  world.assertClean();
  finishDispatch({ results: [] });
  await flush();
  assertEqual(world.calls.length, 1);
});

await check('取消看护不会中止已经受理的备选启动信号', async () => {
  let world;
  let replacement;
  world = monitorFixture({ execute(input) {
    const call = input.calls[0];
    const args = JSON.parse(call.arguments);
    replacement = world.childFor({ args }, 'child-backup', WATCH_BACKUP);
    return { results: [{ callId: call.id, result: { isError: false, value: replacement.receipt } }] };
  } });
  const ticket = world.begin('ordinary');
  const attempt = world.childFor(ticket);
  world.watchdog.finish(ticket, attempt.receipt);
  attempt.usage();
  attempt.fail();
  await flush();
  assert(replacement !== undefined);
  assertEqual(world.calls.length, 1);
  world.config.watchdog.mode = 'off';
  world.emit('settings/document-updated', 'submodel');
  assertEqual(world.calls[0].signal.aborted, false);
  world.assertClean();
});

function exhaustGroupRetries(run, route, { count = 5, limit = 5, lastStarted = true, missingAt, startedId } = {}) {
  const retryId = 'group-retry';
  for (let retry = 1; retry <= count; retry++) {
    run.usage({ sampled: retry !== missingAt });
    run.log('llm/retry', { turn: 1, step: 1, retry, retryId, provider: route.provider,
      mode: 'normal', maxRetries: limit, policyKey: 'group-policy' });
    if (retry !== count || lastStarted) {
      run.log('llm/retry-started', { turn: 1, step: 1, retry, retryId: startedId ?? retryId });
    }
  }
  run.usage({ sampled: missingAt !== count + 1 });
  return { mode: 'normal', maxRetries: limit, retryableCodes: ['RATE_LIMIT'] };
}

const groupFirst = { provider: 'synthetic-other', model: 'example-first' };
const groupNext = { provider: 'synthetic-other', model: 'example-next' };
const groupOrder = [groupFirst, WATCH_PRIMARY, groupNext];
const modelGroupsFor = tier => tier === 'expert' ? { executors: [], experts: groupOrder }
  : { executors: groupOrder, experts: [] };

await check('两组模型都在五次宿主重试后从所选位置往后，跨渠道只尝试下一位', async () => {
  for (const tier of ['executor', 'expert']) {
    const world = monitorFixture({ modelGroups: modelGroupsFor(tier), allowedModels: [groupFirst, groupNext],
      watchdog: { tiers: [tier] } });
    const ticket = world.begin('ordinary', WATCH_PRIMARY, tier);
    const run = world.childFor(ticket);
    world.watchdog.finish(ticket, run.receipt);
    const retryPolicy = exhaustGroupRetries(run, WATCH_PRIMARY);
    assertEqual(world.calls.length, 0, 'a retry record alone must not start the next model');
    run.fail({ retryPolicy });
    await flush();
    assertEqual(world.calls.length, 1);
    const args = JSON.parse(world.calls[0].calls[0].arguments);
    assertEqual([args.provider, args.model], [groupNext.provider, groupNext.model]);
    assert(!Object.hasOwn(args, 'note') && !Object.hasOwn(args, 'reasoning_effort'));
    world.assertClean();
  }
});

await check('分组任务缺少结束证据、额度或授权时不会换模型', async () => {
  for (const scenario of [
    { retry: { count: 4 } }, { retry: { limit: 6 } }, { retry: { count: 4, limit: 4 } },
    { retry: { lastStarted: false } }, { retry: { startedId: 'different-retry' } },
    { retry: { missingAt: 2 } }, { retry: { missingAt: 6 } },
    { step: 2 }, { always: true }, { reason: 'aborted' }, { tool: true }, { partial: true }, { routeChanged: true },
    { unrecorded: true }, { revoked: true }, { reordered: true }, { atTail: true },
    { overBudget: true }, { catalogMissing: true },
  ]) {
    const modelGroups = modelGroupsFor('expert');
    const world = monitorFixture({ modelGroups, allowedModels: [groupFirst, groupNext], unrecorded: scenario.unrecorded,
      listModels: scenario.catalogMissing ? async () => [] : undefined });
    const initial = scenario.atTail ? groupNext : WATCH_PRIMARY;
    const ticket = world.begin('ordinary', initial, 'expert');
    const run = world.childFor(ticket, 'child', initial);
    world.watchdog.finish(ticket, run.receipt);
    const retryPolicy = exhaustGroupRetries(run, initial, scenario.retry);
    if (scenario.overBudget) run.usage({ value: { ...WATCH_USAGE, outputTokens: 1200 } });
    if (scenario.revoked) world.grant.enabled = false;
    if (scenario.reordered) world.config.modelGroups.experts.reverse();
    if (scenario.tool) run.log('tool/call');
    if (scenario.routeChanged) run.log('request/context', groupFirst);
    if (scenario.partial) run.usage({ text: 'partial result' });
    run.fail({ step: scenario.step, reason: scenario.reason, retryPolicy: scenario.always ? { mode: 'always' } : retryPolicy });
    await flush();
    assertEqual(world.calls.length, 0, JSON.stringify(scenario));
    world.assertClean();
  }
});

await check('分组改派用目标模型的配置档位，不继承原档位', async () => {
  const withEffort = { provider: 'synthetic-other', model: 'example-next', note: '', reasoningEffort: 'high' };
  const world = monitorFixture({ modelGroups: { executors: [], experts: [WATCH_PRIMARY, withEffort] },
    allowedModels: [WATCH_PRIMARY, withEffort] });
  const ticket = world.begin('ordinary');
  const run = world.childFor(ticket);
  world.watchdog.finish(ticket, run.receipt);
  const retryPolicy = exhaustGroupRetries(run, WATCH_PRIMARY);
  run.fail({ retryPolicy });
  await flush();
  assertEqual(world.calls.length, 1);
  assertEqual(JSON.parse(world.calls[0].calls[0].arguments).reasoning_effort, 'high');
  world.assertClean();
});

await check('宿主派发异常时通知结果未确认并收回观察资源', async () => {
  const world = monitorFixture({ modelGroups: modelGroupsFor('expert'), allowedModels: [groupNext],
    execute() { throw new Error('fixture private provider failure'); } });
  const ticket = world.begin('ordinary');
  const run = world.childFor(ticket);
  world.watchdog.finish(ticket, run.receipt);
  run.fail({ retryPolicy: exhaustGroupRetries(run, WATCH_PRIMARY) });
  await flush();
  assertEqual(world.calls.length, 1);
  assertEqual(world.parentMessages.length, 1);
  const notice = world.parentMessages[0].content[0].text;
  assert(notice.includes('ordinary') && notice.includes('子代理面板') && !notice.includes('private provider failure'));
  world.assertClean();
});

// ── 12. 团队队形自检（tool:team-fit）：纯函数 + 假宿主入口接线 ────────────────
const FIT_INPUT = { role: 'root', preset: 'standard', presetId: 'standard', teamEnabled: true };
const FIT_TEXT = teamFit.teamFitTextFor(FIT_INPUT);

await check('team-fit：段名唯一', () => {
  assertEqual(teamFit.TEAM_FIT_SECTION, 'tool:team-fit');
});
await check('team-fit：主脑 + standard + 团队开 → 三行连续且顺序固定', () => {
  assert(FIT_TEXT !== '', '正例必须产出正文');
  assert(
    /^可并行性：[^\n]+\n串行点：[^\n]+\n决定：/m.test(FIT_TEXT),
    `三个行首必须连续且顺序固定；实际开头: ${FIT_TEXT.slice(0, 120)}`,
  );
});
await check('team-fit：正文含串行决定、依赖、模型分配、独立审查与提交纪律', () => {
  for (const phrase of ['本次串行，不用任务板', 'blocked_by', '模型分配', '独立审查', 'git commit/push']) {
    assert(FIT_TEXT.includes(phrase), `正文缺少：${phrase}`);
  }
});
await check('team-fit：团队关 / 状态未知 / 子代理 / 未知角色 / 其他预设 / 无预设证据 → 空串', () => {
  for (const [label, patch] of [
    ['团队关', { teamEnabled: false }],
    ['团队状态未知', { teamEnabled: undefined }],
    ['子代理', { role: 'child' }],
    ['未知角色', { role: undefined }],
    ['其他预设', { preset: 'other' }],
    ['无预设证据', { preset: undefined, presetId: undefined }],
    ['预设 id 为空串', { presetId: '   ' }],
  ]) {
    assertEqual(teamFit.teamFitTextFor({ ...FIT_INPUT, ...patch }), '', `${label} 应返回空串`);
  }
});

/** 首轮 fake 主脑：requestHeader() 尚无值，角色证据只在 durable session.header。 */
const fitAgent = {
  ctx: {},
  options: {},
  session: { id: 'first-session', header: { id: 'first-session' }, requestHeader: () => undefined },
};
const fitAssembly = { agent: fitAgent, scope: fitAgent };

/** 假宿主：收集 systemPrompt 段；TEAM_POLICY=600；团队/预设服务可动态替换。 */
function makeTeamFitHost() {
  const sections = [];
  const services = {
    agentPresets: { composedPreset: (scope) => (scope === fitAgent.ctx ? 'standard' : undefined) },
    agentTeams: { isEnabled: (caller) => caller === fitAgent },
  };
  const boardTool = { name: 'team_task_create' };
  const admitted = { view: (scope) => new Map(scope === fitAgent ? [[boardTool.name, boardTool]] : []) };
  const excluded = { view: () => new Map() };
  const tools = {
    // 两个参数的调用只能看到"工具注册了"；第三个参数才是本步获准集合，别混。
    get: (name, scope, toolSet) => toolSet === undefined
      ? (name === boardTool.name ? boardTool : undefined)
      : toolSet.view(scope).get(name),
    register: () => () => {},
    guard: () => () => {},
  };
  const register = (config) => {
    sections.length = 0;
    entry.apply(
      {
        logger: { info() {}, warn() {}, error() {} },
        on: () => () => {},
        get: (name) => services[name],
        systemPrompt: {
          section: (definition) => {
            sections.push(definition);
            return () => {};
          },
          getSectionOrder: (name) => (name === 'TEAM_POLICY' ? 600 : undefined),
        },
        tools,
      },
      entry.Config(config),
    );
    return sections;
  };
  return { sections, services, boardTool, admitted, excluded, tools, register };
}

const fitHost = makeTeamFitHost();

await check('入口：总开关关时即使 teamFit.enabled=true 也只注册策略段', () => {
  assertEqual(
    fitHost.register({ enabled: false, teamFit: { enabled: true } }).map((section) => section.name),
    ['tool:model-routing'],
  );
});
await check('入口：配置缺省（不写 teamFit）只注册策略段', () => {
  assertEqual(fitHost.register({ enabled: true }).map((section) => section.name), ['tool:model-routing']);
});
await check('入口：teamFit.enabled=false 即回滚，只注册策略段', () => {
  assertEqual(
    fitHost.register({ enabled: true, teamFit: { enabled: false } }).map((section) => section.name),
    ['tool:model-routing'],
  );
});
const bothSections = fitHost.register({ enabled: true, teamFit: { enabled: true } });
await check('入口：两个段各注册一次，自检段紧随 TEAM_POLICY（601）', () => {
  assertEqual(
    bothSections.map((section) => [section.name, section.order]),
    [
      ['tool:model-routing', 2850],
      ['tool:team-fit', 601],
    ],
  );
});
const fitSectionText = bothSections.find((section) => section.name === teamFit.TEAM_FIT_SECTION).text;

await check('入口：首轮 requestHeader() 尚无值也能显示（读 durable header）', () => {
  assertEqual(fitSectionText(fitAssembly), FIT_TEXT);
});
await check('入口：上下文缺 agent、scope 不匹配或 agent 无 ctx → 隐藏', () => {
  assertEqual(
    [
      fitSectionText({}),
      fitSectionText({ ...fitAssembly, scope: fitAgent.ctx }),
      fitSectionText({ agent: { session: fitAgent.session }, scope: undefined }),
    ],
    ['', '', ''],
  );
});
await check('入口：会话身份不一致（header.id ≠ session.id）→ 隐藏', () => {
  fitAgent.session.id = 'another-session';
  try {
    assertEqual(fitSectionText(fitAssembly), '');
  } finally {
    fitAgent.session.id = 'first-session';
  }
});
await check('入口：origin / delegationDepth 标记的子代理不可见', () => {
  for (const child of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
    fitAgent.session.header = { id: 'first-session', ...child };
    assertEqual(fitSectionText(fitAssembly), '', `子代理标记 ${JSON.stringify(child)} 必须隐藏`);
  }
  fitAgent.session.header = { id: 'first-session' };
});
await check('入口：普通用户 fork 带 parentSession 仍保留主脑视图', () => {
  fitAgent.session.header = { id: 'first-session', parentSession: 'user-fork-source' };
  try {
    assertEqual(fitSectionText(fitAssembly), FIT_TEXT);
  } finally {
    fitAgent.session.header = { id: 'first-session' };
  }
});
await check('入口：运行时 options.subagentDepth>0 也会隐藏', () => {
  fitAgent.options.subagentDepth = 1;
  try {
    assertEqual(fitSectionText(fitAssembly), '');
  } finally {
    delete fitAgent.options.subagentDepth;
  }
});
await check('入口：身份未知（session.header 缺失）时不把默认 root 当证据', () => {
  delete fitAgent.session.header;
  try {
    assertEqual(fitSectionText(fitAssembly), '');
  } finally {
    fitAgent.session.header = { id: 'first-session' };
  }
});
await check('入口：其他预设 / 无预设服务 / 预设查询异常 → 隐藏', () => {
  const presets = fitHost.services.agentPresets;
  fitHost.services.agentPresets = { composedPreset: () => 'other' };
  assertEqual(fitSectionText(fitAssembly), '', '其他预设不可见');
  fitHost.services.agentPresets = {
    composedPreset: () => {
      throw new Error('composing');
    },
  };
  assertEqual(fitSectionText(fitAssembly), '', 'composedPreset 抛错时必须隐藏，不向宿主抛');
  delete fitHost.services.agentPresets;
  assertEqual(fitSectionText(fitAssembly), '', '无 agentPresets 服务时不可见');
  fitHost.services.agentPresets = presets;
});
await check('入口：团队开关动态切换（true → false → true）即时生效', () => {
  const teams = fitHost.services.agentTeams;
  fitHost.services.agentTeams = { isEnabled: () => false };
  assertEqual(fitSectionText(fitAssembly), '', '团队关闭时隐藏');
  fitHost.services.agentTeams = { isEnabled: () => true };
  assertEqual(fitSectionText(fitAssembly), FIT_TEXT, '团队开启时显示');
  fitHost.services.agentTeams = { isEnabled: () => false };
  assertEqual(fitSectionText(fitAssembly), '', '再次关闭时隐藏');
  fitHost.services.agentTeams = teams;
});
const teamStep = { ...fitAssembly, toolSet: fitHost.admitted };
await check('入口：明确 isEnabled=false 优先于本步已获批的团队工具 → 隐藏', () => {
  fitHost.services.agentTeams.isEnabled = () => false;
  try {
    assertEqual(fitSectionText(teamStep), '');
  } finally {
    fitHost.services.agentTeams.isEnabled = (caller) => caller === fitAgent;
  }
});
await check('入口：团队服务缺失时，凭本步获批的 team_task_create 显示', () => {
  delete fitHost.services.agentTeams;
  try {
    assertEqual(fitSectionText(teamStep), FIT_TEXT, '本步工具集合是正向证据');
    assertEqual(fitSectionText(fitAssembly), '', '没有本步工具集合时不能仅凭注册表判断');
  } finally {
    fitHost.services.agentTeams = { isEnabled: (caller) => caller === fitAgent };
  }
});
await check('入口：工具已注册但本步未获准 / 空工具集合 → 隐藏', () => {
  // 两参 tools.get 能看到注册表里的 team_task_create，但缺少第三个参数（本步 toolSet）不能当证据。
  const teams = fitHost.services.agentTeams;
  delete fitHost.services.agentTeams;
  try {
    assertEqual(fitSectionText(fitAssembly), '');
    assertEqual(fitSectionText({ ...fitAssembly, toolSet: fitHost.excluded }), '');
  } finally {
    fitHost.services.agentTeams = teams;
  }
});
await check('入口：团队服务抛错时仍按本步工具集合判断，回退查询失败也不影响组装', () => {
  fitHost.services.agentTeams = {
    isEnabled() {
      throw new Error('service unavailable');
    },
  };
  try {
    assertEqual(fitSectionText(teamStep), FIT_TEXT, '服务抛错 + 本步获批 → 显示');
    assertEqual(fitSectionText(fitAssembly), '', '服务抛错 + 无本步证据 → 隐藏');
    assertEqual(
      fitSectionText({ ...fitAssembly, toolSet: { view() { throw new Error('unavailable'); } } }),
      '',
    );
  } finally {
    fitHost.services.agentTeams = { isEnabled: (caller) => caller === fitAgent };
  }
});
await check('入口：重复组装幂等且无写入副作用', () => {
  assertEqual([fitSectionText(fitAssembly), fitSectionText(fitAssembly)], [FIT_TEXT, FIT_TEXT]);
});

// ── 13. 设置页模型标签：每个模型都标出所属渠道（client.js 的目录投影）────────────
// client.js 是浏览器端单文件模块（window.__ModuleLoader__），没有可 import 的导出；
// 这里在假 window 里执行真源码，只注入一个测试用键取出内部的目录投影函数。
function loadClientDirectory() {
  const clientSource = readFileSync(resolvePath(libDir, '..', 'client.js'), 'utf8');
  const anchor = "inject: ['slots', 'locale'],";
  const anchorAt = clientSource.indexOf(anchor);
  assert(anchorAt >= 0, 'client.js 的模块返回结构已变化：找不到 inject 标记');
  const returnAt = clientSource.lastIndexOf('return {', anchorAt);
  assert(returnAt >= 0, 'client.js 的模块返回结构已变化：找不到 return 标记');
  const eol = clientSource.includes('\r\n') ? '\r\n' : '\n';
  const instrumented = clientSource.slice(0, returnAt)
    + `return {${eol}      __directoryOfForTest: directoryOf,${eol}      `
    + clientSource.slice(returnAt + 'return {'.length);
  const react = {
    createElement: () => null,
    useEffect: () => undefined,
    useId: () => 'fixture-id',
    useRef: () => ({ current: false }),
    useState: (initial) => [initial, () => undefined],
    useSyncExternalStore: () => undefined,
  };
  let testedModule;
  const fakeWindow = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        testedModule = factory((name) => (name === 'react' ? react : undefined));
      },
    },
  };
  new Function('window', instrumented)(fakeWindow);
  assert(typeof testedModule?.__directoryOfForTest === 'function', 'client.js 未暴露目录投影函数');
  return testedModule.__directoryOfForTest;
}
const clientDirectoryOf = loadClientDirectory();
await check('设置页模型标签：模型名不重复时也显示所属渠道', () => {
  const rows = clientDirectoryOf({
    groups: [
      { id: 'chan-a', name: 'Channel A', models: [{ id: 'model-one', name: 'Model One' }] },
      { id: 'chan-b', name: 'Channel B', models: [{ id: 'model-two', name: 'Model Two' }] },
    ],
  });
  assertEqual(rows.map((row) => row.label), ['Model One · Channel A', 'Model Two · Channel B'],
    '每个模型都必须带所属渠道名，不能只在重名时才显示');
});
await check('设置页模型标签：同名模型按渠道区分且互不覆盖', () => {
  const rows = clientDirectoryOf({
    groups: [
      { id: 'chan-a', name: 'Channel A', models: [{ id: 'model-one', name: 'Model One' }] },
      { id: 'chan-b', name: 'Channel B', models: [{ id: 'model-one', name: 'Model One' }] },
    ],
  });
  assertEqual(rows.map((row) => row.label), ['Model One · Channel A', 'Model One · Channel B']);
  assertEqual(rows.map((row) => `${row.provider}/${row.model}`), ['chan-a/model-one', 'chan-b/model-one']);
});
await check('设置页模型标签：渠道显示名缺失时回退到渠道 id', () => {
  const rows = clientDirectoryOf({ groups: [{ id: 'chan-a', models: [{ id: 'model-one', name: 'Model One' }] }] });
  assertEqual(rows.map((row) => row.label), ['Model One · chan-a']);
});

// ── 输出 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
process.stdout.write(`${JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
