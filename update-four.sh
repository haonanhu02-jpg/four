#!/usr/bin/env bash
# Standalone entry: a child Bash protects the caller when this file is sourced.
(
bash -s -- "$@" <<'FOUR_DEPLOY_SCRIPT'
set -Eeuo pipefail
umask 077
APP_DIR="${FOUR_APP_DIR:-$HOME/four-workbench}"
BRANCH="${FOUR_BRANCH:-main}"
PROJECT="${FOUR_PROJECT:-}"
OFFICIAL='https://github.com/haonanhu02-jpg/four.git'
STAGE='检查环境'
trap 'printf "\n部署未完成（%s）。请修复后重跑；配置、数据卷和备份保留。\n" "$STAGE" >&2' ERR
while (($#)); do
  case "$1" in
    --dir) APP_DIR="${2:?--dir 需要目录}"; shift 2;;
    --branch) BRANCH="${2:?--branch 需要分支}"; shift 2;;
    --project) PROJECT="${2:?--project 需要名称}"; shift 2;;
    --help|-h) printf '%s\n' '用法：source ./update-four.sh [--dir 目录] [--branch main] [--project 名称]' '默认目录：~/four-workbench；重复运行更新源码并重新部署。' '首次部署可用 FOUR_ORIGIN=http://服务器IP:8080 指定访问地址。' '需要 Bash、Git、Python 3.10+、Docker Compose 2.20+、flock、timeout。'; exit 0;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 1;;
  esac
done
for program in git python3 docker flock timeout sed head sha256sum; do
  command -v "$program" >/dev/null || { printf '请先安装 %s\n' "$program" >&2; exit 1; }
done
python3 -c 'import sys; assert sys.version_info >= (3,10), "需要 Python 3.10+"'
docker info >/dev/null
docker compose version --short | python3 -c 'import sys,re; v=tuple(map(int,re.findall(r"\d+",sys.stdin.read())[:2])); assert v >= (2,20), "需要 Docker Compose 2.20+"'
APP_DIR="$(python3 -c 'import pathlib,sys; p=pathlib.Path(sys.argv[1]).expanduser().resolve(); assert str(p)!="/", "不能以根目录部署"; print(p)' "$APP_DIR")"
mkdir -p -- "$(dirname -- "$APP_DIR")"
exec 9>"${APP_DIR}.deploy.lock"
flock -n 9 || { printf '%s\n' '同一目录已有部署任务正在运行。' >&2; exit 1; }
export GIT_TERMINAL_PROMPT=0
g() { git -c "safe.directory=$APP_DIR" -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=20 -C "$APP_DIR" "$@"; }
STAGE='下载源码'
if [[ ! -d "$APP_DIR/.git" ]]; then
  if [[ -d "$APP_DIR" && -n "$(ls -A -- "$APP_DIR")" ]]; then
    printf '%s\n' '目标目录已有其他文件，请用 --dir 选择一个空目录。' >&2; exit 1
  fi
  mkdir -p -- "$APP_DIR"
  git init -q "$APP_DIR"
  g remote add origin "$OFFICIAL"
fi
[[ "$(g remote get-url origin)" == "$OFFICIAL" ]] || { printf '%s\n' '目标目录不是本项目的官方 Git 仓库，停止部署。' >&2; exit 1; }
[[ -z "$(g status --porcelain --untracked-files=no)" ]] || { printf '%s\n' '源码存在本地修改，请先提交或备份；脚本不会覆盖。' >&2; exit 1; }
git check-ref-format --branch "$BRANCH" >/dev/null
UPDATED=false
for url in "https://ghfast.top/$OFFICIAL" "https://gh-proxy.com/$OFFICIAL" "$OFFICIAL"; do
  for attempt in 1 2; do
    printf '获取 %s 分支，第 %s 次尝试：%s\n' "$BRANCH" "$attempt" "$url"
    if timeout 120 git -c "safe.directory=$APP_DIR" -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=20 -C "$APP_DIR" fetch --no-tags --force "$url" "refs/heads/$BRANCH:refs/remotes/four-deploy/target"; then UPDATED=true; break; fi
  done
  [[ "$UPDATED" == false ]] || break
done
[[ "$UPDATED" == true ]] || { printf '%s\n' '所有代码通道失败，未构建或重启现有容器。' >&2; exit 1; }
if g rev-parse --verify HEAD >/dev/null 2>&1; then
  [[ "$(g branch --show-current)" == "$BRANCH" ]] || { printf '%s\n' '当前分支与请求分支不同，停止自动更新。' >&2; exit 1; }
  g merge-base --is-ancestor HEAD refs/remotes/four-deploy/target || { printf '%s\n' '本地与远端已分叉，停止更新，未覆盖代码。' >&2; exit 1; }
  g merge --ff-only refs/remotes/four-deploy/target
else
  g checkout -b "$BRANCH" refs/remotes/four-deploy/target
fi
cd -- "$APP_DIR"
[[ -f compose.yaml && -f Dockerfile && -f package.json ]] || { printf '%s\n' '缺少本项目部署文件。' >&2; exit 1; }
STAGE='初始化配置'
python3 - <<'PY_CONFIG'
from pathlib import Path
import os,secrets,socket
from urllib.parse import urlsplit
p=Path('.env')
if p.exists():
    print('保留已有 .env（访问地址和端口也沿用原配置）。')
