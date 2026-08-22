[CmdletBinding()]
param(
  [switch]$Publish,
  [switch]$ValidateFrozenStage,
  [string]$FrozenManifestPath,
  [string]$SigningKeyPath,
  [string]$SigningKeyPassword
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SourceRepository = 'fengni658/LineDog'
$ReleaseRepository = 'fengni658/LineDog-Releases'
$UpdaterEndpoint = 'https://github.com/fengni658/LineDog-Releases/releases/latest/download/latest.json'
$WindowsTarget = 'windows-x86_64'
$ReleasePublisher = 'fengni658'
$FrozenManifestSchema = 'linedog.release-freeze/v3'
$NsisBundleRelativeDirectory = 'src-tauri/target/release/bundle/nsis'
$NsisGeneratedScriptRelativePath = 'src-tauri/target/release/nsis/x64/installer.nsi'
$NsisPayloadSourceRelativePath = 'src-tauri/target/release/linedog.exe'
$NsisPayloadName = 'linedog.exe'

function Stop-Release {
  param([Parameter(Mandatory)][string]$Message)

  throw "Release preparation stopped: $Message"
}

function Assert-Condition {
  param(
    [Parameter(Mandatory)][bool]$Condition,
    [Parameter(Mandatory)][string]$Message
  )

  if (-not $Condition) {
    Stop-Release $Message
  }
}

function Test-MapContainsKey {
  param([object]$Map, [Parameter(Mandatory)][string]$Key)

  if ($null -eq $Map -or -not ($Map -is [System.Collections.IDictionary])) {
    return $false
  }
  return ([System.Collections.IDictionary]$Map).Contains($Key)
}

function Get-RequiredMapValue {
  param(
    [object]$Map,
    [Parameter(Mandatory)][string]$Key,
    [Parameter(Mandatory)][string]$Message
  )

  Assert-Condition -Condition (Test-MapContainsKey -Map $Map -Key $Key) -Message $Message
  return $Map[$Key]
}

function ConvertTo-PositiveInt64 {
  param([object]$Value, [Parameter(Mandatory)][string]$Message)

  $text = if ($null -eq $Value) { '' } else { [string]$Value }
  Assert-Condition -Condition ($text -match '^[1-9]\d*$') -Message $Message
  try {
    return [int64]::Parse($text, [System.Globalization.CultureInfo]::InvariantCulture)
  } catch {
    Stop-Release $Message
  }
}

function ConvertTo-NormalizedSha256 {
  param([object]$Value, [Parameter(Mandatory)][string]$Message)

  $hash = if ($null -eq $Value) { '' } else { [string]$Value }
  Assert-Condition -Condition ($hash -match '^[0-9A-Fa-f]{64}$') -Message $Message
  return $hash.ToUpperInvariant()
}

function Get-RegularFileIdentity {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  Assert-Condition -Condition (-not $item.PSIsContainer) -Message "$Label must be a file."
  Assert-Condition -Condition (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -Message "$Label must not be a reparse point."
  $length = ConvertTo-PositiveInt64 -Value $item.Length -Message "$Label length must be a positive integer."
  return [pscustomobject]@{
    Length = $length
    Sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
  }
}

function Assert-NsisPayloadSourceRelativePath {
  param([Parameter(Mandatory)][string]$RelativePath)

  $message = 'payloadIdentity.sourceRelativePath must be the canonical NSIS main binary input path.'
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($RelativePath)) -Message $message
  Assert-Condition -Condition ($RelativePath -ceq $NsisPayloadSourceRelativePath) -Message $message
  return $NsisPayloadSourceRelativePath
}

function Get-NsisPayloadSourcePath {
  $relativePath = Assert-NsisPayloadSourceRelativePath -RelativePath $NsisPayloadSourceRelativePath
  $projectRootPath = ConvertTo-NormalizedFullPath -Path $ProjectRoot
  $sourcePath = ConvertTo-NormalizedFullPath -Path (Join-Path $projectRootPath ($relativePath.Replace('/', '\')))
  $expectedPath = ConvertTo-NormalizedFullPath -Path (Join-Path $projectRootPath 'src-tauri\target\release\linedog.exe')
  Assert-Condition -Condition ($sourcePath -ieq $expectedPath) -Message 'Canonical NSIS main binary input path did not resolve under the project root.'
  return $sourcePath
}

function New-PayloadIdentity {
  param(
    [Parameter(Mandatory)][string]$SourceRelativePath,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)]$BeforeBundleIdentity,
    [Parameter(Mandatory)]$AfterBundleIdentity
  )

  $sourcePath = Assert-NsisPayloadSourceRelativePath -RelativePath $SourceRelativePath
  Assert-Condition -Condition ($Name -ceq $NsisPayloadName) -Message 'payloadIdentity.name must be linedog.exe.'
  $beforeLength = ConvertTo-PositiveInt64 -Value $BeforeBundleIdentity.Length -Message 'payloadIdentity.beforeBundle.length must be a positive integer.'
  $beforeHash = ConvertTo-NormalizedSha256 -Value $BeforeBundleIdentity.Sha256 -Message 'payloadIdentity.beforeBundle.sha256 is invalid.'
  $afterLength = ConvertTo-PositiveInt64 -Value $AfterBundleIdentity.Length -Message 'payloadIdentity.afterBundle.length must be a positive integer.'
  $afterHash = ConvertTo-NormalizedSha256 -Value $AfterBundleIdentity.Sha256 -Message 'payloadIdentity.afterBundle.sha256 is invalid.'
  Assert-Condition -Condition ($beforeLength -eq $afterLength -and $beforeHash -ceq $afterHash) -Message 'NSIS main binary input drifted between build-only and bundle.'
  return [ordered]@{
    sourceKind = 'tauri-nsis-main-binary-input'
    sourceRelativePath = $sourcePath
    name = $NsisPayloadName
    length = $beforeLength
    sha256 = $beforeHash
    beforeBundle = [ordered]@{
      length = $beforeLength
      sha256 = $beforeHash
    }
    afterBundle = [ordered]@{
      length = $afterLength
      sha256 = $afterHash
    }
  }
}

function Assert-PayloadIdentity {
  param([Parameter(Mandatory)]$PayloadIdentity)

  Assert-Condition -Condition ($PayloadIdentity -is [System.Collections.IDictionary]) -Message 'Frozen manifest payloadIdentity is missing.'
  $sourceKind = Get-RequiredMapValue -Map $PayloadIdentity -Key 'sourceKind' -Message 'Frozen manifest payloadIdentity.sourceKind is missing.'
  Assert-Condition -Condition ([string]$sourceKind -ceq 'tauri-nsis-main-binary-input') -Message 'Frozen manifest payloadIdentity.sourceKind is unsupported.'
  $sourceRelativePath = Get-RequiredMapValue -Map $PayloadIdentity -Key 'sourceRelativePath' -Message 'Frozen manifest payloadIdentity.sourceRelativePath is missing.'
  $sourceRelativePath = Assert-NsisPayloadSourceRelativePath -RelativePath ([string]$sourceRelativePath)
  $name = Get-RequiredMapValue -Map $PayloadIdentity -Key 'name' -Message 'Frozen manifest payloadIdentity.name is missing.'
  Assert-Condition -Condition ([string]$name -ceq $NsisPayloadName) -Message 'Frozen manifest payloadIdentity.name must be linedog.exe.'
  $length = ConvertTo-PositiveInt64 -Value (Get-RequiredMapValue -Map $PayloadIdentity -Key 'length' -Message 'Frozen manifest payloadIdentity.length is missing.') -Message 'Frozen manifest payloadIdentity.length must be a positive integer.'
  $sha256 = ConvertTo-NormalizedSha256 -Value (Get-RequiredMapValue -Map $PayloadIdentity -Key 'sha256' -Message 'Frozen manifest payloadIdentity.sha256 is missing.') -Message 'Frozen manifest payloadIdentity.sha256 is invalid.'
  $beforeBundle = Get-RequiredMapValue -Map $PayloadIdentity -Key 'beforeBundle' -Message 'Frozen manifest payloadIdentity.beforeBundle is missing.'
  $afterBundle = Get-RequiredMapValue -Map $PayloadIdentity -Key 'afterBundle' -Message 'Frozen manifest payloadIdentity.afterBundle is missing.'
  Assert-Condition -Condition ($beforeBundle -is [System.Collections.IDictionary]) -Message 'Frozen manifest payloadIdentity.beforeBundle is invalid.'
  Assert-Condition -Condition ($afterBundle -is [System.Collections.IDictionary]) -Message 'Frozen manifest payloadIdentity.afterBundle is invalid.'
  $beforeLength = ConvertTo-PositiveInt64 -Value (Get-RequiredMapValue -Map $beforeBundle -Key 'length' -Message 'Frozen manifest payloadIdentity.beforeBundle.length is missing.') -Message 'Frozen manifest payloadIdentity.beforeBundle.length must be a positive integer.'
  $beforeHash = ConvertTo-NormalizedSha256 -Value (Get-RequiredMapValue -Map $beforeBundle -Key 'sha256' -Message 'Frozen manifest payloadIdentity.beforeBundle.sha256 is missing.') -Message 'Frozen manifest payloadIdentity.beforeBundle.sha256 is invalid.'
  $afterLength = ConvertTo-PositiveInt64 -Value (Get-RequiredMapValue -Map $afterBundle -Key 'length' -Message 'Frozen manifest payloadIdentity.afterBundle.length is missing.') -Message 'Frozen manifest payloadIdentity.afterBundle.length must be a positive integer.'
  $afterHash = ConvertTo-NormalizedSha256 -Value (Get-RequiredMapValue -Map $afterBundle -Key 'sha256' -Message 'Frozen manifest payloadIdentity.afterBundle.sha256 is missing.') -Message 'Frozen manifest payloadIdentity.afterBundle.sha256 is invalid.'
  Assert-Condition -Condition ($length -eq $beforeLength -and $length -eq $afterLength -and $sha256 -ceq $beforeHash -and $sha256 -ceq $afterHash) -Message 'Frozen manifest payloadIdentity values must match the build-only and post-bundle identities exactly.'
  return [pscustomobject]@{
    SourceKind = [string]$sourceKind
    SourceRelativePath = $sourceRelativePath
    Name = $NsisPayloadName
    Length = $length
    Sha256 = $sha256
    BeforeBundleLength = $beforeLength
    BeforeBundleSha256 = $beforeHash
    AfterBundleLength = $afterLength
    AfterBundleSha256 = $afterHash
  }
}

function Assert-NsisMainBinarySourceText {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$NsiText,
    [Parameter(Mandatory)][string]$ExpectedMainBinaryPath
  )

  $definitions = @([regex]::Matches($NsiText, '(?m)^\s*!define\s+MAINBINARYSRCPATH\s+"(?<path>[^"\r\n]+)"\s*$'))
  Assert-Condition -Condition ($definitions.Count -eq 1) -Message 'Generated installer.nsi must contain exactly one MAINBINARYSRCPATH definition.'
  $declaredPath = ConvertTo-NormalizedFullPath -Path $definitions[0].Groups['path'].Value
  $expectedPath = ConvertTo-NormalizedFullPath -Path $ExpectedMainBinaryPath
  Assert-Condition -Condition ($declaredPath -ieq $expectedPath) -Message 'Generated installer.nsi MAINBINARYSRCPATH must resolve to the canonical NSIS main binary input.'
  $fileUses = @([regex]::Matches($NsiText, '(?m)^\s*File\s+"\$\{MAINBINARYSRCPATH\}"\s*$'))
  Assert-Condition -Condition ($fileUses.Count -eq 1) -Message 'Generated installer.nsi must directly consume MAINBINARYSRCPATH exactly once.'
  return [pscustomobject]@{ MainBinarySourcePath = $declaredPath }
}

function Assert-GeneratedNsisPayloadSource {
  param([Parameter(Mandatory)][string]$ExpectedMainBinaryPath)

  $expectedRelativePath = 'src-tauri/target/release/nsis/x64/installer.nsi'
  Assert-Condition -Condition ($NsisGeneratedScriptRelativePath -ceq $expectedRelativePath) -Message 'Generated NSIS source script relative path is unsupported.'
  $projectRootPath = ConvertTo-NormalizedFullPath -Path $ProjectRoot
  $candidatePath = ConvertTo-NormalizedFullPath -Path (Join-Path $projectRootPath $NsisGeneratedScriptRelativePath.Replace('/', '\'))
  $expectedPath = ConvertTo-NormalizedFullPath -Path (Join-Path $projectRootPath 'src-tauri\target\release\nsis\x64\installer.nsi')
  Assert-Condition -Condition ($candidatePath -ieq $expectedPath) -Message 'Generated NSIS source script must resolve beneath the project root at the exact x64 path.'
  Assert-Condition -Condition (Test-Path -LiteralPath $candidatePath -PathType Leaf) -Message 'Generated NSIS source script is missing at the exact x64 path.'
  $candidate = Get-Item -LiteralPath $candidatePath -Force -ErrorAction Stop
  Assert-Condition -Condition (-not $candidate.PSIsContainer) -Message 'Generated installer.nsi must be an ordinary file.'
  Assert-Condition -Condition (($candidate.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -Message 'Generated installer.nsi must not be a reparse point.'
  $nsiText = Get-Content -LiteralPath $candidatePath -Raw -Encoding utf8
  return Assert-NsisMainBinarySourceText -NsiText $nsiText -ExpectedMainBinaryPath $ExpectedMainBinaryPath
}

function Assert-NsisBundleInstallerRelativePath {
  param(
    [Parameter(Mandatory)][string]$RelativePath,
    [Parameter(Mandatory)][string]$Version
  )

  $message = 'containerProvenance.sourceBundleInstaller.relativePath must be a canonical direct NSIS bundle installer path.'
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($RelativePath)) -Message $message
  Assert-Condition -Condition ($RelativePath -notmatch '\\') -Message $message
  Assert-Condition -Condition ($RelativePath -notmatch '(^|/)\.{1,2}(/|$)') -Message $message
  $prefix = "$NsisBundleRelativeDirectory/"
  Assert-Condition -Condition ($RelativePath.StartsWith($prefix, [System.StringComparison]::Ordinal)) -Message $message
  $fileName = $RelativePath.Substring($prefix.Length)
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($fileName) -and -not $fileName.Contains('/')) -Message $message
  $versionPattern = '^.+_' + [regex]::Escape($Version) + '_x64-setup\.exe$'
  Assert-Condition -Condition ($fileName -match $versionPattern) -Message $message
  Assert-Condition -Condition ($RelativePath -ceq ($prefix + $fileName)) -Message $message
  return $RelativePath
}

function New-ContainerProvenance {
  param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$SourceRelativePath,
    [Parameter(Mandatory)]$SourceInstallerIdentity,
    [Parameter(Mandatory)][string]$StagedInstallerName,
    [Parameter(Mandatory)]$StagedInstallerIdentity
  )

  $sourcePath = Assert-NsisBundleInstallerRelativePath -RelativePath $SourceRelativePath -Version $Version
  $expectedStagedName = "LineDog_$Version`_x64-setup.exe"
  Assert-Condition -Condition ($StagedInstallerName -ceq $expectedStagedName) -Message 'NSIS staged installer provenance name must match the exact frozen installer asset.'
  $sourceLength = ConvertTo-PositiveInt64 -Value $SourceInstallerIdentity.Length -Message 'NSIS source installer provenance length must be a positive integer.'
  $sourceHash = ConvertTo-NormalizedSha256 -Value $SourceInstallerIdentity.Sha256 -Message 'NSIS source installer provenance SHA-256 is invalid.'
  $stagedLength = ConvertTo-PositiveInt64 -Value $StagedInstallerIdentity.Length -Message 'NSIS staged installer provenance length must be a positive integer.'
  $stagedHash = ConvertTo-NormalizedSha256 -Value $StagedInstallerIdentity.Sha256 -Message 'NSIS staged installer provenance SHA-256 is invalid.'
  Assert-Condition -Condition ($sourceLength -eq $stagedLength -and $sourceHash -ceq $stagedHash) -Message 'NSIS source and staged installer provenance must match exactly.'
  return [ordered]@{
    sourceKind = 'tauri-nsis-bundle'
    sourceBundleInstaller = [ordered]@{
      relativePath = $sourcePath
      length = $sourceLength
      sha256 = $sourceHash
    }
    stagedInstaller = [ordered]@{
      name = $expectedStagedName
      length = $stagedLength
      sha256 = $stagedHash
    }
  }
}

function Assert-FrozenManifestHeader {
  param(
    [Parameter(Mandatory)]$Manifest,
    [Parameter(Mandatory)][string]$Version
  )

  $schema = Get-RequiredMapValue -Map $Manifest -Key 'schema' -Message 'Frozen manifest schema is unsupported.'
  Assert-Condition -Condition ([string]$schema -ceq $FrozenManifestSchema) -Message 'Frozen manifest schema is unsupported.'
  $manifestVersion = Get-RequiredMapValue -Map $Manifest -Key 'version' -Message 'Frozen manifest version does not match the release version.'
  Assert-Condition -Condition ([string]$manifestVersion -eq $Version) -Message 'Frozen manifest version does not match the release version.'
  $stage = Get-RequiredMapValue -Map $Manifest -Key 'stage' -Message 'Frozen manifest stage path is not exact.'
  Assert-Condition -Condition ([string]$stage -ceq ".release/$Version") -Message 'Frozen manifest stage path is not exact.'
}

function Assert-ContainerProvenance {
  param(
    [Parameter(Mandatory)]$ContainerProvenance,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)]$FrozenInstallerAsset
  )

  Assert-Condition -Condition ($ContainerProvenance -is [System.Collections.IDictionary]) -Message 'Frozen manifest containerProvenance is missing.'
  $sourceKind = Get-RequiredMapValue -Map $ContainerProvenance -Key 'sourceKind' -Message 'Frozen manifest containerProvenance.sourceKind is missing.'
  Assert-Condition -Condition ([string]$sourceKind -ceq 'tauri-nsis-bundle') -Message 'Frozen manifest containerProvenance.sourceKind is unsupported.'
  $source = Get-RequiredMapValue -Map $ContainerProvenance -Key 'sourceBundleInstaller' -Message 'Frozen manifest containerProvenance.sourceBundleInstaller is missing.'
  $staged = Get-RequiredMapValue -Map $ContainerProvenance -Key 'stagedInstaller' -Message 'Frozen manifest containerProvenance.stagedInstaller is missing.'
  Assert-Condition -Condition ($source -is [System.Collections.IDictionary]) -Message 'Frozen manifest containerProvenance.sourceBundleInstaller is invalid.'
  Assert-Condition -Condition ($staged -is [System.Collections.IDictionary]) -Message 'Frozen manifest containerProvenance.stagedInstaller is invalid.'

  $sourcePath = Get-RequiredMapValue -Map $source -Key 'relativePath' -Message 'Frozen manifest containerProvenance.sourceBundleInstaller.relativePath is missing.'
  $sourcePath = Assert-NsisBundleInstallerRelativePath -RelativePath ([string]$sourcePath) -Version $Version
  $sourceLength = ConvertTo-PositiveInt64 -Value (Get-RequiredMapValue -Map $source -Key 'length' -Message 'Frozen manifest containerProvenance.sourceBundleInstaller.length is missing.') -Message 'containerProvenance.sourceBundleInstaller.length must be a positive integer.'
  $sourceHash = ConvertTo-NormalizedSha256 -Value (Get-RequiredMapValue -Map $source -Key 'sha256' -Message 'Frozen manifest containerProvenance.sourceBundleInstaller.sha256 is missing.') -Message 'containerProvenance.sourceBundleInstaller.sha256 is invalid.'

  $expectedStagedName = "LineDog_$Version`_x64-setup.exe"
  $stagedName = Get-RequiredMapValue -Map $staged -Key 'name' -Message 'Frozen manifest containerProvenance.stagedInstaller.name is missing.'
  Assert-Condition -Condition ([string]$stagedName -ceq $expectedStagedName) -Message 'containerProvenance.stagedInstaller.name must match frozen installer asset.'
  $stagedLength = ConvertTo-PositiveInt64 -Value (Get-RequiredMapValue -Map $staged -Key 'length' -Message 'Frozen manifest containerProvenance.stagedInstaller.length is missing.') -Message 'containerProvenance.stagedInstaller.length must be a positive integer.'
  $stagedHash = ConvertTo-NormalizedSha256 -Value (Get-RequiredMapValue -Map $staged -Key 'sha256' -Message 'Frozen manifest containerProvenance.stagedInstaller.sha256 is missing.') -Message 'containerProvenance.stagedInstaller.sha256 is invalid.'

  $frozenLength = ConvertTo-PositiveInt64 -Value $FrozenInstallerAsset.Length -Message 'Frozen installer asset length must be a positive integer.'
  $frozenHash = ConvertTo-NormalizedSha256 -Value $FrozenInstallerAsset.Sha256 -Message 'Frozen installer asset SHA-256 is invalid.'
  Assert-Condition -Condition ($sourceLength -eq $stagedLength -and $sourceHash -ceq $stagedHash) -Message 'NSIS source and staged installer provenance must match exactly.'
  Assert-Condition -Condition ($stagedLength -eq $frozenLength) -Message 'containerProvenance.stagedInstaller.length must match frozen installer asset.'
  Assert-Condition -Condition ($stagedHash -ceq $frozenHash) -Message 'containerProvenance.stagedInstaller.sha256 must match frozen installer asset.'
  return [pscustomobject]@{
    SourceKind = [string]$sourceKind
    SourceRelativePath = $sourcePath
    SourceLength = $sourceLength
    SourceSha256 = $sourceHash
    StagedInstallerName = [string]$stagedName
    StagedLength = $stagedLength
    StagedSha256 = $stagedHash
  }
}

