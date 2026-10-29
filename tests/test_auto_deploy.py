"""Deployment safety checks without network access or a Docker daemon."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("auto_deploy", Path(__file__).resolve().parents[1] / "deploy/auto-deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


def manifest(version="1.1.0"):
    return dict(version=version, platform="linux/amd64", gitCommit="a" * 40, sourceDigest="b" * 64,
                images=[dict(tag="four-layer-workbench-" + service + ":" + ("18-abc" if service == "postgres" else version),
                             id="sha256:" + "c" * 64) for service in ("api", "web", "postgres")],
                sourceFiles=[dict(path="package.json", sha256="d" * 64)],
                artifacts=[dict(path=p, sha256="e" * 64) for p in
                           ("compose.production.yaml", "deploy/production.env.example", "images.tar.gz", "source.tar.gz")])


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_reject_archive_traversal_before_writing_any_file(self):
        for name in ("../escape", "/absolute", "a/../../escape", "a\\escape", "C:/escape"):
            with self.subTest(name=name):
                archive = self.root / "test.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    item = tarfile.TarInfo("safe.txt")
                    item.size = 2
                    tar.addfile(item, io.BytesIO(b"ok"))
                    item = tarfile.TarInfo(name)
                    tar.addfile(item, io.BytesIO())
                target = self.root / "extract"
                target.mkdir(exist_ok=True)
                with self.assertRaises(deploy.DeployError):
                    deploy.unpack(archive, target)
                self.assertEqual(list(target.iterdir()), [])

    def test_reject_links_devices_and_duplicates(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, "duplicate"):
            with self.subTest(kind=kind):
                archive = self.root / "test.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    item = tarfile.TarInfo("item")
                    if kind == "duplicate":
                        tar.addfile(item)
                    else:
                        item.type = kind
                        item.linkname = "target"
                    tar.addfile(item)
                with self.assertRaises(deploy.DeployError):
                    deploy.unpack(archive, self.root / "extract")

    def test_extract_regular_files_with_unicode(self):
        archive = self.root / "good.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            item = tarfile.TarInfo("docs/部署.md")
            item.size = 2
            tar.addfile(item, io.BytesIO(b"ok"))
        deploy.unpack(archive, self.root / "out")
        self.assertEqual((self.root / "out/docs/部署.md").read_bytes(), b"ok")

    def test_verified_release_is_installed_atomically_and_can_be_reused(self):
        payload = self.root / "payload"
        (payload / "deploy").mkdir(parents=True)
        source = b'{"name":"deployment-fixture"}'
        with tarfile.open(payload / "source.tar.gz", "w:gz") as tar:
            item = tarfile.TarInfo("package.json")
            item.size = len(source)
            tar.addfile(item, io.BytesIO(source))
        (payload / "images.tar.gz").write_bytes(b"fixture-image-archive")
        (payload / "compose.production.yaml").write_text("services: {}\n")
        (payload / "deploy/production.env.example").write_text("WEB_PORT=8080\n")
        value = manifest()
        value["sourceFiles"] = [dict(path="package.json", sha256=hashlib.sha256(source).hexdigest())]
        value["sourceDigest"] = hashlib.sha256(b"package.json\0" + source).hexdigest()
        for entry in value["artifacts"]:
            entry["sha256"] = deploy.sha256(payload / entry["path"])
        deploy.write_json(payload / "release.json", value)
        archive = self.root / "release.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for path in payload.rglob("*"):
                if path.is_file():
                    tar.add(path, arcname=path.relative_to(payload).as_posix())
        args = deploy.arguments(["--bundle", str(archive), "--sha256", deploy.sha256(archive)])
        installation = self.root / "installation"
        installation.mkdir()
        first, _, _ = deploy.prepare_release(args, installation)
        second, _, _ = deploy.prepare_release(args, installation)
        self.assertEqual(first, second)
        self.assertEqual((first / "source/package.json").read_bytes(), source)
        self.assertEqual(list((installation / "releases").glob("prepare-*")), [])

    def test_hash_and_source_file_tampering_are_rejected(self):
        path = self.root / "file"
        path.write_bytes(b"correct")
        expected = hashlib.sha256(b"correct").hexdigest()
        deploy.verify_files(self.root, [dict(path="file", sha256=expected)])
        path.write_bytes(b"changed")
        with self.assertRaises(deploy.DeployError):
            deploy.verify_files(self.root, [dict(path="file", sha256=expected)])

    def test_classic_and_containerd_ids_are_linked_by_verified_archive_blobs(self):
        config = json.dumps(dict(os="linux", architecture="amd64")).encode()
        config_id = "sha256:" + hashlib.sha256(config).hexdigest()
        image = json.dumps(dict(config=dict(digest=config_id))).encode()
        image_id = "sha256:" + hashlib.sha256(image).hexdigest()
        tag = "four-layer-workbench-api:1.1.0"
        index = dict(manifests=[dict(digest=image_id, annotations={"io.containerd.image.name": "docker.io/library/" + tag})])
        archive = self.root / "images.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for name, data in [("index.json", json.dumps(index).encode()),
                               ("blobs/sha256/" + config_id[7:], config),
                               ("blobs/sha256/" + image_id[7:], image)]:
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                tar.addfile(entry, io.BytesIO(data))
        ids = deploy.archive_image_ids(archive, [dict(tag=tag, id=config_id)])
        self.assertEqual(ids[tag], {image_id, config_id})
        with self.assertRaises(deploy.DeployError):
            deploy.archive_image_ids(archive, [dict(tag=tag, id="sha256:" + "f" * 64)])

    def test_release_must_include_all_runtime_files_images_and_fixed_commit(self):
        deploy.validate_manifest(manifest())
        for field, value in (("gitCommit", None), ("platform", "linux/arm64"), ("images", []), ("artifacts", [])):
            with self.subTest(field=field):
                changed = manifest()
                changed[field] = value
                with self.assertRaises((deploy.DeployError, TypeError)):
                    deploy.validate_manifest(changed)

    def test_env_secrets_and_project_are_preserved_on_update(self):
        args = deploy.arguments(["--port", "18080"])
        path, initial = deploy.configure(args, self.root, manifest())
        deploy.write_private(path, "".join(k + "=" + v + "\n" for k, v in initial.items()))
        _, updated = deploy.configure(deploy.arguments([]), self.root, manifest("1.1.1"))
        for field in ("POSTGRES_PASSWORD", "AUTH_TOKEN_SECRET", "DATABASE_URL", "COMPOSE_PROJECT_NAME"):
            self.assertEqual(initial[field], updated[field])
        self.assertEqual(updated["APP_ORIGIN"], "http://localhost:18080")
        with self.assertRaises(deploy.DeployError):
            deploy.configure(deploy.arguments(["--project", "different"]), self.root, manifest())

    def test_changed_local_port_updates_origin_and_https_origin_is_preserved(self):
        path, first = deploy.configure(deploy.arguments([]), self.root, manifest())
        deploy.write_private(path, "".join(k + "=" + v + "\n" for k, v in first.items()))
        _, changed = deploy.configure(deploy.arguments(["--port", "18081"]), self.root, manifest())
        self.assertEqual(changed["APP_ORIGIN"], "http://localhost:18081")
        _, external = deploy.configure(deploy.arguments(["--origin", "https://work.example.com", "--port", "18082"]), self.root, manifest())
        self.assertEqual(external["APP_ORIGIN"], "https://work.example.com")
        self.assertEqual(external["COOKIE_SECURE"], "true")

    def test_reject_public_http_and_origin_credentials_or_paths(self):
        for origin in ("http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?x=1"):
            with self.subTest(origin=origin), self.assertRaises(deploy.DeployError):
                deploy.origin_settings(origin)

    def test_postgres_major_change_is_not_applied_automatically(self):
        path, initial = deploy.configure(deploy.arguments([]), self.root, manifest())
        deploy.write_private(path, "".join(k + "=" + v + "\n" for k, v in initial.items()))
        new = manifest()
        new["images"][2]["tag"] = "four-layer-workbench-postgres:19-new"
        with self.assertRaises(deploy.DeployError):
            deploy.configure(deploy.arguments([]), self.root, new)

    def test_failed_mirror_or_bad_hash_falls_back_without_partial_files(self):
        target = self.root / "download"
        calls = []

        def fake_curl(command, **kwargs):
            self.assertNotIn("Authorization", " ".join(command))
            calls.append(command[-1])
            partial = Path(command[command.index("--output") + 1])
            partial.write_bytes(b"bad" if len(calls) == 1 else b"good")
            return subprocess.CompletedProcess(command, 0, b"", b"")

        with patch.object(deploy.subprocess, "run", fake_curl):
            downloader = deploy.Downloader(["https://first.example", "https://second.example"])
            downloader.fetch("https://github.com/file", target,
                             lambda p: deploy.check_hash(p, hashlib.sha256(b"good").hexdigest()))
            downloader.fetch("https://github.com/next", target)
        self.assertEqual(len(calls), 3)
        self.assertTrue(calls[2].startswith("https://second.example/"))
        self.assertEqual(target.read_bytes(), b"good")
        self.assertFalse(Path(str(target) + ".partial").exists())

    def test_total_download_failure_does_not_replace_verified_cache(self):
        target = self.root / "download"
        target.write_bytes(b"cached")
        with patch.object(deploy.subprocess, "run", return_value=subprocess.CompletedProcess([], 22, b"", b"bad")):
            with self.assertRaises(deploy.DeployError):
                deploy.Downloader([]).fetch("https://github.com/file", target)
        self.assertEqual(target.read_bytes(), b"cached")

    def test_shell_environment_does_not_override_saved_settings(self):
        config = dict(POSTGRES_PASSWORD="saved-password", DATABASE_URL="saved-url", WEB_PORT="18080", COMPOSE_PROJECT_NAME="test")
        with patch.dict(os.environ, {"POSTGRES_PASSWORD": "wrong", "COMPOSE_FILE": "wrong.yaml", "COMPOSE_PROFILES": "wrong"}):
            docker = deploy.Docker(self.root, self.root, config)
        self.assertNotIn("POSTGRES_PASSWORD", docker.environment)
        self.assertNotIn("COMPOSE_FILE", docker.environment)
        self.assertNotIn("COMPOSE_PROFILES", docker.environment)

    def test_docker_errors_redact_passwords_and_connection_strings(self):
        config = dict(POSTGRES_PASSWORD="secret-pass", DATABASE_URL="postgres://secret-pass@host/db", COMPOSE_PROJECT_NAME="test")
        docker = deploy.Docker(self.root, self.root, config)
        with patch.object(deploy.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", config["DATABASE_URL"].encode())):
            with self.assertRaises(deploy.DeployError) as result:
                docker.run(["docker", "info"])
        self.assertNotIn("secret-pass", str(result.exception))

    def test_failed_backup_never_leaves_a_valid_dump(self):
        docker = deploy.Docker(self.root, self.root, dict(COMPOSE_PROJECT_NAME="test"))
        with patch.object(docker, "compose", side_effect=deploy.DeployError("backup failed")):
            with self.assertRaises(deploy.DeployError):
                docker.backup()
        self.assertEqual(list((self.root / "backups").iterdir()), [])

    def test_existing_admin_is_not_reset_and_no_false_credentials_are_saved(self):
        docker = deploy.Docker(self.root, self.root, dict(COMPOSE_PROJECT_NAME="test"))
        with patch.object(docker, "compose", side_effect=["已有可用管理员", "existing", ""]):
            docker.admin("admin")
        self.assertFalse((self.root / ".admin-bootstrap.json").exists())
        self.assertEqual(list(self.root.glob("admin-credentials-*.txt")), [])

    def test_interrupted_admin_bootstrap_reuses_saved_password(self):
        docker = deploy.Docker(self.root, self.root, dict(COMPOSE_PROJECT_NAME="test"))
        with patch.object(docker, "compose", side_effect=deploy.DeployError("interrupted")):
            with self.assertRaises(deploy.DeployError):
                docker.admin("admin")
        proposal = deploy.read_json(self.root / ".admin-bootstrap.json")
        self.assertNotIn("BOOTSTRAP_ADMIN_PASSWORD", docker.environment)
        with patch.object(docker, "compose", side_effect=["已初始化", "verified", ""]):
            docker.admin("admin")
        self.assertIn(proposal["password"], (self.root / ("admin-credentials-" + proposal["suffix"] + ".txt")).read_text(encoding="utf-8"))
        self.assertFalse((self.root / ".admin-bootstrap.json").exists())

    def test_process_lock_is_released_after_failure(self):
        with self.assertRaises(RuntimeError):
            with deploy.deployment_lock(self.root):
                raise RuntimeError("interrupted")
        with deploy.deployment_lock(self.root):
            with self.assertRaises(deploy.DeployError):
                with deploy.deployment_lock(self.root):
                    self.fail("second deployment acquired the lock")


if __name__ == "__main__":
    unittest.main()
