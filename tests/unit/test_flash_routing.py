"""dsh-submodel 策略包 —— 常驻回归测试（stdlib unittest 驱动）。

存在理由（为什么不是一次性脚本）：
本模块的规则是**跨文件不变量**——模型 ID 的 Flash 后缀判定、四类路由分支、子代递归边界、
模板渲染与占位符注入，它们分散在 `lib/policy.js` / `lib/delegation.js` / `lib/index.js`，
靠人肉 review 保证不了；且这些规则正是"改配置的人不会回头看"的那类漂移高发点。

驱动方式：
- 本文件用**标准库 unittest**，断言的是"fixture 是否整体通过"，
- 具体断言在 `flash-routing-fixture.mjs`（Node 侧，纯函数 + mock lifecycle），
- **不触发真实 LLM、不访问网络、不碰任何真实 profile**。

运行（包根）：
    <python.exe> -m unittest discover -s tests/unit -v

路径解析（不再硬编码本机绝对路径）：
- 被测 lib 目录：环境变量 `DSH_POLICY_LIB` 优先，否则由本文件位置推导 `../lib`；
- Node 可执行文件：环境变量 `DSH_POLICY_NODE` 优先，否则 PATH 上的 `node`。

注意：导入本模块**无副作用**（不起进程、不读生产文件），
所有执行都在用例方法内绑定 `__main__` 之外的显式调用。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

# 包根：tests/unit/test_flash_routing.py → <包根>/
MODULE_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / "flash-routing-fixture.mjs"

# 被测 lib 目录：环境变量优先，否则由脚本位置推导（公版包不写死本机路径）。
PLUGIN_LIB = Path(os.environ["DSH_POLICY_LIB"]).resolve() if os.environ.get("DSH_POLICY_LIB") else MODULE_ROOT / "lib"


def resolve_node() -> str:
    """解析 Node 可执行文件：环境变量优先，其次 PATH。"""
    pinned = os.environ.get("DSH_POLICY_NODE")
    if pinned and Path(pinned).is_file():
        return pinned
    found = shutil.which("node")
    if found:
        return found
    raise AssertionError("no Node executable available (DSH_POLICY_NODE missing and `node` not on PATH)")


def run_fixture() -> subprocess.CompletedProcess:
    """跑一次 Node fixture，返回完整结果（stdout/stderr/returncode）。"""
    if not FIXTURE.is_file():
        raise AssertionError(f"fixture missing: {FIXTURE}")
    if not PLUGIN_LIB.is_dir():
        raise AssertionError(f"plugin lib dir missing: {PLUGIN_LIB}")
    return subprocess.run(
        [resolve_node(), str(FIXTURE), str(PLUGIN_LIB)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        cwd=str(MODULE_ROOT),
    )


def parse_report(completed: subprocess.CompletedProcess) -> dict:
    """从 fixture stdout 解析 JSON 报告；失败时把 stderr 一起报出来。"""
    stdout = (completed.stdout or "").strip()
    if not stdout:
        raise AssertionError(
            f"fixture produced no stdout (exit={completed.returncode}); stderr:\n{completed.stderr}"
        )
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(
            f"fixture stdout is not JSON ({error}); stdout:\n{stdout[:2000]}\nstderr:\n{completed.stderr}"
        ) from error


class FlashRoutingPolicyTests(unittest.TestCase):
    """整体门禁：Node fixture 的**每一条**断言都必须通过。"""

    @classmethod
    def setUpClass(cls) -> None:
        # 整个测试类只跑一次 fixture（全部断言，秒级），避免重复起进程。
        cls.completed = run_fixture()
        cls.report = parse_report(cls.completed)

    def test_fixture_exit_code_is_zero(self) -> None:
        """fixture 退出码必须为 0（非 0 代表有断言失败）。"""
        self.assertEqual(
            self.completed.returncode,
            0,
            msg=f"fixture failed; stderr:\n{self.completed.stderr}",
        )

    def test_no_assertion_failed(self) -> None:
        """报告里 failed 计数必须为 0，且逐条列出失败原因（便于定位）。"""
        self.assertEqual(
            self.report.get("failed"),
            0,
            msg="\n".join(
                f"  - {row['name']}: {row['detail']}"
                for row in self.report.get("results", [])
                if not row.get("ok")
            ),
        )

    def test_assertion_count_is_meaningful(self) -> None:
        """断言数量下限（plan V1：≥ 60）：防止 fixture 被误删/短路后"空跑全绿"。"""
        self.assertGreaterEqual(
            self.report.get("total", 0),
            60,
            msg="fixture 断言数量异常偏少，可能被裁剪或提前退出",
        )

    def test_every_report_row_has_name(self) -> None:
        """每行报告都必须有可读名字（失败时能定位到具体规则）。"""
        for row in self.report.get("results", []):
            self.assertTrue(row.get("name"), msg=f"unnamed row: {row!r}")


class PackageShapeTests(unittest.TestCase):
    """发布件的基本形态守卫（只读，不执行被测代码）。"""

    def test_module_files_exist(self) -> None:
        """入口与两个职责模块必须存在。"""
        for filename in ("index.js", "policy.js", "delegation.js"):
            with self.subTest(file=filename):
                self.assertTrue((PLUGIN_LIB / filename).is_file(), msg=f"missing {filename}")

    def test_package_entry_points_at_index(self) -> None:
        """package.json 必须指向 lib/index.js，且包名是 dsh-submodel。"""
        package = json.loads((MODULE_ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package.get("name"), "dsh-submodel")
        self.assertEqual(package.get("main"), "lib/index.js")
        self.assertTrue((MODULE_ROOT / "lib" / "index.js").is_file(), msg="lib/index.js must exist")

    def test_policy_module_is_pure_of_runtime_imports(self) -> None:
        """policy.js 不得 import 任何 runtime helper（保持可纯函数单测）。"""
        source = (PLUGIN_LIB / "policy.js").read_text(encoding="utf-8")
        import_pattern = re.compile(r"^\s*(import\s|import\(|export\s+.*\s+from\s+['\"])")
        for line in source.splitlines():
            if import_pattern.match(line):
                self.fail(f"policy.js must stay dependency-free, found: {line.strip()}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
