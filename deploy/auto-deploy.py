#!/usr/bin/env python3
"""Deploy verified GitHub Release images. Python 3.10+, curl and Docker Compose required."""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

REPOSITORY = "https://github.com/haonanhu02-jpg/four"
DEFAULT_MIRRORS = ["https://ghfast.top", "https://gh-proxy.com"]
HEX = re.compile(r"[a-f0-9]{64}")
VERSION = re.compile(r"\d+\.\d+\.\d+")


class DeployError(Exception):
    pass


def log(message):
    print(message, flush=True)


def sha256(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def write_private(path, content):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(content)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    write_private(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


@contextlib.contextmanager
def deployment_lock(root):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / "deploy.lock").open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise DeployError("另一个部署正在运行，请等待其完成。") from error
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def safe_path(root, name):
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or ".." in path.parts or "\\" in name
            or ":" in name or "\x00" in name):
        raise DeployError("归档包含非法路径。")
    resolved = root.joinpath(*path.parts).resolve()
    if not resolved.is_relative_to(root.resolve()) or resolved == root.resolve():
        raise DeployError("归档路径越界。")
    return resolved


def unpack(archive, destination):
    """Reject links, devices and traversal before writing any archive member."""
    with tarfile.open(archive, "r:gz") as stream:
        members = stream.getmembers()
        if len(members) > 20000 or sum(v.size for v in members) > 4 * 1024**3:
            raise DeployError("归档超过部署包大小限制。")
        seen = set()
        for entry in members:
            # GNU tar sometimes emits the root directory as './'.
            if entry.isdir() and entry.name in (".", "./"):
                continue
            path = safe_path(destination, entry.name)
            key = os.path.normcase(str(path))
            if key in seen or not (entry.isfile() or entry.isdir()):
                raise DeployError("归档包含重复路径、链接或特殊文件。")
            seen.add(key)
        for entry in members:
            if entry.isdir() and entry.name in (".", "./"):
                continue
            path = safe_path(destination, entry.name)
            if entry.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with stream.extractfile(entry) as source, path.open("xb") as target:
                    shutil.copyfileobj(source, target)


def validate_manifest(value):
    if not isinstance(value, dict):
        raise DeployError("发布清单必须是 JSON 对象。")
    for key in ("version", "platform", "gitCommit", "sourceDigest"):
        if not isinstance(value.get(key), str):
            raise DeployError("发布清单字段缺失：" + key)
    if not VERSION.fullmatch(value.get("version", "")) or value.get("platform") != "linux/amd64":
        raise DeployError("目前只支持正式版本的 Linux amd64 发布包。")
    if not re.fullmatch(r"[a-f0-9]{40}", value.get("gitCommit", "")):
        raise DeployError("发布包没有固定 Git 提交。")
    if not HEX.fullmatch(value.get("sourceDigest", "")):
        raise DeployError("源码指纹格式错误。")
    for key in ("images", "artifacts", "sourceFiles"):
        if not isinstance(value.get(key), list) or any(not isinstance(i, dict) for i in value[key]):
            raise DeployError("发布清单列表格式错误：" + key)
    images = value.get("images", [])
    for prefix in ("api", "web", "postgres"):
        matches = [i for i in images if i.get("tag", "").startswith("four-layer-workbench-" + prefix + ":")]
        if len(matches) != 1 or not re.fullmatch(r"sha256:[a-f0-9]{64}", matches[0].get("id", "")):
            raise DeployError("运行镜像清单不完整。")
    if len(images) != 3:
        raise DeployError("发布包镜像数量不正确。")
    for key in ("artifacts", "sourceFiles"):
        entries = value.get(key, [])
        if any(not isinstance(i.get("path"), str) or not isinstance(i.get("sha256"), str) for i in entries):
            raise DeployError("发布包文件条目格式错误。")
        if not entries or len({i["path"] for i in entries}) != len(entries):
            raise DeployError("发布包文件清单为空或重复。")
        if any(not HEX.fullmatch(i.get("sha256", "")) for i in entries):
            raise DeployError("发布包校验值格式错误。")
    required = {"compose.production.yaml", "deploy/production.env.example", "images.tar.gz", "source.tar.gz"}
    if not required.issubset({i["path"] for i in value["artifacts"]}):
        raise DeployError("发布包缺少运行文件。")
    return value


