param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$BlenderPath = 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe'
)
$ErrorActionPreference = 'Stop'
$reviewRepository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$reviewOutput = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
if (Test-Path -LiteralPath $reviewOutput) { throw 'Choose a new output directory to preserve existing review evidence.' }
if (-not (Test-Path -LiteralPath $BlenderPath)) { throw "Blender executable not found: $BlenderPath" }
$reviewNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $reviewNode) { $reviewNode = 'C:/Program Files/nodejs/node.exe' }
function Invoke-ReviewNative {
    param([string]$Executable, [string[]]$Arguments)
    # Windows PowerShell wraps native stderr (including harmless warnings) as
    # ErrorRecords. Preserve those messages, and use the executable's exit code.
    $savedErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Executable @Arguments
        $reviewNativeExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedErrorPreference }
    if ($reviewNativeExit -ne 0) { throw "$Executable failed with exit code $reviewNativeExit; inspect preserved evidence." }
}
Push-Location $reviewRepository
try {
    Invoke-ReviewNative -Executable $reviewNode -Arguments @('node_modules/vite-node/vite-node.mjs', 'scripts/blender/export-review.ts', $reviewOutput)
    Invoke-ReviewNative -Executable $BlenderPath -Arguments @('--background', '--factory-startup', '--python-exit-code', '1', '--python', 'scripts/blender/build-review.py', '--', $reviewOutput)
    Invoke-ReviewNative -Executable $reviewNode -Arguments @('node_modules/vite-node/vite-node.mjs', 'scripts/blender/verify-roundtrip.ts', $reviewOutput)
    Write-Output "Ready: $reviewOutput/movement-review.blend"
} finally { Pop-Location }
