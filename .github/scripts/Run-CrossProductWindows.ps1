#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$env:NO_PROXY = 'portal-e2e.local,localhost,127.0.0.1'
$env:no_proxy = $env:NO_PROXY

$sourceRoot = Join-Path $env:RUNNER_TEMP 'sirk-portal-e2e-source'
$zipPath = Join-Path $env:RUNNER_TEMP 'sirk-portal-main.zip'
$publishRoot = Join-Path $env:RUNNER_TEMP 'sirk-portal-e2e-publish'

Remove-Item -LiteralPath $sourceRoot,$publishRoot -Recurse -Force -ErrorAction SilentlyContinue
Invoke-WebRequest `
    -UseBasicParsing `
    -Uri 'https://codeload.github.com/Eris92/SIRK-Portal/zip/refs/heads/main' `
    -OutFile $zipPath
Expand-Archive -LiteralPath $zipPath -DestinationPath $sourceRoot -Force

$portalRoot = Get-ChildItem -LiteralPath $sourceRoot -Directory | Select-Object -First 1
if (-not $portalRoot) { throw 'Downloaded Portal source is empty.' }
$project = Join-Path $portalRoot.FullName 'src\Sirk.Portal\Sirk.Portal.csproj'
if (-not (Test-Path -LiteralPath $project -PathType Leaf)) {
    throw "Portal project is missing: $project"
}

dotnet publish $project `
    --configuration Release `
    --runtime win-x64 `
    --self-contained false `
    --output $publishRoot `
    /p:DebugType=None `
    /p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { throw "Portal publish failed. ExitCode=$LASTEXITCODE" }

$portalDll = Join-Path $publishRoot 'Sirk.Portal.dll'
if (-not (Test-Path -LiteralPath $portalDll -PathType Leaf)) {
    throw 'Published Sirk.Portal.dll is missing.'
}

& "$PSScriptRoot\Test-GroupAgentInstallerE2E.ps1" -PortalDll $portalDll
