$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'auto-deploy.py'
if (Get-Command python -ErrorAction SilentlyContinue) {
    & python $scriptPath @args
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $scriptPath @args
} else {
    Write-Error 'Python 3.10 or newer is required. Install Python before running this script.'
    exit 1
}
exit $LASTEXITCODE
