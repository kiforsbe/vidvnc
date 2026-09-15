import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const excluded = new Set([
  'node_modules',
  '.deps',
  'build',
  'bin',
  'obj',
  'diagnostics',
  'windows-host',
  'out',
  '.git',
]);
const extensions = {
  native: new Set(['.cpp', '.hpp', '.h', '.c']),
  web: new Set(['.mjs', '.js', '.json', '.html', '.css']),
};

export async function sourceFiles(directory, scope) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name))
      result.push(...(await sourceFiles(file, scope)));
    else if (entry.isFile() && extensions[scope].has(path.extname(file))) result.push(file);
  }
  return result.sort();
}

export async function formatSources(scope, check = false) {
  if (!['all', 'web', 'native'].includes(scope)) throw new Error('Expected all, web, or native.');
  let changed = 0;
  for (const part of scope === 'all' ? ['native', 'web'] : [scope]) {
    let format;
    if (part === 'native') {
      const clang = await import('@wasm-fmt/clang-format');
      const config = await readFile(path.join(root, '.clang-format'), 'utf8');
      format = (source, file) => clang.format(source, file, config);
    } else {
      const prettier = await import('prettier');
      const config = JSON.parse(await readFile(path.join(root, '.prettierrc.json'), 'utf8'));
      format = (source, file) => prettier.format(source, { ...config, filepath: file });
    }
    const directories =
      part === 'native'
        ? ['native']
        : ['apps/server', 'apps/web-client', 'native/media-worker', 'packaging', 'tests', 'tools'];
    const files = (
      await Promise.all(directories.map((dir) => sourceFiles(path.join(root, dir), part)))
    ).flat();
    if (part === 'web')
      files.push(
        path.join(root, 'package.json'),
        path.join(root, '.prettierrc.json'),
        path.join(root, 'CMakePresets.json'),
      );
    for (const file of files) {
      const before = await readFile(file, 'utf8');
      const after = await format(before, file);
      if (before === after) continue;
      ++changed;
      if (!check) await writeFile(file, after);
      console.log(`${check ? 'Needs formatting' : 'Formatted'}: ${path.relative(root, file)}`);
    }
  }
  console.log(
    `${check ? 'Format check' : 'Formatting'}: ${changed} file(s) ${check ? 'need changes' : 'updated'}.`,
  );
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 2 || (args[1] && args[1] !== '--check'))
      throw new Error('Usage: format.mjs all|web|native [--check]');
    const check = args.includes('--check');
    const changed = await formatSources(args[0] || 'all', check);
    if (check && changed) process.exitCode = 1;
  } catch (error) {
    console.error(
      `Formatting failed: ${error.code === 'ERR_MODULE_NOT_FOUND' ? 'Run npm ci at the repository root to install the pinned development formatters.' : error.message}`,
    );
    process.exitCode = 1;
  }
}
