#!/usr/bin/env bash
# Standalone entry: a child Bash protects the caller when this file is sourced.
(
wb_update_script="$(cat <<'FOUR_DEPLOY_SCRIPT'
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
    --help|-h) printf '%s\n' '用法：source ./update-four.sh [--dir 目录] [--branch main] [--project 名称]' '默认目录：~/four-workbench；重复运行更新源码并重新部署。' '默认网站端口 5001，地址 http://192.168.3.110:5001；可用 FOUR_ORIGIN/FOUR_PORT 覆盖。' '需要 Bash、Git、Python 3.10+、Docker Compose 2.20+、flock、timeout。'; exit 0;;
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
import os,secrets,re,time,tempfile
from urllib.parse import urlsplit
p=Path('.env')
port=int(os.environ.get('FOUR_PORT','5001'))
assert 1 <= port <= 65535, 'FOUR_PORT 必须在 1 到 65535 之间'
origin=os.environ.get('FOUR_ORIGIN',f'http://192.168.3.110:{port}').rstrip('/')
url=urlsplit(origin)
assert url.scheme in ('http','https') and url.hostname and url.path in ('','/') and not url.query and not url.fragment and not url.username and not url.password and not any(c.isspace() for c in origin), 'FOUR_ORIGIN 必须是 http(s)://主机[:端口]'
updates={'COMPOSE_APP_ORIGIN':origin,'WEB_PORT':str(port),'WEB_BIND_ADDRESS':'0.0.0.0','COOKIE_SECURE':str(url.scheme=='https').lower()}
if p.exists():
    old=p.read_text(encoding='utf-8')
    content=old
    for key,value in updates.items():
        pattern=rf'^(?:export[ \t]+)?{key}[ \t]*=.*$'
        if re.search(pattern,content,re.M):
            content=re.sub(pattern,lambda m:f'{key}={value}',content,flags=re.M)
        else:
            content=content.rstrip('\n')+f'\n{key}={value}\n'
    if content!=old:
        backups=Path('.local/source-config-backups');backups.mkdir(parents=True,exist_ok=True)
        backup=backups/f'env-{time.time_ns()}.bak'
        with backup.open('x',encoding='utf-8') as stream:stream.write(old)
        backup.chmod(0o600)
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=p.parent,delete=False) as stream:
            stream.write(content);temporary=Path(stream.name)
        temporary.chmod(0o600);temporary.replace(p)
        print(f'原配置已备份至 {backup}，保留数据库密码和账号配置，更新网站地址：{origin}')
    else:print(f'配置已是目标端口，无需修改：{origin}')
else:
    password=secrets.token_hex(24)
    p.write_text(f'POSTGRES_USER=workbench\nPOSTGRES_DB=workbench\nPOSTGRES_PASSWORD={password}\nAUTH_TOKEN_SECRET={secrets.token_hex(32)}\n'+''.join(f'{k}={v}\n' for k,v in updates.items()),encoding='utf-8')
    p.chmod(0o600)
    print(f'已生成随机密钥，访问地址：{origin}')

PY_CONFIG
# Explicit deployment settings also override stale variables in the caller's env.
export WEB_PORT="${FOUR_PORT:-5001}"
export COMPOSE_APP_ORIGIN="${FOUR_ORIGIN:-http://192.168.3.110:$WEB_PORT}"
export WEB_BIND_ADDRESS=0.0.0.0
if [[ "$COMPOSE_APP_ORIGIN" == https://* ]]; then export COOKIE_SECURE=true; else export COOKIE_SECURE=false; fi
export SOURCE_REVISION="$(g rev-parse HEAD)"
export IMAGE_TAG="source-${SOURCE_REVISION:0:12}"
dc() {
  # Connection secrets must come from this deployment's file, not the login shell.
  if [[ -n "$PROJECT" ]]; then env -u POSTGRES_USER -u POSTGRES_DB -u POSTGRES_PASSWORD -u AUTH_TOKEN_SECRET -u DATABASE_URL docker compose --project-name "$PROJECT" --env-file "$APP_DIR/.env" -f "$APP_DIR/compose.yaml" "$@";
  else env -u POSTGRES_USER -u POSTGRES_DB -u POSTGRES_PASSWORD -u AUTH_TOKEN_SECRET -u DATABASE_URL docker compose --env-file "$APP_DIR/.env" -f "$APP_DIR/compose.yaml" "$@"; fi
}
unset COMPOSE_DATABASE_URL
# Build a properly escaped URL; JSON and the result remain in pipes/variables.
export COMPOSE_DATABASE_URL="$(dc config --format json | python3 -c 'import json,sys; from urllib.parse import quote; e=json.load(sys.stdin)["services"]["db"]["environment"]; print("postgresql://"+quote(e["POSTGRES_USER"],safe="")+":"+quote(e["POSTGRES_PASSWORD"],safe="")+"@db:5432/"+quote(e["POSTGRES_DB"],safe=""))')"
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
STAGE='校验应用数据库凭据'
if dc run -T --rm --no-deps api node scripts/database-connection.mjs check </dev/null; then
  printf '%s\n' '应用与数据库凭据一致。'
else
  AUTH_CODE=$?
  if [[ "$AUTH_CODE" != 28 ]]; then exit "$AUTH_CODE"; fi
  STAGE='同步已有数据库卷的连接密码'
  printf '%s\n' '已确认密码不一致；数据库已备份，现在将本项目数据库角色同步为 .env 中的密码。网页登录账号密码保持不变。'
  dc run -T --rm --no-deps api node scripts/database-connection.mjs repair-sql </dev/null |
    dc exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
  dc run -T --rm --no-deps api node scripts/database-connection.mjs check </dev/null
fi
STAGE='迁移数据库'
dc run -T --rm --no-deps migrate </dev/null
STAGE='初始化管理员'
dc run -T --rm --no-deps --user "$(id -u):$(id -g)" -v "$APP_DIR/.local/source-admin:/admin-credentials" -e ADMIN_CREDENTIALS_FILE=/admin-credentials/admin.txt api node scripts/bootstrap-admin.mjs </dev/null
STAGE='启动与健康检查'
dc up -d --no-build --pull never --wait --wait-timeout 180 api web
dc ps
printf '\n部署完成，源码版本：%s\n目录：%s\n管理员初始凭据（仅首次创建）：%s\n' "$SOURCE_REVISION" "$APP_DIR" "$APP_DIR/.local/source-admin/admin.txt"
python3 -c 'from pathlib import Path; print(next(line.split("=",1)[1] for line in Path(".env").read_text().splitlines() if line.startswith("COMPOSE_APP_ORIGIN=")))'
printf '%s\n' '以上为网站地址；以后重复运行本脚本即可更新。'
FOUR_DEPLOY_SCRIPT
)"
# Keep program text separate from stdin: Docker/BuildKit may consume stdin.
bash -c "$wb_update_script" four-source-update "$@" </dev/null
)