function Read-JsonFile {
  param([Parameter(Mandatory)][string]$Path)

  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
  } catch {
    Stop-Release "Cannot parse $Path as JSON: $($_.Exception.Message)"
  }
}

function Write-Utf8File {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Text
  )

  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Command
  )

  Write-Host "==> $Name"
  & $Command 2>&1 | Out-Host
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Stop-Release "$Name exited with code $exitCode."
  }
}

function Assert-PowerShellVersion {
  Assert-Condition -Condition ($PSVersionTable.PSVersion.Major -ge 7) -Message 'PowerShell 7 or later is required.'
}

function Get-VersionFacts {
  $package = Read-JsonFile (Join-Path $ProjectRoot 'package.json')
  $lock = Read-JsonFile (Join-Path $ProjectRoot 'package-lock.json')
  $tauriConfig = Read-JsonFile (Join-Path $ProjectRoot 'src-tauri\tauri.conf.json')
  $cargoText = Get-Content -LiteralPath (Join-Path $ProjectRoot 'src-tauri\Cargo.toml') -Raw -Encoding utf8
  $cargoVersionMatch = [regex]::Match($cargoText, '(?m)^\s*version\s*=\s*"(?<version>[^"]+)"\s*$')
  $cargoAuthorMatch = [regex]::Match($cargoText, '(?m)^\s*authors\s*=\s*\[\s*"(?<author>[^"]+)"\s*\]\s*$')

  Assert-Condition -Condition ($null -ne $lock['packages'] -and $null -ne $lock['packages']['']) -Message 'package-lock.json is missing packages[""] metadata.'
  Assert-Condition -Condition $cargoVersionMatch.Success -Message 'src-tauri/Cargo.toml is missing the package version.'
  Assert-Condition -Condition $cargoAuthorMatch.Success -Message 'src-tauri/Cargo.toml is missing the package author.'
  Assert-Condition -Condition ([string]$package['author'] -eq 'fengni658') -Message 'package.json author must be fengni658.'
  Assert-Condition -Condition ($cargoAuthorMatch.Groups['author'].Value -eq 'fengni658') -Message 'src-tauri/Cargo.toml author must be fengni658.'
  Assert-Condition -Condition ([string]$lock['version'] -eq [string]$lock['packages']['']['version']) -Message 'package-lock.json has inconsistent root versions.'

  $fourVersions = [ordered]@{
    'package.json' = [string]$package['version']
    'package-lock.json' = [string]$lock['version']
    'src-tauri/tauri.conf.json' = [string]$tauriConfig['version']
    'src-tauri/Cargo.toml' = [string]$cargoVersionMatch.Groups['version'].Value
  }
  $distinctVersions = @($fourVersions.Values | Select-Object -Unique)
  Assert-Condition -Condition ($distinctVersions.Count -eq 1) -Message ("Four-way version mismatch: " + (($fourVersions.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '; '))

  $version = $distinctVersions[0]
  Assert-Condition -Condition ($version -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') -Message "Version $version is not valid SemVer."
  return [pscustomobject]@{ Version = $version; TauriConfig = $tauriConfig }
}

function Assert-UpdaterConfiguration {
  param([Parameter(Mandatory)]$TauriConfig)

  $bundle = $TauriConfig['bundle']
  Assert-Condition -Condition ($null -ne $bundle) -Message 'Tauri bundle configuration is missing.'
  Assert-Condition -Condition ([string]$bundle['publisher'] -ceq $ReleasePublisher) -Message 'Tauri bundle.publisher must be explicitly set to fengni658.'
  Assert-Condition -Condition ($null -ne $bundle -and $bundle['createUpdaterArtifacts'] -eq $true) -Message 'Tauri bundle.createUpdaterArtifacts must be true.'
  Assert-Condition -Condition ([string]$bundle['targets'] -eq 'nsis') -Message 'Tauri bundle.targets must be nsis for this release channel.'
  Assert-Condition -Condition ([string]$bundle['windows']['nsis']['installMode'] -eq 'currentUser') -Message 'NSIS installMode must be currentUser.'

  $updater = $TauriConfig['plugins']['updater']
  Assert-Condition -Condition ($null -ne $updater) -Message 'Tauri updater configuration is missing.'
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$updater['pubkey'])) -Message 'Tauri updater public key is missing.'
  Assert-Condition -Condition (@($updater['endpoints']) -contains $UpdaterEndpoint) -Message "Tauri updater endpoints must include $UpdaterEndpoint."
  Assert-Condition -Condition ([string]$updater['windows']['installMode'] -eq 'passive') -Message 'Updater Windows installMode must be passive.'
}

