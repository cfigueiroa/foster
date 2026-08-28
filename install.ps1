<#
.SYNOPSIS
  Installs foster — brings Claude Desktop Code sessions from a previous local
  account back into the current account's sidebar.

.DESCRIPTION
  Intended to be run as:

      irm https://raw.githubusercontent.com/cfigueiroa/foster/<tag>/install.ps1 | iex

  The bundle is downloaded from a tagged GitHub release, never from a moving
  branch, and its SHA256 is verified against the checksum published alongside it
  before anything is written to disk or executed.
#>
[CmdletBinding()]
param(
  # Release tag to install. Overridable so a specific version can be pinned.
  [string]$Version = 'v0.36.0',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'foster'),
  # Install without opening the menu afterwards, for scripted setups.
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = 'cfigueiroa/foster'
$base = "https://github.com/$repo/releases/download/$Version"
$bundleUrl = "$base/foster.js"
$checksumUrl = "$base/foster.js.sha256"

function Test-NodeVersion {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Node.js 20 or newer is required but was not found on PATH. Install it from https://nodejs.org and run this again."
  }
  $raw = (& node --version).TrimStart('v')
  $major = [int]($raw -split '\.')[0]
  if ($major -lt 20) {
    throw "Node.js 20 or newer is required, but $raw is installed."
  }
  Write-Host "  Node.js $raw" -ForegroundColor DarkGray
}

Write-Host "Installing foster $Version" -ForegroundColor Cyan
Test-NodeVersion

# Download to a temporary location first: nothing lands in the install directory
# until the integrity of the payload has been confirmed.
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("foster-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

try {
  $bundle = Join-Path $temp 'foster.js'
  Write-Host "  downloading bundle" -ForegroundColor DarkGray
  Invoke-WebRequest -Uri $bundleUrl -OutFile $bundle -UseBasicParsing

  Write-Host "  verifying checksum" -ForegroundColor DarkGray
  # GitHub serves release assets as application/octet-stream, for which
  # Invoke-WebRequest returns Content as a byte array rather than a string, so it
  # is decoded explicitly instead of being treated as text.
  $checksumContent = (Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing).Content
  if ($checksumContent -is [byte[]]) {
    $checksumContent = [System.Text.Encoding]::UTF8.GetString($checksumContent)
  }
  $expected = ([string]$checksumContent).Trim().Split()[0]
  $actual = (Get-FileHash -Path $bundle -Algorithm SHA256).Hash

  if ($actual -ne $expected.ToUpperInvariant()) {
    throw "Checksum mismatch. Expected $expected but the download hashed to $actual. Nothing was installed."
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Copy-Item -Path $bundle -Destination (Join-Path $InstallDir 'foster.js') -Force

  # The bundle is ES modules, but a .js file only says so through the nearest
  # package.json. Without this one Node searches upward, out of the install
  # directory and into whatever unrelated package.json happens to sit above it —
  # then warns before every command's real output and reparses the bundle on
  # each run. Declaring the type here keeps that search inside foster's own
  # directory, rather than depending on what the rest of the tree looks like.
  Set-Content -Path (Join-Path $InstallDir 'package.json') -Encoding ASCII -Value '{ "type": "module" }'

  # A small shim so `foster` works as a command rather than `node <path>`.
  $shim = Join-Path $InstallDir 'foster.cmd'
  Set-Content -Path $shim -Encoding ASCII -Value @"
@echo off
node "%~dp0foster.js" %*
"@

  # Persisted for future sessions.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
    Write-Host "  added $InstallDir to your PATH" -ForegroundColor DarkGray
  }

  # A persisted PATH only reaches processes started afterwards, so the running
  # session is updated as well. Without this the very next thing the user types
  # fails, which is exactly the command the installer just told them to run.
  if ($env:Path -notlike "*$InstallDir*") { $env:Path = "$env:Path;$InstallDir" }

  Write-Host ""
  Write-Host "Installed to $InstallDir" -ForegroundColor Green

  # Only claim the command is ready if it actually resolves: piping through a
  # child process would leave this session's PATH untouched.
  if (-not (Get-Command foster -ErrorAction SilentlyContinue)) {
    Write-Host "Open a new terminal, then run:  foster" -ForegroundColor Yellow
    Write-Host "Or run it here as:  $shim" -ForegroundColor DarkGray
  }
  elseif ($NoLaunch -or [Console]::IsInputRedirected) {
    # Nothing would be able to answer the menu's prompts, so just say how to start.
    Write-Host "Start with:  foster"
  }
  else {
    # Installing is not the goal, using it is: the menu opens straight away
    # rather than asking the user to type another command.
    Write-Host ""
    & foster
  }
}
finally {
  Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
