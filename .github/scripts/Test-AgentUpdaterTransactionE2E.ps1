#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$BaseUrl,
    [Parameter(Mandatory)][object]$PortalSession,
    [Parameter(Mandatory)][string]$GroupId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$centralRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$agentInstallRoot = 'C:\Program Files\SIRK\Agent'
$agentDataRoot = 'C:\ProgramData\SIRK\Agent'
$agentCli = Join-Path $agentInstallRoot 'sirkctl.exe'
$trustedKeys = Join-Path $agentInstallRoot 'release-trusted-keys.json'
$updaterCli = 'C:\Program Files\SIRK\Updater\SirkUpdater.exe'
$updaterManifestPath = 'C:\ProgramData\SIRK\Updater\applications\sirk-agent.json'
$maintenanceLock = Join-Path $agentDataRoot 'maintenance.lock'
$exportRoot = Join-Path $Root 'central-cache-export'

function Assert-ServiceHealthy {
    foreach ($serviceName in @('SirkAgent','SirkAgentWatchdog','SirkUpdater')) {
        $service = Get-Service -Name $serviceName -ErrorAction Stop
        if ($service.Status -ne 'Running' -or $service.StartType -ne 'Automatic') {
            throw "Invalid service state after update transaction for ${serviceName}: $($service.Status) / $($service.StartType)"
        }
    }
    if (Test-Path -LiteralPath $maintenanceLock -PathType Leaf) {
        throw "Updater left maintenance lock behind: $maintenanceLock"
    }
}

function Wait-AgentOnline {
    param([int]$TimeoutSeconds = 90)
    & $agentCli sync | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Agent sync failed after updater transaction.' }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $snapshot = Invoke-RestMethod -Uri ($BaseUrl + '/api/v1/admin/computer-groups') -WebSession $PortalSession -TimeoutSec 15
            $device = @($snapshot.value.devices | Where-Object {
                $_.groupId -eq $GroupId -and $_.online -eq $true
            } | Select-Object -First 1)
            if ($device) { return }
        }
        catch {}
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'Agent did not return online after updater transaction.'
}