def archive_image_ids(archive, images):
    """Map config IDs and OCI manifest IDs to the same verified archive content.

    Classic Docker reports the config digest; containerd may report the manifest
    digest. Accept only a digest connected to the release ID in the saved graph.
    """
    metadata = {}
    size = 0
    with tarfile.open(archive, "r|gz") as stream:
        for entry in stream:
            if entry.isfile() and entry.size <= 1024 * 1024:
                data = stream.extractfile(entry).read()
                if data[:1] in (b"{", b"["):
                    size += len(data)
                    if size > 16 * 1024 * 1024:
                        raise DeployError("镜像元数据超过大小限制。")
                    metadata[entry.name] = data

    def blob(digest):
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise DeployError("镜像摘要格式不正确。")
        raw = metadata["blobs/sha256/" + digest[7:]]
        if hashlib.sha256(raw).hexdigest() != digest[7:]:
            raise DeployError("镜像配置或清单内容与摘要不符。")
        return json.loads(raw)

    def identities(digest, depth=0):
        if depth > 5:
            raise DeployError("镜像清单嵌套过深。")
        value = blob(digest)
        if "manifests" in value:
            result = set()
            for item in value["manifests"]:
                result.update(identities(item["digest"], depth + 1))
            return result | {digest} if result else set()
        config_digest = value["config"]["digest"]
        config = blob(config_digest)
        if config.get("os") == "linux" and config.get("architecture") == "amd64":
            return {digest, config_digest}
        return set()

    index = json.loads(metadata.get("index.json", b'{"manifests":[]}'))
    legacy = json.loads(metadata.get("manifest.json", b"[]"))
    result = {}
    for image in images:
        allowed = {image["id"]}
        for descriptor in index["manifests"]:
            name = descriptor.get("annotations", {}).get("io.containerd.image.name", "")
            if name == image["tag"] or name.endswith("/" + image["tag"]):
                related = identities(descriptor["digest"])
                if image["id"] not in related:
                    raise DeployError("发布镜像 ID 与归档清单关联不一致。")
                allowed.update(related)
        for item in legacy:
            if image["tag"] in (item.get("RepoTags") or []):
                raw = metadata[item["Config"]]
                config_id = "sha256:" + hashlib.sha256(raw).hexdigest()
                if config_id not in allowed:
                    raise DeployError("Docker 镜像配置不在已验证的摘要链中。")
        result[image["tag"]] = allowed
    return result


def verify_files(root, entries):
    for entry in entries:
        path = safe_path(root, entry["path"])
        if not path.is_file() or sha256(path) != entry["sha256"]:
            raise DeployError("文件校验失败：" + entry["path"])


class Downloader:
    def __init__(self, mirrors, timeout=600):
        self.mirrors = mirrors
        self.timeout = timeout
        self.preferred = None

    def fetch(self, url, target, validate=None, small=False):
        # No tokens/cookies are sent to public acceleration services.
        routes = list(dict.fromkeys(([self.preferred] if self.preferred is not None else []) + self.mirrors + [""]))
        errors = []
        for route in routes:
            label = urllib.parse.urlsplit(route).netloc if route else "GitHub 官方"
            download_url = route.rstrip("/") + "/" + url if route else url
            partial = target.with_name(target.name + ".partial")
            try:
                log("下载：" + label + " / " + target.name)
                # A subprocess deadline also bounds DNS/connect hangs on Windows curl.
                result = subprocess.run([
                    "curl", "--fail", "--location", "--silent", "--show-error",
                    "--proto", "=https", "--proto-redir", "=https",
                    "--connect-timeout", "5", "--max-time", str(18 if small else self.timeout),
                    "--speed-limit", "32768", "--speed-time", "20",
                    "--output", str(partial), download_url,
                ], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    timeout=25 if small else self.timeout + 10)
                if result.returncode:
                    raise DeployError("HTTP 下载失败，curl 状态 " + str(result.returncode))
                if validate:
                    validate(partial)
                os.replace(partial, target)
                self.preferred = route
                return target
            except (OSError, ValueError, DeployError, subprocess.TimeoutExpired) as error:
                errors.append(label + ": " + str(error))
                log("此通道未成功，切换备用通道。")
            finally:
                partial.unlink(missing_ok=True)
        raise DeployError("所有下载通道均失败：" + "; ".join(errors))


