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
$PortalLog = Join-Path $Root 'portal.log'
$PfxPasswordText = 'SIRK-Portal-E2E-PFX-2026!'
$PortalProcess = $null
$Certificate = $null
$HostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$HostsMarker = '# SIRK product E2E'

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
        -RedirectStandardError $PortalLog `
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

    $installer = Start-Process -FilePath $InstallerPath -Wait -PassThru
    if ($installer.ExitCode -ne 0) {
        throw "Group-bound Agent EXE failed with exit code $($installer.ExitCode)."
    }

    $deadline = (Get-Date).AddMinutes(6)
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
        throw 'Installed Agent did not appear online in the selected Portal group.'
    }

    foreach ($serviceName in @('SirkAgent','SirkAgentWatchdog','SirkUpdater')) {
        $service = Get-Service -Name $serviceName -ErrorAction Stop
        if ($service.Status -ne 'Running' -or $service.StartType -ne 'Automatic') {
            throw "Invalid service state for ${serviceName}: $($service.Status) / $($service.StartType)"
        }
    }

    $ticketStore = Join-Path $DataRoot 'security\agent-installer-tickets.json'
    if (-not (Test-Path -LiteralPath $ticketStore -PathType Leaf)) {
        throw 'Single-use installer ticket store was not created.'
    }
    $ticketText = Get-Content -LiteralPath $ticketStore -Raw
    if ($ticketText -match 'install-[a-f0-9]{20}\.[A-Za-z0-9_-]{40,128}') {
        throw 'Installer ticket store contains a plaintext ticket.'
    }

    Write-Host 'SIRK_GROUP_AGENT_EXE_INSTALLATION_E2E_OK' -ForegroundColor Green
}
catch {
    Write-Host "SIRK group Agent EXE E2E failed: $($_.Exception.Message)" -ForegroundColor Red
    Get-Content -LiteralPath $PortalLog -Tail 300 -ErrorAction SilentlyContinue | Out-Host
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