function Invoke-Updater {
    param(
        [Parameter(Mandatory)][string]$PackagePath,
        [Parameter(Mandatory)][string]$Sha256,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][int]$ExpectedExitCode,
        [Parameter(Mandatory)][string]$Label
    )
    $stdout = Join-Path $Root ("updater-$Label.stdout.log")
    $stderr = Join-Path $Root ("updater-$Label.stderr.log")
    $previousTimeout = $env:SIRK_UPDATER_HEALTH_TIMEOUT_SECONDS
    $env:SIRK_UPDATER_HEALTH_TIMEOUT_SECONDS = '5'
    try {
        $arguments = 'update sirk-agent "{0}" {1} {2}' -f $PackagePath,$Sha256,$Version
        $process = Start-Process -FilePath $updaterCli `
            -ArgumentList $arguments `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -Wait `
            -PassThru
    }
    finally {
        $env:SIRK_UPDATER_HEALTH_TIMEOUT_SECONDS = $previousTimeout
    }
    $outText = [string](Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue)
    $errText = [string](Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue)
    if ($outText) { Write-Host $outText }
    if ($errText) { Write-Host $errText }
    if ($process.ExitCode -ne $ExpectedExitCode) {
        throw "SIRK Updater $Label transaction returned ExitCode=$($process.ExitCode), expected $ExpectedExitCode."
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $outText; StdErr = $errText }
}

function Export-VerifiedAgentRelease {
    if ([string]::IsNullOrWhiteSpace($env:SIRK_REAL_RELEASE_GITHUB_TOKEN)) {
        throw 'Central-cache executor E2E requires the GitHub read token supplied to the Central job.'
    }
    if (-not (Test-Path -LiteralPath $trustedKeys -PathType Leaf)) {
        throw "Installed Agent production trust keyring is missing: $trustedKeys"
    }
    Remove-Item -LiteralPath $exportRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $exportRoot -Force | Out-Null

    $previous = @{
        E2E = $env:SIRK_REAL_RELEASE_E2E
        Keys = $env:SIRK_REAL_RELEASE_TRUSTED_KEYS
        Export = $env:SIRK_REAL_RELEASE_EXPORT_DIR
        App = $env:SIRK_REAL_RELEASE_EXPORT_APPLICATION_ID
        Runtime = $env:SIRK_REAL_RELEASE_EXPORT_RUNTIME
        Channel = $env:SIRK_REAL_RELEASE_EXPORT_CHANNEL
    }
    try {
        $env:SIRK_REAL_RELEASE_E2E = '1'
        $env:SIRK_REAL_RELEASE_TRUSTED_KEYS = $trustedKeys
        $env:SIRK_REAL_RELEASE_EXPORT_DIR = $exportRoot
        $env:SIRK_REAL_RELEASE_EXPORT_APPLICATION_ID = 'sirk-agent'
        $env:SIRK_REAL_RELEASE_EXPORT_RUNTIME = 'win-x64'
        $env:SIRK_REAL_RELEASE_EXPORT_CHANNEL = 'preview'
        dotnet run `
            --project (Join-Path $centralRoot 'tests\Sirk.Central.UpdateTests\Sirk.Central.UpdateTests.csproj') `
            --configuration Release | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "Central PlatformUpdateCache export failed. ExitCode=$LASTEXITCODE"
        }
    }
    finally {
        $env:SIRK_REAL_RELEASE_E2E = $previous.E2E
        $env:SIRK_REAL_RELEASE_TRUSTED_KEYS = $previous.Keys
        $env:SIRK_REAL_RELEASE_EXPORT_DIR = $previous.Export
        $env:SIRK_REAL_RELEASE_EXPORT_APPLICATION_ID = $previous.App
        $env:SIRK_REAL_RELEASE_EXPORT_RUNTIME = $previous.Runtime
        $env:SIRK_REAL_RELEASE_EXPORT_CHANNEL = $previous.Channel
    }

    $metadataPath = Join-Path $exportRoot 'release.json'
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        throw 'Central PlatformUpdateCache did not export release metadata.'
    }
    $release = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in @('applicationId','version','runtime','channel','sha256','size','packagePath')) {
        if (-not $release.PSObject.Properties[$property]) {
            throw "Central cache export metadata is missing property: $property"
        }
    }
    if ($release.applicationId -ne 'sirk-agent' -or $release.runtime -ne 'win-x64' -or $release.channel -ne 'preview') {
        throw 'Exported Central cache release scope is invalid.'
    }
    if ([string]$release.version -notmatch '^0\.1\.1\.\d+$' -or [version]$release.version -lt [version]'0.1.1.37') {
        throw "Exported Agent release is outside the accepted baseline: $($release.version)"
    }
    if ([string]$release.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'Exported Agent SHA256 is invalid.'
    }
    if (-not (Test-Path -LiteralPath ([string]$release.packagePath) -PathType Leaf)) {
        throw "Exported Central cache package is missing: $($release.packagePath)"
    }
    $actualSize = (Get-Item -LiteralPath ([string]$release.packagePath)).Length
    if ($actualSize -ne [int64]$release.size) {
        throw "Exported Central cache package size mismatch: $actualSize != $($release.size)"
    }
    return $release
}

function Start-SentinelHealthServer {
    param([Parameter(Mandatory)][string]$SentinelPath)
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $port = ([Net.IPEndPoint]$probe.LocalEndpoint).Port
    $probe.Stop()

    $stopFile = Join-Path $Root 'rollback-health.stop'
    $scriptPath = Join-Path $Root 'rollback-health.ps1'
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    $sentinelLiteral = $SentinelPath.Replace("'", "''")
    $stopLiteral = $stopFile.Replace("'", "''")
    $script = @"
`$ErrorActionPreference = 'Stop'
`$sentinel = '$sentinelLiteral'
`$stop = '$stopLiteral'
`$listener = [Net.HttpListener]::new()
`$listener.Prefixes.Add('http://127.0.0.1:$port/')
`$listener.Start()
try {
    while (-not (Test-Path -LiteralPath `$stop)) {
        `$async = `$listener.BeginGetContext(`$null, `$null)
        while (-not `$async.AsyncWaitHandle.WaitOne(200)) {
            if (Test-Path -LiteralPath `$stop) { break }
        }
        if (Test-Path -LiteralPath `$stop) { break }
        `$context = `$listener.EndGetContext(`$async)
        `$healthy = Test-Path -LiteralPath `$sentinel -PathType Leaf
        `$context.Response.StatusCode = if (`$healthy) { 200 } else { 503 }
        `$body = if (`$healthy) { 'healthy' } else { 'update-active' }
        `$bytes = [Text.Encoding]::UTF8.GetBytes(`$body)
        `$context.Response.ContentLength64 = `$bytes.Length
        `$context.Response.OutputStream.Write(`$bytes, 0, `$bytes.Length)
        `$context.Response.Close()
    }
}
finally {
    `$listener.Stop()
    `$listener.Close()
}
"@
    Set-Content -LiteralPath $scriptPath -Value $script -Encoding UTF8
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath) -WindowStyle Hidden -PassThru
    $uri = "http://127.0.0.1:$port/health"
    $deadline = (Get-Date).AddSeconds(15)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                return [pscustomobject]@{ Process = $process; StopFile = $stopFile; Uri = $uri }
            }
        }
        catch {}
        if ($process.HasExited) { throw "Rollback health server exited early with code $($process.ExitCode)." }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'Rollback health server did not become ready.'
}

