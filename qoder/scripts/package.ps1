$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("qoder-thin-ssh-pack-" + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $dist 'qoder-thin-ssh-0.1.0.zip'
$items = @('.qoder-plugin', '.mcp.json', 'README.md', 'SELF_TEST_REPORT.md', 'MARKETPLACE.md', 'LICENSE', 'package.json', 'server.mjs', 'lib', 'scripts', 'assets')

New-Item -ItemType Directory -Path $dist -Force | Out-Null
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    foreach ($item in $items) {
        $source = Join-Path $root $item
        if (-not (Test-Path -LiteralPath $source)) {
            throw "Missing package item: $item"
        }
        Copy-Item -LiteralPath $source -Destination $stage -Recurse -Force
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $zip) {
        Remove-Item -LiteralPath $zip -Force
    }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($required in @('.qoder-plugin/plugin.json', '.mcp.json', 'server.mjs')) {
            if ($names -notcontains $required) {
                throw "ZIP is missing root entry: $required"
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}
finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$checksum = Join-Path $dist ([System.IO.Path]::GetFileName($zip) + '.sha256')
Set-Content -LiteralPath $checksum -Value "$hash  qoder-thin-ssh-0.1.0.zip" -Encoding ascii
Write-Output "Created: $zip"
Write-Output "SHA-256: $hash"
