#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PortalDll
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$PortalDll = (Resolve-Path -LiteralPath $PortalDll).Path
$BaseUrl = 'https://portal-e2e.local:19443'
$Password = 'Portal-Agent-E2E-BreakGlass-2026!'
$AccessCode = 'portal-agent-e2e-access-code-0123456789'
$GroupId = 'e2e-agent-group'
$Root = Join-Path $env:RUNNER_TEMP ('SIRK-Portal-Agent-E2E-' + [guid]::NewGuid().ToString('N'))
$DataRoot = Join-Path $Root 'data'
$TlsRoot = Join-Path $Root 'tls'
$PfxPath = Join-Path $TlsRoot 'portal-e2e.pfx'
$CerPath = Join-Path $TlsRoot 'portal-e2e.cer'
$InstallerPath = Join-Path $Root 'SIRK-Agent-e2e-Installer.exe'
$PortalLog = Join-Path $Root 'portal.stdout.log'
$PortalErrorLog = Join-Path $Root 'portal.stderr.log'
$PfxPasswordText = 'SIRK-Portal-E2E-PFX-2026!'
$PortalProcess = $null
$Certificate = $null
$HostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$HostsMarker = '# SIRK product E2E'
$AgentRoot = 'C:\ProgramData\SIRK\Agent'
$AgentCli = 'C:\Program Files\SIRK\Agent\sirkctl.exe'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Wait-PortalReady {
    param([int]$TimeoutSeconds = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    do {
        try {
            $value = Invoke-RestMethod -Uri ($BaseUrl + '/readyz') -TimeoutSec 5
            if ($value.status -eq 'ready') { return }
        }
        catch { $last = $_ }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Portal did not become ready: $last"
}

function Start-Portal {
    $env:ASPNETCORE_ENVIRONMENT = 'Development'
    $env:ASPNETCORE_URLS = 'https://0.0.0.0:19443'
    $env:AllowedHosts = 'portal-e2e.local;localhost;127.0.0.1'
    $env:Kestrel__Certificates__Default__Path = $PfxPath
    $env:Kestrel__Certificates__Default__Password = $PfxPasswordText
    $env:Sirk__DataRoot = $DataRoot
    $env:Sirk__Central__Enabled = 'false'
    $env:Sirk__CentralTunnel__Enabled = 'false'
    $env:SIRK_BOOTSTRAP_PASSWORD = $Password
    $env:SIRK_BOOTSTRAP_ACCESS_CODE = $AccessCode

    $process = Start-Process -FilePath 'dotnet.exe' `
        -ArgumentList @($PortalDll) `
        -WorkingDirectory (Split-Path -Parent $PortalDll) `
        -RedirectStandardOutput $PortalLog `
        -RedirectStandardError $PortalErrorLog `
        -PassThru
    Wait-PortalReady
    return $process
}

function New-AuthenticatedSession {
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $authorization = @{ Authorization = 'Bearer ' + $AccessCode }
    $body = @{
        userName = 'admin'
        password = $Password
        accessCode = $AccessCode
    } | ConvertTo-Json -Compress
    $login = Invoke-RestMethod `
        -Uri ($BaseUrl + '/api/v1/auth/login') `
        -Method Post `
        -ContentType 'application/json' `
        -Headers $authorization `
        -Body $body `
        -WebSession $session `
        -TimeoutSec 15
    if ($login.user.role -ne 'Break-Glass') {
        throw 'Portal Break-Glass login returned an invalid role.'
    }
    $csrf = Invoke-RestMethod `
        -Uri ($BaseUrl + '/api/v1/auth/csrf') `
        -WebSession $session `
        -TimeoutSec 15
    if ([string]::IsNullOrWhiteSpace([string]$csrf.headerName) -or
        [string]::IsNullOrWhiteSpace([string]$csrf.requestToken)) {
        throw 'Portal CSRF endpoint returned an invalid token.'
    }
    return [pscustomobject]@{
        Session = $session
        Headers = @{ ([string]$csrf.headerName) = [string]$csrf.requestToken }
    }
}

function Remove-ServiceCompletely {
    param([Parameter(Mandatory)][string]$Name)
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $service) { return }
    Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
    & sc.exe delete $Name | Out-Null
}

function Show-AgentInstallerLogs {
    Get-ChildItem 'C:\ProgramData\SIRK\Logs' -Filter 'Agent-Group-Installer-*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 3 |
        ForEach-Object {
            Write-Host "--- $($_.FullName) ---" -ForegroundColor Cyan
            Get-Content -LiteralPath $_.FullName -Tail 300 -ErrorAction SilentlyContinue | Out-Host
        }
}

function Invoke-AgentCliDiagnostic {
    param([Parameter(Mandatory)][string]$Command)
    if (-not (Test-Path -LiteralPath $AgentCli -PathType Leaf)) {
        Write-Host "Agent CLI is missing: $AgentCli" -ForegroundColor Yellow
        return
    }
    Write-Host "--- sirkctl $Command ---" -ForegroundColor Cyan
    $stdout = Join-Path $Root ("sirkctl-$Command.stdout.log")
    $stderr = Join-Path $Root ("sirkctl-$Command.stderr.log")
    $process = Start-Process -FilePath $AgentCli `
        -ArgumentList @($Command) `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -Wait `
        -PassThru
    Write-Host "ExitCode=$($process.ExitCode)"
    Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue | Out-Host
    Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue | Out-Host
}

function Write-AgentDiagnostics {
    Write-Host '=== SIRK Agent diagnostics ===' -ForegroundColor Cyan
    foreach ($serviceName in @('SirkAgent','SirkAgentWatchdog','SirkUpdater')) {
        Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue |
            Select-Object Name,State,StartMode,StartName,PathName |
            Format-List | Out-Host
    }

    $credential = Join-Path $AgentRoot 'portal-credential.bin'
    $heartbeat = Join-Path $AgentRoot 'heartbeat-latest.json'
    $management = Join-Path $AgentRoot 'management-state.json'
    [pscustomobject]@{
        CredentialExists = Test-Path -LiteralPath $credential -PathType Leaf
        CredentialLength = if (Test-Path -LiteralPath $credential -PathType Leaf) { (Get-Item -LiteralPath $credential).Length } else { 0 }
        HeartbeatExists = Test-Path -LiteralPath $heartbeat -PathType Leaf
        ManagementStateExists = Test-Path -LiteralPath $management -PathType Leaf
        AgentCliExists = Test-Path -LiteralPath $AgentCli -PathType Leaf
    } | Format-List | Out-Host

    Invoke-AgentCliDiagnostic -Command 'status'
    Invoke-AgentCliDiagnostic -Command 'sync'
    Start-Sleep -Seconds 2
    Invoke-AgentCliDiagnostic -Command 'status'

    foreach ($path in @($heartbeat,$management)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Write-Host "--- $path ---" -ForegroundColor Cyan
            Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue | Out-Host
        }
    }
    $portalStatus = Join-Path $AgentRoot 'portal-checkin-status.json'
    if (Test-Path -LiteralPath $portalStatus -PathType Leaf) {
        Write-Host "--- $portalStatus ---" -ForegroundColor Cyan
        Get-Content -LiteralPath $portalStatus -Raw -ErrorAction SilentlyContinue | Out-Host
    }
}

if (-not (Test-Administrator)) {
    throw 'Windows E2E runner must have local Administrator rights.'
}
if (-not (Test-Path -LiteralPath $PortalDll -PathType Leaf)) {
    throw "Portal assembly is missing: $PortalDll"
}

New-Item -ItemType Directory -Path $Root,$DataRoot,$TlsRoot -Force | Out-Null
try {
    $Certificate = New-SelfSignedCertificate `
        -Subject 'CN=portal-e2e.local' `
        -DnsName @('portal-e2e.local','localhost') `
        -CertStoreLocation 'Cert:\LocalMachine\My' `
        -FriendlyName 'SIRK Product E2E Portal HTTPS' `
        -NotBefore (Get-Date).AddMinutes(-5) `
        -NotAfter (Get-Date).AddDays(2) `
        -KeyAlgorithm RSA `
        -KeyLength 3072 `
        -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
    $securePfxPassword = ConvertTo-SecureString $PfxPasswordText -AsPlainText -Force
    Export-PfxCertificate -Cert $Certificate -FilePath $PfxPath -Password $securePfxPassword -Force | Out-Null
    Export-Certificate -Cert $Certificate -FilePath $CerPath -Type CERT -Force | Out-Null
    Import-Certificate -FilePath $CerPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null

    Add-Content -LiteralPath $HostsPath -Value "`r`n127.0.0.1`tportal-e2e.local`t$HostsMarker" -Encoding ASCII

    $PortalProcess = Start-Portal
    $auth = New-AuthenticatedSession

    $groupBody = @{
        id = $GroupId
        name = 'E2E Agent Group'
        description = 'Actual group-bound EXE installation test'
        enabled = $true
    } | ConvertTo-Json -Compress
    $group = Invoke-RestMethod `
        -Uri ($BaseUrl + '/api/v1/admin/computer-groups') `
        -Method Post `
        -ContentType 'application/json' `
        -Headers $auth.Headers `
        -Body $groupBody `
        -WebSession $auth.Session `
        -TimeoutSec 20
    if ($group.groupId -ne $GroupId -or [string]::IsNullOrWhiteSpace([string]$group.enrollmentToken)) {
        throw 'Portal did not create the expected computer group.'
    }

    $installerBody = @{ validMinutes = 60; channel = 'dev' } | ConvertTo-Json -Compress
    Invoke-WebRequest `
        -Uri ($BaseUrl + '/api/v1/admin/agent-groups/' + $GroupId + '/installer') `
        -Method Post `
        -ContentType 'application/json' `
        -Headers $auth.Headers `
        -Body $installerBody `
        -WebSession $auth.Session `
        -OutFile $InstallerPath `
        -TimeoutSec 120

    $installerBytes = [IO.File]::ReadAllBytes($InstallerPath)
    if ($installerBytes.Length -lt 4096 -or $installerBytes[0] -ne 0x4D -or $installerBytes[1] -ne 0x5A) {
        throw 'Portal did not generate a valid PE installer.'
    }

    Write-Host 'Starting group-bound Agent EXE...' -ForegroundColor Cyan
    $installer = Start-Process -FilePath $InstallerPath -PassThru
    $installerDeadline = (Get-Date).AddMinutes(6)
    while (-not $installer.HasExited -and (Get-Date) -lt $installerDeadline) {
        Start-Sleep -Seconds 2
        $installer.Refresh()
    }
    if (-not $installer.HasExited) {
        Write-Host 'Group-bound Agent EXE exceeded the 6-minute installation limit.' -ForegroundColor Red
        Show-AgentInstallerLogs
        & taskkill.exe /PID $installer.Id /T /F 2>&1 | Out-Host
        Start-Sleep -Seconds 2
        Show-AgentInstallerLogs
        throw 'Group-bound Agent EXE did not finish within 6 minutes.'
    }
    $installer.Refresh()
    Write-Host "Group-bound Agent EXE finished. ExitCode=$($installer.ExitCode)" -ForegroundColor Cyan
    if ($installer.ExitCode -ne 0) {
        Show-AgentInstallerLogs
        throw "Group-bound Agent EXE failed with exit code $($installer.ExitCode)."
    }

    # Force one explicit post-install management cycle and expose its response.
    # The service remains the actor; sirkctl only requests sync through the local
    # authenticated control channel, so this does not bypass Agent security.
    Write-AgentDiagnostics

    $deadline = (Get-Date).AddMinutes(2)
    $onlineDevice = $null
    do {
        try {
            $snapshot = Invoke-RestMethod `
                -Uri ($BaseUrl + '/api/v1/admin/computer-groups') `
                -WebSession $auth.Session `
                -TimeoutSec 15
            $onlineDevice = @($snapshot.value.devices | Where-Object {
                $_.groupId -eq $GroupId -and $_.online -eq $true
            } | Select-Object -First 1)
            if ($onlineDevice) { break }
        }
        catch {}
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)

    if (-not $onlineDevice) {
        Write-AgentDiagnostics
        throw 'Installed Agent did not appear online in the selected Portal group.'
    }

    foreach ($serviceName in @('SirkAgent','SirkAgentWatchdog','SirkUpdater')) {
        $service = Get-Service -Name $serviceName -ErrorAction Stop
        if ($service.Status -ne 'Running' -or $service.StartType -ne 'Automatic') {
            throw "Invalid service state for ${serviceName}: $($service.Status) / $($service.StartType)"
        }
    }

    $ticketStore = Join-Path $DataRoot 'agent-installer-tickets.json'
    if (-not (Test-Path -LiteralPath $ticketStore -PathType Leaf)) {
        throw 'Single-use installer ticket store was not created.'
    }
    $ticketText = Get-Content -LiteralPath $ticketStore -Raw
    if ($ticketText -match 'install-[a-f0-9]{20}\.[A-Za-z0-9_-]{40,128}') {
        throw 'Installer ticket store contains a plaintext ticket.'
    }
    $ticketDocument = $ticketText | ConvertFrom-Json
    $consumedTicket = @($ticketDocument.Tickets | Where-Object {
        $_.GroupId -eq $GroupId -and $null -ne $_.UsedAtUtc
    } | Select-Object -First 1)
    if (-not $consumedTicket) {
        throw 'Installer ticket was not persisted as consumed after enrollment.'
    }

    Write-Host 'SIRK_GROUP_AGENT_EXE_INSTALLATION_E2E_OK' -ForegroundColor Green
}
catch {
    Write-Host "SIRK group Agent EXE E2E failed: $($_.Exception.Message)" -ForegroundColor Red
    Show-AgentInstallerLogs
    Write-AgentDiagnostics
    Get-Content -LiteralPath $PortalLog -Tail 300 -ErrorAction SilentlyContinue | Out-Host
    Get-Content -LiteralPath $PortalErrorLog -Tail 300 -ErrorAction SilentlyContinue | Out-Host
    Get-ChildItem 'C:\ProgramData\SIRK\Logs' -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            Write-Host "--- $($_.FullName) ---"
            Get-Content -LiteralPath $_.FullName -Tail 200 -ErrorAction SilentlyContinue | Out-Host
        }
    throw
}
finally {
    if ($PortalProcess -and -not $PortalProcess.HasExited) {
        Stop-Process -Id $PortalProcess.Id -Force -ErrorAction SilentlyContinue
        $PortalProcess.WaitForExit(10000) | Out-Null
    }
    foreach ($serviceName in @('SirkAgent','SirkAgentWatchdog','SirkUpdater')) {
        Remove-ServiceCompletely -Name $serviceName
    }
    Remove-Item 'C:\Program Files\SIRK\Agent','C:\Program Files\SIRK\Updater' -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item 'C:\ProgramData\SIRK\Agent','C:\ProgramData\SIRK\Updater' -Recurse -Force -ErrorAction SilentlyContinue
    if ($Certificate) {
        Get-ChildItem 'Cert:\LocalMachine\My','Cert:\LocalMachine\Root' -ErrorAction SilentlyContinue |
            Where-Object Thumbprint -eq $Certificate.Thumbprint |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $HostsPath) {
        $remaining = Get-Content -LiteralPath $HostsPath | Where-Object { $_ -notmatch [regex]::Escape($HostsMarker) }
        Set-Content -LiteralPath $HostsPath -Value $remaining -Encoding ASCII
    }
    Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}