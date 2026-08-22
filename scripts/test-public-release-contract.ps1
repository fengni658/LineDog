[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$publishScript = Join-Path $PSScriptRoot 'publish-release.ps1'
$exportScript = Join-Path $PSScriptRoot 'export-public-source.ps1'
$outputDirectory = Join-Path $projectRoot '.public-source\contract-test'

function Assert-Contract {
  param(
    [Parameter(Mandatory)][bool]$Condition,
    [Parameter(Mandatory)][string]$Message
  )

  if (-not $Condition) {
    throw "Release contract failed: $Message"
  }
}

function Assert-Throws {
  param(
    [Parameter(Mandatory)][scriptblock]$Action,
    [Parameter(Mandatory)][string]$ExpectedMessage
  )

  $caught = $null
  try {
    & $Action
  } catch {
    $caught = $_
  }
  Assert-Contract -Condition ($null -ne $caught) -Message "Expected failure was not raised: $ExpectedMessage"
  Assert-Contract -Condition ($caught.Exception.Message -match [regex]::Escape($ExpectedMessage)) -Message "Expected failure '$ExpectedMessage', got '$($caught.Exception.Message)'."
}

function New-ValidTauriConfiguration {
  return [ordered]@{
    bundle = [ordered]@{
      publisher = 'fengni658'
      createUpdaterArtifacts = $true
      targets = 'nsis'
      windows = [ordered]@{ nsis = [ordered]@{ installMode = 'currentUser' } }
    }
    plugins = [ordered]@{
      updater = [ordered]@{
        pubkey = 'contract-test-public-key'
        endpoints = @('https://github.com/fengni658/LineDog-Releases/releases/latest/download/latest.json')
        windows = [ordered]@{ installMode = 'passive' }
      }
    }
  }
}

function Copy-ContractValue {
  param([Parameter(Mandatory)]$Value)

  return ($Value | ConvertTo-Json -Depth 12 | ConvertFrom-Json -AsHashtable)
}

function Get-FunctionText {
  param(
    [Parameter(Mandatory)][string]$Text,
    [Parameter(Mandatory)][string]$Name
  )

  $pattern = '(?ms)^function\s+' + [regex]::Escape($Name) + '\s*\{(?<body>.*?)(?=^function\s+|\z)'
  $match = [regex]::Match($Text, $pattern)
  Assert-Contract -Condition $match.Success -Message "Expected function is missing: $Name."
  return $match.Groups['body'].Value
}

Assert-Contract -Condition (Test-Path -LiteralPath $publishScript -PathType Leaf) -Message 'publish-release.ps1 is missing.'
Assert-Contract -Condition (Test-Path -LiteralPath $exportScript -PathType Leaf) -Message 'export-public-source.ps1 is missing.'

$publishText = Get-Content -LiteralPath $publishScript -Raw -Encoding utf8
Assert-Contract -Condition ($publishText -match "fengni658/LineDog'") -Message 'SOURCE_REPO must be fengni658/LineDog.'
Assert-Contract -Condition ($publishText -match "fengni658/LineDog-Releases'") -Message 'RELEASE_REPO must be fengni658/LineDog-Releases.'
Assert-Contract -Condition ($publishText -match '\$FrozenManifestSchema = ''linedog.release-freeze/v3''') -Message 'Frozen manifest schema must be linedog.release-freeze/v3.'
Assert-Contract -Condition ($publishText -match 'function\s+New-ContainerProvenance') -Message 'Local preparation must construct NSIS container provenance.'
Assert-Contract -Condition ($publishText -match 'function\s+Assert-ContainerProvenance') -Message 'Frozen manifest validation must validate NSIS container provenance.'
Assert-Contract -Condition ($publishText -match 'function\s+New-PayloadIdentity') -Message 'Local preparation must construct NSIS main-binary payload identity.'
Assert-Contract -Condition ($publishText -match 'function\s+Assert-PayloadIdentity') -Message 'Frozen manifest validation must validate NSIS main-binary payload identity.'
Assert-Contract -Condition ($publishText -match 'function\s+Assert-NsisMainBinarySourceText') -Message 'Local preparation must validate generated NSIS main-binary source declarations.'
Assert-Contract -Condition ($publishText -match "sourceKind = 'tauri-nsis-bundle'") -Message 'Container provenance must bind the Tauri NSIS bundle source kind.'
Assert-Contract -Condition ($publishText -match "sourceBundleInstaller") -Message 'Container provenance must bind the source bundle installer.'
Assert-Contract -Condition ($publishText -match "stagedInstaller") -Message 'Container provenance must bind the staged installer.'
Assert-Contract -Condition ($publishText -match "sourceKind = 'tauri-nsis-main-binary-input'") -Message 'Payload identity must bind the Tauri NSIS main binary input source kind.'
Assert-Contract -Condition ($publishText -match "sourceRelativePath = 'src-tauri/target/release/linedog.exe'") -Message 'Payload identity must bind the canonical project-relative main binary input path.'
Assert-Contract -Condition ($publishText -match 'beforeBundle') -Message 'Payload identity must retain the build-only input identity.'
Assert-Contract -Condition ($publishText -match 'afterBundle') -Message 'Payload identity must retain the post-bundle input identity.'
Assert-Contract -Condition ($publishText -match '\[''publisher''\].*-ceq.*\$ReleasePublisher') -Message 'Release preparation must require the explicit configured Tauri bundle.publisher.'
Assert-Contract -Condition ($publishText -match '\[string\]\$SigningKeyPath') -Message 'Signing key injection must use an explicit parameter.'
Assert-Contract -Condition ($publishText -match 'LINEDOG_SIGNING_KEY_PATH') -Message 'Signing key injection must support the explicit LineDog environment variable.'
Assert-Contract -Condition ($publishText -match 'cargo test') -Message 'Local release gate must include cargo test.'
Assert-Contract -Condition ($publishText -match '\[string\]\$FrozenManifestPath') -Message 'Publish must require an explicit frozen manifest parameter.'
Assert-Contract -Condition ($publishText -match '\[switch\]\$ValidateFrozenStage') -Message 'Release script must provide a no-remote frozen-stage validation mode.'
Assert-Contract -Condition ($publishText -match 'function\s+Write-FrozenReleaseManifest') -Message 'Local preparation must write a frozen release manifest.'
Assert-Contract -Condition ($publishText -match 'function\s+Assert-FrozenReleaseManifest') -Message 'Publish must validate the explicit frozen release manifest.'
Assert-Contract -Condition ($publishText -match 'function\s+Assert-FrozenStageContract') -Message 'Publish must validate the existing frozen stage without rebuilding it.'
Assert-Contract -Condition ($publishText -match 'FrozenManifestPath is required for -Publish') -Message 'Publish must fail closed before any build or remote action when its manifest is absent.'
$releaseAssetPatterns = @(
  'LineDog_\$\(\$Version\)_x64-setup\.exe',
  'LineDog_\$\(\$Version\)_x64-setup\.exe\.sig',
  [regex]::Escape('latest.json'),
  [regex]::Escape('SHA256SUMS.txt'),
  [regex]::Escape('FREEWARE-NOTICE.txt'),
  [regex]::Escape('RELEASE-NOTES-zh-CN.md')
)
foreach ($releaseAssetPattern in $releaseAssetPatterns) {
  Assert-Contract -Condition ($publishText -match $releaseAssetPattern) -Message "Frozen handoff is missing required asset contract: $releaseAssetPattern."
}

$releaseBuildText = Get-FunctionText -Text $publishText -Name 'Invoke-ReleaseBuild'
$buildOnlyCommand = 'npm run tauri -- build --no-bundle --ci'
$bundleCommand = 'npm run tauri -- bundle --bundles nsis --ci'
Assert-Contract -Condition ($releaseBuildText -match [regex]::Escape($buildOnlyCommand)) -Message 'Release preparation must invoke Tauri build-only with --no-bundle.'
Assert-Contract -Condition ($releaseBuildText -match [regex]::Escape($bundleCommand)) -Message 'Release preparation must invoke Tauri NSIS bundle with --bundles nsis.'

$generatedNsisSourceText = Get-FunctionText -Text $publishText -Name 'Assert-GeneratedNsisPayloadSource'
$expectedGeneratedNsisSourceRelativePath = 'src-tauri/target/release/nsis/x64/installer.nsi'
Assert-Contract -Condition ($generatedNsisSourceText -notmatch [regex]::Escape('src-tauri\target\release\bundle\nsis')) -Message 'Generated NSIS source gate must not search the bundle asset directory for installer.nsi.'
Assert-Contract -Condition ($generatedNsisSourceText -notmatch 'Get-ChildItem\s+.*-Recurse') -Message 'Generated NSIS source gate must not recursively search for installer.nsi.'
Assert-Contract -Condition ($generatedNsisSourceText -match [regex]::Escape($expectedGeneratedNsisSourceRelativePath)) -Message 'Generated NSIS source gate must read the exact retained x64 installer.nsi path.'

$buildOnlyIndex = $releaseBuildText.IndexOf($buildOnlyCommand, [System.StringComparison]::Ordinal)
$beforeIdentityIndex = $releaseBuildText.IndexOf('$beforeBundleIdentity', [System.StringComparison]::Ordinal)
$bundleIndex = $releaseBuildText.IndexOf($bundleCommand, [System.StringComparison]::Ordinal)
$afterIdentityIndex = $releaseBuildText.IndexOf('$afterBundleIdentity', [System.StringComparison]::Ordinal)
$nsiVerificationIndex = $releaseBuildText.IndexOf('Assert-GeneratedNsisPayloadSource', [System.StringComparison]::Ordinal)
Assert-Contract -Condition ($buildOnlyIndex -ge 0 -and $beforeIdentityIndex -gt $buildOnlyIndex -and $bundleIndex -gt $beforeIdentityIndex -and $afterIdentityIndex -gt $bundleIndex -and $nsiVerificationIndex -gt $afterIdentityIndex) -Message 'Release preparation must fence the main binary before and after NSIS bundle generation before validating generated source declarations.'

$workflowText = Get-FunctionText -Text $publishText -Name 'Invoke-ReleaseWorkflow'
$payloadFenceIndex = $workflowText.IndexOf('$payloadIdentity = Invoke-ReleaseBuild', [System.StringComparison]::Ordinal)
$removeStageIndex = $workflowText.IndexOf('Remove-ExistingReleasePreparation', [System.StringComparison]::Ordinal)
$prepareAssetsIndex = $workflowText.IndexOf('Prepare-ReleaseAssets', [System.StringComparison]::Ordinal)
Assert-Contract -Condition ($payloadFenceIndex -ge 0 -and $removeStageIndex -gt $payloadFenceIndex -and $prepareAssetsIndex -gt $removeStageIndex) -Message 'Candidate replacement must occur only after the build and NSIS payload fence succeeds.'

$validateManifestText = Get-FunctionText -Text $publishText -Name 'Assert-FrozenReleaseManifest'
$validateStageText = Get-FunctionText -Text $publishText -Name 'Assert-FrozenStageContract'
Assert-Contract -Condition ($validateManifestText -notmatch 'target\\release\\linedog\.exe|installer\.nsi|Get-NsisPayloadSourcePath|Assert-GeneratedNsisPayloadSource') -Message 'Frozen manifest validation must not depend on mutable target or generated NSIS files.'
Assert-Contract -Condition ($validateStageText -notmatch 'target\\release\\linedog\.exe|installer\.nsi|Get-NsisPayloadSourcePath|Assert-GeneratedNsisPayloadSource') -Message 'Frozen-stage validation must not depend on mutable target or generated NSIS files.'

. $publishScript

$noisyCheckedCommandOutput = @(Invoke-CheckedCommand -Name 'contract noisy command' -Command {
  & $env:ComSpec /d /c 'echo contract stdout & echo contract stderr 1>&2 & exit /b 0' 2>&1
})
Assert-Contract -Condition ($noisyCheckedCommandOutput.Count -eq 0) -Message 'Checked command output must be audit-visible without entering the success pipeline.'
Assert-Throws -Action {
  Invoke-CheckedCommand -Name 'contract failing command' -Command { & $env:ComSpec /d /c 'exit /b 17' }
} -ExpectedMessage 'contract failing command exited with code 17.'
$global:LASTEXITCODE = 0

$buildMockFunctionNames = @('npm', 'cargo', 'Get-NsisPayloadSourcePath', 'Get-RegularFileIdentity', 'Assert-GeneratedNsisPayloadSource')
$buildMockOriginalFunctions = @{}
foreach ($functionName in $buildMockFunctionNames) {
  $existingFunction = Get-Command -Name $functionName -CommandType Function -ErrorAction SilentlyContinue
  $buildMockOriginalFunctions[$functionName] = if ($null -ne $existingFunction) { $existingFunction.ScriptBlock } else { $null }
}
try {
  Set-Item -Path 'Function:npm' -Value {
    param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Arguments)
    Write-Output ('synthetic npm output: ' + ($Arguments -join ' '))
    & $env:ComSpec /d /c 'exit /b 0'
  } -Force
  Set-Item -Path 'Function:cargo' -Value {
    param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Arguments)
    Write-Output ('synthetic cargo output: ' + ($Arguments -join ' '))
    & $env:ComSpec /d /c 'exit /b 0'
  } -Force
  Set-Item -Path 'Function:Get-NsisPayloadSourcePath' -Value { 'D:\contract\linedog.exe' } -Force
  Set-Item -Path 'Function:Get-RegularFileIdentity' -Value {
    param([string]$Path, [string]$Label)
    return [pscustomobject]@{ Length = [int64]42; Sha256 = ('E' * 64) }
  } -Force
  Set-Item -Path 'Function:Assert-GeneratedNsisPayloadSource' -Value {
    param([string]$ExpectedMainBinaryPath)
    return [pscustomobject]@{ MainBinarySourcePath = $ExpectedMainBinaryPath }
  } -Force

  $syntheticBuildResult = @(Invoke-ReleaseBuild -SigningMaterial ([pscustomobject]@{ KeyPath = 'contract-key'; KeyPassword = '' }))
  Assert-Contract -Condition ($syntheticBuildResult.Count -eq 1 -and $syntheticBuildResult[0] -is [System.Collections.IDictionary]) -Message 'Invoke-ReleaseBuild must return exactly one payloadIdentity IDictionary without command output.'
  $syntheticPayloadIdentity = $syntheticBuildResult[0]
  Assert-Contract -Condition ($syntheticPayloadIdentity['length'] -eq 42 -and $syntheticPayloadIdentity['sha256'] -ceq ('E' * 64)) -Message 'The singular Invoke-ReleaseBuild payloadIdentity must preserve the fenced source identity.'
} finally {
  foreach ($functionName in $buildMockFunctionNames) {
    $functionPath = "Function:$functionName"
    if ($null -eq $buildMockOriginalFunctions[$functionName]) {
      Remove-Item -LiteralPath $functionPath -Force -ErrorAction SilentlyContinue
    } else {
      Set-Item -LiteralPath $functionPath -Value $buildMockOriginalFunctions[$functionName] -Force
    }
  }
}

