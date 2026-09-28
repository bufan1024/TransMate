import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(extensionDirectory, 'manifest.json'), 'utf8'));

if (manifest.manifest_version !== 3 || !manifest.name?.includes('TransMate')) {
  throw new Error('This directory is not the expected TransMate Manifest V3 extension.');
}

const files = new Set([
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
]);

for (const relativePath of files) {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('..')) {
    throw new Error(`Invalid manifest resource path: ${relativePath}`);
  }
  const resource = await stat(join(extensionDirectory, relativePath));
  if (!resource.isFile() || resource.size === 0) {
    throw new Error(`Missing or empty manifest resource: ${relativePath}`);
  }
}

process.stdout.write(JSON.stringify({
  extensionDirectory,
  name: manifest.name,
  version: manifest.version,
  minimumChromeVersion: manifest.minimum_chrome_version,
  checkedResources: files.size,
}, null, 2) + '\n');
