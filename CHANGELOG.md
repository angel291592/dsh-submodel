# Changelog

本包是作者自建路由插件策略层的公版化产物；公开名定为 `dsh-submodel`。

## 0.2.0（2026-11-11）

**通用自动配置 + DSH 0.2.2 适配收口。** 模式判定由「模型名后缀」改为「路由」，新增 `configure_submodel`
首次配置向导与 `economyRoutes`，修复冷恢复子代策略失效，并补齐英文 README / CI / hero。

### 新增

- **`configure_submodel` 配置向导**：顶层主代理、`autoConfigure` 为 `true` 且 `executor` 未配置时可见；
  弹 3 个问题（执行路由 / 专家路由 / 是否同时写宿主授权表），经官方 `configEditor` **先写宿主授权**
  （`subagent-model-selection-settings` 的 `enabled` + `allowedModels`）、再写插件配置
  （`executor` / `experts` / `economyRoutes`）；无 GUI 客户端或所需服务缺失时降级返回手动 YAML，不写任何配置。
- **`economyRoutes` 配置字段**（默认 `[]`，每项 `{provider?, model}`）：显式声明哪些路由算便宜路由，
  有多条便宜路由时不再依赖模型命名约定。
- **`autoConfigure` 配置字段**（默认 `true`）：关闭后不注册 `configure_submodel`，完全手动配置。
- **文档与发布资产**：`README.en.md`（英文对应版）、`assets/hero.svg`（纯图形，不含任何渠道/模型名）、
  `.github/workflows/ci.yml`（push / PR 跑 fixture + smoke + Python 测试）；README 重写为
  hero 首屏 + 两步配置（宿主授权 / 插件配置）+ 路由规则 + 兼容性 + 故障排查。
- **发布自动化**：`.github/workflows/release.yml` 通过 npm Trusted Publishing（OIDC）自动发布，
  `scripts/release.ps1` 提供本机一键发版（门禁 → 版本 → tag → push → 验证），
  本机与仓库均不保存 npm 令牌。

### 修复

- **`roleOf` 改读 `session.header`**（`origin` / `delegationDepth`，回退 `options.subagentDepth`）：
  修复冷恢复（cold resume）的子代会话没有 `subagentDepth`、被误判为顶层主代理，导致「子代策略与
  子代硬边界整段失效」的问题。
- 三处模式判定来源（提示词装配 / 执行期 / 原生 `subagent` guard）统一改用路由判定，
  避免同一请求在提示词与执行期被判成不同模式。

### 变更

- **模式判定不再只认「模型名以 flash 结尾」**：本次请求路由等于配置的 `executor` 路由，或命中
  `economyRoutes` → `economize`（Flash）模式；`economyRoutes` 为空时保留 flash 后缀 legacy 兼容。
- **`delegate_task` 语义与文案**：统一为「启动后立即返回子会话 id，完成时由运行时通知」，删除
  「前台调用直接返回结果」的过期措辞；轮询纪律改用官方 `list_agents` / `send_message` /
  `interrupt_agent`。
- **fail-fast 文案**：`executor` 未配置时追加「可调用 `configure_submodel` 自动配置或按 README 两步配置」；
  嵌套调用错误含 `is not allowed for this Session` 时追加宿主授权修复提示。

### 兼容性

- `engines.dsh` 不变：`>=0.2.2-rc.1 <0.3.0`；`0.2.1` 及更早不兼容（没有批量 `ctx.tools.execute`
  与 0.2.2 的子代理路由语义）。
- `peerDependencies` 不变：`@deepseek-ai/schemastery` `>=3.18.4 <4.0.0`。

### 验证

<!-- 验证计数：fixture / Python / smoke 三处数字集中在下面三条；实测有出入时只改这三处。 -->

- `node tests/unit/flash-routing-fixture.mjs ./lib` → **104 条断言，failed 0**
  （新增覆盖：`modeForRoute` 6 条、`roleOf` 新判据 7 条、装配路由 4 条、正文/工具描述语义 4 条、setup 17 条）。
