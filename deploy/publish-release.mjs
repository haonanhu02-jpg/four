// Runs only in the manually dispatched publishing workflow; never reads a user database.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const tag = process.env.RELEASE_TAG,
  repo = process.env.RELEASE_REPOSITORY;
if (process.env.GITHUB_ACTIONS !== 'true' || tag !== `v${version}` || !repo)
  throw Error('An existing matching release tag and GitHub Actions environment are required');
const capture = (args) =>
  execFileSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const run = (args) =>
  new Promise((yes, no) => {
    const p = spawn(args[0], args.slice(1), { stdio: 'inherit' });
    p.on('error', no);
    p.on('close', (c) => (c === 0 ? yes() : no(Error(args[0] + ' exited ' + c))));
  });
const release = JSON.parse(
  capture(['gh', 'release', 'view', tag, '--repo', repo, '--json', 'isDraft']),
);
if (!release.isDraft) throw Error('Only unpublished drafts may be rebuilt');
await mkdir('artifacts/publish-inputs', { recursive: true });
await run([
  'gh',
  'release',
  'download',
  tag,
  '--repo',
  repo,
  '--pattern',
  `release-evidence-${version}.tar.gz`,
  '--dir',
  'artifacts/publish-inputs',
]);
await mkdir('artifacts/release-verification', { recursive: true });
await run([
  'tar',
  '-xzf',
  `artifacts/publish-inputs/release-evidence-${version}.tar.gz`,
  '-C',
  'artifacts/release-verification',
]);
await run(['node', 'deploy/init-env.mjs']);
const output = `artifacts/releases/release-${version}`;
await run(['node', 'deploy/release.mjs', output, 'artifacts/release-verification']);
const manifest = JSON.parse(await readFile(output + '/release.json', 'utf8'));
assert.equal(manifest.gitCommit, capture(['git', 'rev-parse', 'HEAD']).trim());
for (const item of manifest.images) await run(['docker', 'image', 'rm', item.tag]);
await run(['docker', 'load', '--input', output + '/images.tar.gz']);
await run(['node', 'deploy/verify-release.mjs', output, '--images']);
const password = randomBytes(24).toString('hex');
await mkdir('.local', { recursive: true });
await writeFile(
  '.local/release-smoke.env',
  [
    'COMPOSE_PROJECT_NAME=release-smoke',
    `API_IMAGE=${manifest.images[0].tag}`,
    `WEB_IMAGE=${manifest.images[1].tag}`,
    `POSTGRES_IMAGE=${manifest.images[2].tag}`,
    'POSTGRES_USER=workbench',
    `POSTGRES_PASSWORD=${password}`,
    'POSTGRES_DB=workbench_release_smoke',
    `DATABASE_URL=postgresql://workbench:${password}@db:5432/workbench_release_smoke`,
    `AUTH_TOKEN_SECRET=${randomBytes(32).toString('hex')}`,
    'APP_ORIGIN=http://localhost:18090',
    'WEB_PORT=18090',
    'COOKIE_SECURE=false',
    'TRUST_PROXY_HOPS=1',
  ].join('\n') + '\n',
  { mode: 0o600 },
);
const compose = [
  'docker',
  'compose',
  '--env-file',
  '.local/release-smoke.env',
  '-f',
  output + '/compose.production.yaml',
  '--profile',
  'database',
];
let started = false;
try {
  await run([...compose, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '180']);
  started = true;
  assert.equal((await fetch('http://localhost:18090/')).status, 200);
  assert.equal((await (await fetch('http://localhost:18090/api/health')).json()).version, version);
  await run([
    ...compose,
    'exec',
    '-T',
    '-e',
    'ADMIN_CREDENTIALS_FILE=/tmp/smoke-admin.txt',
    'api',
    'node',
    'scripts/bootstrap-admin.mjs',
  ]);
  const probe =
    "const fs=require('fs');const v=fs.readFileSync('/tmp/smoke-admin.txt','utf8').split(/\\r?\\n/);(async()=>{const r=await fetch('http://localhost:3000/api/auth/login',{method:'POST',headers:{Origin:process.env.APP_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({username:v[0].split('：')[1],password:v[1].split('：')[1]})});if(!r.ok)throw Error('login');const a=await r.json();if(a.user.role!=='admin')throw Error('role');for(const p of ['accounts','logs'])if(!(await fetch('http://localhost:3000/api/admin/'+p,{headers:{Cookie:r.headers.get('set-cookie').split(';')[0]}})).ok)throw Error(p);console.log(JSON.stringify({administratorLogin:true,management:true,audit:true}));})().catch(()=>process.exit(1));";
  const admin = JSON.parse(capture([...compose, 'exec', '-T', 'api', 'node', '-e', probe]));
  const proof = {
    verifiedAt: new Date().toISOString(),
    archiveLoaded: true,
    imageIdsMatch: true,
    newProject: true,
    newVolume: true,
    pullPolicy: 'never',
    administratorBootstrapAndLogin: admin.administratorLogin,
    accountManagement: admin.management,
    audit: admin.audit,
    sourceRevision: manifest.gitCommit,
    platform: manifest.platform,
    images: manifest.images,
  };
  await writeFile(
    output + '/verification/release-archive-check.json',
    JSON.stringify(proof, null, 2),
  );
} finally {
  if (started) await run([...compose, 'down']);
}
async function sha(path) {
  const h = createHash('sha256');
  for await (const b of createReadStream(path)) h.update(b);
  return h.digest('hex');
}
manifest.artifacts.push({
  path: 'verification/release-archive-check.json',
  sha256: await sha(output + '/verification/release-archive-check.json'),
});
await writeFile(output + '/release.json', JSON.stringify(manifest, null, 2));
await writeFile(
  output + '/SHA256SUMS',
  [...manifest.artifacts, { path: 'release.json', sha256: await sha(output + '/release.json') }]
    .map((v) => v.sha256 + '  ' + v.path)
    .join('\n') + '\n',
);
await run(['node', 'deploy/verify-release.mjs', output, '--images']);
const bundle = `artifacts/releases/four-layer-workbench-${version}-linux-amd64.tar.gz`;
await run(['tar', '-czf', bundle, '-C', output, '.']);
await writeFile(bundle + '.sha256', (await sha(bundle)) + '  ' + bundle.split('/').at(-1) + '\n');
await run([
  'gh',
  'release',
  'upload',
  tag,
  bundle,
  bundle + '.sha256',
  output + '/images.tar.gz',
  output + '/release.json',
  output + '/SHA256SUMS',
  '--repo',
  repo,
  '--clobber',
]);
console.log(
  JSON.stringify({
    tag,
    sourceRevision: manifest.gitCommit,
    bytes: (await stat(bundle)).size,
    sha256: await sha(bundle),
    draftAssetsUploaded: true,
  }),
);
