/**
 * public-profile-smoke.mjs —— 干净用户配置的确定性冒烟（plan V4）。
 *
 * 模拟"用户刚装好、还没写任何配置"的 profile，逐条断言 §4.3 的**四类 fail-fast 日志级别与文案**，
 * 以及注册结果、正文渲染。约束：不访问网络、不启动宿主、不触发真实 LLM、不碰任何真实 profile。
 *
 * 用法（包根）：
 *   node tests/unit/public-profile-smoke.mjs [lib 目录绝对路径]
 * stdout 为 JSON，退出码非 0 即失败。
 */
import { pathToFileURL } from 'node:url';
import { dirname as dirnamePath, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirnamePath(fileURLToPath(import.meta.url));
const libDir = process.argv[2] ?? resolvePath(here, '..', '..', 'lib');
const entry = await import(pathToFileURL(resolvePath(libDir, 'index.js')).href);

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 干净用户 profile 的宿主替身：只有官方服务，没有任何本包配置。 */
function makeHost({ nativeDefinition, modelSelectionVisible = true, presetService, candidates = [] }) {
  const logs = { info: [], warn: [], error: [] };
  const registered = [];
  const guards = [];
  const listeners = [];
  const assemblyListeners = [];
  const tools = {
    get: (name) => {
      if (name === 'subagent') return nativeDefinition;
      if (name === 'list_subagent_models') return modelSelectionVisible ? {} : undefined;
      return undefined;
    },
    register: (definition) => {
      registered.push(definition.name);
      return () => {};
    },
    guard: (guard) => {
      guards.push(guard);
      return () => {};
    },
  };
  const get = (name) => {
    if (name === 'agents') return { list: () => candidates };
    if (name === 'agentPresets') return presetService;
    return undefined;
  };
  const fakeCtx = {
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
      error: (message) => logs.error.push(message),
    },
    tools,
    systemPrompt: { section: () => () => {} },
    on: (event, callback) => {
      listeners.push([event, callback]);
      return () => {};
    },
    get,
  };
  for (const candidate of candidates) {
    candidate.ctx = {
      get,
      tools,
      on: (event, listener) => {
        if (event === 'system-prompt/assemble') assemblyListeners.push(listener);
        return () => {};
      },
    };
  }
  return { fakeCtx, logs, registered, guards, listeners, assemblyListeners };
}

/** 干净的顶层 agent（durable header 判 root；requestHeader 只供执行期读 config）。 */
function rootCandidate() {
  return {
    id: 'clean-root',
    ctx: {},
    session: {
      header: { delegationDepth: 0 },
      requestHeader: () => ({ id: 's-clean', config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
    },
    options: { model: 'deepseek-flash' },
  };
}

const NATIVE_PARAMETERS = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    prompt: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
  },
  required: ['description', 'prompt'],
};
function nativeWithRoute() {
  return { parameters: structuredClone(NATIVE_PARAMETERS), output: { schema: { type: 'object' }, render: () => [] } };
}
function nativeWithoutRoute() {
  return {
    parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    output: { schema: { type: 'object' }, render: () => [] },
  };
}

const CLEAN_EXECUTOR = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' };

// ── ① executor 未配置：error 日志（文案逐字断言） ─────────────────────────────
await check('干净配置: executor 未配置 → error 文案逐字匹配，且不抛', () => {
  const host = makeHost({
    nativeDefinition: nativeWithRoute(),
    presetService: { composedPreset: () => 'standard' },
  });
  entry.apply(host.fakeCtx, entry.Config({ enabled: true }));
  const expected =
    'dsh-submodel: config.executor.provider/model 未配置，自动委派不可用；可调用 `configure_submodel` 自动配置或按 README 两步配置';
  assertEqual(host.logs.error, [expected], 'executor 未配置必须且只记一条 error（并指向自动配置向导）');
});

// ── ② 无 agentPresets 服务：每 agent 一次 warn ────────────────────────────────
await check('干净配置: 无 agentPresets 服务 → 每 agent 一次 warn（文案逐字）', async () => {
  const candidate = rootCandidate();
  const host = makeHost({ nativeDefinition: nativeWithRoute(), presetService: undefined, candidates: [candidate] });
  entry.apply(host.fakeCtx, entry.Config({ enabled: true, executor: CLEAN_EXECUTOR }));
  await sleep(30);
  const expected = 'dsh-submodel: 当前 profile 无 agentPresets 服务，策略不生效';
  assertEqual(host.logs.warn.filter((m) => m === expected).length, 1, '每 agent 一次 warn');
  assertEqual(host.registered, [], '服务缺失时不得注册任何工具');
});

// ── ③ 原生 subagent 无 provider/model：warn 一次 + 不注册 delegate_task ───────
await check('干净配置: 原生 subagent 无选模参数 → warn 一次且不装 delegate_task（文案逐字）', async () => {
  const candidate = rootCandidate();
  const host = makeHost({
    nativeDefinition: nativeWithoutRoute(),
    presetService: { composedPreset: () => 'standard' },
    candidates: [candidate],
  });
  entry.apply(host.fakeCtx, entry.Config({ enabled: true, executor: CLEAN_EXECUTOR }));
  await sleep(50);
  const expected = 'dsh-submodel: 原生 subagent 未暴露 provider/model，delegate_task 不安装';
  assertEqual(host.logs.warn.filter((m) => m === expected).length, 1, '每 agent 一次 warn');
  assertEqual(host.registered, [], '不得注册一个必然失败的 delegate_task');
});