$checkedCommandText = Get-FunctionText -Text $publishText -Name 'Invoke-CheckedCommand'
Assert-Contract -Condition ($checkedCommandText -match '2>&1\s*\|\s*Out-Host') -Message 'Checked commands must forward combined stdout and stderr to Out-Host.'
Assert-Contract -Condition ($checkedCommandText -match '\$exitCode\s*=\s*\$LASTEXITCODE') -Message 'Checked commands must preserve the native exit code after output forwarding.'
$checkedCommandCallCount = [regex]::Matches($releaseBuildText, '(?m)^\s*(?:\$null\s*=\s*)?Invoke-CheckedCommand\b').Count
$discardedCheckedCommandCallCount = [regex]::Matches($releaseBuildText, '(?m)^\s*\$null\s*=\s*Invoke-CheckedCommand\b').Count
Assert-Contract -Condition ($checkedCommandCallCount -gt 0 -and $checkedCommandCallCount -eq $discardedCheckedCommandCallCount) -Message 'Invoke-ReleaseBuild must discard every checked-command return value before returning payloadIdentity.'
$preRemovalPayloadValidationIndex = $workflowText.IndexOf('$null = Assert-PayloadIdentity -PayloadIdentity $payloadIdentity', [System.StringComparison]::Ordinal)
$preRemovalSourceValidationIndex = $workflowText.IndexOf('$null = Assert-ReleaseSourceAssets -Version $versionFacts.Version -PayloadIdentity $payloadIdentity', [System.StringComparison]::Ordinal)
Assert-Contract -Condition ($preRemovalPayloadValidationIndex -gt $payloadFenceIndex -and $preRemovalPayloadValidationIndex -lt $removeStageIndex -and $preRemovalSourceValidationIndex -gt $preRemovalPayloadValidationIndex -and $preRemovalSourceValidationIndex -lt $removeStageIndex) -Message 'Payload and immutable release source validation must complete before candidate removal.'