function Stop-SentinelHealthServer {
    param([object]$Server)
    if (-not $Server) { return }
    Set-Content -LiteralPath $Server.StopFile -Value 'stop' -Encoding ASCII
    try { $Server.Process.WaitForExit(5000) | Out-Null } catch {}
    if (-not $Server.Process.HasExited) {
        Stop-Process -Id $Server.Process.Id -Force -ErrorAction SilentlyContinue
    }
}

foreach ($requiredPath in @($updaterCli,$agentCli,$updaterManifestPath,$trustedKeys)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required Agent update E2E file is missing: $requiredPath"
    }
}

$originalManifestText = Get-Content -LiteralPath $updaterManifestPath -Raw -Encoding UTF8
$manifest = $originalManifestText | ConvertFrom-Json
if ($manifest.applicationId -ne 'sirk-agent' -or $manifest.updateSource -ne 'sirk-central-cache' -or $manifest.signatureRequired -ne $true) {
    throw 'Installed Agent Updater manifest does not enforce the Central-cache signed update contract.'
}
if (-not [string]::Equals([string]$manifest.signatureVerifierPath, $agentCli, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Installed Agent Updater verifier path mismatch: $($manifest.signatureVerifierPath)"
}
$verifierArguments = @($manifest.signatureVerifierArguments | ForEach-Object { [string]$_ })
if (-not ($verifierArguments -contains '{payload}') -or -not ($verifierArguments -contains 'verify-update')) {
    throw 'Installed Agent Updater manifest does not delegate package verification to sirkctl.'
}

$release = Export-VerifiedAgentRelease
Write-Host "Central-cache Agent package ready: $($release.version), $($release.size) bytes" -ForegroundColor Cyan

$positive = Invoke-Updater -PackagePath ([string]$release.packagePath) -Sha256 ([string]$release.sha256) -Version ([string]$release.version) -ExpectedExitCode 0 -Label 'positive'
$positiveState = $positive.StdOut | ConvertFrom-Json
if ($positiveState.phase -ne 'completed' -or $positiveState.progress -ne 100) {
    throw 'Positive SIRK Updater transaction did not reach Completed/100.'
}
Assert-ServiceHealthy
Wait-AgentOnline
Write-Host "SIRK_AGENT_UPDATER_REAL_PACKAGE_E2E_OK version=$($release.version)" -ForegroundColor Green

$sentinel = Join-Path $agentInstallRoot 'e2e-rollback-sentinel.txt'
Set-Content -LiteralPath $sentinel -Value ([guid]::NewGuid().ToString('N')) -Encoding ASCII
$server = $null
$modifiedManifestPath = Join-Path $Root 'sirk-agent-updater-rollback.json'
$originalManifestPath = Join-Path $Root 'sirk-agent-updater-original.json'
Set-Content -LiteralPath $originalManifestPath -Value $originalManifestText -Encoding UTF8
try {
    $server = Start-SentinelHealthServer -SentinelPath $sentinel
    $rollbackManifest = $originalManifestText | ConvertFrom-Json
    $rollbackManifest.healthUrl = $server.Uri
    $rollbackManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $modifiedManifestPath -Encoding UTF8
    & $updaterCli register $modifiedManifestPath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Could not register rollback E2E manifest.' }

    $failed = Invoke-Updater -PackagePath ([string]$release.packagePath) -Sha256 ([string]$release.sha256) -Version ([string]$release.version) -ExpectedExitCode 3 -Label 'rollback'
    $failedState = $failed.StdErr | ConvertFrom-Json
    if ($failedState.phase -ne 'failed' -or $failedState.message -notmatch 'rollback was attempted') {
        throw 'Rollback E2E did not expose the expected failed-after-rollback state.'
    }
    if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) {
        throw 'Rollback did not restore the pre-update sentinel from backup.'
    }
    Assert-ServiceHealthy
    Wait-AgentOnline
    Write-Host "SIRK_AGENT_UPDATER_ROLLBACK_E2E_OK version=$($release.version)" -ForegroundColor Green
}
finally {
    Stop-SentinelHealthServer -Server $server
    if (Test-Path -LiteralPath $originalManifestPath -PathType Leaf) {
        & $updaterCli register $originalManifestPath | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Could not restore the original Agent Updater manifest.' }
    }
    Remove-Item -LiteralPath $sentinel -Force -ErrorAction SilentlyContinue
}

Assert-ServiceHealthy
Write-Host 'SIRK_AGENT_UPDATER_TRANSACTION_AND_ROLLBACK_E2E_OK' -ForegroundColor Green
