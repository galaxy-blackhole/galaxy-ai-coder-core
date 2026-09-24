import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = { cli, core: resolve(cli, '..') };
const directories = ['src', 'test', 'scripts', 'live', 'fixtures', 'campaigns', 'docs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Explicit public source/config inventory: never traverse .galaxy, .git,
// node_modules, credentials, generated builds or symlinks.
export async function sourceManifest(snapshotRoot) {
  const files = [];
  const repositories = {};
  for (const [name, root] of Object.entries(roots)) {
    let head = null;
    try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
    repositories[name] = { head, packageVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version };
    async function visit(relative) {
      for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if ((relative || directories.includes(entry.name)) && !['node_modules', '.git', '.galaxy', 'dist'].includes(entry.name)) await visit(path);
        } else if (entry.isFile() && (relative || /^(package(-lock)?\.json|tsconfig[^/]*\.json|README\.md|LICENSE|\.gitignore)$/.test(entry.name))) {
          const bytes = await readFile(join(root, path));
          files.push({ path: `${name}/${path}`, bytes: bytes.length, sha256: sha(bytes) });
          if (snapshotRoot) {
            const target = join(snapshotRoot, name, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
          }
        }
      }
    }
    await visit('');
  }
  files.sort((a, b) => compare(a.path, b.path));
  return { schemaVersion: 1, sha256: sha(JSON.stringify(files)), repositories, files };
}

export async function verifyBaseline(destination) {
  const target = resolve(destination);
  const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
  if (sha(JSON.stringify(manifest.source.files)) !== manifest.source.sha256) throw new Error('Source inventory hash mismatch.');
  if (sha(await readFile(join(target, 'audit-summary.json'))) !== manifest.audit.sha256) throw new Error('Audit summary hash mismatch.');
  for (const file of manifest.source.files) {
    if (!/^(cli|core)\//.test(file.path) || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid snapshot path.');
    const path = join(target, 'snapshot', file.path);
    if (!(await lstat(path)).isFile()) throw new Error(`Not a regular snapshot file: ${file.path}`);
    const bytes = await readFile(path);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`Snapshot hash mismatch: ${file.path}`);
  }
  return { baseline: target, verified: true, fingerprint: manifest.source.sha256, files: manifest.source.files.length };
}

async function main() {
  const [auditPath, destination] = process.argv.slice(2);
  if (!auditPath || !destination || process.argv.length !== 4) throw new Error('Usage: source-baseline.mjs <passed summary.json | --verify> <baseline directory>');
  if (auditPath === '--verify') { process.stdout.write(JSON.stringify(await verifyBaseline(destination)) + '\n'); return; }
  const auditBytes = await readFile(resolve(auditPath));
  const audit = JSON.parse(auditBytes);
  if (audit.status !== 'passed' || !audit.steps?.length || audit.steps.some(step => !step.passed)) throw new Error('Baseline requires a passed audit.');
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 }); // Existing baselines are never overwritten.
  const source = await sourceManifest(join(target, 'snapshot'));
  const manifest = {
    createdAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    audit: { path: resolve(auditPath), sha256: sha(auditBytes), groups: audit.steps.length,
      sourceBinding: audit.source?.sha256 === source.sha256 ? 'matched-at-audit-start' : 'retrospective-unverified' },
    source,
  };
  await writeFile(join(target, 'audit-summary.json'), auditBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ baseline: target, fingerprint: source.sha256, sourceBinding: manifest.audit.sourceBinding, files: source.files.length }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