- `python -m unittest discover -s tests/unit` → **7 个用例 OK**。
- `node tests/unit/public-profile-smoke.mjs` → **7 条断言，failed 0**（新增「未配置时注册向导」「已配置时不注册」两条）。
- 隔离 profile 真机装载（DSH `0.2.2-rc.1`）：打包件安装成功，`--dump-config` 含 `- id: submodel`。
- 隔离 profile（DSH `0.2.2-rc.1` + 本地 mock LLM，不联网不花钱）：退出码 0、stderr 无 `failed to import`、
  日志含「自动策略已启用」与「executor 未配置…configure_submodel」；执行前后 desktop 生产插件与
  `cordis.patch.yml` 共 8 个文件 SHA256 与基线完全一致。
- GUI 端到端（`configure_submodel` 弹卡与两处写入、`delegate_task` 派工、主模型切到执行路由进入
  economize 模式）：**未验证**（需用户在新会话里验收）。

## 0.1.1（2026-11-10）

**兼容 DSH 0.2.2-rc.1 的破坏性变更。必须升级：0.2.1 及更早版本与 0.1.0 互相不兼容。**

### 修复

- **`delegate_task` 迁移到 0.2.2 的批量执行 API**：`ctx.tools.execute(input)` 现在只接受
  `{calls:[{id,name,arguments}], signal, agent?, toolSet?, log?, maxParallelToolCalls?}`，
  返回 `{results:[{callId,result}], additionalContexts, concluded}`。0.1.0 传的是旧的单次
  `execute({callId, rootCallId, name, arguments, agent, parent, signal})`，在 0.2.2 上会让
  `delegate_task` **100% 失败**（模型只能看到 `Error: Tool batch execution failed`，根因被批量层吞掉）。
- `arguments` 改传 **JSON 文本**（0.2.2 的批量实现会 `JSON.parse`）；结果按 `callId` 从
  `results` 里取；`additionalContexts` / `concludesTurn` 从**子调用的 result**（不是 batch 级）读取。
- 批量调度器抛错时把 `cause` 链写进错误消息（避免只剩通用文案，便于诊断）。
- 嵌套调用不再伪造 `parent` / `rootCallId`（0.2.2 批量 API 已无该通道）；`toolSet` 在存在时
  透传给同一步的准入集合（agent 必须是本步 resolve 时的同一对象，否则 `toolSet.view()` 返回空）。

### 兼容性

- `engines.dsh`: `>=0.2.2-rc.1 <0.3.0`（0.2.1 没有批量 API，无法兼容）。
- `peerDependencies`: `@deepseek-ai/schemastery` `>=3.18.4 <4.0.0`（0.2.2 内置 3.19.0，旧范围 `~3.18.4` 会排除它）。

### 验证

- `node tests/unit/flash-routing-fixture.mjs ./lib` → **73 条断言，failed 0**
  （新增：批量形状、arguments 为 JSON 文本、按 callId 取结果、toolSet 透传、cause 链诊断）。
- `python -m unittest discover -s tests/unit` → **7 个用例 OK**。
- 未做真实 DSH 0.2.2 宿主内的 `delegate_task` 端到端（需要重启后的桌面会话）；fixture 里的
  `ctx.tools.execute` 是行为等价的假实现。

## 0.1.0（2026-10-30）

首个公开版本：官方 subagent 的默认策略包——装上一次配好「什么时候自己干、什么时候派出去、派给谁」。

### 新增

- **Flash 主脑策略**：默认自己干；普通子任务用 `delegate_task`（不传 provider/model，子代继承当前路由）；
  只有"问题本身够复杂"或"超出执行上限"时才升级，升级时从配置的专家路由里点名。
- **强主脑策略**：理解/判断/关键写作自己做；可验证的执行块默认派给配置的执行路由。
- **`delegate_task` 统一委派入口**：参数与原生 `subagent` 相同，经 `ctx.tools.execute` 转发真正的原生调用，
  宿主的 allowlist / 预检 / 权限照旧生效；`provider` 与 `model` 必须成对传。