function Get-ExplicitSigningMaterial {
  param([string]$KeyPath, [string]$KeyPassword)

  foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')) {
    Assert-Condition -Condition (-not (Test-Path -LiteralPath ("Env:" + $name))) -Message "Inherited $name is not accepted; use the explicit LineDog signing inputs."
  }
  if ([string]::IsNullOrWhiteSpace($KeyPath)) {
    $KeyPath = [Environment]::GetEnvironmentVariable('LINEDOG_SIGNING_KEY_PATH')
  }
  if ([string]::IsNullOrWhiteSpace($KeyPassword)) {
    $KeyPassword = [Environment]::GetEnvironmentVariable('LINEDOG_SIGNING_KEY_PASSWORD')
  }
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($KeyPath)) -Message 'Signing material is missing: pass -SigningKeyPath or inject LINEDOG_SIGNING_KEY_PATH.'
  Assert-Condition -Condition (Test-Path -LiteralPath $KeyPath -PathType Leaf) -Message 'The explicitly supplied signing key path does not resolve to a file.'
  return [pscustomobject]@{ KeyPath = $KeyPath; KeyPassword = if ($null -eq $KeyPassword) { '' } else { $KeyPassword } }
}

function Assert-GhAuthenticated {
  Assert-Condition -Condition ($null -ne (Get-Command gh -ErrorAction SilentlyContinue)) -Message 'GitHub CLI (gh) is not installed.'
  $null = & gh auth status 2>$null
  if ($LASTEXITCODE -ne 0) {
    Stop-Release 'GH_AUTH_INVALID: GitHub CLI authentication is unavailable for an explicit -Publish request.'
  }
}

