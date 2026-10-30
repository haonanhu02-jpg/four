"""Real image deployment test. Use only an isolated four-deploy-check-* project."""
import argparse
import datetime as dt
import http.cookiejar
import importlib.util
import json
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.request
import uuid

SPEC = importlib.util.spec_from_file_location("auto_deploy", Path(__file__).resolve().parents[1] / "deploy/auto-deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--direct", action="store_true")
    parser.add_argument("--shell-source", action="store_true")
    args = parser.parse_args()
    if not args.project.startswith("four-deploy-check-"):
        parser.error("This test must use an isolated four-deploy-check-* project")
    root = Path(args.dir).resolve()
    script = Path(__file__).resolve().parents[1] / "deploy/auto-deploy.py"
    command = [sys.executable, str(script), "--dir", str(root), "--project", args.project]
    if args.shell_source:
        command = ["bash", "--noprofile", "--norc", "-c",
                   'if source "$1" "${@:2}"; then result=0; else result=$?; fi; '
                   'printf "SOURCE_RETURNED:%s\\n" "$result"; exit "$result"',
                   "source-deployment-test", str(script.with_suffix('.sh')),
                   "--dir", str(root), "--project", args.project]
    if args.direct:
        command.append("--direct")

    def run(*options, expected=0):
        result = subprocess.run(command + list(options), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=1000)
        output = result.stdout.decode("utf-8", errors="replace")
        print(output, flush=True)
        if args.shell_source:
            assert "SOURCE_RETURNED:" + str(expected) in output, "source must return to the calling shell"
        if result.returncode != expected:
            raise AssertionError("Deployment exit code " + str(result.returncode))

    run("--port", str(args.port))
    state = deploy.read_json(root / "state.json")
    config = deploy.parse_env(root / ".env.production")
    docker = deploy.Docker(root, Path(state["releaseDir"]), config)
    credentials = {p.name: deploy.sha256(p) for p in root.glob("admin-credentials-*.txt")}
    assert credentials, "Fresh deployment must save initial admin credentials"
    private = {k: config[k] for k in ("AUTH_TOKEN_SECRET", "POSTGRES_PASSWORD", "DATABASE_URL")}
    before_backups = set((root / "backups").glob("*.dump"))
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    origin = config["APP_ORIGIN"]

    def request(path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        value = urllib.request.Request(origin + "/api" + path, data=data,
                                       headers={"Origin": origin, "Content-Type": "application/json"})
        with opener.open(value, timeout=20) as response:
            return json.load(response)

    username, password = "deploy-check-" + uuid.uuid4().hex, secrets.token_urlsafe(12)
    user = request("/auth/register", dict(username=username, password=password))["user"]
    goal = request("/work-items/annual", dict(operationId=str(uuid.uuid4()),
                    values=dict(title="Repeat deployment preserves this goal", year=dt.datetime.now().year)))["item"]

    def roster():
        return docker.compose("exec", "-T", "db", "psql", "-U", config["POSTGRES_USER"], "-d", config["POSTGRES_DB"],
            "-Atc", "SELECT json_agg(t ORDER BY id) FROM (SELECT id,username,role,password_hash FROM users) t")

    original_roster = roster()
    run("--port", str(args.port))
    assert original_roster == roster(), "Account IDs and password hashes must survive repeat deployment"
    assert set((root / "backups").glob("*.dump")) == before_backups, "Unchanged version should reuse its cache without redundant backups"
    request("/auth/login", dict(username=username, password=password))
    assert request("/work-items/annual/" + goal["id"])["item"]["title"] == goal["title"]

    # Stop all containers, then change the port to exercise recovery and backup.
    docker.compose("stop")
    run("--port", str(args.port + 1))
    config = deploy.parse_env(root / ".env.production")
    origin = config["APP_ORIGIN"]
    docker = deploy.Docker(root, Path(state["releaseDir"]), config)
    assert original_roster == roster()
    assert private == {k: config[k] for k in private}
    assert credentials == {p.name: deploy.sha256(p) for p in root.glob("admin-credentials-*.txt")}
    assert request("/auth/login", dict(username=username, password=password))["user"]["id"] == user["id"]
    assert request("/work-items/annual/" + goal["id"])["item"]["title"] == goal["title"]
    backups = set((root / "backups").glob("*.dump")) - before_backups
    assert len(backups) == 1, "Configuration change must first create a database backup"
    backup = backups.pop()
    assert backup.read_bytes().startswith(b"PGDMP")
    assert deploy.sha256(backup) == Path(str(backup) + ".sha256").read_text().strip()
    with backup.open("rb") as stream:
        catalog = subprocess.run(docker.base + ["exec", "-T", "db", "pg_restore", "--list"], stdin=stream,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=docker.environment, timeout=30)
    assert catalog.returncode == 0 and b"annual_goals" in catalog.stdout

    # A corrupted/pinned-wrong package must leave the successful configuration untouched.
    config_hash = deploy.sha256(root / ".env.production")
    successful_state = (root / "state.json").read_bytes()
    bundle = root / "downloads" / ("four-layer-workbench-" + state["version"] + "-linux-amd64.tar.gz")
    run("--bundle", str(bundle), "--sha256", "0" * 64, expected=1)
    assert deploy.sha256(root / ".env.production") == config_hash
    assert (root / "state.json").read_bytes() == successful_state
    deploy.health_check(config, state["version"])
    report = dict(version=state["version"], source=state["gitCommit"], freshDeployment=True,
                  repeatedDeployment=True, restartStoppedServices=True, credentialsPreserved=True,
                  accountsAndGoalsPreserved=True, backupVerifiedWithPgRestore=True,
                  corruptedPackageLeavesCurrentServiceUntouched=True,
                  url=config["APP_ORIGIN"])
    deploy.write_json(root / "smoke-result.json", report)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