- **子代硬边界**：`delegate_task` / `subagent` / `subagent_fork` / `workflow` / `spawn_teammate` 对子代不可用；
  非 Flash 顶层用原生 `subagent` 却缺完整 provider/model 时拒绝并指向 `delegate_task`。
- **正文模板化**：内置模板不含任何具体渠道/模型名；执行路由与专家路由只经
  `{{executorRoute}}` / `{{expertRoutes}}` 占位符注入；`texts.*` 可整段覆盖且替换后不再插值。
- **fail-fast 日志**（只记日志、绝不抛）：`executor` 未配置 → `error`；无 `agentPresets` 服务 → `warn`；
  原生 `subagent` 无选模参数 → `warn`；未启用官方模型选择 → `info`。

### 移除（相对作者自建插件）

- 4 个控制工具（官方 `@deepseek-ai/dsh-tool-subagent-control` 已提供 `send_message` / `interrupt_agent` / `list_agents`，
  重复注册会冲突）。
- watchdog（预算护栏 / 催收 / 故障改派）——v0.2 候选。
- 旧入口的静态正文模式与 `text` 配置字段。
- 私有兜底硬编码与全部私有路由名。

### 发布前审查修复（2026-10-30）

- `agent/created` 安装路径补 try/catch：cordis 的事件发射不等待、也不捕获监听器返回的 Promise，
  安装失败会变成 unhandled rejection（纯 Node CLI 下默认终止进程）；现在只记 `error` 日志，
  与 `reconcile` / `agent/pre-step` 两条通道一致。
- Python 驱动测试加固：找不到 Node 时**失败**而不是整体 skip（避免"一条断言都没跑也算 OK"）；
  `policy.js` 零 import 检查覆盖 `from …` 与动态 `import()` 形态。
- 兼容性声明按实测写明 DSH `0.2.1-rc.5`（`engines.dsh` 范围不变）。

### 验证（2026-10-30 实测，V0–V7）

| 编号 | 结果 |
|---|---|
| V0 | 生产插件未被改动：`desktop` profile 的自建路由插件 `lib/*.js`（6 个）+ `cordis.patch.yml` + `package.json` 哈希与执行前基线逐一相同 |
| V1 | `node tests/unit/flash-routing-fixture.mjs ./lib` → **71 条断言，failed 0** |
| V2 | `python -m unittest discover -s tests/unit` → **7 个用例 OK** |
| V3 | 隔离 profile（`probe-pub`，由 `web` 模板复制，DSH `0.2.1-rc.5`）：打包件安装成功；`--dump-config` 含 `# == dsh-submodel`；`--port 51978` 启动成功且 stderr 为空（对照实验：故意报错的插件会打 `failed to import`，证明加载失败可见）；验证后 profile 已删除 |
| V4 | `node tests/unit/public-profile-smoke.mjs` → **5 条断言，failed 0**（四类 fail-fast 日志文案逐字断言） |
| V5 | `lib/` grep 私有路由名与禁止工具名 → **0 命中** |
| V6 | `npm pack --dry-run` → **7 个文件**（lib×3、cordis.patch.yml、README、LICENSE、package.json），无 `reference/`、`tests/`、`.bak-*` |
| V7 | 发布后验证：npm 0.1.0 公开可装；隔离 profile 从 registry 安装成功；GitHub 仓库公开（12 文件、7 topic）；dshbase issue #221 |

### 发布（2026-10-31）

- npm：[dsh-submodel@0.1.0](https://www.npmjs.com/package/dsh-submodel)（MIT）
- GitHub：[angel291592/dsh-submodel](https://github.com/angel291592/dsh-submodel)（topic：dsh-plugin、dsh-plugins、deepseek-harness、deepseek-harness-plugin、subagent、delegation、model-routing）
- dshbase 收录：[issue #221](https://github.com/ylwl1997/dshbase/issues/221)
- 安装验证：隔离 profile（web 模板复制）从 npm 安装 → `dump-config` 含 `# == dsh-submodel` → 启动无插件报错