function Test-GitHubResourceExists {
  param([Parameter(Mandatory)][string]$Endpoint)
  $output = @(& gh api --include --method GET $Endpoint 2>&1)
  $exitCode = $LASTEXITCODE
  $outputText = $output | Out-String
  if ($exitCode -eq 0) { return $true }
  if ($outputText -match '(?m)^HTTP/\S+\s+404\b') { return $false }
  Stop-Release "Could not determine whether GitHub resource $Endpoint exists (gh exit $exitCode)."
}

function Assert-PublishPreconditions {
  param([Parameter(Mandatory)][string]$Version)

  $worktree = @(& git -C $ProjectRoot status --porcelain)
  Assert-Condition -Condition ($LASTEXITCODE -eq 0) -Message 'Cannot inspect the local integration worktree.'
  Assert-Condition -Condition ($worktree.Count -eq 0) -Message 'Publish requires a clean local integration worktree.'
  $tag = "v$Version"
  if (-not (Test-GitHubResourceExists -Endpoint "/repos/$SourceRepository/git/ref/tags/$tag")) { Stop-Release "Public source tag $tag must exist before binary publication." }
  if (Test-GitHubResourceExists -Endpoint "/repos/$ReleaseRepository/git/ref/tags/$tag") { Stop-Release "Public release tag $tag already exists." }
  if (Test-GitHubResourceExists -Endpoint "/repos/$ReleaseRepository/releases/tags/$tag") { Stop-Release "Public release $tag already exists." }
}

function ConvertTo-NormalizedFullPath {
  param([Parameter(Mandatory)][string]$Path)
  $separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  return ([System.IO.Path]::GetFullPath($Path)).TrimEnd($separators)
}

