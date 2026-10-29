#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo '需要 Python 3.10 或更新版本；请先安装 python3。' >&2
  exit 1
fi
exec python3 "$script_dir/auto-deploy.py" "$@"
