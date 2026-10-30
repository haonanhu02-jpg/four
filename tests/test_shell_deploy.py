"""Exercise sourcing in a real Bash process without starting a deployment."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
BASH = shutil.which('bash') if os.name == 'posix' else None


@unittest.skipUnless(BASH, 'Requires Linux/Bash; run through WSL on Windows')
class SourceDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='four source test ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.launcher = self.root / 'source-deploy.sh'
        shutil.copyfile(REPO / 'deploy/auto-deploy.sh', self.launcher)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.temp = self.root / 'temp'
        self.temp.mkdir()
        self.environment = {**os.environ, 'TMPDIR': str(self.temp),
                            'PATH': str(self.bin) + os.pathsep + os.environ['PATH']}
        self.environment.pop('BASH_ENV', None)

    def companion(self):
        (self.root / 'auto-deploy.py').write_text(
            'import sys,json,os\n'
            'print("PROGRAM:"+json.dumps(dict(args=sys.argv[1:],cwd=os.getcwd())))\n'
            'sys.exit(7 if "--fail" in sys.argv else 0)\n', encoding='utf-8')

    def source(self, arguments, repeat=False):
        script = '''
set -u
launcher=$1
shift
caller_options=$SHELLOPTS
caller_directory=$PWD
trap ':' EXIT
caller_trap=$(trap -p EXIT)
if source "$launcher" "$@"; then result=0; else result=$?; fi
[[ $SHELLOPTS == "$caller_options" ]] || exit 90
[[ $PWD == "$caller_directory" ]] || exit 91
[[ $(trap -p EXIT) == "$caller_trap" ]] || exit 92
'''
        if repeat:
            script += 'if source "$launcher" "$@"; then result=0; else result=$?; fi\n'
        script += 'printf "PARENT:%s\\n" "$result"\nprintf "ARGS:%s\\n" "$@"\n'
        return subprocess.run([BASH, '--noprofile', '--norc', '-c', script, 'test', str(self.launcher), *arguments],
                              cwd=self.root, env=self.environment, capture_output=True, encoding='utf-8', timeout=30)

    def fake_download(self, all_bad=False):
        fake = self.bin / 'curl'
        fake.write_text('#!' + sys.executable + '\n' +
            'from pathlib import Path\nimport sys,json,shutil\n'
            f'log=Path({str(self.root / "calls.jsonl")!r})\n'
            'with log.open("a") as stream:stream.write(json.dumps(sys.argv[1:])+"\\n")\n'
            'output=Path(sys.argv[sys.argv.index("--output")+1])\n'
            f'bad={all_bad!r} or sys.argv[-1].startswith("https://ghfast.top/")\n'
            'if bad:output.write_bytes(b"corrupted-download")\n'
            f'else:shutil.copyfile({str(REPO / "deploy/auto-deploy.py")!r},output)\n', encoding='utf-8')
        fake.chmod(0o755)

    def test_syntax_and_bootstrap_pin_match_the_deployment_tool(self):
        subprocess.run([BASH, '-n', str(self.launcher)], check=True)
        script = self.launcher.read_text(encoding='utf-8')
        pin = re.search(r"wb_bootstrap_sha256='([0-9a-f]{64})'", script).group(1)
        self.assertEqual(pin, hashlib.sha256((REPO / 'deploy/auto-deploy.py').read_bytes()).hexdigest())

    def test_source_preserves_shell_directory_options_traps_and_spaced_arguments(self):
        self.companion()
        result = self.source(['--dir', 'deployment path with spaces', '--port', '8088'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PARENT:0', result.stdout)
        received = json.loads(next(line[8:] for line in result.stdout.splitlines() if line.startswith('PROGRAM:')))
        self.assertEqual(received['args'], ['--dir', 'deployment path with spaces', '--port', '8088'])
        self.assertEqual(received['cwd'], str(self.root))
        self.assertIn('ARGS:deployment path with spaces', result.stdout)

    def test_failed_deployment_returns_status_without_replacing_the_caller(self):
        self.companion()
        result = self.source(['--fail'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PARENT:7', result.stdout)

    def test_repeated_source_calls_return_to_the_same_shell(self):
        self.companion()
        result = self.source(['--dir', 'same deployment'], repeat=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('PROGRAM:'), 2)
        self.assertIn('PARENT:0', result.stdout)

    def test_direct_bash_execution_also_preserves_the_exit_status(self):
        self.companion()
        result = subprocess.run([BASH, str(self.launcher), '--fail'], cwd=self.root,
                                env=self.environment, capture_output=True, encoding='utf-8', timeout=20)
        self.assertEqual(result.returncode, 7, result.stderr)

    def test_standalone_download_rejects_corruption_and_uses_the_backup_channel(self):
        self.fake_download()
        result = self.source(['--help'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PARENT:0', result.stdout)
        self.assertIn('--download-timeout', result.stdout)
        requests = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertEqual(len(requests), 2)
        self.assertTrue(requests[1][-1].startswith('https://gh-proxy.com/'))
        self.assertEqual(list(self.temp.iterdir()), [])

    def test_all_bad_channels_never_execute_downloaded_content_and_clean_up(self):
        self.fake_download(all_bad=True)
        result = self.source(['--help'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PARENT:1', result.stdout)
        self.assertNotIn('--download-timeout', result.stdout)
        self.assertEqual(len((self.root / 'calls.jsonl').read_text().splitlines()), 3)
        self.assertEqual(list(self.temp.iterdir()), [])

    def test_missing_supported_python_returns_to_the_caller(self):
        self.companion()
        fake = self.bin / 'python3'
        fake.write_text('#!/bin/sh\nexit 1\n', encoding='utf-8')
        fake.chmod(0o755)
        result = self.source(['--help'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PARENT:1', result.stdout)
        self.assertNotIn('PROGRAM:', result.stdout)


if __name__ == '__main__':
    unittest.main()
