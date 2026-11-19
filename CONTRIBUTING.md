# 贡献指南

[English](CONTRIBUTING.en.md) | 简体中文

谢谢你来。这份指南只解决一件事：**让一次贡献第一次就能被合掉**——该跑的、该说的、
不该带的东西，都写在前面。

## 先看边界

`dsh-submodel` 只做一件事：给官方 `subagent` 配一套可复用的默认派工策略，
并提供统一的委派入口 `delegate_task`。以下不属于本项目范围，提之前请先确认：

- 新建 provider 体系、或让插件自带 API Key——它只读你已经配好的渠道与模型；
- 改 DSH 本体、`app.asar` 或任何 `@deepseek-ai/*` 包的问题——那是上游的事；
- 需要联网或托管服务的功能。

## 开发环境

- Node.js 24（CI 用的版本；测试只用到 `node:path` / `node:url` 这类内置模块）
- Python 3.12（CI 用的版本；测试只用标准库 `unittest`）
- 首次运行前先 `npm install --no-audit --no-fund`：`@deepseek-ai/schemastery`
  是 peerDependency，不装的话 `lib/index.js` 加载不了。

## 跑测试

改完请跑这三条，CI 跑的是同一组命令（见 `.github/workflows/ci.yml`）：

```bash
node tests/unit/flash-routing-fixture.mjs ./lib   # 纯函数与生命周期回归
node tests/unit/public-profile-smoke.mjs          # 干净用户配置下的确定性冒烟
python -m unittest discover -s tests/unit -v      # Python 驱动的门禁
```

这三套测试**不联网、不读你的真实 profile、不调真实模型**。给改动补断言时请顺着这个前提写：
需要复现的状态用 fake agent 造出来，别把它变成「得先装好一整套环境才跑得动」的测试。

## 提交与 PR

- **提交信息用 Conventional Commits**：`feat:` / `fix:` / `docs:` / `ci:` / `test:` / `refactor:`，
  标题里说清改了什么，正文里说清为什么。
- **PR 里写清验证**：跑了哪几条命令、输出是什么。没跑就写没跑——不要把「我读过代码」
  写成「我测过」。
- **契约类改动要说明影响**：改配置字段、改 `delegate_task` 的参数或输出、改渲染进系统提示词的
  策略文本，都算契约改动。写清旧配置会怎样、要不要迁移。
- **文档同步**：这次改动推翻了 `README.md` / `README.en.md` / `CHANGELOG.md` 里的哪些说法，
  请在同一个 PR 里一起改掉。

## 请不要带进仓库

- 你的私有 provider / 模型名、真实 profile 路径、本机绝对路径；
- API Key、令牌、内网地址；
- 你的 DSH 配置截图（通常带着渠道名与模型名）；
- 计划、待办一类只对维护者有意义的过程文档。

## 安全问题与行为准则

- 安全问题走 [SECURITY.md](SECURITY.md) 的私密渠道，不要开公开 issue。
- 参与本项目即视为同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 发版

发版由维护者按 `README.md` 的「发版」一节执行（打 tag → GitHub Actions 校验并发布到 npm）。
贡献者不需要动版本号，也不需要碰 `npm publish`。