$workflowMockFunctionNames = @('Get-ExplicitSigningMaterial', 'Invoke-ReleaseBuild', 'Remove-ExistingReleasePreparation')
$workflowMockOriginalFunctions = @{}
foreach ($functionName in $workflowMockFunctionNames) {
  $workflowMockOriginalFunctions[$functionName] = (Get-Command -Name $functionName -CommandType Function -ErrorAction Stop).ScriptBlock
}
$script:fixtureCandidate = [pscustomobject]@{ Exists = $true; RemoveCalls = 0 }
try {
  Set-Item -Path 'Function:Get-ExplicitSigningMaterial' -Value {
    param([string]$KeyPath, [string]$KeyPassword)
    return [pscustomobject]@{ KeyPath = 'contract-key'; KeyPassword = '' }
  } -Force
  Set-Item -Path 'Function:Invoke-ReleaseBuild' -Value {
    param($SigningMaterial)
    return [pscustomobject]@{ Invalid = $true }
  } -Force
  Set-Item -Path 'Function:Remove-ExistingReleasePreparation' -Value {
    param([string]$Version)
    $script:fixtureCandidate.RemoveCalls += 1
    $script:fixtureCandidate.Exists = $false
  } -Force

  Assert-Throws -Action { Invoke-ReleaseWorkflow } -ExpectedMessage 'Frozen manifest payloadIdentity is missing.'
  Assert-Contract -Condition ($script:fixtureCandidate.Exists -and $script:fixtureCandidate.RemoveCalls -eq 0) -Message 'Invalid payloadIdentity must reject before candidate removal and preserve the fixture candidate.'
} finally {
  foreach ($functionName in $workflowMockFunctionNames) {
    Set-Item -Path "Function:$functionName" -Value $workflowMockOriginalFunctions[$functionName] -Force
  }
}