else:
    try:
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
            s.connect(('198.18.0.1',80)); ip=s.getsockname()[0]
    except OSError: ip='127.0.0.1'
    origin=os.environ.get('FOUR_ORIGIN',f'http://{ip}:8080').rstrip('/')
    url=urlsplit(origin)
    assert url.scheme in ('http','https') and url.hostname and url.path in ('','/') and not url.query and not url.fragment and not url.username, 'FOUR_ORIGIN 必须是 http(s)://主机[:端口]'
    password=secrets.token_hex(24)
    p.write_text(f'POSTGRES_USER=workbench\nPOSTGRES_DB=workbench\nPOSTGRES_PASSWORD={password}\nAUTH_TOKEN_SECRET={secrets.token_hex(32)}\nCOMPOSE_APP_ORIGIN={origin}\nWEB_PORT=8080\nWEB_BIND_ADDRESS=0.0.0.0\nCOOKIE_SECURE={str(url.scheme=="https").lower()}\n',encoding='utf-8')
    p.chmod(0o600)
    print(f'已生成随机密钥，访问地址：{origin}。如为内网地址，请在 .env 修改 COMPOSE_APP_ORIGIN。')
PY_CONFIG
export SOURCE_REVISION="$(g rev-parse HEAD)"
export IMAGE_TAG="source-${SOURCE_REVISION:0:12}"
dc() {
  if [[ -n "$PROJECT" ]]; then docker compose --project-name "$PROJECT" --env-file "$APP_DIR/.env" -f "$APP_DIR/compose.yaml" "$@";
  else docker compose --env-file "$APP_DIR/.env" -f "$APP_DIR/compose.yaml" "$@"; fi
}
STAGE='拉取基础镜像'
# Mirrors retain the upstream immutable digest; failures fall back to upstream.
pull_base() {
  local reference="$1" repository="$2" prefix candidate
  for prefix in 'docker.1ms.run/' 'docker.xuanyuan.me/' ''; do
    candidate="${prefix}${repository}"
    printf '尝试基础镜像：%s\n' "$candidate" >&2
    if timeout 180 docker pull "$candidate" >&2; then printf '%s' "$candidate"; return 0; fi
  done
  if docker image inspect "$reference" >/dev/null 2>&1; then printf '%s' "$reference"; return 0; fi
  return 1
}
NODE_BASE="$(sed -n 's/^ARG NODE_IMAGE=//p' Dockerfile | head -n 1)"
NGINX_BASE="$(sed -n 's/^ARG NGINX_IMAGE=//p' Dockerfile | head -n 1)"
[[ "$NODE_BASE" == *@sha256:* && "$NGINX_BASE" == *@sha256:* ]] || { printf '%s\n' 'Dockerfile 缺少固定摘要的基础镜像参数，请更新部署脚本或源码。' >&2; exit 1; }
NODE_IMAGE="$(pull_base "$NODE_BASE" "library/$NODE_BASE")"
NGINX_IMAGE="$(pull_base "$NGINX_BASE" "$NGINX_BASE")"
export POSTGRES_IMAGE
POSTGRES_IMAGE="$(pull_base 'postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2' 'library/postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2')"
STAGE='构建应用镜像（此阶段不停止旧应用）'
if ! dc build --build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "NGINX_IMAGE=$NGINX_IMAGE" --build-arg NPM_REGISTRY=https://registry.npmmirror.com api web; then
  printf '%s\n' '国内 npm 源构建失败，改用官方 npm 源重试。'
  dc build --build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "NGINX_IMAGE=$NGINX_IMAGE" --build-arg NPM_REGISTRY=https://registry.npmjs.org api web
fi
STAGE='数据库备份'
mkdir -p .local/source-backups .local/source-admin
# Back up the existing running database before replacing its container image.
DB_ID="$(dc ps -q db)"
if [[ -n "$DB_ID" && "$(docker inspect --format '{{.State.Running}}' "$DB_ID")" == true ]]; then
  DB_VERSION="$(dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SHOW server_version_num"' </dev/null)"
  [[ "$DB_VERSION" =~ ^18[0-9]{4}$ ]] || { printf '%s\n' '现有数据库不是 PostgreSQL 18，需要单独规划大版本迁移。' >&2; exit 1; }
else
  dc up -d --wait --wait-timeout 180 db
fi
BACKUP="$APP_DIR/.local/source-backups/$(date -u +%Y%m%dT%H%M%SZ)-${SOURCE_REVISION:0:12}-$$.dump"
dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$BACKUP.partial"
dc exec -T db pg_restore --list <"$BACKUP.partial" >/dev/null
mv -- "$BACKUP.partial" "$BACKUP"
sha256sum "$BACKUP" >"$BACKUP.sha256"
printf '已备份数据库：%s\n' "$BACKUP"
dc up -d --wait --wait-timeout 180 db
STAGE='迁移数据库'
dc run -T --rm --no-deps migrate </dev/null
STAGE='初始化管理员'
dc run -T --rm --no-deps --user "$(id -u):$(id -g)" -v "$APP_DIR/.local/source-admin:/admin-credentials" -e ADMIN_CREDENTIALS_FILE=/admin-credentials/admin.txt api node scripts/bootstrap-admin.mjs </dev/null
STAGE='启动与健康检查'
dc up -d --no-build --pull never --wait --wait-timeout 180 api web
dc ps
printf '\n部署完成，源码版本：%s\n目录：%s\n管理员初始凭据（仅首次创建）：%s\n' "$SOURCE_REVISION" "$APP_DIR" "$APP_DIR/.local/source-admin/admin.txt"
printf '%s\n' '以后重复运行本脚本即可更新。外网访问地址以 .env 的 COMPOSE_APP_ORIGIN 为准。'
FOUR_DEPLOY_SCRIPT
)
