/**
 * Builds the deployment package for Azure App Service.
 *
 * App Service runs one Node process from the site root, so the package has to
 * be self contained: compiled server, compiled client, replay fixtures and a
 * production node_modules, with no workspace symlinks in it. Symlinks do not
 * survive a zip round trip reliably, so the one workspace dependency is copied
 * in as a real directory instead.
 *
 * The layout mirrors the repository on purpose. paths.js resolves the client
 * and the fixtures relative to its own location, so keeping the same shape
 * means the deployed server needs no path configuration at all.
 *
 *   package.json                     start script and production dependencies
 *   node_modules/                    installed here, resolvable from anywhere below
 *   node_modules/@nlam/shared/       copied, not linked
 *   packages/server/dist/            compiled server
 *   packages/server/fixtures/        replay traces
 *   packages/web/dist/               built client
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const staging = join(root, '.deploy', 'site');
const zipPath = join(root, '.deploy', 'site.zip');

const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), 'utf8'));

const serverPackage = read('packages', 'server', 'package.json');
const sharedPackage = read('packages', 'shared', 'package.json');

for (const required of [
  ['packages', 'server', 'dist', 'main.js'],
  ['packages', 'shared', 'dist', 'index.js'],
  ['packages', 'web', 'dist', 'index.html'],
]) {
  if (!existsSync(join(root, ...required))) {
    throw new Error(`missing ${required.join('/')}. Run "npm run build" first.`);
  }
}

console.log('cleaning');
rmSync(join(root, '.deploy'), { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

console.log('copying build output');
cpSync(join(root, 'packages', 'server', 'dist'), join(staging, 'packages', 'server', 'dist'), {
  recursive: true,
});
cpSync(
  join(root, 'packages', 'server', 'fixtures'),
  join(staging, 'packages', 'server', 'fixtures'),
  { recursive: true },
);
cpSync(join(root, 'packages', 'web', 'dist'), join(staging, 'packages', 'web', 'dist'), {
  recursive: true,
});

// The workspace dependency is resolved by name, so it has to sit in
// node_modules under its package name rather than at its repository path.
const sharedTarget = join(staging, 'node_modules', '@nlam', 'shared');
mkdirSync(sharedTarget, { recursive: true });
cpSync(join(root, 'packages', 'shared', 'dist'), join(sharedTarget, 'dist'), { recursive: true });
writeFileSync(
  join(sharedTarget, 'package.json'),
  `${JSON.stringify(sharedPackage, null, 2)}\n`,
  'utf8',
);

// Everything except the workspace package, which npm could not resolve: it is
// private and has no registry entry.
const dependencies = Object.fromEntries(
  Object.entries(serverPackage.dependencies).filter(([name]) => !name.startsWith('@nlam/')),
);

writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: 'nl-to-app-model-site',
      version: serverPackage.version,
      private: true,
      type: 'module',
      engines: read('package.json').engines,
      scripts: { start: 'node packages/server/dist/main.js' },
      dependencies,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log('installing production dependencies');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {
  cwd: staging,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// npm rewrites node_modules during install, so the copied workspace package is
// put back afterwards rather than before.
mkdirSync(sharedTarget, { recursive: true });
cpSync(join(root, 'packages', 'shared', 'dist'), join(sharedTarget, 'dist'), { recursive: true });
writeFileSync(
  join(sharedTarget, 'package.json'),
  `${JSON.stringify(sharedPackage, null, 2)}\n`,
  'utf8',
);

// The zip is read on Linux, so its entry names have to use forward slashes.
// PowerShell's Compress-Archive writes the Windows separator, and the result
// unpacks as a flat pile of files with backslashes in their names, which is
// exactly as broken as it sounds. The zip utility writes POSIX paths.
console.log('zipping');
execFileSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: staging, stdio: 'inherit' });

const { stat } = await import('node:fs/promises');
const { size } = await stat(zipPath);

// Cheap proof that the archive is readable the way the target expects, rather
// than trusting that the tool did what it says.
const listing = execFileSync('zip', ['-sf', zipPath], { encoding: 'utf8' });
if (listing.includes('\\')) throw new Error('zip entries contain backslashes');
for (const required of [
  'package.json',
  'packages/server/dist/main.js',
  'packages/web/dist/index.html',
  'node_modules/@nlam/shared/dist/index.js',
  'node_modules/fastify/',
]) {
  if (!listing.includes(required)) throw new Error(`zip is missing ${required}`);
}

console.log(`\npackage ready: ${zipPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
