# dsh-submodel

> **官方 subagent 的默认策略包**：装上一次配好「什么时候自己干、什么时候派出去、派给谁」。

它**不新建 provider 体系**——只读你 profile 里已有的渠道与模型配置，把委派策略写进系统提示词，
并给官方 `subagent` 补一个统一的委派入口 `delegate_task`。本机实测于 DeepSeek Harness `0.2.1-rc.5`。

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-submodel
```

## 配置（5 行）

在你的 profile 补丁层（`~/.dsh/profiles/<你的 profile>/cordis.patch.yml`）里按 id 覆盖配置。
该文件默认是空数组 `[]`：**把 `[]` 替换成下面的条目**；已有其他条目时，把它追加到数组里。

```yaml
- id: submodel
  config:
    executor:
      provider: <执行渠道>
      model: <执行模型>
```

注意：profile 补丁对某一条目的 `config` 是**整段替换**——没写的字段回落到默认值（见下表），
不会和内置默认值逐字段合并。

完整字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时只注册一个空段，不装任何工具/guard |
| `preset` | `standard` | 只对这个 composition 生效 |
| `executor.provider` / `executor.model` | 空 | 非 Flash 主脑的默认派工目标；**留空会记 error 日志**（见故障排查） |
| `executor.reasoningEffort` | `max` | 只在调用方没显式指定档位时作缺省 |
| `experts` | `[]` | 允许升级时显式点名的专家路由列表，每项 `{label, provider, model, reasoningEffort?}`；`reasoningEffort` 目前为预留字段，不影响派工 |
| `texts.economize` / `texts.boss` / `texts.child` | 空 | 非空时整段替换内置正文（替换后不再插值） |
| `toolName` | `list_subagent_models` | 策略段的能力门控工具名 |
| `order` | `2850` | 策略段在系统提示词里的顺序 |
| `guardNativeSubagent` | `true` | 是否拦截"非 Flash 顶层用原生 `subagent` 却不给完整 provider/model" |

## 它做什么

- **Flash 主脑**：默认自己干；普通子任务用 `delegate_task`（不传 provider/model，子代继承当前路由）；
  只有"问题本身够复杂"或"超出执行上限"时才升级，升级时从 `experts` 里点名。
- **非 Flash 主脑**：理解/判断/写作自己来；可验证的执行块默认派给 `executor` 配置的执行路由。
- **子代**：硬边界——`delegate_task` / `subagent` / `subagent_fork` / `workflow` / `spawn_teammate`
  一律不可用，防止递归派活。
- **`delegate_task`**：参数与原生 `subagent` 相同；`provider` 与 `model` 必须成对传；经
  `ctx.tools.execute` 发起真正的原生调用，宿主的 allowlist / 预检 / 权限照旧生效。

## 与官方插件的边界

| 能力 | 提供方 |
|---|---|
| 状态查看 `list_agents`、追加消息 `send_message`、停止 `interrupt_agent` | 官方 `@deepseek-ai/dsh-tool-subagent-control`（本包**不重复注册**） |
| 策略正文、`delegate_task`、子代 guard | 本包 |
| 模型选择能力本身（`subagent` 的 `provider`/`model` 参数） | 官方 subagent（本包只消费） |

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| `0.2.1-rc.5` | ✅ 实测通过（安装、`--dump-config`、启动均实测） |
| 其他 rc / 正式版 | 未逐一实测（`engines.dsh` 声明 `>=0.2.1-rc.3 <0.3.0`，不作宽承诺） |

## 故障排查（fail-fast：只记日志，绝不抛）

| 现象（日志） | 级别 | 含义与处理 |
|---|---|---|
| `config.executor.provider/model 未配置，自动委派不可用` | `error` | 非 Flash 主脑没有默认派工目标；按上面的 5 行配置补上 |
| `当前 profile 无 agentPresets 服务，策略不生效` | `warn` | 该 profile 没有 agentPresets 服务；换一个支持 composition 的 profile |
| `原生 subagent 未暴露 provider/model，delegate_task 不安装` | `warn` | 本会话的原生 `subagent` 没有选模参数：该 agent 上**整套安装**（策略段 / guard / `delegate_task`）都会跳过，等能力出现后由 `tools/change` 或 `agent/pre-step` 自动补装 |
| `本会话未启用官方 subagent 模型选择，策略段不渲染` | `info` | 去设置里启用 `subagent-model-selection`；工具本身仍按注册门控安装 |

## 已知限制

- 只对 `preset` 指定的 composition 生效（默认 `standard`）。
- 不提供预算护栏 / 催收 / 故障改派（watchdog）——v0.2 候选。
- 不提供英文文案与 locale：默认中文，可用 `texts.*` 整段覆盖（工具描述与 guard 拒绝理由仍为英文）。
- 正文里的执行路由与专家路由全部来自你的配置，本包内置模板**不含任何具体渠道/模型名**。

## 回滚

```bash
dsh plugin --profile <你的 profile> remove dsh-submodel
```

## 开发与验证

```bash
node tests/unit/flash-routing-fixture.mjs ./lib   # 纯函数 + 生命周期回归（71 条断言）
python -m unittest discover -s tests/unit         # 包根执行（7 个用例）
node tests/unit/public-profile-smoke.mjs          # 干净用户配置的确定性冒烟（5 条断言）
```
