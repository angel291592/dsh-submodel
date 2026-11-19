<!--
谢谢你的 PR。下面几格是点评时反复要问的，空着比写一句诚实的短答更糟。
提交信息用 Conventional Commits（feat: / fix: / docs: / ci: / test: / refactor:）。
English is fine too — answer in whichever language you are comfortable with.
-->

## 改了什么，为什么

<!--
动机，不是 diff：原来错在哪、缺什么、用户之前做不到什么。有 issue 就链接上。
-->

## 跑了什么

<!--
贴真实输出，别写「测试通过」。包根下：

  npm install --no-audit --no-fund
  node tests/unit/flash-routing-fixture.mjs ./lib
  node tests/unit/public-profile-smoke.mjs
  python -m unittest discover -s tests/unit -v
-->

```console

```

## 是否动了契约

<!--
配置字段、delegate_task 的参数与输出、渲染进系统提示词的策略文本，都算契约。
-->

- [ ] 没有动契约
- [ ] 动了契约 —— 下面写清旧配置会怎样、需不需要迁移

## 检查清单

- [ ] 提交信息是 Conventional Commits 格式。
- [ ] 没有带进私有 provider / 模型名、本机绝对路径、API Key、令牌或内网地址。
- [ ] `README.md` / `README.en.md` / `CHANGELOG.md` 里被这次改动推翻的说法已在同一个 PR 内改掉。
