# scripts/release.ps1 —— 本地发行准备与发版门禁（实际公开发布由 GitHub Actions + npm Trusted Publishing/OIDC 完成）
#
# 用法（在任意目录执行；脚本自动定位仓库根）：
#   pwsh scripts/release.ps1 0.4.0
#       本地准备：只做预检、门禁、按 Git 原始 blob 打包并记录摘要；不改版本、不提交、不推送。
#   pwsh scripts/release.ps1 0.4.0 -ExpectedContentSha256 <64 位十六进制>
#       复核：与人工记录并审阅过的包内容摘要比对（发布前必须复核一次）。
#   pwsh scripts/release.ps1 0.4.0 -ExpectedContentSha256 <摘要> -Publish
#       明确发布指令：制作 v<版本> 注解 tag（注解含 pack-content-sha256:<摘要>），
#       只推公开仓 origin 的审定提交与该 tag；发布由 release 工作流在同一内容上执行。
#   pwsh scripts/release.ps1 0.4.0 -FromIndex
#       零提交暂存快照（计划 §7.1）：用 git write-tree 生成的暂存树做本地验收/试装候选，
#       不要求先提交；该模式只做本地准备，不能用 -Publish 发布（发布必须来自已审定提交）。
#
# 设计约束（统一版计划 §5/§7.1）：
#   - 不改 package.json 版本、不提交任何文件；版本在进入本脚本前已写入并随候选提交/暂存树审阅。
#   - 打包输入一律取自“核对过的 Git 树”的原始 blob（避免 Windows core.autocrlf 换行差异），
#     并在隔离临时目录里执行 npm pack；Git 操作与门禁命令逐一检查退出码。
#   - 隐私项只输出类别与公开路径，绝不打印命中的敏感值；脚本不读取、不保存任何 npm 令牌。
#   - 具体私有主机/词条不写死进脚本；需要时用环境变量 DSH_RELEASE_PRIVATE_PATTERNS
#     （逗号分隔字面值）从本机注入，内容不入库、不回显。
#   - 三项现有门禁与包门禁不可跳过；没有 SkipTests/TestMode 之类的绕过开关。
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version,
    [string]$ExpectedContentSha256,
    [switch]$Publish,
    [switch]$FromIndex,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# 高信号隐私模式（与 scripts/verify-package.mjs 保持同一口径；只报类别与路径，不打印命中值）。
# 只放通用判定（本机绝对路径、RFC1918 私网、常见凭据形态）；具体私有主机/词条绝不写死进
# 本脚本，需要时由运行环境用逗号分隔传入 DSH_RELEASE_PRIVATE_PATTERNS（字面词条）。
$PrivatePathPatterns = @(
    '(^|/)reference/',
    '(^|/)docs/plans/',
    '(^|/)tests/_scratch/',
    '(^|/)node_modules/',
    '(^|/)__pycache__/',
    '(^|/)\.env([^/]*)$',
    '\.pyc$',
    '\.bak-',
    '(^|/)HANDOFF\.md$'
)
# .NET 正则（用于解析待推提交补丁）
$HistoryPrivacyPatterns = [ordered]@{
    'local-absolute-path' = '[A-Za-z]:[/\\]Users[/\\]|/Users/[A-Za-z0-9._-]+/|/home/[a-z][a-z0-9._-]*/'
    'private-host'        = '\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b'
    'credential'          = 'sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|\bxox[baprs]-|Bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
}
# GNU grep ERE（用于扫描已核对 Git 树的全部文本文件；-l 只出文件名，不回显命中值）
$TreePrivacyPatterns = [ordered]@{
    'local-absolute-path' = '[A-Za-z]:[\\/]Users[\\/]|/Users/[A-Za-z0-9._-]+/|/home/[a-z][a-z0-9._-]*/'
    'private-host'        = '(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})'
    'credential'          = 'sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-|Bearer[[:space:]]+[A-Za-z0-9._-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
}
# 运行环境提供的私有词条（逗号分隔字面值；本变量内容不入库、不回显）。
$envPrivatePatterns = @()
if ($env:DSH_RELEASE_PRIVATE_PATTERNS) {
    $envPrivatePatterns = @($env:DSH_RELEASE_PRIVATE_PATTERNS -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
}

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text"
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
        [string]$WorkingDirectory,
        [switch]$AllowFailure
    )
    $stderrFile = [IO.Path]::GetTempFileName()
    try {
        if ($WorkingDirectory) { Push-Location -LiteralPath $WorkingDirectory }
        try {
            $stdout = & $FilePath @Arguments 2> $stderrFile
            $code = $LASTEXITCODE
        } finally {
            if ($WorkingDirectory) { Pop-Location }
        }
        $stderrText = ''
        if (Test-Path -LiteralPath $stderrFile) {
            $stderrText = [string](Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue)
        }
        $stdoutText = (@($stdout) | ForEach-Object { "$_" }) -join "`n"
        if ($code -ne 0 -and -not $AllowFailure) {
            $outTail = $stdoutText.Trim()
            if ($outTail.Length -gt 800) { $outTail = '…' + $outTail.Substring($outTail.Length - 800) }
            $errTail = $stderrText.Trim()
            if ($errTail.Length -gt 800) { $errTail = '…' + $errTail.Substring($errTail.Length - 800) }
            throw "命令失败（$Label，退出码 $code）`n$outTail`n$errTail"
        }
        return [pscustomobject]@{ ExitCode = $code; Stdout = $stdoutText; Stderr = $stderrText }
    } finally {
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    return Invoke-Native -Label "git $Label" -FilePath 'git' -Arguments $Arguments -AllowFailure:$AllowFailure
}

