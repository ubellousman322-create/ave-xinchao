import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const token = String(process.env.XINCHAO_SERVICE_TOKEN ?? '').trim();
const marker = '__AVE_XINCHAO_SERVICE_TOKEN__';
if (!token) throw new Error('XINCHAO_SERVICE_TOKEN is required');

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  }));
  return nested.flat();
}

const files = await javascriptFiles(root);
const changed = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (!source.includes(marker)) continue;
  await writeFile(file, source.replaceAll(marker, token));
  changed.push(file);
}
if (changed.length === 0) throw new Error('service token placeholder missing from dist');
const remaining = [];
for (const file of files) {
  if ((await readFile(file, 'utf8')).includes(marker)) remaining.push(file);
}
if (remaining.length) throw new Error(`uninjected service token placeholders: ${remaining.join(', ')}`);
console.log(`injected service token into ${changed.length} module(s)`);