$validTauriConfiguration = New-ValidTauriConfiguration
$null = Assert-UpdaterConfiguration -TauriConfig $validTauriConfiguration
foreach ($publisherCase in @(
  [pscustomobject]@{ Name = 'missing'; Value = $null; Remove = $true },
  [pscustomobject]@{ Name = 'empty'; Value = ''; Remove = $false },
  [pscustomobject]@{ Name = 'wrong'; Value = 'personalstudio'; Remove = $false }
)) {
  $invalidConfiguration = Copy-ContractValue -Value $validTauriConfiguration
  if ($publisherCase.Remove) {
    $null = $invalidConfiguration['bundle'].Remove('publisher')
  } else {
    $invalidConfiguration['bundle']['publisher'] = $publisherCase.Value
  }
  Assert-Throws -Action { Assert-UpdaterConfiguration -TauriConfig $invalidConfiguration } -ExpectedMessage 'Tauri bundle.publisher must be explicitly set to fengni658.'
}

$installerAsset = [pscustomobject]@{ Length = [int64]42; Sha256 = ('A' * 64) }
$sourceIdentity = [pscustomobject]@{ Length = [int64]42; Sha256 = ('A' * 64) }
$stagedIdentity = [pscustomobject]@{ Length = [int64]42; Sha256 = ('A' * 64) }
$sourceRelativePath = 'src-tauri/target/release/bundle/nsis/线条小狗_0.3.0_x64-setup.exe'
$validContainerProvenance = New-ContainerProvenance -Version '0.3.0' -SourceRelativePath $sourceRelativePath -SourceInstallerIdentity $sourceIdentity -StagedInstallerName 'LineDog_0.3.0_x64-setup.exe' -StagedInstallerIdentity $stagedIdentity
$null = Assert-ContainerProvenance -ContainerProvenance $validContainerProvenance -Version '0.3.0' -FrozenInstallerAsset $installerAsset