function Resolve-PublishStageDirectory {
  param([Parameter(Mandatory)][string]$Version)

  Assert-Condition -Condition ($Version -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') -Message "Publish staging version $Version is not valid SemVer."
  $projectRootPath = ConvertTo-NormalizedFullPath -Path $ProjectRoot
  $releaseRootPath = ConvertTo-NormalizedFullPath -Path (Join-Path $projectRootPath '.release')
  $expectedStagePath = ConvertTo-NormalizedFullPath -Path (Join-Path $releaseRootPath $Version)
  $expectedRelativePath = ".release/$Version"
  $actualRelativePath = [System.IO.Path]::GetRelativePath($projectRootPath, $expectedStagePath).Replace('\', '/')
  Assert-Condition -Condition (([System.IO.Path]::GetDirectoryName($expectedStagePath)) -ieq $releaseRootPath) -Message 'Publish staging path must be exactly one direct child of .release.'
  Assert-Condition -Condition ($actualRelativePath -ceq $expectedRelativePath) -Message "Publish staging path must be exactly $expectedRelativePath."
  $releaseRootItem = Get-Item -LiteralPath $releaseRootPath -ErrorAction Stop
  Assert-Condition -Condition (($releaseRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -Message 'Release staging root must not be a reparse point.'
  $ignoreOutput = @(& git -C $projectRootPath check-ignore -v -- $expectedRelativePath)
  $ignoreExitCode = $LASTEXITCODE
  $ignoreText = $ignoreOutput | Out-String
  Assert-Condition -Condition ($ignoreExitCode -eq 0) -Message "Publish staging directory $expectedRelativePath is not ignored."
  Assert-Condition -Condition ($ignoreText -match '(?m)\.gitignore:\d+:\/\.release\/\s+') -Message 'Publish staging directory must be ignored by the repository /.release/ rule.'
  if (-not (Test-Path -LiteralPath $expectedStagePath -PathType Container)) { return $null }

  $stageItem = Get-Item -LiteralPath $expectedStagePath -ErrorAction Stop
  Assert-Condition -Condition (($stageItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -Message 'Release staging directory must not be a reparse point.'
  $resolvedStagePath = ConvertTo-NormalizedFullPath -Path ((Resolve-Path -LiteralPath $expectedStagePath -ErrorAction Stop).Path)
  $resolvedParentPath = ConvertTo-NormalizedFullPath -Path ([System.IO.Path]::GetDirectoryName($resolvedStagePath))
  $resolvedRelativePath = [System.IO.Path]::GetRelativePath($projectRootPath, $resolvedStagePath).Replace('\', '/')
  Assert-Condition -Condition ($resolvedStagePath -ieq $expectedStagePath) -Message 'Resolved publish staging path differs from the exact expected target.'
  Assert-Condition -Condition ($resolvedParentPath -ieq $releaseRootPath) -Message 'Resolved publish staging path is not directly under .release.'
  Assert-Condition -Condition ($resolvedRelativePath -ceq $expectedRelativePath) -Message "Resolved publish staging path must be exactly $expectedRelativePath."
  return $resolvedStagePath
}

function Get-ReleaseAssetNames {
  param([Parameter(Mandatory)][string]$Version)

  return @(
    "LineDog_$($Version)_x64-setup.exe",
    "LineDog_$($Version)_x64-setup.exe.sig",
    'latest.json',
    'SHA256SUMS.txt',
    'FREEWARE-NOTICE.txt',
    'RELEASE-NOTES-zh-CN.md'
  )
}

function Get-ExpectedFrozenManifestPath {
  param([Parameter(Mandatory)][string]$Version)

  $projectRootPath = ConvertTo-NormalizedFullPath -Path $ProjectRoot
  $releaseRootPath = ConvertTo-NormalizedFullPath -Path (Join-Path $projectRootPath '.release')
  return ConvertTo-NormalizedFullPath -Path (Join-Path $releaseRootPath "LineDog-$Version-FROZEN-MANIFEST.json")
}

function Resolve-FrozenManifestPath {
  param(
    [Parameter(Mandatory)][string]$Version,
    [switch]$RequireExisting
  )

  $projectRootPath = ConvertTo-NormalizedFullPath -Path $ProjectRoot
  $releaseRootPath = ConvertTo-NormalizedFullPath -Path (Join-Path $projectRootPath '.release')
  $expectedManifestPath = Get-ExpectedFrozenManifestPath -Version $Version
  $expectedRelativePath = ".release/$([System.IO.Path]::GetFileName($expectedManifestPath))"
  $actualRelativePath = [System.IO.Path]::GetRelativePath($projectRootPath, $expectedManifestPath).Replace('\', '/')
  Assert-Condition -Condition (([System.IO.Path]::GetDirectoryName($expectedManifestPath)) -ieq $releaseRootPath) -Message 'Frozen manifest must be exactly one direct child of .release.'
  Assert-Condition -Condition ($actualRelativePath -ceq $expectedRelativePath) -Message "Frozen manifest path must be exactly $expectedRelativePath."

  $releaseRootItem = Get-Item -LiteralPath $releaseRootPath -ErrorAction Stop
  Assert-Condition -Condition (($releaseRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -Message 'Release staging root must not be a reparse point.'
  $ignoreOutput = @(& git -C $projectRootPath check-ignore -v -- $expectedRelativePath)
  $ignoreExitCode = $LASTEXITCODE
  $ignoreText = $ignoreOutput | Out-String
  Assert-Condition -Condition ($ignoreExitCode -eq 0) -Message "Frozen manifest $expectedRelativePath is not ignored."
  Assert-Condition -Condition ($ignoreText -match '(?m)\.gitignore:\d+:\/\.release\/\s+') -Message 'Frozen manifest must be ignored by the repository /.release/ rule.'

  if (-not (Test-Path -LiteralPath $expectedManifestPath -PathType Leaf)) {
    if ($RequireExisting) {
      Stop-Release "Frozen manifest is missing: $expectedManifestPath."
    }
    return $null
  }

  $manifestItem = Get-Item -LiteralPath $expectedManifestPath -Force -ErrorAction Stop
  Assert-Condition -Condition (($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -Message 'Frozen manifest must not be a reparse point.'
  $resolvedManifestPath = ConvertTo-NormalizedFullPath -Path ((Resolve-Path -LiteralPath $expectedManifestPath -ErrorAction Stop).Path)
  Assert-Condition -Condition ($resolvedManifestPath -ieq $expectedManifestPath) -Message 'Resolved frozen manifest path differs from the exact expected target.'
  return $resolvedManifestPath
}

function Remove-ExistingReleasePreparation {
  param([Parameter(Mandatory)][string]$Version)

  $stageDirectory = Resolve-PublishStageDirectory -Version $Version
  $frozenManifest = Resolve-FrozenManifestPath -Version $Version
  if ($null -ne $stageDirectory) {
    Remove-Item -LiteralPath $stageDirectory -Recurse -Force -ErrorAction Stop
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $stageDirectory)) -Message "Publish staging directory was not removed: $stageDirectory."
  }
  if ($null -ne $frozenManifest) {
    Remove-Item -LiteralPath $frozenManifest -Force -ErrorAction Stop
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $frozenManifest)) -Message "Frozen manifest was not removed: $frozenManifest."
  }
}

function Write-FrozenReleaseManifest {
  param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)]$PreparedAssets
  )

  $stageDirectory = Resolve-PublishStageDirectory -Version $Version
  Assert-Condition -Condition ($null -ne $stageDirectory) -Message 'Cannot freeze a missing release stage.'
  Assert-Condition -Condition ((ConvertTo-NormalizedFullPath -Path $PreparedAssets.StageDirectory) -ieq $stageDirectory) -Message 'Prepared assets do not point to the exact release stage.'
  $existingManifest = Resolve-FrozenManifestPath -Version $Version
  Assert-Condition -Condition ($null -eq $existingManifest) -Message 'Refusing to overwrite an existing frozen manifest.'
  $manifestPath = Get-ExpectedFrozenManifestPath -Version $Version
  $assetNames = Get-ReleaseAssetNames -Version $Version
  $assets = foreach ($assetName in $assetNames) {
    $assetPath = Join-Path $stageDirectory $assetName
    $assetItem = Get-Item -LiteralPath $assetPath -Force -ErrorAction Stop
    Assert-Condition -Condition (-not $assetItem.PSIsContainer) -Message "Frozen asset is not a file: $assetName."
    Assert-Condition -Condition (($assetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -Message "Frozen asset must not be a reparse point: $assetName."
    [ordered]@{
      name = $assetName
      length = [int64]$assetItem.Length
      sha256 = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToUpperInvariant()
    }
  }
  $installerAssetName = "LineDog_$Version`_x64-setup.exe"
  $installerAssets = @($assets | Where-Object { [string]$_['name'] -ceq $installerAssetName })
  Assert-Condition -Condition ($installerAssets.Count -eq 1) -Message 'Frozen manifest installer asset is missing or duplicated.'
  Assert-Condition -Condition ($null -ne $PreparedAssets.PSObject.Properties['ContainerProvenance']) -Message 'Prepared assets are missing NSIS container provenance.'
  Assert-Condition -Condition ($null -ne $PreparedAssets.PSObject.Properties['PayloadIdentity']) -Message 'Prepared assets are missing NSIS payload identity.'
  $containerProvenance = $PreparedAssets.ContainerProvenance
  $payloadIdentity = $PreparedAssets.PayloadIdentity
  $frozenInstallerAsset = [pscustomobject]@{
    Length = [int64]$installerAssets[0]['length']
    Sha256 = [string]$installerAssets[0]['sha256']
  }
  $null = Assert-ContainerProvenance -ContainerProvenance $containerProvenance -Version $Version -FrozenInstallerAsset $frozenInstallerAsset
  $null = Assert-PayloadIdentity -PayloadIdentity $payloadIdentity
  $manifest = [ordered]@{
    schema = $FrozenManifestSchema
    version = $Version
    stage = ".release/$Version"
    assets = @($assets)
    containerProvenance = $containerProvenance
    payloadIdentity = $payloadIdentity
  }
  Write-Utf8File -Path $manifestPath -Text (($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
  return $manifestPath
}

function Assert-FrozenReleaseManifest {
  param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$ManifestPath
  )

  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($ManifestPath)) -Message 'Frozen manifest path is required.'
  $expectedManifestPath = Resolve-FrozenManifestPath -Version $Version -RequireExisting
  $suppliedManifestPath = ConvertTo-NormalizedFullPath -Path $ManifestPath
  Assert-Condition -Condition ($suppliedManifestPath -ieq $expectedManifestPath) -Message 'Frozen manifest path must resolve to the exact versioned .release sibling.'
  $manifest = Read-JsonFile -Path $expectedManifestPath
  Assert-FrozenManifestHeader -Manifest $manifest -Version $Version
  Assert-Condition -Condition ($manifest.Contains('assets')) -Message 'Frozen manifest assets are missing.'

  $assetNames = Get-ReleaseAssetNames -Version $Version
  $manifestAssets = @($manifest['assets'])
  Assert-Condition -Condition ($manifestAssets.Count -eq $assetNames.Count) -Message 'Frozen manifest must describe exactly six release assets.'
  $assetIndex = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
  foreach ($asset in $manifestAssets) {
    Assert-Condition -Condition ($null -ne $asset -and $asset.Contains('name') -and $asset.Contains('length') -and $asset.Contains('sha256')) -Message 'Frozen manifest asset is missing a required field.'
    $assetName = [string]$asset['name']
    $assetLength = [int64]$asset['length']
    $assetHash = [string]$asset['sha256']
    Assert-Condition -Condition ($assetName -in $assetNames) -Message "Frozen manifest contains an unexpected asset: $assetName."
    Assert-Condition -Condition (-not $assetIndex.ContainsKey($assetName)) -Message "Frozen manifest contains a duplicate asset: $assetName."
    Assert-Condition -Condition ($assetLength -ge 0) -Message "Frozen manifest length is invalid for $assetName."
    Assert-Condition -Condition ($assetHash -match '^[0-9A-F]{64}$') -Message "Frozen manifest SHA-256 is invalid for $assetName."
    $assetIndex.Add($assetName, [pscustomobject]@{ Length = $assetLength; Sha256 = $assetHash })
  }
  foreach ($assetName in $assetNames) {
    Assert-Condition -Condition ($assetIndex.ContainsKey($assetName)) -Message "Frozen manifest is missing release asset: $assetName."
  }
  $installerAssetName = "LineDog_$Version`_x64-setup.exe"
  $containerProvenance = Get-RequiredMapValue -Map $manifest -Key 'containerProvenance' -Message 'Frozen manifest containerProvenance is missing.'
  $payloadIdentity = Get-RequiredMapValue -Map $manifest -Key 'payloadIdentity' -Message 'Frozen manifest payloadIdentity is missing.'
  $validatedContainerProvenance = Assert-ContainerProvenance -ContainerProvenance $containerProvenance -Version $Version -FrozenInstallerAsset $assetIndex[$installerAssetName]
  $validatedPayloadIdentity = Assert-PayloadIdentity -PayloadIdentity $payloadIdentity
  return [pscustomobject]@{ Path = $expectedManifestPath; AssetIndex = $assetIndex; ContainerProvenance = $validatedContainerProvenance; PayloadIdentity = $validatedPayloadIdentity }
}

function Assert-StageMetadataContract {
  param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$StageDirectory
  )

  $installer = Join-Path $StageDirectory "LineDog_$($Version)_x64-setup.exe"
  $signaturePath = "$installer.sig"
  $latestJsonPath = Join-Path $StageDirectory 'latest.json'
  $checksumsPath = Join-Path $StageDirectory 'SHA256SUMS.txt'
  $noticePath = Join-Path $StageDirectory 'FREEWARE-NOTICE.txt'
  $notesPath = Join-Path $StageDirectory 'RELEASE-NOTES-zh-CN.md'
  $signature = [System.IO.File]::ReadAllText($signaturePath, [System.Text.Encoding]::UTF8).Trim()
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($signature)) -Message 'Updater signature file is empty.'

  $latest = Read-JsonFile -Path $latestJsonPath
  Assert-Condition -Condition ([string]$latest['version'] -eq $Version) -Message 'latest.json version does not match the frozen stage.'
  $platforms = $latest['platforms']
  Assert-Condition -Condition ($null -ne $platforms -and @($platforms.Keys).Count -eq 1 -and $platforms.Contains($WindowsTarget)) -Message 'latest.json must describe exactly the windows-x86_64 updater target.'
  $platform = $platforms[$WindowsTarget]
  Assert-Condition -Condition ($null -ne $platform -and [string]$platform['signature'] -eq $signature) -Message 'latest.json signature does not match the staged signature file.'
  $expectedUrl = "https://github.com/$ReleaseRepository/releases/download/v$Version/LineDog_$($Version)_x64-setup.exe"
  Assert-Condition -Condition ([string]$platform['url'] -eq $expectedUrl) -Message 'latest.json updater URL does not match the frozen installer.'

  $checksumMap = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
  $invalidChecksumLines = 0
  foreach ($line in ((Get-Content -LiteralPath $checksumsPath -Raw -Encoding utf8) -split "\r?\n")) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -match '^(?<hash>[0-9A-Fa-f]{64})\s+\*?(?<name>.+)$') {
      $name = $matches['name'].Trim()
      if ($checksumMap.ContainsKey($name)) {
        $invalidChecksumLines++
      } else {
        $checksumMap.Add($name, $matches['hash'].ToUpperInvariant())
      }
    } else {
      $invalidChecksumLines++
    }
  }
  $checksummedNames = @(
    [System.IO.Path]::GetFileName($installer),
    [System.IO.Path]::GetFileName($signaturePath),
    [System.IO.Path]::GetFileName($latestJsonPath),
    [System.IO.Path]::GetFileName($noticePath),
    [System.IO.Path]::GetFileName($notesPath)
  )
  Assert-Condition -Condition ($invalidChecksumLines -eq 0 -and $checksumMap.Count -eq $checksummedNames.Count) -Message 'SHA256SUMS.txt must contain exactly the five non-checksum release assets.'
  foreach ($name in $checksummedNames) {
    Assert-Condition -Condition ($checksumMap.ContainsKey($name)) -Message "SHA256SUMS.txt is missing $name."
    $actualHash = (Get-FileHash -LiteralPath (Join-Path $StageDirectory $name) -Algorithm SHA256).Hash.ToUpperInvariant()
    Assert-Condition -Condition ($checksumMap[$name] -eq $actualHash) -Message "SHA256SUMS.txt does not match $name."
  }
}

function Assert-FrozenStageContract {
  param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$ManifestPath
  )

  $stageDirectory = Resolve-PublishStageDirectory -Version $Version
  Assert-Condition -Condition ($null -ne $stageDirectory) -Message 'Frozen stage directory is missing.'
  $frozenManifest = Assert-FrozenReleaseManifest -Version $Version -ManifestPath $ManifestPath
  $assetNames = Get-ReleaseAssetNames -Version $Version
  $stageEntries = @(Get-ChildItem -LiteralPath $stageDirectory -Force -ErrorAction Stop)
  $stageNames = @($stageEntries | ForEach-Object { $_.Name })
  Assert-Condition -Condition ($stageEntries.Count -eq $assetNames.Count) -Message 'Frozen stage must contain exactly six entries.'
  Assert-Condition -Condition (@($stageEntries | Where-Object { $_.PSIsContainer -or (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) }).Count -eq 0) -Message 'Frozen stage may contain only ordinary non-reparse files.'
  Assert-Condition -Condition (@($assetNames | Where-Object { $_ -notin $stageNames }).Count -eq 0) -Message 'Frozen stage is missing a required release asset.'
  Assert-Condition -Condition (@($stageNames | Where-Object { $_ -notin $assetNames }).Count -eq 0) -Message 'Frozen stage contains an unexpected release asset.'
  foreach ($assetName in $assetNames) {
    $assetPath = Join-Path $stageDirectory $assetName
    $assetItem = Get-Item -LiteralPath $assetPath -Force -ErrorAction Stop
    $frozenAsset = $frozenManifest.AssetIndex[$assetName]
    $actualHash = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToUpperInvariant()
    Assert-Condition -Condition ([int64]$assetItem.Length -eq $frozenAsset.Length) -Message "Frozen length mismatch for $assetName."
    Assert-Condition -Condition ($actualHash -eq $frozenAsset.Sha256) -Message "Frozen SHA-256 mismatch for $assetName."
  }
  Assert-StageMetadataContract -Version $Version -StageDirectory $stageDirectory
  return [pscustomobject]@{
    StageDirectory = $stageDirectory
    Installer = Join-Path $stageDirectory "LineDog_$($Version)_x64-setup.exe"
    Signature = Join-Path $stageDirectory "LineDog_$($Version)_x64-setup.exe.sig"
    LatestJson = Join-Path $stageDirectory 'latest.json'
    Checksums = Join-Path $stageDirectory 'SHA256SUMS.txt'
    Notice = Join-Path $stageDirectory 'FREEWARE-NOTICE.txt'
    Notes = Join-Path $stageDirectory 'RELEASE-NOTES-zh-CN.md'
    FrozenManifest = $frozenManifest.Path
  }
}

function Invoke-ReleaseBuild {
  param([Parameter(Mandatory)]$SigningMaterial)

  $null = Invoke-CheckedCommand -Name 'npm test' -Command { & npm test }
  $null = Invoke-CheckedCommand -Name 'npm run typecheck' -Command { & npm run typecheck }
  $null = Invoke-CheckedCommand -Name 'npm run build' -Command { & npm run build }
  Push-Location -LiteralPath (Join-Path $ProjectRoot 'src-tauri')
  try {
    $null = Invoke-CheckedCommand -Name 'cargo fmt --check' -Command { & cargo fmt --check }
    $null = Invoke-CheckedCommand -Name 'cargo check' -Command { & cargo check }
    $null = Invoke-CheckedCommand -Name 'cargo test' -Command { & cargo test }
  } finally {
    Pop-Location
  }
  try {
    $env:TAURI_SIGNING_PRIVATE_KEY = $SigningMaterial.KeyPath
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $SigningMaterial.KeyPassword
    $null = Invoke-CheckedCommand -Name 'npm run tauri -- build --no-bundle --ci' -Command { & npm run tauri -- build --no-bundle --ci }
    $payloadSourcePath = Get-NsisPayloadSourcePath
    $beforeBundleIdentity = Get-RegularFileIdentity -Path $payloadSourcePath -Label 'NSIS main binary input after build-only'
    $null = Invoke-CheckedCommand -Name 'npm run tauri -- bundle --bundles nsis --ci' -Command { & npm run tauri -- bundle --bundles nsis --ci }
    $afterBundleIdentity = Get-RegularFileIdentity -Path $payloadSourcePath -Label 'NSIS main binary input after bundle'
    $payloadIdentity = New-PayloadIdentity -SourceRelativePath $NsisPayloadSourceRelativePath -Name $NsisPayloadName -BeforeBundleIdentity $beforeBundleIdentity -AfterBundleIdentity $afterBundleIdentity
    $null = Assert-GeneratedNsisPayloadSource -ExpectedMainBinaryPath $payloadSourcePath
    return $payloadIdentity
  } finally {
    Remove-Item -LiteralPath 'Env:TAURI_SIGNING_PRIVATE_KEY' -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath 'Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD' -ErrorAction SilentlyContinue
  }
}

function Assert-ReleaseSourceAssets {
  param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)]$PayloadIdentity
  )

  $null = Assert-PayloadIdentity -PayloadIdentity $PayloadIdentity
  $nsisDirectory = Join-Path $ProjectRoot 'src-tauri\target\release\bundle\nsis'
  Assert-Condition -Condition (Test-Path -LiteralPath $nsisDirectory -PathType Container) -Message 'NSIS bundle directory is missing.'
  $installerCandidates = @(Get-ChildItem -LiteralPath $nsisDirectory -File -Filter "*_$Version`_x64-setup.exe")
  Assert-Condition -Condition ($installerCandidates.Count -eq 1) -Message "Expected exactly one NSIS installer for $Version."
  $sourceInstaller = $installerCandidates[0]
  $sourceSignature = "$($sourceInstaller.FullName).sig"
  Assert-Condition -Condition (Test-Path -LiteralPath $sourceSignature -PathType Leaf) -Message "Updater signature is missing beside $($sourceInstaller.Name)."
  $projectRootPath = ConvertTo-NormalizedFullPath -Path $ProjectRoot
  $sourceRelativePath = [System.IO.Path]::GetRelativePath($projectRootPath, $sourceInstaller.FullName).Replace('\', '/')
  $sourceInstallerIdentity = Get-RegularFileIdentity -Path $sourceInstaller.FullName -Label 'NSIS source installer'
  return [pscustomobject]@{
    SourceInstaller = $sourceInstaller.FullName
    SourceSignature = $sourceSignature
    SourceRelativePath = $sourceRelativePath
    SourceInstallerIdentity = $sourceInstallerIdentity
  }
}

