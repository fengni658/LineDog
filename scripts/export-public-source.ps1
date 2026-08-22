[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [Parameter(Mandatory)][string]$Version,
  [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ExportRoot = Join-Path $ProjectRoot '.public-source'
$SourceRepository = 'fengni658/LineDog'
$ManifestName = 'PUBLIC-SOURCE-MANIFEST.txt'

function Stop-Export {
  param([Parameter(Mandatory)][string]$Message)

  throw "Public-source export stopped: $Message"
}

function Assert-Condition {
  param(
    [Parameter(Mandatory)][bool]$Condition,
    [Parameter(Mandatory)][string]$Message
  )

  if (-not $Condition) {
    Stop-Export $Message
  }
}

function Get-NormalizedPath {
  param([Parameter(Mandatory)][string]$Path)

  $separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  return ([System.IO.Path]::GetFullPath($Path)).TrimEnd($separators)
}

function Get-ExportClassification {
  param([Parameter(Mandatory)][string]$RelativePath)

  $normalized = $RelativePath.Replace('\\', '/')
  $rootFiles = @(
    '.gitignore',
    'ASSET-LICENSE.md',
    'FREEWARE-NOTICE.txt',
    'LICENSE',
    'README.md',
    'index.html',
    'package-lock.json',
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'vitest.config.ts'
  )
  $scriptFiles = @(
    'scripts/export-public-source.ps1',
    'scripts/publish-release.ps1',
    'scripts/test-public-release-contract.ps1'
  )

  if ($normalized -in $rootFiles -or $normalized -in $scriptFiles) { return 'include' }
  if ($normalized -match '^(src|tests|src-tauri)/') {
    if ($normalized -match '^src-tauri/icons/.*\.rgba$') { return 'exclude' }
    return 'include'
  }
  if ($normalized -eq 'public/character/manifest.json') { return 'include' }
  if ($normalized -match '^public/character/(blink|drag|fall|happy|idle|land|look_mouse|turn|walk)/frame_\d+\.png$') { return 'include' }

  if ($normalized -eq 'AGENTS.md') { return 'exclude' }
  if ($normalized -match '^\.agents/') { return 'exclude' }
  if ($normalized -match '^public/character/work/') { return 'exclude' }
  if ($normalized -match '^public/character/model/') { return 'exclude' }
  if ($normalized -match '^public/character/[^/]+/candidate/') { return 'exclude' }
  if ($normalized -match '^public/character/.*\.preflight\.png$') { return 'exclude' }
  if ($normalized -match '^(\.release|\.local|release-staging|publish-staging)/') { return 'exclude' }

  return 'unknown'
}

function Assert-ExportTarget {
  param([Parameter(Mandatory)][string]$Path)

  $exportRootPath = Get-NormalizedPath -Path $ExportRoot
  $outputPath = Get-NormalizedPath -Path $Path
  $relative = [System.IO.Path]::GetRelativePath($exportRootPath, $outputPath).Replace('\\', '/')
  Assert-Condition -Condition ($relative -notmatch '^(\.\./|\.\.$)' -and $relative -ne '.') -Message 'OutputDirectory must be a direct or nested child of the ignored .public-source directory.'
  return $outputPath
}

function Assert-IgnoredExportRoot {
  $ignoreOutput = @(& git -C $ProjectRoot check-ignore -v -- '.public-source/ignore-probe')
  Assert-Condition -Condition ($LASTEXITCODE -eq 0) -Message '.public-source must be ignored before export.'
  Assert-Condition -Condition (($ignoreOutput | Out-String) -match '(?m)\.gitignore:\d+:\/\.public-source\/\s+') -Message '.public-source must be ignored by the repository /.public-source/ rule.'
}

function Copy-AllowedFile {
  param(
    [Parameter(Mandatory)][string]$RelativePath,
    [Parameter(Mandatory)][string]$DestinationRoot
  )

  $sourcePath = Join-Path $ProjectRoot $RelativePath
  $sourceItem = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
  Assert-Condition -Condition (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -Message "Tracked source must not be a reparse point: $RelativePath."
  $destinationPath = Join-Path $DestinationRoot $RelativePath
  $destinationParent = Split-Path -Parent $destinationPath
  $null = New-Item -ItemType Directory -Path $destinationParent -Force -ErrorAction Stop
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -ErrorAction Stop
  return $destinationPath
}

function Write-Manifest {
  param(
    [Parameter(Mandatory)][string]$DestinationRoot,
    [Parameter(Mandatory)][string[]]$IncludedPaths
  )

  $lines = foreach ($relativePath in ($IncludedPaths | Sort-Object)) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $DestinationRoot $relativePath) -Algorithm SHA256).Hash.ToUpperInvariant()
    '{0} *{1}' -f $hash, $relativePath.Replace('\\', '/')
  }
  $manifestPath = Join-Path $DestinationRoot $ManifestName
  [System.IO.File]::WriteAllText($manifestPath, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  return $manifestPath
}

Assert-Condition -Condition ($Version -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') -Message "Version $Version is not valid SemVer."
Assert-IgnoredExportRoot
$destinationRoot = Assert-ExportTarget -Path $OutputDirectory

if (Test-Path -LiteralPath $destinationRoot) {
  Assert-Condition -Condition $Clean -Message "OutputDirectory already exists: $destinationRoot. Use -Clean only for this generated export target."
  $destinationItem = Get-Item -LiteralPath $destinationRoot -Force -ErrorAction Stop
  Assert-Condition -Condition (($destinationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -Message 'OutputDirectory must not be a reparse point.'
  Remove-Item -LiteralPath $destinationRoot -Recurse -Force -ErrorAction Stop
}

$trackedFiles = @(& git -C $ProjectRoot ls-files)
Assert-Condition -Condition ($LASTEXITCODE -eq 0) -Message 'Cannot enumerate tracked files.'
$requiredCandidateFiles = @(
  'ASSET-LICENSE.md',
  'LICENSE',
  'scripts/export-public-source.ps1',
  'scripts/publish-release.ps1',
  'scripts/test-public-release-contract.ps1'
)
$candidateFiles = @($trackedFiles + $requiredCandidateFiles | Sort-Object -Unique)
$includedPaths = [System.Collections.Generic.List[string]]::new()
$excludedPaths = [System.Collections.Generic.List[string]]::new()
foreach ($relativePath in $candidateFiles) {
  $classification = Get-ExportClassification -RelativePath $relativePath
  if ($classification -eq 'include') {
    $null = Copy-AllowedFile -RelativePath $relativePath -DestinationRoot $destinationRoot
    $includedPaths.Add($relativePath)
    continue
  }
  if ($classification -eq 'exclude') {
    $excludedPaths.Add($relativePath)
    continue
  }
  Stop-Export "Candidate path has no allowlist or explicit exclusion classification: $relativePath."
}

$manifestPath = Write-Manifest -DestinationRoot $destinationRoot -IncludedPaths $includedPaths.ToArray()
Write-Output ([pscustomobject]@{
  SourceRepository = $SourceRepository
  Version = $Version
  OutputDirectory = $destinationRoot
  IncludedFileCount = $includedPaths.Count
  ExcludedFileCount = $excludedPaths.Count
  Manifest = $manifestPath
})
