import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const output = resolve(process.argv[2] || `artifacts/releases/release-${version}`);
const evidenceRoot = resolve(process.argv[3] || 'artifacts/release-verification');
const evidence = JSON.parse(await readFile(join(evidenceRoot, 'delivery-check.json'), 'utf8'));
if (evidence.version !== version)
  throw new Error('Verification report version does not match package version');
const verificationFiles = [
  'integration.log',
  'browser/browser-check.json',
  'ui/browser-check.json',
  'upgrade-check.json',
  'delivery-check.json',
  'baseline-browser/browser-check.json',
];
for (const file of verificationFiles) await readFile(join(evidenceRoot, file));
await mkdir(output, { recursive: false });
async function filesAt(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await filesAt(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
const folders = ['apps', 'packages', 'database', 'deploy', 'scripts', 'tests', 'docs', '.github'];
const files = [];
for (const dir of folders) {
  for (const path of await filesAt(join(root, dir))) {
    const rel = relative(root, path).replaceAll('\\', '/');
    if (
      !rel
        .split('/')
        .some((p) =>
          ['node_modules', 'dist', '.local', '.git', '__pycache__', '.deployment'].includes(p),
        ) &&
      (!rel.split('/').at(-1).startsWith('.env') || rel.endsWith('.env.example'))
    )
      files.push(rel);
  }
}
for (const entry of await readdir(root, { withFileTypes: true }))
  if (
    entry.isFile() &&
    (/^package.*\.json$/.test(entry.name) ||
      /^(Dockerfile|compose.*\.yaml|README.md|eslint.config.mjs|tsconfig.*\.json|\.dockerignore|\.gitignore|\.gitattributes|\.prettier.*|\.env.example)$/.test(
        entry.name,
      ))
  )
    files.push(entry.name);
files.sort();
const sourceHash = createHash('sha256'),
  sourceFiles = [];
for (const path of files) {
  const bytes = await readFile(join(root, path)),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  sourceHash.update(path + '\0').update(bytes);
  sourceFiles.push({ path, sha256 });
}
const digest = sourceHash.digest('hex');
let commit = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  /* No Git repository was provided. */
}
let dirty = false;
if (commit)
  dirty = Boolean(
    execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
  );
const revision = commit && !dirty ? commit : `source-sha256:${digest}`,
  suffix = digest.slice(0, 12);
function run(args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: root,
      env: { ...process.env, IMAGE_TAG: version, SOURCE_REVISION: revision },
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${args[0]} exited ${code}`)),
    );
  });
}
await run(['docker', 'compose', 'build']);
const api = `four-layer-workbench-api:${version}-${suffix}`,
  web = `four-layer-workbench-web:${version}-${suffix}`;
const postgresBase =
  'postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2';
const imageId = (tag) =>
  execFileSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
const postgres = `four-layer-workbench-postgres:18-${imageId(postgresBase).slice(7, 19)}`;
for (const [from, to] of [
  [`four-layer-workbench-api:${version}`, api],
  [`four-layer-workbench-web:${version}`, web],
  [postgresBase, postgres],
])
  await run(['docker', 'tag', from, to]);
const images = [api, web, postgres].map((tag) => ({ tag, id: imageId(tag) }));
const platform = execFileSync(
  'docker',
  ['image', 'inspect', api, '--format', '{{.Os}}/{{.Architecture}}'],
  { encoding: 'utf8', windowsHide: true },
).trim();
const archive = spawn('docker', ['image', 'save', ...images.map((v) => v.tag)], {
  stdio: ['ignore', 'pipe', 'inherit'],
  windowsHide: true,
});
const exited = new Promise((resolveRun, reject) => {
  archive.on('error', reject);
  archive.on('close', (code) =>
    code === 0 ? resolveRun() : reject(new Error('Image export failed')),
  );
});
await Promise.all([
  pipeline(
    archive.stdout,
    createGzip(),
    createWriteStream(join(output, 'images.tar.gz'), { flags: 'wx' }),
  ),
  exited,
]);
const list = join(output, 'source-files.txt');
await writeFile(list, files.join('\n') + '\n');
// Package with Linux tar from the already-built image so UTF-8 file lists work
// consistently on Windows hosts as well as on Linux.
await run([
  'docker',
  'run',
  '--rm',
  '--user',
  '0',
  '--entrypoint',
  'tar',
  '--mount',
  `type=bind,source=${root},target=/source,readonly`,
  '--mount',
  `type=bind,source=${output},target=/release`,
  api,
  '-czf',
  '/release/source.tar.gz',
  '-C',
  '/source',
  '-T',
  '/release/source-files.txt',
]);
await mkdir(join(output, 'deploy'));
await mkdir(join(output, 'docs'));
for (const name of [
  'database.mjs',
  'init-production.mjs',
  'verify-release.mjs',
  'https.nginx.example.conf',
  'auto-deploy.py',
  'auto-deploy.sh',
  'auto-deploy.ps1',
])
  await copyFile(join(root, 'deploy', name), join(output, 'deploy', name));
await copyFile(join(root, 'compose.production.yaml'), join(output, 'compose.production.yaml'));
let env = await readFile(join(root, 'deploy/production.env.example'), 'utf8');
env = env
  .replace(/^API_IMAGE=.*$/m, `API_IMAGE=${api}`)
  .replace(/^WEB_IMAGE=.*$/m, `WEB_IMAGE=${web}`)
  .replace(`POSTGRES_IMAGE=${postgresBase}`, `POSTGRES_IMAGE=${postgres}`);
await writeFile(join(output, 'deploy/production.env.example'), env);
for (const name of [
  '生产部署与恢复.md',
  '阶段6-验收记录.md',
  '工号登录改造-验收记录.md',
  '管理员与文件管理-验收记录.md',
  '一键部署.md',
  '深色界面可读性-验收记录.md',
])
  await copyFile(join(root, 'docs', name), join(output, 'docs', name));
await writeFile(
  join(output, 'README.md'),
  `# 四层对齐工作台 ${version}\n\n先运行 node deploy/verify-release.mjs . 校验文件，再 docker load --input images.tar.gz。运行 node deploy/init-production.mjs，填写 .env.production 的域名和 HTTPS 配置，按 docs/生产部署与恢复.md 启动并初始化管理员。\n\n镜像为 Linux amd64。内含三个运行镜像、源代码归档和部署恢复工具，不含实际数据库、管理员初始密码或密钥。\n`,
);
await mkdir(join(output, 'verification'));
for (const file of verificationFiles)
  await copyFile(join(evidenceRoot, file), join(output, 'verification', file.replaceAll('/', '-')));
async function sha(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
const entries = await filesAt(output),
  artifacts = [];
for (const path of entries)
  artifacts.push({ path: relative(output, path).replaceAll('\\', '/'), sha256: await sha(path) });
const manifest = {
  version,
  platform,
  createdAt: new Date().toISOString(),
  gitCommit: commit,
  sourceRevision: revision,
  sourceDigest: digest,
  images,
  sourceFiles,
  artifacts,
};
await writeFile(join(output, 'release.json'), JSON.stringify(manifest, null, 2));
await writeFile(
  join(output, 'SHA256SUMS'),
  [...artifacts, { path: 'release.json', sha256: await sha(join(output, 'release.json')) }]
    .map((v) => `${v.sha256}  ${v.path}`)
    .join('\n') + '\n',
);
console.log('Release exported to ' + output);
console.log('Source revision: ' + revision);