function Prepare-ReleaseAssets {
  param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)]$PayloadIdentity
  )
  $null = Assert-PayloadIdentity -PayloadIdentity $PayloadIdentity
  $nsisDirectory = Join-Path $ProjectRoot 'src-tauri\target\release\bundle\nsis'
  Assert-Condition -Condition (Test-Path -LiteralPath $nsisDirectory -PathType Container) -Message 'NSIS bundle directory is missing.'
  $installerCandidates = @(Get-ChildItem -LiteralPath $nsisDirectory -File -Filter "*_$Version`_x64-setup.exe")
  Assert-Condition -Condition ($installerCandidates.Count -eq 1) -Message "Expected exactly one NSIS installer for $Version."
  $sourceInstaller = $installerCandidates[0]
  $sourceSignature = "$($sourceInstaller.FullName).sig"
  Assert-Condition -Condition (Test-Path -LiteralPath $sourceSignature -PathType Leaf) -Message "Updater signature is missing beside $($sourceInstaller.Name)."
  $projectRootPath = ConvertTo-NormalizedFullPath -Path $ProjectRoot
  $sourceRelativePath = [System.IO.Path]::GetRelativePath($projectRootPath, $sourceInstaller.FullName).Replace('\', '/')
  $sourceInstallerIdentity = Get-RegularFileIdentity -Path $sourceInstaller.FullName -Label 'NSIS source installer'

  $stageDirectory = Join-Path $ProjectRoot ".release\$Version"
  Assert-Condition -Condition (-not (Test-Path -LiteralPath $stageDirectory)) -Message "Staging directory already exists: $stageDirectory. Refusing to overwrite."
  $null = New-Item -ItemType Directory -Path $stageDirectory -ErrorAction Stop
  $releaseInstaller = Join-Path $stageDirectory "LineDog_$Version`_x64-setup.exe"
  $releaseSignature = "$releaseInstaller.sig"
  $releaseNotice = Join-Path $stageDirectory 'FREEWARE-NOTICE.txt'
  $notesPath = Join-Path $stageDirectory 'RELEASE-NOTES-zh-CN.md'
  $latestJsonPath = Join-Path $stageDirectory 'latest.json'
  $checksumsPath = Join-Path $stageDirectory 'SHA256SUMS.txt'
  Copy-Item -LiteralPath $sourceInstaller.FullName -Destination $releaseInstaller -ErrorAction Stop
  Copy-Item -LiteralPath $sourceSignature -Destination $releaseSignature -ErrorAction Stop
  Copy-Item -LiteralPath (Join-Path $ProjectRoot 'FREEWARE-NOTICE.txt') -Destination $releaseNotice -ErrorAction Stop
  $stagedInstallerIdentity = Get-RegularFileIdentity -Path $releaseInstaller -Label 'Staged NSIS installer'
  $containerProvenance = New-ContainerProvenance -Version $Version -SourceRelativePath $sourceRelativePath -SourceInstallerIdentity $sourceInstallerIdentity -StagedInstallerName ([System.IO.Path]::GetFileName($releaseInstaller)) -StagedInstallerIdentity $stagedInstallerIdentity

  $notes = @"
# 线条小狗桌宠 v$Version

- Windows 11 x64
- unsigned NSIS current-user installer
- Tray 中由用户主动检查更新；Windows 使用 passive 安装语义
- 签名、Microsoft Store/MSIX 与后台自动更新不在本次发布范围
"@.Trim() + [Environment]::NewLine
  Write-Utf8File -Path $notesPath -Text $notes
  $signature = [System.IO.File]::ReadAllText($releaseSignature, [System.Text.Encoding]::UTF8).Trim()
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($signature)) -Message 'Updater signature file is empty.'
  $platforms = [ordered]@{}
  $platforms[$WindowsTarget] = [ordered]@{ signature = $signature; url = "https://github.com/$ReleaseRepository/releases/download/v$Version/LineDog_$Version`_x64-setup.exe" }
  $latest = [ordered]@{ version = $Version; notes = $notes.Trim(); pub_date = (Get-Date).ToUniversalTime().ToString('o'); platforms = $platforms }
  Write-Utf8File -Path $latestJsonPath -Text (($latest | ConvertTo-Json -Depth 6) + [Environment]::NewLine)
  $checksummedAssets = @($releaseInstaller, $releaseSignature, $latestJsonPath, $releaseNotice, $notesPath)
  $checksumLines = foreach ($asset in $checksummedAssets) {
    $hash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToUpperInvariant()
    '{0} *{1}' -f $hash, [System.IO.Path]::GetFileName($asset)
  }
  Write-Utf8File -Path $checksumsPath -Text (($checksumLines -join [Environment]::NewLine) + [Environment]::NewLine)
  return [pscustomobject]@{ StageDirectory = $stageDirectory; Installer = $releaseInstaller; Signature = $releaseSignature; LatestJson = $latestJsonPath; Checksums = $checksumsPath; Notice = $releaseNotice; Notes = $notesPath; ContainerProvenance = $containerProvenance; PayloadIdentity = $PayloadIdentity }
}

