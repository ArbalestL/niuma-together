param(
    [Parameter(Mandatory, ParameterSetName='Build')][switch]$Build,
    [Parameter(Mandatory, ParameterSetName='Publish')][switch]$Publish,
    [string]$Destination = (Join-Path $PSScriptRoot '../../dist')
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$tag = [IO.File]::ReadAllText((Join-Path $root '.github/release-version.txt')).Trim()
if ($tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Invalid release version.' }
$version = $tag.Substring(1)
$name = "niuma-together-$tag-windows-x64"
$output = (New-Item -ItemType Directory -Path $Destination -Force).FullName
$asset = Join-Path $output "$name.zip"

if ($Build) {
    & (Join-Path $root 'build-portable.ps1') -Destination $output
    $bundle = Join-Path $output $name
    $exe = Get-Item -LiteralPath (Join-Path $bundle 'niuma.exe')
    if ($exe.VersionInfo.ProductVersion -ne $version -or $exe.VersionInfo.FileVersion -ne "$version.0") {
        throw "The Windows version must match $tag."
    }
    $required = @('runtime/node.exe', 'runtime/cloudflared.exe', 'launch.mjs', 'room/server.mjs', 'room/public/index.html', 'CHANGELOG.md')
    foreach ($item in $required) {
        if (!(Test-Path -LiteralPath (Join-Path $bundle $item) -PathType Leaf)) { throw "Missing component $item" }
    }
    & (Join-Path $bundle 'runtime/node.exe') --test (Join-Path $root 'room/room.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Room service tests failed.' }
    Compress-Archive -LiteralPath $bundle -DestinationPath $asset -CompressionLevel Optimal
    Write-Output "Built $asset"
    return
}

if ($env:GITHUB_REPOSITORY -ne 'ArbalestL/niuma-together' -or $env:GITHUB_REF -ne 'refs/heads/main' -or
    $env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$' -or !$env:GH_TOKEN) {
    throw 'Publishing requires the main-branch workflow token in ArbalestL/niuma-together.'
}
$repo = $env:GITHUB_REPOSITORY
$file = Get-Item -LiteralPath $asset
$hash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()

function Invoke-Gh {
    $result = & gh @args
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI operation failed ($LASTEXITCODE)." }
    return $result
}

function Find-Release {
    $result = Invoke-Gh api "repos/$repo/releases" --paginate --jq ".[] | select(.tag_name == `"$tag`")"
    if ($result) { return ($result -join "`n" | ConvertFrom-Json) }
}

$release = Find-Release
if ($release -and !$release.draft) {
    $existing = $release.assets | Where-Object { $_.name -eq $file.Name -and $_.state -eq 'uploaded' -and $_.digest }
    if (!$existing) { throw "Published release $tag is missing its verified ZIP." }
    Write-Output "$tag is already published at $($release.html_url)."
    return
}

if (!$release) {
    $changelog = [IO.File]::ReadAllText((Join-Path $root 'CHANGELOG.md'))
    $entry = [regex]::Match($changelog, '(?ms)^## ' + [regex]::Escape($tag) + '\b[^\r\n]*\r?\n.*?(?=^## |\z)')
    if (!$entry.Success) { throw "Missing CHANGELOG.md entry for $tag." }
    $notes = Join-Path $output 'release-notes.md'
    $body = $entry.Value.TrimEnd() + "`n`n### 安装`n`n完整解压 Assets 中的 Windows x64 便携包，再打开 niuma.exe。`n`nZIP SHA-256：$hash`n"
    [IO.File]::WriteAllText($notes, $body, [Text.UTF8Encoding]::new($false))
    Invoke-Gh release create $tag $asset --repo $repo --draft --target $env:GITHUB_SHA --title "NiuMa Together $tag" --notes-file $notes
    $release = Find-Release
}
if (!$release -or !$release.draft -or $release.target_commitish -ne $env:GITHUB_SHA) {
    throw "Unexpected target for draft $tag."
}

$previous = $release.assets | Where-Object { $_.name -eq $file.Name }
$expectedSize = $file.Length
$hashLine = [regex]'(?m)^ZIP SHA-256：([a-f0-9]{64})[ \t]*\r?$'
$recorded = $hashLine.Match($release.body)
if (!$recorded.Success) { throw "Draft $tag is missing its ZIP checksum." }
if ($previous) {
    # On a retry the compiler or ZIP timestamps can differ. Keep a verified upload from the same commit.
    if ($previous.digest -ne ('sha256:' + $recorded.Groups[1].Value) -or
        $previous.state -ne 'uploaded' -or $previous.size -le 0) {
        throw "Draft $tag has an unverified ZIP. Inspect the draft before replacing its attachment."
    }
    $hash = $recorded.Groups[1].Value
    $expectedSize = $previous.size
} else {
    if ($recorded.Groups[1].Value -ne $hash) {
        $notes = Join-Path $output 'release-notes.md'
        $body = $hashLine.Replace($release.body, "ZIP SHA-256：$hash", 1)
        [IO.File]::WriteAllText($notes, $body, [Text.UTF8Encoding]::new($false))
        Invoke-Gh release edit $tag --repo $repo --notes-file $notes
    }
    Invoke-Gh release upload $tag $asset --repo $repo
}
$release = Find-Release
$uploaded = $release.assets | Where-Object {
    $_.name -eq $file.Name -and $_.state -eq 'uploaded' -and $_.size -eq $expectedSize -and $_.digest -eq "sha256:$hash"
}
if (!$uploaded) { throw 'GitHub ZIP verification failed.' }
Invoke-Gh api --method PATCH "repos/$repo/releases/$($release.id)" -F draft=false -f make_latest=true --jq .html_url