function Assert-Clean([string]$What) {
    if ($What.Trim().Length -gt 0) {
        throw "工作区不干净，请先提交或清空后再发版：`n$($What.Trim())"
    }
}

function Assert-OutDirOutsideRepo([string]$RepoRoot) {
    $resolved = [IO.Path]::GetFullPath($OutDir)
    $rootFull = [IO.Path]::GetFullPath($RepoRoot)
    if ($resolved -eq $rootFull -or $resolved.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar)) {
        throw "输出目录必须在仓库之外（计划要求在隔离目录打包）：$resolved"
    }
}

function Format-PrivateFindings($Findings) {
    $lines = @()
    foreach ($finding in $Findings) {
        $lines += "  - [$($finding.Category)] $($finding.Path)"
    }
    return ($lines -join "`n")
}

# ---------------- 0. 参数与环境 ----------------
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
    throw "版本号格式应为 x.y.z（可带预发布后缀），收到：$Version"
}
if ($ExpectedContentSha256) {
    if ($ExpectedContentSha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw '-ExpectedContentSha256 必须是 64 位十六进制摘要（可用本脚本首次本地准备输出）'
    }
    $ExpectedContentSha256 = $ExpectedContentSha256.ToLowerInvariant()
}
if ($Publish -and -not $ExpectedContentSha256) {
    throw '发布前必须传入 -ExpectedContentSha256（先做本地准备，人工复核摘要后再发布）'
}
if ($Publish -and $FromIndex) {
    throw '-FromIndex 的零提交暂存树只用于本地验收/试装；发布必须来自已审定提交（去掉 -FromIndex 并先提交）'
}
if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw '需要 PowerShell 7（pwsh）运行本脚本'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
    throw "脚本位置不在预期仓库结构中：$repoRoot"
}
Push-Location -LiteralPath $repoRoot
$workRoot = $null
try {
    Write-Host "本地发行准备：dsh-submodel v$Version（PowerShell $($PSVersionTable.PSVersion)；仅本机操作）"
    if ($Publish) {
        Write-Host '模式：明确发布指令（-Publish）：将创建注解 tag 并推送到公开仓 origin'
    } elseif ($FromIndex) {
        Write-Host '模式：零提交暂存快照（-FromIndex）：按 git write-tree 的暂存树做本地验收/试装候选，不发布'
    } else {
        Write-Host '模式：本地准备（默认）：不改版本、不提交、不打 tag、不推送'
    }

    # 本地候选来源：默认要求工作树干净并取 HEAD 提交树；-FromIndex 允许零提交，
    # 但暂存区必须与工作树一致且没有未跟踪文件，打包对象是 git write-tree 生成的树。
    $stagedTreeSha = $null
    $stagedChangedFiles = @()
    if ($FromIndex) {
        $unstaged = (Invoke-Git 'diff --name-only' @('diff', '--name-only')).Stdout.Trim()
        if ($unstaged) {
            throw "存在未暂存改动：暂存快照必须与工作树一致（先 git add 或还原）：`n$unstaged"
        }
        $untracked = (Invoke-Git 'ls-files --others --exclude-standard' @('ls-files', '--others', '--exclude-standard')).Stdout.Trim()
        if ($untracked) {
            throw "存在未跟踪文件：暂存快照必须完整（请 git add 或清理）：`n$untracked"
        }
        $stagedTreeSha = (Invoke-Git 'write-tree' @('write-tree')).Stdout.Trim()
        if ($stagedTreeSha -notmatch '^[0-9a-f]{40,64}$') {
            throw "git write-tree 未返回合法的暂存树对象：$stagedTreeSha"
        }
        $stagedDiff = (Invoke-Git 'diff --cached --name-only' @('diff', '--cached', '--name-only')).Stdout.Trim()
        if ($stagedDiff) {
            $stagedChangedFiles = @($stagedDiff -split "`n" | Where-Object { $_.Trim().Length -gt 0 })
            Write-Host "零提交暂存快照树：$stagedTreeSha"
            Write-Host '暂存改动文件（请逐一对照计划 §5 文件清单人工复核）：'
            foreach ($file in $stagedChangedFiles) { Write-Host "  $file" }
        } else {
            Write-Host "暂存区与 HEAD 相同，按暂存树 $stagedTreeSha 做本地准备"
        }
    } else {
        $statusText = (Invoke-Git 'status' @('status', '--porcelain')).Stdout.Trim()
        Assert-Clean $statusText
    }

    foreach ($requiredFile in @('package.json', 'CHANGELOG.md', 'scripts/verify-package.mjs', '.github/workflows/release.yml', '.github/workflows/ci.yml')) {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $requiredFile))) {
            throw "缺少脚本依赖文件：$requiredFile"
        }
    }

    # ---------------- 1. 已审阅版本与变更记录 ----------------
    Write-Step '核对已审阅的版本'
    $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
    if ($manifest.name -ne 'dsh-submodel') {
        throw "包名应为 dsh-submodel，实际为 $($manifest.name)"
    }
    if ([string]$manifest.version -ne $Version) {
        throw "package.json 版本是 $($manifest.version)，与已审阅的版本 $Version 不一致；本脚本不修改版本，请先提交正确版本"
    }
    $changelog = Get-Content -LiteralPath (Join-Path $repoRoot 'CHANGELOG.md') -Raw
    $changelogPattern = '(?m)^##\s+' + [regex]::Escape($Version) + '(?![0-9A-Za-z.-])'
    if ([regex]::Matches($changelog, $changelogPattern).Count -ne 1) {
        throw "CHANGELOG.md 必须恰好有一处 ## $Version 段"
    }
    Write-Host "版本 $Version 与 package.json、CHANGELOG.md 一致"

    Write-Step '记录本机工具链版本（CI 发版固定 Node 24 / Python 3.12）'
    $nodeVersion = ((Invoke-Native -Label 'node --version' -FilePath 'node' -Arguments @('--version')).Stdout).Trim()
    $npmVersion = ((Invoke-Native -Label 'npm --version' -FilePath 'npm' -Arguments @('--version')).Stdout).Trim()
    $pythonVersion = ((Invoke-Native -Label 'python --version' -FilePath 'python' -Arguments @('--version')).Stdout).Trim()
    $gitVersion = ((Invoke-Git 'version' @('--version')).Stdout).Trim()
    Write-Host "本机：node $nodeVersion；npm $npmVersion；$pythonVersion；$gitVersion"
    if ($nodeVersion -notmatch '^v24\.') {
        Write-Warning "本机 Node 为 $nodeVersion，CI 发版固定 Node 24；门禁结论以 Node 24 的 CI 为准"
    }

    # ---------------- 2. 公开仓、工作区与待推历史 ----------------
    Write-Step '核对 origin 与待推历史'
    $originChecks = @(
        @{ Label = 'configured origin'; Args = @('config', '--get-all', 'remote.origin.url') },
        @{ Label = 'effective fetch origin'; Args = @('remote', 'get-url', '--all', 'origin') },
        @{ Label = 'effective push origin'; Args = @('remote', 'get-url', '--push', '--all', 'origin') }
    )
    function Assert-PublicOrigin {
        foreach ($check in $originChecks) {
            $answer = Invoke-Git $check.Label $check.Args -AllowFailure
            $routes = @($answer.Stdout -split "`n" | Where-Object { $_.Trim() })
            $publicOrigin = '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)angel291592/dsh-submodel(?:\.git)?/?$'
            if ($answer.ExitCode -ne 0 -or $routes.Count -ne 1 -or $routes[0] -cnotmatch $publicOrigin) {
                throw "发布远端检查失败（$($check.Label)），需要唯一的公开仓 origin。"
            }
        }
    }
    Assert-PublicOrigin
    $null = Invoke-Git 'fetch origin main --tags' @('fetch', 'origin', 'main', '--tags')
    Write-Host 'origin：github.com/angel291592/dsh-submodel'

    $branch = (Invoke-Git 'branch --show-current' @('branch', '--show-current')).Stdout.Trim()
    $headSha = (Invoke-Git 'rev-parse HEAD' @('rev-parse', 'HEAD')).Stdout.Trim()
    if ($Publish -and $branch -ne 'main') {
        throw "发版必须在 main 分支执行（当前：$(if ($branch) { $branch } else { 'detached HEAD' })）"
    }
    if (-not $Publish -and $branch -ne 'main') {
        Write-Warning "当前不在 main 分支（$(if ($branch) { $branch } else { 'detached HEAD' })）：可在隔离工作树做候选准备，但 -Publish 会被拒绝"
    }
    $originMainSha = (Invoke-Git 'rev-parse origin/main' @('rev-parse', 'origin/main')).Stdout.Trim()
    $ancestor = Invoke-Git 'merge-base --is-ancestor origin/main HEAD' @('merge-base', '--is-ancestor', 'origin/main', 'HEAD') -AllowFailure
    if ($ancestor.ExitCode -ne 0) {
        throw 'HEAD 不在 origin/main 之后（分叉或未基于最新 main）：先 fetch/合并后再发版'
    }
    $contentRev = if ($FromIndex) { $stagedTreeSha } else { $headSha }
    Write-Host "HEAD $headSha；origin/main $originMainSha；候选内容树：$contentRev"

    $pendingLog = (Invoke-Git 'log origin/main..HEAD' @('log', '--oneline', 'origin/main..HEAD')).Stdout.Trim()
    if ($pendingLog) {
        Write-Host '待推提交：'
        $pendingLog -split "`n" | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Host '没有待推提交（main 已推送，本次只处理 tag/或不推送）'
    }
    $changedFiles = (Invoke-Git 'diff --name-only origin/main..HEAD' @('diff', '--name-only', 'origin/main..HEAD')).Stdout.Trim()
    if ($changedFiles) {
        Write-Host '待推改动文件（请逐一对照计划 §5 文件清单人工复核）：'
        $changedFiles -split "`n" | ForEach-Object { Write-Host "  $_" }
    }

    # ---------------- 3. 私密检查：路径与内容 ----------------
    Write-Step '私密检查（路径与内容，只报告类别与公开路径）'
    $privateFindings = @()
    # 路径检查以候选内容树为准（提交树或零提交暂存树），另看待推/暂存改动清单。
    $trackedFiles = (Invoke-Git 'ls-tree -r --name-only' @('ls-tree', '-r', '--name-only', $contentRev)).Stdout -split "`n" | Where-Object { $_.Trim().Length -gt 0 }
    foreach ($file in $trackedFiles) {
        foreach ($pattern in $PrivatePathPatterns) {
            if ([regex]::IsMatch($file, $pattern)) {
                $privateFindings += [pscustomobject]@{ Category = 'private-path(tree)'; Path = $file }
            }
        }
    }
    $reviewChangedFiles = @()
    if ($changedFiles) { $reviewChangedFiles += @($changedFiles -split "`n" | Where-Object { $_.Trim().Length -gt 0 }) }
    if ($FromIndex -and $stagedChangedFiles.Count -gt 0) { $reviewChangedFiles += $stagedChangedFiles }
    foreach ($file in $reviewChangedFiles) {
        foreach ($pattern in $PrivatePathPatterns) {
            if ([regex]::IsMatch($file, $pattern)) {
                $privateFindings += [pscustomobject]@{ Category = 'private-path(changed)'; Path = $file }
            }
        }
    }

    foreach ($category in $TreePrivacyPatterns.Keys) {
        $grep = Invoke-Git "grep $category" @('grep', '-I', '-l', '-E', $TreePrivacyPatterns[$category], $contentRev, '--', '.') -AllowFailure
        if ($grep.ExitCode -gt 1) {
            throw "git grep 执行失败（$category，退出码 $($grep.ExitCode)）：$($grep.Stderr.Trim())"
        }
        if ($grep.ExitCode -eq 0) {
            foreach ($file in ($grep.Stdout -split "`n" | Where-Object { $_.Trim().Length -gt 0 })) {
                $privateFindings += [pscustomobject]@{ Category = "privacy:$category(tree)"; Path = $file }
            }
        }
    }

    # 运行环境提供的私有词条（不写死进脚本）：对候选内容树与待推补丁都做字面包含匹配。
    if ($envPrivatePatterns.Count -gt 0) {
        $envGrepArgs = @('grep', '-I', '-l', '-F')
        foreach ($literal in $envPrivatePatterns) { $envGrepArgs += @('-e', $literal) }
        $envGrepArgs += @($contentRev, '--', '.')
        $envGrep = Invoke-Git 'grep env-private' $envGrepArgs -AllowFailure
        if ($envGrep.ExitCode -gt 1) {
            throw "git grep 执行失败（env-private，退出码 $($envGrep.ExitCode)）"
        }
        if ($envGrep.ExitCode -eq 0) {
            foreach ($file in ($envGrep.Stdout -split "`n" | Where-Object { $_.Trim().Length -gt 0 })) {
                $privateFindings += [pscustomobject]@{ Category = 'privacy:env-private(tree)'; Path = $file }
            }
        }
        Write-Host "已应用运行环境提供的 $($envPrivatePatterns.Count) 条私有词条（内容不入库、不回显）"
    }

    # 待推提交补丁：加入或删除过的私有内容都要处理（只记录类别/提交/路径，不回显命中值）。
    $historyLog = (Invoke-Git 'log origin/main..HEAD -p' @('log', '--no-color', '--format=commit %H', '-p', 'origin/main..HEAD')).Stdout
    if ($historyLog.Trim().Length -gt 0) {
        $currentCommit = ''
        $currentPath = ''
        $historyFindings = @{}
        foreach ($line in ($historyLog -split "`n")) {
            if ($line -match '^commit ([0-9a-f]{7,64})$') {
                $currentCommit = $Matches[1]
                $currentPath = ''
                continue
            }
            if ($line -match '^\+\+\+ b/(.+)$') { $currentPath = $Matches[1]; continue }
            if ($line -match '^--- a/(.+)$') { $currentPath = $Matches[1]; continue }
            if ($line -match '^(\+\+\+|---) ' ) { continue }
            if ($line -notmatch '^[+-]') { continue }
            $matchedCategory = $null
            foreach ($category in $HistoryPrivacyPatterns.Keys) {
                if ([regex]::IsMatch($line, $HistoryPrivacyPatterns[$category])) { $matchedCategory = $category; break }
            }
            if (-not $matchedCategory -and $envPrivatePatterns.Count -gt 0) {
                foreach ($literal in $envPrivatePatterns) {
                    if ([regex]::IsMatch($line, [regex]::Escape($literal))) { $matchedCategory = 'env-private'; break }
                }
            }
            if ($matchedCategory) {
                $shortCommit = $currentCommit.Substring(0, [Math]::Min(7, $currentCommit.Length))
                $key = "$matchedCategory|$shortCommit|$currentPath"
                if (-not $historyFindings.ContainsKey($key)) {
                    $historyFindings[$key] = [pscustomobject]@{ Category = "privacy:$matchedCategory(history)"; Path = "$currentPath @ $shortCommit" }
                }
            }
        }
        foreach ($finding in $historyFindings.Values) { $privateFindings += $finding }
    }

    if ($privateFindings.Count -gt 0) {
        throw "私密检查失败：待发布树/历史命中私有路径或敏感内容（不打印命中值，请人工复核）：`n$(Format-PrivateFindings $privateFindings)"
    }
    Write-Host '私密检查通过：未命中私有路径、本机绝对路径、内网主机或凭据模式'

    # ---------------- 4. 现有三项门禁（不可跳过） ----------------
    Write-Step '现有门禁 1/3：fixture'
    $fixtureGate = Invoke-Native -Label 'node tests/unit/flash-routing-fixture.mjs ./lib' -FilePath 'node' -Arguments @('tests/unit/flash-routing-fixture.mjs', './lib')
    if ($fixtureGate.Stdout.Trim().Length -gt 0) { Write-Host $fixtureGate.Stdout.Trim() }
    Write-Step '现有门禁 2/3：public profile smoke'
    $smokeGate = Invoke-Native -Label 'node tests/unit/public-profile-smoke.mjs' -FilePath 'node' -Arguments @('tests/unit/public-profile-smoke.mjs')
    if ($smokeGate.Stdout.Trim().Length -gt 0) { Write-Host $smokeGate.Stdout.Trim() }
    Write-Step '现有门禁 3/3：Python 常驻测试'
    $pythonGate = Invoke-Native -Label 'python -m unittest discover' -FilePath 'python' -Arguments @('-m', 'unittest', 'discover', '-s', 'tests/unit', '-v')
    if ($pythonGate.Stdout.Trim().Length -gt 0) { Write-Host $pythonGate.Stdout.Trim() }
    Write-Host '三项现有门禁全部通过'

    # ---------------- 5. 按 Git 原始 blob 打包并核对摘要 ----------------
    Write-Step '按已核对 Git 树的原始 blob 在隔离目录打包'
    $workRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-submodel-release-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workRoot | Out-Null
    $packSrc = Join-Path $workRoot 'src'
    $distDir = Join-Path $workRoot 'dist'
    New-Item -ItemType Directory -Path $distDir | Out-Null

    $materialize = Invoke-Native -Label 'verify-package --materialize' -FilePath 'node' -Arguments @('scripts/verify-package.mjs', '--materialize', $packSrc, '--rev', $contentRev, '--json')
    $materialized = $materialize.Stdout.Trim() | ConvertFrom-Json
    if (-not $materialized.ok) {
        throw "Git 树物化失败：$($materialize.Stdout.Trim())"
    }
    if ($materialized.contentSha256 -notmatch '^[0-9a-f]{64}$') {
        throw '物化结果缺少合法的内容摘要'
    }
    Write-Host "打包输入：$($materialized.fileCount) 个文件，来自 Git 树 $($materialized.tree)"

    $dryRun = Invoke-Native -Label 'npm pack --dry-run' -FilePath 'npm' -Arguments @('pack', '--ignore-scripts', '--dry-run', '--json') -WorkingDirectory $packSrc
    $dryRunJson = $dryRun.Stdout.Trim() | ConvertFrom-Json
    if (-not $dryRunJson -or -not $dryRunJson[0].files) {
        throw 'npm pack --dry-run 未返回文件清单'
    }
    $dryRunPaths = @($dryRunJson[0].files | ForEach-Object { $_.path } | Sort-Object)
    $materializedPaths = @($materialized.files | ForEach-Object { $_.path } | Sort-Object)
    $dryRunDiff = Compare-Object -ReferenceObject $materializedPaths -DifferenceObject $dryRunPaths
    if ($dryRunDiff) {
        throw "npm pack --dry-run 清单与已核对 Git 树不一致：`n$($dryRunDiff | ForEach-Object { "  $($_.SideIndicator) $($_.InputObject)" } | Out-String)"
    }
    Write-Host "npm pack --dry-run 清单与 Git 树一致（$($dryRunPaths.Count) 个文件），无生命周期脚本（--ignore-scripts）"

    $pack = Invoke-Native -Label 'npm pack' -FilePath 'npm' -Arguments @('pack', '--ignore-scripts', '--json', '--pack-destination', $distDir) -WorkingDirectory $packSrc
    $packJson = $pack.Stdout.Trim() | ConvertFrom-Json
    if (-not $packJson -or -not $packJson[0].filename) {
        throw 'npm pack 未返回 tarball 文件名'
    }
    $tgzPath = Join-Path $distDir $packJson[0].filename
    if (-not (Test-Path -LiteralPath $tgzPath)) {
        throw "npm pack 未产出 tarball：$tgzPath"
    }

    Write-Step '核对实际 tarball 与 Git 树是同一内容'
    $verify = Invoke-Native -Label 'verify-package tarball' -FilePath 'node' -Arguments @('scripts/verify-package.mjs', $tgzPath, '--json')
    $verified = $verify.Stdout.Trim() | ConvertFrom-Json
    if (-not $verified.ok) {
        throw "包门禁失败：$($verify.Stdout.Trim())"
    }
    if ($verified.contentSha256 -ne $materialized.contentSha256) {
        throw "实际 tarball 与 Git 树内容不一致：tarball $($verified.contentSha256)，Git 树 $($materialized.contentSha256)"
    }
    $contentSha = $verified.contentSha256
    $tarballSha = $verified.tarballSha256
    Write-Host "tarball：$tgzPath"
    Write-Host "pack-content-sha256: $contentSha"
    Write-Host "tarball-sha256: $tarballSha"

    if ($ExpectedContentSha256) {
        if ($contentSha -ne $ExpectedContentSha256) {
            throw "内容摘要与已审阅期望不一致：期望 $ExpectedContentSha256，实际 $contentSha（候选内容已变化，需重新审阅）"
        }
        Write-Host '内容摘要与已审阅期望一致'
    } else {
        Write-Warning '未传入 -ExpectedContentSha256：请记录上面的 pack-content-sha256 供人工审阅，再用该值重跑；不带期望值不会推送或打 tag'
    }

    $annotation = "dsh-submodel v$Version`n`npack-content-sha256:$contentSha`ntarball-sha256:$tarballSha"

    # ---------------- 6. 保存产物与摘要记录（仓库外） ----------------
    if (-not $OutDir) {
        $outLeaf = if ($FromIndex) { $Version + '-staged' } else { $Version }
        $OutDir = Join-Path ([IO.Path]::GetTempPath()) ('dsh-submodel-release\' + $outLeaf)
    }
    Assert-OutDirOutsideRepo $repoRoot
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $finalTgz = Join-Path $OutDir $packJson[0].filename
    Copy-Item -LiteralPath $tgzPath -Destination $finalTgz -Force
    $sourceLine = if ($FromIndex) {
        "candidate-source: staged-tree $($materialized.tree) (zero-commit)"
    } else {
        "candidate-source: head-commit $headSha"
    }
    $summaryLines = @()
    $summaryLines += "dsh-submodel v$Version"
    $summaryLines += $sourceLine
    $summaryLines += "pack-content-sha256: $contentSha"
    $summaryLines += "tarball-sha256: $tarballSha"
    $summaryLines += "files: $($verified.fileCount)"
    foreach ($file in $verified.files) {
        $summaryLines += "  $($file.path)  $($file.bytes) 字节  $($file.sha256)"
    }
    $summaryPath = Join-Path $OutDir 'release-summary.txt'
    Set-Content -LiteralPath $summaryPath -Value ($summaryLines -join "`n") -Encoding utf8
    Write-Host "候选 tarball：$finalTgz"
    Write-Host "摘要记录：$summaryPath"

    # ---------------- 7. 明确发布指令：注解 tag + 只推 origin ----------------
    if ($Publish) {
        Write-Step '发布：制作注解 tag 并只推公开仓 origin'
        if (-not $ExpectedContentSha256) {
            throw '发布前必须传入 -ExpectedContentSha256'
        }
        $tag = "v$Version"
        try {
            $npmVersionStatus = (Invoke-WebRequest -Uri "https://registry.npmjs.org/dsh-submodel/$Version" `
                -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 20 -ErrorAction Stop).StatusCode
        } catch {
            throw '无法核实 npm 发布目标是否可用，未打标签或推送。'
        }
        if ($npmVersionStatus -ne 404) {
            throw "npm 版本已存在或状态无法确认（HTTP $npmVersionStatus），未打标签或推送。"
        }
        $localTag = Invoke-Git "rev-parse tag $tag" @('rev-parse', '-q', '--verify', "refs/tags/$tag") -AllowFailure
        if ($localTag.ExitCode -eq 0) {
            throw "本地已存在 tag $tag，不覆盖旧 tag；如为上次失败残留，请人工确认后 git tag -d $tag"
        }
        $remoteTag = Invoke-Git "ls-remote tag $tag" @('ls-remote', '--tags', 'origin', "refs/tags/$tag")
        if ($remoteTag.Stdout.Trim().Length -gt 0) {
            throw "远端已存在 tag $tag，不覆盖旧 tag"
        }

        # Recheck both resolved URLs and the pinned review baseline before changing refs.
        Assert-PublicOrigin
        $null = Invoke-Git 'fetch origin main' @('fetch', 'origin', 'main')
        $originMainAfter = (Invoke-Git 'rev-parse origin/main' @('rev-parse', 'origin/main')).Stdout.Trim()
        $headAfter = (Invoke-Git 'rev-parse HEAD' @('rev-parse', 'HEAD')).Stdout.Trim()
        $branchAfter = (Invoke-Git 'branch --show-current' @('branch', '--show-current')).Stdout.Trim()
        if ($originMainAfter -ne $originMainSha -or $headAfter -ne $headSha -or $branchAfter -ne 'main') {
            throw '本地或远端 main 在验证期间变化：重新审阅后再发布。'
        }
        Assert-Clean (Invoke-Git 'status' @('status', '--porcelain')).Stdout.Trim()

        $tagRef = "refs/tags/$tag"
        $null = Invoke-Git "tag -a $tag" @('tag', '-a', $tag, '-m', $annotation, $headSha)
        $tagContents = (Invoke-Git "for-each-ref tag $tag" @('for-each-ref', $tagRef, '--format=%(contents)')).Stdout
        $tagObject = (Invoke-Git 'resolve annotated tag' @('rev-parse', '--verify', "$tagRef^{tag}")).Stdout.Trim()
        $tagCommit = (Invoke-Git 'resolve tag commit' @('rev-parse', '--verify', "$tagObject^{commit}")).Stdout.Trim()
        if (-not $tagContents.Contains("pack-content-sha256:$contentSha") -or $tagCommit -ne $headSha) {
            throw "tag $tag 与核对的提交或包摘要不一致，停止发布"
        }
        Write-Host "已创建注解 tag $tag（含 pack-content-sha256:$contentSha）"

        Assert-PublicOrigin
        $null = Invoke-Git 'push origin reviewed main and tag' @('push', '--atomic', '--no-follow-tags', 'origin', "${headSha}:refs/heads/main", "${tagObject}:$tagRef")
        Write-Host "已推送 main 与 tag $tag；release 工作流将固定该 tag 提交、重新打包比对摘要后发布"
        Write-Host '后续：在 GitHub Actions 查看 release 工作流；发布成功后 CI 会从 registry 复核同一内容摘要并同步 GitHub Release'
    } else {
        Write-Step '本地准备完成'
        if ($FromIndex) {
            Write-Host "候选来自零提交暂存树 $($materialized.tree)（pack-content-sha256: $contentSha）。"
            Write-Host '该候选可用于隔离环境试装/验收；发布必须去掉 -FromIndex 并先把同一内容提交、审阅后再发。'
            Write-Host '未打 tag、未推送。'
        } else {
            Write-Host '未打 tag、未推送。人工复核摘要与文件清单后，用 -ExpectedContentSha256 重跑，再加 -Publish 执行发布。'
            Write-Host "建议的 tag 注解：`n$annotation"
        }
    }
} finally {
    Pop-Location
    if ($workRoot -and (Test-Path -LiteralPath $workRoot)) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