function Publish-Release {
  param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)]$PreparedAssets)
  $tag = "v$Version"
  $assets = @($PreparedAssets.Installer, $PreparedAssets.Signature, $PreparedAssets.LatestJson, $PreparedAssets.Checksums, $PreparedAssets.Notice, $PreparedAssets.Notes)
  $null = Invoke-CheckedCommand -Name "gh release create $tag" -Command {
    & gh release create $tag @assets --repo $ReleaseRepository --target main --title "LineDog v$Version" --notes-file $PreparedAssets.Notes
  }
}

function Invoke-ReleaseWorkflow {
  Assert-PowerShellVersion
  $versionFacts = Get-VersionFacts
  Assert-UpdaterConfiguration -TauriConfig $versionFacts.TauriConfig
  Assert-Condition -Condition (-not ($Publish -and $ValidateFrozenStage)) -Message '-Publish and -ValidateFrozenStage cannot be combined.'
  if ($Publish) {
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($FrozenManifestPath)) -Message 'FrozenManifestPath is required for -Publish.'
    $preparedAssets = Assert-FrozenStageContract -Version $versionFacts.Version -ManifestPath $FrozenManifestPath
    Assert-GhAuthenticated
    Assert-PublishPreconditions -Version $versionFacts.Version
    Publish-Release -Version $versionFacts.Version -PreparedAssets $preparedAssets
    Write-Host "Published $($versionFacts.Version) assets to $ReleaseRepository."
  } elseif ($ValidateFrozenStage) {
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($FrozenManifestPath)) -Message 'FrozenManifestPath is required for -ValidateFrozenStage.'
    $preparedAssets = Assert-FrozenStageContract -Version $versionFacts.Version -ManifestPath $FrozenManifestPath
    Write-Host "Verified frozen $($versionFacts.Version) assets at $($preparedAssets.StageDirectory). No build, Git, or GitHub write was performed."
  } else {
    $signingMaterial = Get-ExplicitSigningMaterial -KeyPath $SigningKeyPath -KeyPassword $SigningKeyPassword
    $payloadIdentity = Invoke-ReleaseBuild -SigningMaterial $signingMaterial
    $null = Assert-PayloadIdentity -PayloadIdentity $payloadIdentity
    $null = Assert-ReleaseSourceAssets -Version $versionFacts.Version -PayloadIdentity $payloadIdentity
    Remove-ExistingReleasePreparation -Version $versionFacts.Version
    $preparedAssets = Prepare-ReleaseAssets -Version $versionFacts.Version -PayloadIdentity $payloadIdentity
    $frozenManifest = Write-FrozenReleaseManifest -Version $versionFacts.Version -PreparedAssets $preparedAssets
    Write-Host "Prepared and froze $($versionFacts.Version) assets at $($preparedAssets.StageDirectory). Frozen manifest: $frozenManifest. No Git or GitHub write was performed."
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-ReleaseWorkflow
}