$v1Manifest = [ordered]@{ schema = 'linedog.release-freeze/v1'; version = '0.3.0'; stage = '.release/0.3.0'; assets = @() }
Assert-Throws -Action { Assert-FrozenManifestHeader -Manifest $v1Manifest -Version '0.3.0' } -ExpectedMessage 'Frozen manifest schema is unsupported.'
$v2Manifest = [ordered]@{ schema = 'linedog.release-freeze/v2'; version = '0.3.0'; stage = '.release/0.3.0'; assets = @() }
Assert-Throws -Action { Assert-FrozenManifestHeader -Manifest $v2Manifest -Version '0.3.0' } -ExpectedMessage 'Frozen manifest schema is unsupported.'

$payloadBeforeIdentity = [pscustomobject]@{ Length = [int64]42; Sha256 = ('C' * 64) }
$payloadAfterIdentity = [pscustomobject]@{ Length = [int64]42; Sha256 = ('C' * 64) }
$validPayloadIdentity = New-PayloadIdentity -SourceRelativePath 'src-tauri/target/release/linedog.exe' -Name 'linedog.exe' -BeforeBundleIdentity $payloadBeforeIdentity -AfterBundleIdentity $payloadAfterIdentity
$validatedPayloadIdentity = Assert-PayloadIdentity -PayloadIdentity $validPayloadIdentity
Assert-Contract -Condition ($validatedPayloadIdentity.SourceKind -ceq 'tauri-nsis-main-binary-input' -and $validatedPayloadIdentity.SourceRelativePath -ceq 'src-tauri/target/release/linedog.exe' -and $validatedPayloadIdentity.Name -ceq 'linedog.exe' -and $validatedPayloadIdentity.Length -eq 42 -and $validatedPayloadIdentity.Sha256 -ceq ('C' * 64)) -Message 'A valid v3 payload identity must be accepted without mutable target inspection.'