def check_hash(path, expected):
    if sha256(path) != expected:
        raise DeployError("下载文件 SHA-256 不一致。")


def checksum_file(path, filename):
    fields = path.read_text(encoding="utf-8").strip().split()
    if len(fields) != 2 or not HEX.fullmatch(fields[0]) or fields[1].lstrip("*") != filename:
        raise DeployError("整包校验文件格式错误。")
    return fields[0]


def prepare_release(args, root):
    downloads = root / "downloads"
    downloads.mkdir(exist_ok=True)
    if args.bundle:
        archive = Path(args.bundle).resolve()
        expected = args.sha256 or checksum_file(Path(str(archive) + ".sha256"), archive.name)
        check_hash(archive, expected)
        latest = None
    else:
        mirrors = [] if args.direct else (args.mirror or DEFAULT_MIRRORS)
        for route in mirrors:
            parsed = urllib.parse.urlsplit(route)
            if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.query or parsed.fragment:
                raise DeployError("加速地址必须是无账号、参数的 HTTPS 地址。")
        downloader = Downloader(mirrors, args.download_timeout)
        location = "latest/download" if args.version == "latest" else "download/v" + args.version.removeprefix("v")
        manifest_file = downloads / "requested-release.json"
        downloader.fetch(REPOSITORY + "/releases/" + location + "/release.json", manifest_file,
                         lambda p: validate_manifest(read_json(p)), small=True)
        latest = validate_manifest(read_json(manifest_file))
        if args.version != "latest" and latest["version"] != args.version.removeprefix("v"):
            raise DeployError("请求版本与发布清单不一致。")
        filename = "four-layer-workbench-" + latest["version"] + "-linux-amd64.tar.gz"
        base = REPOSITORY + "/releases/download/v" + latest["version"] + "/" + filename
        sidecar = downloads / (filename + ".sha256")
        downloader.fetch(base + ".sha256", sidecar, lambda p: checksum_file(p, filename), small=True)
        expected = checksum_file(sidecar, filename)
        if args.sha256 and args.sha256 != expected:
            raise DeployError("发布包与指定的 --sha256 不一致。")
        archive = downloads / filename
        if archive.exists() and sha256(archive) == expected:
            log("复用已校验的镜像和源码缓存。")
        else:
            downloader.fetch(base, archive, lambda p: check_hash(p, expected))
    releases = root / "releases"
    releases.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="prepare-", dir=releases) as temporary:
        stage = Path(temporary) / "payload"
        stage.mkdir()
        unpack(archive, stage)
        manifest = validate_manifest(read_json(stage / "release.json"))
        if latest is not None and manifest != latest:
            raise DeployError("完整包与获取的 Release 清单不一致。")
        verify_files(stage, manifest["artifacts"])
        source = stage / "source"
        source.mkdir()
        unpack(stage / "source.tar.gz", source)
        verify_files(source, manifest["sourceFiles"])
        digest = hashlib.sha256()
        for entry in manifest["sourceFiles"]:
            digest.update(entry["path"].encode() + b"\0")
            digest.update(safe_path(source, entry["path"]).read_bytes())
        if digest.hexdigest() != manifest["sourceDigest"]:
            raise DeployError("源代码整体指纹不一致。")
        destination = releases / (manifest["version"] + "-" + expected[:16])
        if destination.exists():
            verify_files(destination, manifest["artifacts"])
            verify_files(destination / "source", manifest["sourceFiles"])
            if read_json(destination / "release.json") != manifest:
                raise DeployError("已有运行目录清单发生变化。")
        else:
            if not destination.resolve().is_relative_to(releases.resolve()):
                raise DeployError("运行目录越界。")
            # Commit the complete directory atomically, so interruption cannot leave
            # a half-written release that would prevent every subsequent retry.
            os.replace(stage, destination)
    log("源码和镜像已校验，版本 " + manifest["version"] + "，提交 " + manifest["gitCommit"][:12])
    return destination, manifest, expected


def parse_env(path):
    result = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip()
    return result


def origin_settings(origin):
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise DeployError("--origin 必须是完整的访问源，例如 https://workbench.example.com。")
    parsed.port  # Validate malformed ports before changing configuration.
    secure = parsed.scheme == "https"
    if not secure and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise DeployError("对外部署须使用 HTTPS 域名；HTTP 仅用于 localhost 本机演练。")
    return origin.rstrip("/"), secure


def configure(args, root, manifest):
    path = root / ".env.production"
    config = parse_env(path) if path.exists() else {}
    if config:
        if args.project and args.project != config["COMPOSE_PROJECT_NAME"]:
            raise DeployError("已有部署不能修改项目名，以免误用其他数据库卷。")
    else:
        project = args.project or "four-workbench-auto"
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,50}", project):
            raise DeployError("项目名只能包含小写字母、数字、下划线及连字符。")
        password = secrets.token_hex(24)
        config = dict(COMPOSE_PROJECT_NAME=project, POSTGRES_USER="workbench", POSTGRES_DB="workbench",
                      POSTGRES_PASSWORD=password, DATABASE_URL="postgresql://workbench:" + password + "@db:5432/workbench",
                      AUTH_TOKEN_SECRET=secrets.token_hex(32), DB_POOL_MAX="10", SESSION_TTL_DAYS="7",
                      ROLLOVER_SCHEDULE_ENABLED="true", WEB_BIND_ADDRESS="127.0.0.1", WEB_PORT=str(args.port or 8080))
    origin = args.origin or config.get("APP_ORIGIN", "http://localhost:" + config["WEB_PORT"])
    if args.port and not args.origin and origin == "http://localhost:" + config["WEB_PORT"]:
        origin = "http://localhost:" + str(args.port)
    config["APP_ORIGIN"], secure = origin_settings(origin)
    config["COOKIE_SECURE"] = str(secure).lower()
    config["TRUST_PROXY_HOPS"] = "2" if secure else "1"
    if args.port:
        config["WEB_PORT"] = str(args.port)
    if args.bind:
        config["WEB_BIND_ADDRESS"] = args.bind
    for service in ("api", "web", "postgres"):
        image = next(i["tag"] for i in manifest["images"] if i["tag"].startswith("four-layer-workbench-" + service + ":"))
        key = service.upper() + "_IMAGE"
        if service == "postgres" and key in config:
            if config[key].split(":")[-1].split("-")[0] != image.split(":")[-1].split("-")[0]:
                raise DeployError("PostgreSQL 大版本发生变化，须先执行独立的数据升级。")
        config[key] = image
    if any("\n" in str(v) or "\r" in str(v) for v in config.values()):
        raise DeployError("配置值不能包含换行。")
    return path, config


class Docker:
    def __init__(self, root, release, config):
        self.root = root
        self.config = config
        self.identities = {}
        self.environment = {k: v for k, v in os.environ.items() if k not in config and not k.startswith("COMPOSE_")}
        self.base = ["docker", "compose", "--project-name", config["COMPOSE_PROJECT_NAME"],
                     "--env-file", str(root / ".env.production"), "-f", str(release / "compose.production.yaml"),
                     "--profile", "database"]

    def run(self, command, output=None, timeout=300):
        result = subprocess.run(command, cwd=self.root, env=self.environment, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode:
            message = result.stderr.decode("utf-8", errors="replace")[-5000:]
            for key, value in {**self.environment, **self.config}.items():
                if any(word in key for word in ("PASSWORD", "TOKEN", "DATABASE_URL")) and value:
                    message = message.replace(value, "[隐藏]")
            raise DeployError("Docker 执行失败：" + message)
        return result.stdout.decode("utf-8", errors="replace").strip() if output is None else ""

    def compose(self, *args, **kwargs):
        return self.run(self.base + list(args), **kwargs)

    def image_matches(self, entry):
        try:
            actual = self.run(["docker", "image", "inspect", entry["tag"], "--format", "{{.Id}}"])
            return actual in self.identities.get(entry["tag"], {entry["id"]})
        except DeployError:
            return False

    def backup(self):
        name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".dump"
        destination = self.root / "backups" / name
        destination.parent.mkdir(exist_ok=True, mode=0o700)
        partial = destination.with_suffix(".partial")
        try:
            fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                self.compose("exec", "-T", "db", "sh", "-c",
                             'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl', output=stream)
            os.replace(partial, destination)
        finally:
            partial.unlink(missing_ok=True)
        write_private(Path(str(destination) + ".sha256"), sha256(destination) + "\n")
        log("升级前数据库已备份：" + str(destination))
        return str(destination)

    def admin(self, username):
        # Persist the generated password BEFORE the database commit, so an
        # interruption/container recreation cannot lose the only credential copy.
        pending = self.root / ".admin-bootstrap.json"
        if pending.exists():
            proposal = read_json(pending)
            if proposal["username"] != username:
                raise DeployError("存在未完成的管理员初始化，请先沿用原 --admin-user 重试。")
        else:
            proposal = dict(username=username, password=secrets.token_urlsafe(12),
                            suffix=secrets.token_hex(8))
            write_json(pending, proposal)
        temporary = "/tmp/bootstrap-" + proposal["suffix"] + ".txt"
        self.environment["BOOTSTRAP_ADMIN_PASSWORD"] = proposal["password"]
        self.environment["BOOTSTRAP_ADMIN_USERNAME"] = username
        try:
            output = self.compose("exec", "-T", "-e", "BOOTSTRAP_ADMIN_PASSWORD",
                                  "-e", "BOOTSTRAP_ADMIN_USERNAME", "-e", "ADMIN_CREDENTIALS_FILE=" + temporary,
                                  "api", "node", "scripts/bootstrap-admin.mjs")
            verified = self.compose("exec", "-T", "-e", "BOOTSTRAP_ADMIN_PASSWORD", "-e", "BOOTSTRAP_ADMIN_USERNAME",
                "api", "node", "--input-type=module", "-e",
                "import pg from 'pg'; import {verifyPassword} from './apps/api/dist/crypto.js';"
                "const p=new pg.Pool({connectionString:process.env.DATABASE_URL});"
                "try{const q=await p.query(\"SELECT password_hash FROM users WHERE username=$1 AND role='admin' AND disabled_at IS NULL AND deleted_at IS NULL\",[process.env.BOOTSTRAP_ADMIN_USERNAME]);"
                "console.log(q.rowCount && await verifyPassword(process.env.BOOTSTRAP_ADMIN_PASSWORD,q.rows[0].password_hash)?'verified':'existing')}finally{await p.end()}")
            if verified == "verified":
                destination = self.root / ("admin-credentials-" + proposal["suffix"] + ".txt")
                write_private(destination, "管理员工号：" + username + "\n初始密码：" + proposal["password"] + "\n登录后可在账号管理中重置密码。\n")
                log("管理员已初始化；工号 " + username + "，初始密码保存在：" + str(destination))
            else:
                log(output)
            self.compose("exec", "-T", "api", "node", "-e",
                         "require('node:fs').rmSync(process.argv[1],{force:true})", temporary)
            pending.unlink()
        finally:
            self.environment.pop("BOOTSTRAP_ADMIN_PASSWORD", None)
            self.environment.pop("BOOTSTRAP_ADMIN_USERNAME", None)


def health_check(config, version):
    bind = config["WEB_BIND_ADDRESS"]
    host = "localhost" if bind in ("0.0.0.0", "::", "[::]") else bind
    if ":" in host and not host.startswith("["):
        host = "[" + host + "]"
    base = "http://" + host + ":" + config["WEB_PORT"]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for path in ("/", "/healthz", "/api/health"):
        with opener.open(base + path, timeout=15) as response:
            if response.status != 200:
                raise DeployError("健康检查失败：" + path)
            if path == "/api/health":
                data = json.load(response)
                if data.get("version") != version:
                    raise DeployError("启动后的应用版本与下载的版本不一致。")
    log("页面、Web 和 API 健康检查通过。")


def deploy(args):
    for tool in ("docker", "curl"):
        if not shutil.which(tool):
            raise DeployError("缺少 " + tool + "，请先按一键部署说明安装运行环境。")
    root = Path(args.dir).expanduser().resolve()
    with deployment_lock(root):
        environment = dict(os.environ)
        environment.pop("DOCKER_DEFAULT_PLATFORM", None)
        info = subprocess.run(["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, env=environment)
        if info.returncode:
            raise DeployError("Docker 未启动或当前账号没有 Docker 权限。")
        if info.stdout.decode().strip() not in ("linux/x86_64", "linux/amd64"):
            raise DeployError("当前发布镜像需要 Linux amd64；Windows 请切换 Docker Desktop 为 Linux 容器。")
        compose = subprocess.run(["docker", "compose", "version", "--short"], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, timeout=20)
        match = re.match(r"v?(\d+)\.(\d+)", compose.stdout.decode().strip())
        if compose.returncode or not match or tuple(map(int, match.groups())) < (2, 20):
            raise DeployError("需要 Docker Compose 2.20 或更新版本。")
        release, manifest, checksum = prepare_release(args, root)
        config_path, config = configure(args, root, manifest)
        previous = read_json(root / "state.json") if (root / "state.json").exists() else None
        if previous and tuple(map(int, manifest["version"].split("."))) < tuple(map(int, previous["version"].split("."))):
            raise DeployError("拒绝自动降级数据库和应用；请先按恢复说明另建环境。")
        docker = Docker(root, release, config)
        log("检查运行镜像（整个过程不构建镜像）。")
        if not all(docker.image_matches(i) for i in manifest["images"]):
            docker.identities = archive_image_ids(release / "images.tar.gz", manifest["images"])
        if not all(docker.image_matches(i) for i in manifest["images"]):
            log("从已校验的发布包装载全部镜像。")
            docker.run(["docker", "load", "--input", str(release / "images.tar.gz")], timeout=600)
        if not all(docker.image_matches(i) for i in manifest["images"]):
            raise DeployError("装载后的镜像 ID 与发布清单不一致。")
        old_content = config_path.read_text(encoding="utf-8") if config_path.exists() else None
        new_content = "".join(k + "=" + v + "\n" for k, v in config.items())
        config_digest = hashlib.sha256(new_content.encode()).hexdigest()
        changed = (not previous or previous["bundleSha256"] != checksum or old_content != new_content
                   or previous.get("configSha256") != config_digest)
        # Detect a previous failed attempt as well as a healthy deployment. Never reuse an
        # existing database volume without the matching configuration and passwords.
        project = config["COMPOSE_PROJECT_NAME"]
        volumes = docker.run(["docker", "volume", "ls", "--filter", "label=com.docker.compose.project=" + project, "--format", "{{.Name}}"])
        containers = docker.run(["docker", "ps", "--all", "--filter", "label=com.docker.compose.project=" + project, "--format", "{{.ID}}"])
        if old_content is None and (volumes or containers):
            raise DeployError("项目已有容器或数据卷但本目录没有原配置；请找回原部署目录和密钥，勿重新初始化。")
        backup = previous.get("backup") if previous else None
        if changed and (containers or volumes):
            # Use the old database image/password before changing configuration.
            old_config = parse_env(config_path)
            old_release = Path(previous["releaseDir"]) if previous else release
            old_docker = Docker(root, old_release, old_config)
            old_docker.compose("up", "-d", "--pull", "never", "--no-build", "--wait", "--wait-timeout", str(args.timeout), "db", timeout=args.timeout + 30)
            backup = old_docker.backup()
        if changed and previous and not (root / "pending.json").exists():
            write_json(root / "previous-state.json", previous)
        if changed and old_content is not None and not (root / "pending.json").exists():
            write_private(root / ".env.previous", old_content)
        write_private(config_path, new_content)
        write_json(root / "pending.json", dict(version=manifest["version"], releaseDir=str(release), backup=backup))
        log("启动数据库、执行迁移并等待前后端就绪……")
        # An exited migration container is deliberately rerun by Compose; migrations
        # themselves are idempotent. Never run down -v or prune persistent volumes.
        docker.compose("up", "-d", "--pull", "never", "--no-build", "--wait", "--wait-timeout", str(args.timeout), timeout=args.timeout + 60)
        docker.admin(args.admin_user)
        health_check(config, manifest["version"])
        state = dict(version=manifest["version"], gitCommit=manifest["gitCommit"], sourceDigest=manifest["sourceDigest"],
                     bundleSha256=checksum, releaseDir=str(release), project=project,
                     deployedAt=dt.datetime.now(dt.timezone.utc).isoformat(), origin=config["APP_ORIGIN"], backup=backup,
                     configSha256=config_digest)
        write_json(root / "state.json", state)
        (root / "pending.json").unlink(missing_ok=True)
        log("部署完成：" + manifest["version"] + "，访问 " + config["APP_ORIGIN"])
        log("源码目录：" + str(release / "source"))
        log("以后运行相同命令即可检查最新 Release 并部署；配置、账号和数据会保留。")
        if config["COOKIE_SECURE"] == "true":
            log("HTTPS 入口需按域名接入反向代理，模板：" + str(release / "deploy/https.nginx.example.conf"))


def arguments(argv=None):
    parser = argparse.ArgumentParser(description="四层工作台：加速下载 GitHub 源码与镜像，校验并自动部署/更新。")
    parser.add_argument("--dir", default=str(Path.home() / "four-workbench-deployment"), help="固定部署目录，后续运行沿用此目录")
    parser.add_argument("--version", default="latest", help="默认 latest；也可指定 1.1.0")
    parser.add_argument("--origin", help="访问源，例如 https://workbench.example.com；默认 localhost 演练")
    parser.add_argument("--port", type=int, help="本机监听端口，默认 8080")
    parser.add_argument("--bind", choices=["127.0.0.1", "0.0.0.0", "::1", "::"], help="默认仅监听本机，供 HTTPS 代理访问")
    parser.add_argument("--project", help="首次部署使用的 Compose 项目名；默认 four-workbench-auto")
    parser.add_argument("--mirror", action="append", help="自定义 HTTPS GitHub 加速前缀，可重复传入；失败后回退官方")
    parser.add_argument("--direct", action="store_true", help="仅使用 GitHub 官方下载通道")
    parser.add_argument("--bundle", help="离线部署：使用本地完整发布包，须有同名 .sha256 文件或 --sha256")
    parser.add_argument("--sha256", help="可选固定的整包 SHA-256，离线和在线均支持")
    parser.add_argument("--admin-user", default="admin", help="没有管理员时创建的工号；不会重置已有管理员")
    parser.add_argument("--timeout", type=int, default=180, help="等待容器健康的秒数，默认 180")
    parser.add_argument("--download-timeout", type=int, default=600, help="单通道大文件下载上限秒数，默认 600")
    result = parser.parse_args(argv)
    if result.version != "latest" and not VERSION.fullmatch(result.version.removeprefix("v")):
        parser.error("--version 需要 latest 或 x.y.z")
    if result.sha256 and not HEX.fullmatch(result.sha256):
        parser.error("--sha256 需要 64 位小写十六进制")
    if result.port is not None and not 1 <= result.port <= 65535:
        parser.error("--port 需要 1 至 65535")
    if result.timeout < 30 or result.download_timeout < 30:
        parser.error("超时时间不能小于 30 秒")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}", result.admin_user):
        parser.error("管理员工号格式不正确")
    return result


if __name__ == "__main__":
    if sys.version_info < (3, 10):
        sys.exit("需要 Python 3.10 或更新版本。")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        deploy(arguments())
    except (DeployError, OSError, ValueError, KeyError, subprocess.TimeoutExpired, tarfile.TarError) as error:
        log("部署未完成：" + str(error))
        log("已有数据卷与配置不会删除。修复后运行相同命令重试；失败版本不会写入成功记录。")
        sys.exit(1)
    except KeyboardInterrupt:
        log("部署已中断；数据卷保留，可运行相同命令重试。")
        sys.exit(130)
