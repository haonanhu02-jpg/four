#!/usr/bin/env bash
# Run in a subshell so `source` preserves the caller's shell, options and directory.
(
  set -euo pipefail
  wb_deploy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 1
  if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' '需要 Python 3.10 或更新版本；请先安装 python3。' >&2
    exit 1
  fi
  if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then
    printf '%s\n' 'Python 版本过低，需要 3.10 或更新版本。' >&2
    exit 1
  fi

  wb_deploy_program="$wb_deploy_dir/auto-deploy.py"
  if [[ ! -f "$wb_deploy_program" ]]; then
    if ! command -v curl >/dev/null 2>&1; then
      printf '%s\n' '缺少 curl，请先安装后重试。' >&2
      exit 1
    fi
    # Pin the bootstrap tool; the Python tool still deploys the latest app release.
    # When changing auto-deploy.py, update this release URL and SHA-256 together.
    wb_bootstrap_url='https://github.com/haonanhu02-jpg/four/releases/download/v1.1.1/auto-deploy.py'
    wb_bootstrap_sha256='3b90c9e5a29b96ea52f4ee0d2445772a3ce5090029f7d6beabe76412a70157ec'
    wb_bootstrap_dir="$(mktemp -d "${TMPDIR:-/tmp}/four-deploy.XXXXXXXX")" || exit 1
    wb_deploy_program="$wb_bootstrap_dir/auto-deploy.py"
    trap 'rm -f -- "$wb_deploy_program"; rmdir -- "$wb_bootstrap_dir" 2>/dev/null || true' EXIT
    wb_bootstrap_ready=false
    for wb_bootstrap_prefix in 'https://ghfast.top/' 'https://gh-proxy.com/' ''; do
      printf '%s\n' '正在获取已固定校验值的部署工具……'
      if curl --fail --location --silent --show-error \
        --proto '=https' --proto-redir '=https' \
        --connect-timeout 5 --max-time 30 --speed-limit 1024 --speed-time 15 \
        --output "$wb_deploy_program" "${wb_bootstrap_prefix}${wb_bootstrap_url}"; then
        if python3 -c \
          'import hashlib,pathlib,sys; sys.exit(0 if hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()==sys.argv[2] else 1)' \
          "$wb_deploy_program" "$wb_bootstrap_sha256"; then
          wb_bootstrap_ready=true
          break
        fi
        printf '%s\n' '部署工具校验不通过，切换备用通道。' >&2
      fi
    done
    if [[ "$wb_bootstrap_ready" != true ]]; then
      printf '%s\n' '所有部署工具下载通道均未成功，未执行部署。' >&2
      exit 1
    fi
  fi

  # Do not use exec: sourcing this file must not replace the user's terminal shell.
  python3 "$wb_deploy_program" "$@"
)
