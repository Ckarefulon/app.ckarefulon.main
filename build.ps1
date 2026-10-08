# Ckarefulon 安卓壳 一键构建（Windows PowerShell）
#   .\build.ps1            构建 release APK
#   .\build.ps1 -Mode debug
#   .\build.ps1 -Mode bundle     只构建 OTA 资源包
#   .\build.ps1 -Mode all        APK + OTA 资源包
param(
  [ValidateSet('release', 'debug', 'bundle', 'all')]
  [string]$Mode = 'release'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "== 环境检查 ==" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "缺少 Node.js（需要 22+），请安装 https://nodejs.org" }
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 22) { throw "Node 版本过低（当前 $(node -v)，需要 22+）" }
Write-Host "node $(node -v)"

if (-not $env:JAVA_HOME) {
  foreach ($g in @("$env:ProgramFiles\Eclipse Adoptium\jdk-21*", "$env:ProgramFiles\Java\jdk-21*", "$env:ProgramFiles\Android\Android Studio\jbr")) {
    $hit = Get-Item $g -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit -and (Test-Path (Join-Path $hit.FullName 'bin\java.exe'))) { $env:JAVA_HOME = $hit.FullName; break }
  }
}
if (-not $env:JAVA_HOME) { throw "缺少 JDK 21：请安装 Temurin JDK 21 并设置 JAVA_HOME" }
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
Write-Host "java $(& java -version 2>&1 | Select-Object -First 1)"

if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
  foreach ($g in @("$env:LOCALAPPDATA\Android\Sdk", "$env:USERPROFILE\Android\Sdk", "C:\Android\sdk")) {
    if (Test-Path $g) { $env:ANDROID_HOME = $g; break }
  }
}
if (-not $env:ANDROID_HOME) { throw "缺少 Android SDK：请安装 Android Studio（或 cmdline-tools）并设置 ANDROID_HOME" }
$env:ANDROID_SDK_ROOT = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $env:ANDROID_HOME }
Write-Host "sdk  $env:ANDROID_HOME"

Write-Host "== 依赖 ==" -ForegroundColor Cyan
if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund }

switch ($Mode) {
  'bundle' { npm run ota:bundle }
  'debug'  { npm run android:sync; npm run android:patch; npm run apk:debug; npm run verify }
  'all'    { npm run android:sync; npm run android:patch; npm run apk; npm run verify; npm run ota:bundle }
  default  { npm run android:sync; npm run android:patch; npm run apk; npm run verify }
}

Write-Host "`n完成。产物在 dist\ 目录：" -ForegroundColor Green
Get-ChildItem dist\*.apk, dist\ota\*.zip -ErrorAction SilentlyContinue | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } }
