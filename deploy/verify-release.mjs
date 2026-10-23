import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(process.argv[2] || '.'),
  manifest = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'));
for (const entry of manifest.artifacts) {
  const path = resolve(root, entry.path);
  if (!path.startsWith(root + sep)) throw new Error('Invalid release path');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest('hex') !== entry.sha256) throw new Error('Checksum mismatch: ' + entry.path);
}
if (process.argv.includes('--images'))
  for (const image of manifest.images) {
    const actual = execFileSync('docker', ['image', 'inspect', image.tag, '--format', '{{.Id}}'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    if (actual !== image.id) throw new Error('Image differs: ' + image.tag);
  }
console.log(
  `已验证 ${manifest.artifacts.length} 个交付文件${process.argv.includes('--images') ? '及全部镜像 ID' : ''}。来源：${manifest.sourceRevision}`,
);