$missingPayloadIdentity = [ordered]@{}
Assert-Throws -Action { Assert-PayloadIdentity -PayloadIdentity $missingPayloadIdentity } -ExpectedMessage 'Frozen manifest payloadIdentity.sourceKind is missing.'

$wrongPayloadSourceKind = Copy-ContractValue -Value $validPayloadIdentity
$wrongPayloadSourceKind['sourceKind'] = 'tauri-nsis-unknown'
Assert-Throws -Action { Assert-PayloadIdentity -PayloadIdentity $wrongPayloadSourceKind } -ExpectedMessage 'Frozen manifest payloadIdentity.sourceKind is unsupported.'

$traversalPayloadPath = Copy-ContractValue -Value $validPayloadIdentity
$traversalPayloadPath['sourceRelativePath'] = 'src-tauri/target/release/../linedog.exe'
Assert-Throws -Action { Assert-PayloadIdentity -PayloadIdentity $traversalPayloadPath } -ExpectedMessage 'payloadIdentity.sourceRelativePath must be the canonical NSIS main binary input path.'

$wrongPayloadName = Copy-ContractValue -Value $validPayloadIdentity
$wrongPayloadName['name'] = 'LineDog.exe'
Assert-Throws -Action { Assert-PayloadIdentity -PayloadIdentity $wrongPayloadName } -ExpectedMessage 'Frozen manifest payloadIdentity.name must be linedog.exe.'

$zeroPayloadLength = Copy-ContractValue -Value $validPayloadIdentity
$zeroPayloadLength['length'] = 0
Assert-Throws -Action { Assert-PayloadIdentity -PayloadIdentity $zeroPayloadLength } -ExpectedMessage 'Frozen manifest payloadIdentity.length must be a positive integer.'

$malformedPayloadHash = Copy-ContractValue -Value $validPayloadIdentity
$malformedPayloadHash['sha256'] = ('G' * 64)
Assert-Throws -Action { Assert-PayloadIdentity -PayloadIdentity $malformedPayloadHash } -ExpectedMessage 'Frozen manifest payloadIdentity.sha256 is invalid.'

$primaryPayloadMismatch = Copy-ContractValue -Value $validPayloadIdentity
$primaryPayloadMismatch['length'] = 43
Assert-Throws -Action { Assert-PayloadIdentity -PayloadIdentity $primaryPayloadMismatch } -ExpectedMessage 'Frozen manifest payloadIdentity values must match the build-only and post-bundle identities exactly.'

$beforePayloadMismatch = Copy-ContractValue -Value $validPayloadIdentity
$beforePayloadMismatch['beforeBundle']['sha256'] = ('D' * 64)
Assert-Throws -Action { Assert-PayloadIdentity -PayloadIdentity $beforePayloadMismatch } -ExpectedMessage 'Frozen manifest payloadIdentity values must match the build-only and post-bundle identities exactly.'

$afterPayloadMismatch = Copy-ContractValue -Value $validPayloadIdentity
$afterPayloadMismatch['afterBundle']['length'] = 43
Assert-Throws -Action { Assert-PayloadIdentity -PayloadIdentity $afterPayloadMismatch } -ExpectedMessage 'Frozen manifest payloadIdentity values must match the build-only and post-bundle identities exactly.'

