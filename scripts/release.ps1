# scripts/release.ps1 —— 本机一键发版（实际发布由 GitHub Actions + npm Trusted Publishing/OIDC 完成）
#
# 用法（在仓库根或任意目录）：
#   pwsh scripts/release.ps1 0.2.1
#
# 做四件事：
#   1) 校验：工作区干净、在 main 分支、CHANGELOG 已有该版本段、版本号格式正确且是新版本；
#   2) 跑门禁：fixture / smoke / Python 常驻测试（失败即停，不提交）；
#   3) 改 package.json 版本 → 提交 → 打 tag → push main 与 tag；
#   4) 等 GitHub Actions 的 release 工作流发布完成，轮询 npm 版本号确认，并尽量创建 GitHub Release。
#
# 本脚本不保存、不读取任何 npm 令牌：发布凭据由 GitHub Actions 的 OIDC 现场换取。
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [switch]$SkipTests,
    [int]$TimeoutMinutes = 20
)

$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
    throw "版本号格式应为 x.y.z（可带预发布后缀），收到：$Version"
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    # ① 前置校验
    if (-not (Test-Path '.github/workflows/release.yml')) {
        throw '缺少 .github/workflows/release.yml：请先完成 OIDC 自动发布接入'
    }
    $dirty = git status --porcelain
    if ($dirty) {
        throw "工作区不干净，请先提交或清空后再发版：`n$dirty"
    }
    $branch = (git branch --show-current).Trim()
    if ($branch -ne 'main') {
        throw "当前分支是 $branch，发版必须在 main 上执行"
    }
    $current = (Get-Content package.json -Raw | ConvertFrom-Json).version
    if ($current -eq $Version) {
        throw "package.json 版本已经是 $Version"
    }
    if (-not (Select-String -Path CHANGELOG.md -Pattern ('^## ' + [regex]::Escape($Version)) -Quiet)) {
        throw "CHANGELOG.md 缺少 `## $Version` 段，请先补好变更记录再发版"
    }

    # ② 本地门禁（与 CI 同一组命令）
    if (-not $SkipTests) {
        Write-Host '运行门禁：fixture…'
        node tests/unit/flash-routing-fixture.mjs ./lib
        if ($LASTEXITCODE -ne 0) { throw 'fixture 门禁失败' }
        Write-Host '运行门禁：smoke…'
        node tests/unit/public-profile-smoke.mjs
        if ($LASTEXITCODE -ne 0) { throw 'smoke 门禁失败' }
        Write-Host '运行门禁：Python 常驻测试…'
        python -m unittest discover -s tests/unit -v
        if ($LASTEXITCODE -ne 0) { throw 'Python 门禁失败' }
    }

    # ③ 改版本（package.json 是唯一版本源，README/CHANGELOG 由人维护）
    $json = Get-Content package.json -Raw
    $next = $json -replace '"version":\s*"[^"]+"', ('"version": "' + $Version + '"')
    Set-Content -Path package.json -Value $next -NoNewline -Encoding utf8
    node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
    if ($LASTEXITCODE -ne 0) { throw '改版本后 package.json 解析失败' }

    git add package.json
    git commit -m ("chore(release): v" + $Version)
    git tag ("v" + $Version)
    git push origin main
    git push origin ("v" + $Version)

    # ④ 等云端发布（npm Trusted Publishing/OIDC），并验证 npm 上的版本
    Write-Host "已推送 v$Version，等待 GitHub Actions 发布（最长 $TimeoutMinutes 分钟）…"
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $published = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 15
        try { $published = ((npm view dsh-submodel version 2>$null) | Out-String).Trim() } catch { $published = $null }
        if ($published -eq $Version) { break }
    }
    if ($published -ne $Version) {
        throw "超时未见 npm 上的 $Version（当前：$published）。请检查 GitHub Actions 的 release 工作流日志"
    }
    Write-Host "npm 已发布 dsh-submodel@$Version"

    # ⑤ 尽量创建 GitHub Release（失败只提示，不影响发布结果）
    try {
        $lines = Get-Content CHANGELOG.md
        $start = -1
        $end = $lines.Count
        for ($i = 0; $i -lt $lines.Count; $i += 1) {
            if ($lines[$i] -match ('^## ' + [regex]::Escape($Version))) { $start = $i; continue }
            if ($start -ge 0 -and $i -gt $start -and $lines[$i] -match '^## ') { $end = $i; break }
        }
        if ($start -ge 0) {
            $notesPath = Join-Path $env:TEMP ("release-notes-" + $Version + ".md")
            ($lines[($start + 1)..([Math]::Max($start + 1, $end - 1))] -join "`n") | Set-Content -Path $notesPath -Encoding utf8
            gh release create ("v" + $Version) --title ("v" + $Version) --notes-file $notesPath
            Write-Host "已创建 GitHub Release v$Version"
        }
    } catch {
        Write-Warning "npm 已发布，但 GitHub Release 创建失败（可稍后手动补）：$($_.Exception.Message)"
    }
} finally {
    Pop-Location
}