// ── ④ list_subagent_models 不可见：info 一次 + 策略段不渲染，但工具仍装 ──────
await check('干净配置: 未启用官方模型选择 → info 一次且策略段不渲染（文案逐字）', async () => {
  const candidate = rootCandidate();
  const host = makeHost({
    nativeDefinition: nativeWithRoute(),
    modelSelectionVisible: false,
    presetService: { composedPreset: () => 'standard' },
    candidates: [candidate],
  });
  entry.apply(host.fakeCtx, entry.Config({ enabled: true, executor: CLEAN_EXECUTOR }));
  await sleep(50);
  const expected = 'dsh-submodel: 本会话未启用官方 subagent 模型选择，策略段不渲染；请在设置中启用 subagent-model-selection';
  assert(host.registered.includes('delegate_task'), '工具仍按注册门控安装（只门控正文段）');
  assertEqual(host.assemblyListeners.length, 1, '必须挂上 assembly listener');
  const assembly = Object.freeze({
    variables: Object.freeze({ model: 'deepseek-flash' }),
    sections: Object.freeze([Object.freeze({ name: 'tool:model-routing', text: '' })]),
  });
  const resolved = await host.assemblyListeners[0](assembly, { agent: candidate, scope: candidate }, async () => assembly);
  assertEqual(resolved.sections[0].text, '', '工具不可见时策略段不得渲染');
  assertEqual(host.logs.info.filter((m) => m === expected).length, 1, '每 agent 一次 info');
});

// ── ⑤ 通用路由 + 原生工具带 provider/model：正常安装并渲染配置路由 ───────────
await check('干净配置: 通用路由正常安装，正文含配置的执行路由、不含任何本机路由名', async () => {
  const candidate = rootCandidate();
  const host = makeHost({
    nativeDefinition: nativeWithRoute(),
    presetService: { composedPreset: () => 'standard' },
    candidates: [candidate],
  });
  entry.apply(host.fakeCtx, entry.Config({ enabled: true, executor: CLEAN_EXECUTOR }));
  await sleep(50);
  assert(host.registered.includes('delegate_task'), '顶层必须注册 delegate_task');
  assert(!host.registered.includes('send_message'), '本包不得重复注册官方控制工具');
  assert(host.guards.length >= 1, '必须注册子代 guard');
  assertEqual(host.assemblyListeners.length, 1);
  const assembly = Object.freeze({
    variables: Object.freeze({ model: 'gpt-6.1-sol' }),
    sections: Object.freeze([Object.freeze({ name: 'tool:model-routing', text: '' })]),
  });
  const resolved = await host.assemblyListeners[0](assembly, { agent: candidate, scope: candidate }, async () => assembly);
  const text = resolved.sections[0].text;
  assert(text.includes('provider: "deepseek-official", model: "deepseek-flash"'), `正文必须注入配置的执行路由；实际: ${text.slice(0, 300)}`);
  for (const leaked of ['p-opus', 'p-gpt', 'm-opus', 'opencode-go', 'deepseek-account']) {
    assert(!text.includes(leaked), `干净配置的正文不得出现本机路由名 ${leaked}`);
  }
  assertEqual(resolved.sections[0].interpolate, false, '策略段必须关闭插值');
});

// ── ⑥ 自动配置向导：executor 未配置时 root 可见 configure_submodel ────────────
await check('干净配置: executor 未配置 + 原生 subagent 可见 → 注册 configure_submodel', async () => {
  const candidate = rootCandidate();
  const host = makeHost({
    nativeDefinition: nativeWithRoute(),
    presetService: { composedPreset: () => 'standard' },
    candidates: [candidate],
  });
  entry.apply(host.fakeCtx, entry.Config({ enabled: true }));
  await sleep(50);
  assert(
    host.registered.includes('configure_submodel'),
    `executor 未配置时顶层必须注册自动配置向导；实际注册: ${host.registered.join(',') || '空'}`,
  );
  assert(host.registered.includes('delegate_task'), 'delegate_task 仍要注册');
});

// ── ⑦ 自动配置向导：executor 已配置时不再注册 ────────────────────────────────
await check('干净配置: executor 已配置 → 不注册 configure_submodel', async () => {
  const candidate = rootCandidate();
  const host = makeHost({
    nativeDefinition: nativeWithRoute(),
    presetService: { composedPreset: () => 'standard' },
    candidates: [candidate],
  });
  entry.apply(host.fakeCtx, entry.Config({ enabled: true, executor: CLEAN_EXECUTOR }));
  await sleep(50);
  assert(
    !host.registered.includes('configure_submodel'),
    `executor 已配置时不得再注册自动配置向导；实际注册: ${host.registered.join(',') || '空'}`,
  );
  assert(host.registered.includes('delegate_task'), 'delegate_task 仍要注册');
});

// ── 输出 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((row) => !row.ok);
process.stdout.write(`${JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