Assert-Throws -Action {
  New-PayloadIdentity -SourceRelativePath 'src-tauri/target/release/linedog.exe' -Name 'linedog.exe' -BeforeBundleIdentity $payloadBeforeIdentity -AfterBundleIdentity ([pscustomobject]@{ Length = [int64]43; Sha256 = ('C' * 64) })
} -ExpectedMessage 'NSIS main binary input drifted between build-only and bundle.'

$expectedMainBinaryPath = Join-Path $projectRoot 'src-tauri\target\release\linedog.exe'
$validNsiText = '!define MAINBINARYSRCPATH "' + $expectedMainBinaryPath + '"' + [Environment]::NewLine + 'File "${MAINBINARYSRCPATH}"' + [Environment]::NewLine
$nsiResult = Assert-NsisMainBinarySourceText -NsiText $validNsiText -ExpectedMainBinaryPath $expectedMainBinaryPath
Assert-Contract -Condition ($nsiResult.MainBinarySourcePath -ieq (ConvertTo-NormalizedFullPath -Path $expectedMainBinaryPath)) -Message 'A valid generated NSIS source declaration must resolve to the canonical main binary input.'
Assert-Throws -Action { Assert-NsisMainBinarySourceText -NsiText '' -ExpectedMainBinaryPath $expectedMainBinaryPath } -ExpectedMessage 'Generated installer.nsi must contain exactly one MAINBINARYSRCPATH definition.'
Assert-Throws -Action { Assert-NsisMainBinarySourceText -NsiText ($validNsiText + $validNsiText) -ExpectedMainBinaryPath $expectedMainBinaryPath } -ExpectedMessage 'Generated installer.nsi must contain exactly one MAINBINARYSRCPATH definition.'
Assert-Throws -Action { Assert-NsisMainBinarySourceText -NsiText ($validNsiText.Replace($expectedMainBinaryPath, 'D:\wrong\linedog.exe')) -ExpectedMainBinaryPath $expectedMainBinaryPath } -ExpectedMessage 'Generated installer.nsi MAINBINARYSRCPATH must resolve to the canonical NSIS main binary input.'
Assert-Throws -Action { Assert-NsisMainBinarySourceText -NsiText ($validNsiText.Replace('File "${MAINBINARYSRCPATH}"', 'File "other.exe"')) -ExpectedMainBinaryPath $expectedMainBinaryPath } -ExpectedMessage 'Generated installer.nsi must directly consume MAINBINARYSRCPATH exactly once.'

$declaredAssets = Get-ReleaseAssetNames -Version '0.3.0'
Assert-Contract -Condition ($declaredAssets.Count -eq 6 -and @($declaredAssets | Select-Object -Unique).Count -eq 6) -Message 'V3 must preserve the exact six release assets.'

$missingProvenance = Copy-ContractValue -Value $validContainerProvenance
$null = $missingProvenance.Remove('stagedInstaller')
Assert-Throws -Action { Assert-ContainerProvenance -ContainerProvenance $missingProvenance -Version '0.3.0' -FrozenInstallerAsset $installerAsset } -ExpectedMessage 'Frozen manifest containerProvenance.stagedInstaller is missing.'

$invalidPathProvenance = Copy-ContractValue -Value $validContainerProvenance
$invalidPathProvenance['sourceBundleInstaller']['relativePath'] = 'src-tauri/target/release/bundle/nsis/../outside_0.3.0_x64-setup.exe'
Assert-Throws -Action { Assert-ContainerProvenance -ContainerProvenance $invalidPathProvenance -Version '0.3.0' -FrozenInstallerAsset $installerAsset } -ExpectedMessage 'containerProvenance.sourceBundleInstaller.relativePath must be a canonical direct NSIS bundle installer path.'

$invalidLengthProvenance = Copy-ContractValue -Value $validContainerProvenance
$invalidLengthProvenance['sourceBundleInstaller']['length'] = -1
Assert-Throws -Action { Assert-ContainerProvenance -ContainerProvenance $invalidLengthProvenance -Version '0.3.0' -FrozenInstallerAsset $installerAsset } -ExpectedMessage 'containerProvenance.sourceBundleInstaller.length must be a positive integer.'

