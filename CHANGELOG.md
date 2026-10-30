# Changelog

本包是 `dsh-model-routing`（本机自建插件）策略层的公版化产物；公开名定为 `dsh-submodel`。

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

### 移除（相对本机自建插件）

- 4 个控制工具（官方 `@deepseek-ai/dsh-tool-subagent-control` 已提供 `send_message` / `interrupt_agent` / `list_agents`，
  重复注册会冲突）。
- watchdog（预算护栏 / 催收 / 故障改派）——v0.2 候选。
- 旧入口的静态正文模式与 `text` 配置字段。
- `m-opus` 兜底硬编码与全部本机私有路由名。

### 发布前审查修复（2026-10-30）

- `agent/created` 安装路径补 try/catch：cordis 的事件发射不等待、也不捕获监听器返回的 Promise，
  安装失败会变成 unhandled rejection（纯 Node CLI 下默认终止进程）；现在只记 `error` 日志，
  与 `reconcile` / `agent/pre-step` 两条通道一致。
- Python 驱动测试加固：找不到 Node 时**失败**而不是整体 skip（避免"一条断言都没跑也算 OK"）；
  `policy.js` 零 import 检查覆盖 `from …` 与动态 `import()` 形态。
- 兼容性声明按实测写明 DSH `0.2.1-rc.5`（`engines.dsh` 范围不变）。

### 验证（2026-10-30 实测，V0–V6）

| 编号 | 结果 |
|---|---|
| V0 | 生产插件未被改动：`desktop` profile 的 `plugins/dsh-model-routing/lib/*.js`（6 个）+ `cordis.patch.yml` + `package.json` 哈希与执行前基线逐一相同 |
| V1 | `node tests/unit/flash-routing-fixture.mjs ./lib` → **71 条断言，failed 0** |
| V2 | `python -m unittest discover -s tests/unit` → **7 个用例 OK** |
| V3 | 隔离 profile（`probe-pub`，由 `web` 模板复制，DSH `0.2.1-rc.5`）：打包件安装成功；`--dump-config` 含 `# == dsh-submodel`；`--port 51978` 启动成功且 stderr 为空（对照实验：故意报错的插件会打 `failed to import`，证明加载失败可见）；验证后 profile 已删除 |
| V4 | `node tests/unit/public-profile-smoke.mjs` → **5 条断言，failed 0**（四类 fail-fast 日志文案逐字断言） |
| V5 | `lib/` grep 本机路由名与禁止工具名 → **0 命中** |
| V6 | `npm pack --dry-run` → **7 个文件**（lib×3、cordis.patch.yml、README、LICENSE、package.json），无 `reference/`、`tests/`、`.bak-*` |

V7（发布）未执行：等用户完成 npm 登录并确认包名、许可证、仓库名后再进行。
