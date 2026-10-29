$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'auto-deploy.py'
if (Get-Command python -ErrorAction SilentlyContinue) {
    & python $scriptPath @args
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $scriptPath @args
} else {
    Write-Error '需要 Python 3.10 或更新版本；请先安装 Python。'
    exit 1
}
exit $LASTEXITCODE