$invalidHashProvenance = Copy-ContractValue -Value $validContainerProvenance
$invalidHashProvenance['sourceBundleInstaller']['sha256'] = ('G' * 64)
Assert-Throws -Action { Assert-ContainerProvenance -ContainerProvenance $invalidHashProvenance -Version '0.3.0' -FrozenInstallerAsset $installerAsset } -ExpectedMessage 'containerProvenance.sourceBundleInstaller.sha256 is invalid.'

Assert-Throws -Action {
  New-ContainerProvenance -Version '0.3.0' -SourceRelativePath $sourceRelativePath -SourceInstallerIdentity $sourceIdentity -StagedInstallerName 'LineDog_0.3.0_x64-setup.exe' -StagedInstallerIdentity ([pscustomobject]@{ Length = [int64]43; Sha256 = ('A' * 64) })
} -ExpectedMessage 'NSIS source and staged installer provenance must match exactly.'

$assetMismatchProvenance = Copy-ContractValue -Value $validContainerProvenance
$assetMismatchProvenance['sourceBundleInstaller']['sha256'] = ('B' * 64)
$assetMismatchProvenance['stagedInstaller']['sha256'] = ('B' * 64)
Assert-Throws -Action { Assert-ContainerProvenance -ContainerProvenance $assetMismatchProvenance -Version '0.3.0' -FrozenInstallerAsset $installerAsset } -ExpectedMessage 'containerProvenance.stagedInstaller.sha256 must match frozen installer asset.'

$publishBranch = [regex]::Match($publishText, '(?s)if \(\$Publish\) \{(?<body>.*?)\} elseif \(\$ValidateFrozenStage\)')
Assert-Contract -Condition $publishBranch.Success -Message 'Publish must have a dedicated frozen-stage branch.'
Assert-Contract -Condition ($publishBranch.Groups['body'].Value -notmatch 'Remove-ExistingReleasePreparation|Invoke-ReleaseBuild|Prepare-ReleaseAssets|Write-FrozenReleaseManifest') -Message 'Publish must not delete, build, sign, or rewrite a frozen stage.'
Assert-Contract -Condition ($publishBranch.Groups['body'].Value -notmatch 'target\\release\\linedog\.exe|installer\.nsi|Get-NsisPayloadSourcePath|Assert-GeneratedNsisPayloadSource') -Message 'Publish must not require mutable target or generated NSIS files.'
try {
  & $publishScript -Publish
  throw 'Expected -Publish without -FrozenManifestPath to fail.'
} catch {
  Assert-Contract -Condition ($_.Exception.Message -match 'FrozenManifestPath is required for -Publish') -Message 'Publish without a frozen manifest must fail before any build or remote action.'
}
Assert-Contract -Condition ($publishText -notmatch 'C:\\Users\\') -Message 'Release script must not hard-code a local user path.'

& $exportScript -OutputDirectory $outputDirectory -Version '0.3.0' -Clean
if ($LASTEXITCODE -ne 0) {
  throw "Release contract failed: public-source export exited with code $LASTEXITCODE."
}

$mustExist = @(
  'README.md',
  'LICENSE',
  'ASSET-LICENSE.md',
  'public/character/manifest.json',
  'src/main.ts',
  'src-tauri/icons/icon.ico',
  'PUBLIC-SOURCE-MANIFEST.txt'
)
foreach ($relativePath in $mustExist) {
  Assert-Contract -Condition (Test-Path -LiteralPath (Join-Path $outputDirectory $relativePath) -PathType Leaf) -Message "Expected exported file is missing: $relativePath."
}

$mustNotExist = @(
  'AGENTS.md',
  '.agents',
  'public/character/work',
  'public/character/model',
  'public/character/model/reference/character-reference.png',
  'public/character/drag/candidate',
  '.release',
  '.local'
)
foreach ($relativePath in $mustNotExist) {
  Assert-Contract -Condition (-not (Test-Path -LiteralPath (Join-Path $outputDirectory $relativePath))) -Message "Prohibited path was exported: $relativePath."
}

$manifest = Get-Content -LiteralPath (Join-Path $outputDirectory 'PUBLIC-SOURCE-MANIFEST.txt') -Raw -Encoding utf8
Assert-Contract -Condition ($manifest -notmatch 'candidate|reference|/work/|\\work\\|AGENTS\.md|\.agents') -Message 'Export manifest proves a prohibited path was included.'

Write-Host 'Public release contract passed.'
