<#
.SYNOPSIS
  Install funoteka as a Windows service, or take it away.

.DESCRIPTION
  Wraps this checkout's `node src/cli.ts serve` in a Windows service using WinSW
  — a small executable that does the one thing Node cannot: talk to the Service
  Control Manager. Node has no way to be a service on its own, and the
  alternatives are all worse for a project with no dependencies: a .NET project
  to build, or a scheduled task that only starts when somebody logs in.

  Run it from an **elevated** PowerShell. Nothing is downloaded without its hash
  being checked, and nothing is written outside the data directory and the
  service's own folder.

  **This script has not been run end to end by the person who wrote it.** It
  installs a service, which needs an elevated shell and a machine to keep the
  service on; the Docker path is the one that was verified. Treat the first run
  as the verification, and read what it says.

.EXAMPLE
  .\install-service.ps1 -Data 'C:\ProgramData\funoteka'

.EXAMPLE
  .\install-service.ps1 -Remove
#>
[CmdletBinding()]
param(
    # Everything this deployment owns: the meta layer, the log, the config and
    # WinSW's own files. Defaults to C:\ProgramData\funoteka, which is where a
    # machine-wide service's state belongs.
    [string] $Data = (Join-Path $env:ProgramData 'funoteka'),

    # Where WinSW is put. Its own directory because the service's executable is
    # one of its files, and a service looking for its wrapper among the sources
    # is a service that breaks on the next `git pull`.
    [string] $ServiceDir = (Join-Path $env:ProgramData 'funoteka\service'),

    # The service's display name; also the XML's id.
    [string] $Name = 'funoteka',

    [switch] $Remove,

    [switch] $SkipDownload
)

$ErrorActionPreference = 'Stop'

# WinSW 2.12.0, pinned — and the hash is of the asset as published on that
# release, computed after downloading it from GitHub. A version without a hash is
# a download that can change under the same name; a hash without a version is one
# nobody can look up.
$WinSwVersion = '2.12.0'
$WinSwUrl = "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW-x64.exe"
$WinSwSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This needs an elevated PowerShell: installing a service writes to the machine, not to your profile.'
    }
}

function Get-WinSw {
    param([string] $Where)

    if ($SkipDownload) {
        if (-not (Test-Path $Where)) { throw "-SkipDownload was given but there is no WinSW at $Where" }
        return
    }

    Write-Host "Downloading WinSW $WinSwVersion ..."
    $temp = Join-Path $env:TEMP "winsw-$WinSwVersion.exe"
    Invoke-WebRequest -Uri $WinSwUrl -OutFile $temp -UseBasicParsing

    $hash = (Get-FileHash -Algorithm SHA256 -Path $temp).Hash.ToLowerInvariant()
    if ($hash -ne $WinSwSha256) {
        Remove-Item -Force $temp
        throw "WinSW $WinSwVersion did not match its published hash.`n  expected $WinSwSha256`n  got      $hash`nNothing was installed."
    }

    New-Item -ItemType Directory -Force -Path (Split-Path $Where) | Out-Null
    Move-Item -Force $temp $Where
    Write-Host "  hash ok: $hash"
}

# ---------------------------------------------------------------- uninstall --
if ($Remove) {
    Assert-Admin
    $exe = Join-Path $ServiceDir "$Name.exe"
    if (Test-Path $exe) {
        Write-Host "Stopping and uninstalling $Name ..."
        # WinSW uninstalls itself; a service file removed by hand leaves the SCM
        # holding an entry that points at nothing.
        & $exe stop 2>$null
        & $exe uninstall 2>$null
    } else {
        Write-Host "No service wrapper at $exe — nothing to uninstall."
    }
    Write-Host "The data in $Data was left alone. Remove it by hand if you mean to."
    return
}

# ------------------------------------------------------------------ install --
Assert-Admin

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node -ErrorAction Stop).Source

Write-Host "funoteka service"
Write-Host "  repo  $repo"
Write-Host "  node  $node"
Write-Host "  data  $Data"

New-Item -ItemType Directory -Force -Path $Data | Out-Null
New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null

# The config file, from the example, only if there is not one already: this
# script installs a service, and overwriting a deployment's credentials would be
# it deciding something that is not its business.
$config = Join-Path $Data 'funoteka.json'
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $repo 'funoteka.json.example') $config
    Write-Host ""
    Write-Host "  Wrote $config from the example."
    Write-Host "  **Edit it before starting the service**: it needs FUNOTEKA_USER/PASSWORD and an admin token."
    Write-Host ""
}

Get-WinSw -Where (Join-Path $ServiceDir "$Name.exe")

$template = Get-Content -Raw (Join-Path $PSScriptRoot 'funoteka-service.xml')
$xml = $template.
    Replace('{{NODE}}', $node).
    Replace('{{REPO}}', $repo).
    Replace('{{DATA}}', $Data)
$xmlPath = Join-Path $ServiceDir "$Name.xml"
Set-Content -Path $xmlPath -Value $xml -Encoding utf8
Write-Host "  wrote $xmlPath"

$exe = Join-Path $ServiceDir "$Name.exe"
& $exe install
if ($LASTEXITCODE -ne 0) { throw "WinSW could not install the service (exit $LASTEXITCODE)" }

# The config carries the credentials, so it is readable by the account the
# service runs as and by administrators — and by nobody else. This is the one
# thing on Windows that stands in for the systemd unit's 0600 EnvironmentFile.
icacls $config /inheritance:r /grant:r 'SYSTEM:(R)' /grant:r 'Administrators:(R)' | Out-Null

Write-Host ""
Write-Host "Installed. Then:"
Write-Host "  Start-Service $Name"
Write-Host "  Get-Service $Name"
Write-Host "  Invoke-RestMethod http://127.0.0.1:4533/health"
Write-Host ""
Write-Host "The first run has nothing to serve — scan the collection once:"
Write-Host "  & '$node' '$repo\src\cli.ts' scan 'D:\Music'"
