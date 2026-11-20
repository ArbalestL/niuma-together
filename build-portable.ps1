param([string]$Destination = (Join-Path $PSScriptRoot 'dist'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This portable build requires Windows x64.'
}

function Get-VerifiedFile($sources, $path, $sha) {
    foreach ($source in $sources) {
        try {
            Invoke-WebRequest -Uri $source -OutFile $path -Headers @{Accept='application/octet-stream'} -UseBasicParsing -TimeoutSec 45
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $sha) { return }
            Write-Warning "Checksum mismatch from $source"
        } catch { Write-Warning "Download failed from $source" }
    }
    throw "No verified download for $path"
}

$root = (New-Item -ItemType Directory -Path $Destination -Force).FullName
$assembly = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'src/App.cs'))
$version = [regex]::Match($assembly, 'AssemblyInformationalVersion\("([0-9]+\.[0-9]+\.[0-9]+)"\)')
if (!$version.Success) { throw 'No portable product version found in src/App.cs.' }
$final = Join-Path $root ('niuma-together-v' + $version.Groups[1].Value + '-windows-x64')
if (Test-Path -LiteralPath $final) { throw "Bundle already exists at $final" }
$scratch = (New-Item -ItemType Directory -Path (Join-Path $root ('.build-' + [guid]::NewGuid().ToString('N')))).FullName
try {
    $bundle = (New-Item -ItemType Directory -Path (Join-Path $scratch 'bundle')).FullName
    $runtime = (New-Item -ItemType Directory -Path (Join-Path $bundle 'runtime')).FullName
    $licenses = (New-Item -ItemType Directory -Path (Join-Path $bundle 'licenses')).FullName
    $room = (New-Item -ItemType Directory -Path (Join-Path $bundle 'room')).FullName
    $nodeZip = Join-Path $scratch 'node.zip'
    Get-VerifiedFile @('https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip') $nodeZip 'E612AF99F626AB415EA225AF6BCE5C971FEB448CB5CAE250BB1C3FA50C5F7D9F'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $node = [IO.Compression.ZipFile]::OpenRead($nodeZip)
    try {
        $archiveRoot = 'node-v24.22.3-win-x64/'
        [IO.Compression.ZipFileExtensions]::ExtractToFile($node.GetEntry($archiveRoot + 'node.exe'), (Join-Path $runtime 'node.exe'))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($node.GetEntry($archiveRoot + 'LICENSE'), (Join-Path $licenses 'nodejs-LICENSE.txt'))
    } finally { $node.Dispose() }

    $cloudUrls = @(
        'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-windows-amd64.exe',
        'https://api.github.com/repos/cloudflare/cloudflared/releases/assets/759528258?download=1'
    )
    Get-VerifiedFile $cloudUrls (Join-Path $runtime 'cloudflared.exe') '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35'
    Get-VerifiedFile @('https://raw.githubusercontent.com/cloudflare/cloudflared/2026.11.1/LICENSE') (Join-Path $licenses 'cloudflared-LICENSE.txt') '58D1E17FFE5109A7AE296CAAFCADFDBE6A7D176F0BC4AB01E12A689B0499D8BD'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE') -Destination (Join-Path $licenses 'niuma-LICENSE.txt')

    $files = @('launch.mjs', 'start-local.cmd', 'start-online.cmd') | ForEach-Object { Join-Path $PSScriptRoot $_ }
    Copy-Item -LiteralPath $files -Destination $bundle
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.txt' -File | Copy-Item -Destination $bundle
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'CHANGELOG.md') -Destination $bundle
    Copy-Item -LiteralPath @((Join-Path $PSScriptRoot 'room/server.mjs'), (Join-Path $PSScriptRoot 'room/public')) -Destination $room -Recurse
    & (Join-Path $PSScriptRoot 'build.ps1') -OutputPath (Join-Path $bundle 'niuma.exe')

    if ((Split-Path -Parent (Resolve-Path -LiteralPath $bundle).Path) -ne $scratch -or
        (Split-Path -Parent $final) -ne $root) { throw 'Unexpected bundle paths.' }
    Move-Item -LiteralPath $bundle -Destination $final
    Write-Output (Join-Path $final 'niuma.exe')
} finally {
    $resolved = Resolve-Path -LiteralPath $scratch -ErrorAction SilentlyContinue
    if ($resolved -and (Split-Path -Parent $resolved.Path) -eq $root) {
        Remove-Item -LiteralPath $resolved.Path -Recurse -Force
    }
}
