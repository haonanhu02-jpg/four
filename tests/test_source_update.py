"""Real Bash execution with isolated Git/Docker doubles; no production writes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

@unittest.skipUnless(os.name == 'posix' and shutil.which('bash'), 'Run on Linux or WSL')
class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='four update ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.app = self.root / 'home/four-workbench'
        self.log = self.root / 'calls'
        self.env = {**os.environ, 'HOME':str(self.root/'home'), 'PATH':str(self.bin)+':'+os.environ['PATH'], 'CALL_LOG':str(self.log)}
        self.env.pop('FOUR_APP_DIR', None)
        self.env.pop('BASH_ENV', None)
        self.env.pop('FOUR_PORT', None)
        self.env.pop('FOUR_ORIGIN', None)
        program = '''#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
a=sys.argv[1:];name=Path(sys.argv[0]).name
with open(os.environ['CALL_LOG'],'a') as f:f.write(json.dumps([name,*a])+'\\n')
if name=='git':
 if 'init' in a:
  p=Path(a[-1]);(p/'.git').mkdir(parents=True,exist_ok=True);sys.exit(0)
 if 'check-ref-format' in a:sys.exit(0)
 p=Path(a[a.index('-C')+1])
 if 'get-url' in a:print('https://github.com/haonanhu02-jpg/four.git')
 elif 'status' in a:
  if os.environ.get('DIRTY'):print(' M tracked')
 elif 'fetch' in a:
  if os.environ.get('FETCH_FAIL') or any('ghfast.top' in x for x in a):sys.exit(1)
 elif 'checkout' in a:
  (p/'Dockerfile').write_text('ARG NODE_IMAGE=node:24@sha256:abc\\nARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1@sha256:def\\n')
  (p/'compose.yaml').write_text('services: {}\\n');(p/'package.json').write_text('{}')
 elif 'rev-parse' in a:
  if '--verify' in a and not (p/'Dockerfile').exists():sys.exit(1)
  print('a'*40)
 elif 'branch' in a:print('main')
elif name=='docker':
 if os.environ.get('CHECK_PORT') and any(v in a for v in ['build','up','run']):
  assert os.environ['WEB_PORT']=='5001', 'stale port override'
  assert os.environ['COMPOSE_APP_ORIGIN']=='http://192.168.3.110:5001', 'stale origin override'
 if a==['compose','version','--short']:print('2.30.0')
 elif 'config' in a:
  assert 'POSTGRES_PASSWORD' not in os.environ
  print(json.dumps({'services':{'db':{'environment':{'POSTGRES_USER':'workbench','POSTGRES_DB':'workbench','POSTGRES_PASSWORD':'mock-password'}}}}))
 elif 'pull' in a:
  if any('docker.1ms.run/' in x for x in a):sys.exit(1)
 elif 'build' in a:
  if os.environ.get('BUILD_FAIL'):sys.exit(1)
  if os.environ.get('CONSUME_BUILD'):sys.stdin.read()
 elif 'exec' in a and any('pg_dump' in x for x in a):
  if os.environ.get('BACKUP_FAIL'):sys.exit(1)
  print('mock-dump')
 elif 'pg_restore' in a:sys.stdin.read()
 elif 'run' in a:
  if 'scripts/database-connection.mjs' in a:
   marker=Path(os.environ['CALL_LOG']+'.repaired')
   if 'check' in a:
    if os.environ.get('AUTH_ERROR'):sys.exit(1)
    if os.environ.get('AUTH_FAIL') and not marker.exists():sys.exit(28)
   elif 'repair-sql' in a:print('ALTER ROLE mock;')
  sys.stdin.read()
 elif 'exec' in a and any('ON_ERROR_STOP' in x for x in a):
  assert 'pg_dump' in Path(os.environ['CALL_LOG']).read_text()
  assert sys.stdin.read().strip()=='ALTER ROLE mock;'
  Path(os.environ['CALL_LOG']+'.repaired').touch()
 elif 'ps' in a and os.environ.get('DB_MAJOR'):print('existing-db')
 elif 'inspect' in a:print('true')
 elif 'exec' in a and any('server_version_num' in x for x in a):print(os.environ['DB_MAJOR']+'0000')
'''
        for name in ('git','docker'):
            file=self.bin/name
            file.write_text(program,encoding='utf-8');file.chmod(0o755)

    def run_script(self):
        command='''set -u
before=$SHELLOPTS
directory=$PWD
launcher=$1
shift
if source "$launcher"; then code=0; else code=$?; fi
[[ $before == "$SHELLOPTS" && $PWD == "$directory" ]] || exit 90
echo RETURNED:$code
exit "$code"
'''
        return subprocess.run(['bash','-c',command,'test',str(ROOT/'update-four.sh')],env=self.env,cwd=self.root,capture_output=True,text=True,timeout=30)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_success_and_rerun_preserve_config(self):
        r=self.run_script();self.assertEqual(r.returncode,0,r.stderr)
        config=(self.app/'.env').read_bytes()
        self.assertIn(b'WEB_PORT=5001',config)
        self.assertIn(b'COMPOSE_APP_ORIGIN=http://192.168.3.110:5001',config)
        r=self.run_script();self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(config,(self.app/'.env').read_bytes())
        calls=self.calls()
        self.assertTrue(any('gh-proxy.com' in ' '.join(c) for c in calls))
        self.assertTrue(any('docker.xuanyuan.me' in ' '.join(c) for c in calls))
        self.assertTrue(list((self.app/'.local/source-backups').glob('*.dump')))
        self.assertFalse(any('down' in c for c in calls))
        self.assertIn('RETURNED:0',r.stdout)
        self.assertIn('部署完成',r.stdout)
        self.assertEqual(sum('run' in c for c in calls),6)

    def test_fetch_failure_never_changes_containers(self):
        self.env['FETCH_FAIL']='1';r=self.run_script()
        self.assertNotEqual(r.returncode,0)
        self.assertFalse(any('build' in c or 'up' in c for c in self.calls()))
        self.assertIn('RETURNED:1',r.stdout)

    def test_stale_shell_environment_cannot_reenable_port_8080(self):
        self.env.update({'WEB_PORT':'8080','COMPOSE_APP_ORIGIN':'http://old:8080','CHECK_PORT':'1'})
        r=self.run_script();self.assertEqual(r.returncode,0,r.stderr)

    def test_auth_failure_is_repaired_only_after_backup(self):
        self.env.update({'AUTH_FAIL':'1','POSTGRES_PASSWORD':'stale-shell-secret'})
        r=self.run_script();self.assertEqual(r.returncode,0,r.stderr)
        self.assertIn('部署完成',r.stdout)
        calls=self.calls()
        self.assertEqual(sum('repair-sql' in c for c in calls),1)
        self.assertEqual(sum('check' in c for c in calls),2)
        self.assertNotIn('stale-shell-secret',r.stdout+r.stderr+self.log.read_text())

    def test_network_failure_is_not_treated_as_wrong_password(self):
        self.env['AUTH_ERROR']='1';r=self.run_script()
        self.assertNotEqual(r.returncode,0)
        self.assertFalse(any('repair-sql' in c or 'migrate' in c for c in self.calls() if 'run' in c))

    def test_existing_8080_config_migrates_without_changing_secrets(self):
        self.app.mkdir(parents=True)
        original='POSTGRES_PASSWORD=keep-this\nAUTH_TOKEN_SECRET=keep-too\nPOSTGRES_DB=existing\nWEB_PORT=8080\nCOMPOSE_APP_ORIGIN=http://192.168.3.110:8080\nCOOKIE_SECURE=true\n'
        (self.app/'.env').write_text(original)
        (self.app/'.git').mkdir()
        (self.app/'Dockerfile').write_text('ARG NODE_IMAGE=node:24@sha256:abc\nARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1@sha256:def\n')
        (self.app/'compose.yaml').write_text('services: {}\n');(self.app/'package.json').write_text('{}')
        r=self.run_script();self.assertEqual(r.returncode,0,r.stderr)
        updated=(self.app/'.env').read_text()
        for entry in ['POSTGRES_PASSWORD=keep-this','AUTH_TOKEN_SECRET=keep-too','POSTGRES_DB=existing','WEB_PORT=5001','COMPOSE_APP_ORIGIN=http://192.168.3.110:5001','COOKIE_SECURE=false']:
            self.assertIn(entry,updated)
        backups=list((self.app/'.local/source-config-backups').glob('*.bak'))
        self.assertEqual(len(backups),1)
        self.assertEqual(backups[0].read_text(),original)
        r=self.run_script();self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual((self.app/'.env').read_text(),updated)
        self.assertEqual(len(list((self.app/'.local/source-config-backups').glob('*.bak'))),1)

    def test_build_failure_does_not_run_database_or_migration(self):
        self.env['BUILD_FAIL']='1';r=self.run_script()
        self.assertNotEqual(r.returncode,0)
        self.assertFalse(any('up' in c or 'run' in c for c in self.calls()))
        self.assertEqual(sum('build' in c for c in self.calls()),2)

    def test_backup_failure_blocks_migration(self):
        self.env['BACKUP_FAIL']='1';r=self.run_script()
        self.assertNotEqual(r.returncode,0)
        self.assertFalse(any('run' in c for c in self.calls()))

    def test_dirty_source_is_not_overwritten(self):
        self.env['DIRTY']='1';r=self.run_script()
        self.assertNotEqual(r.returncode,0)
        self.assertFalse(any('fetch' in c or 'build' in c for c in self.calls()))

    def test_nonempty_nonrepo_is_preserved(self):
        self.app.mkdir(parents=True);(self.app/'keep').write_text('preserve')
        r=self.run_script();self.assertNotEqual(r.returncode,0)
        self.assertEqual((self.app/'keep').read_text(),'preserve')

    def test_database_major_change_is_blocked(self):
        self.env['DB_MAJOR']='19';r=self.run_script()
        self.assertNotEqual(r.returncode,0)
        self.assertFalse(any('up' in c or 'run' in c for c in self.calls()))

    def test_build_reading_stdin_cannot_skip_remaining_deployment(self):
        self.env['CONSUME_BUILD']='1'
        r=self.run_script()
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertIn('部署完成',r.stdout)
        self.assertEqual(sum('run' in c for c in self.calls()),3)

    def test_help_without_dependencies(self):
        r=subprocess.run(['bash',str(ROOT/'update-four.sh'),'--help'],capture_output=True,text=True)
        self.assertEqual(r.returncode,0);self.assertIn('~/four-workbench',r.stdout)

if __name__=='__main__':unittest.main()
