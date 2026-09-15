// Shows or sets the VidVNC version in every file that declares it.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { msixVersion } from '../packaging/windows/msix.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACES = ['apps/server', 'apps/web-client', 'native/media-worker'];

// A package's own version and its dependencies on other workspaces, which npm requires to match.
function* packageFields(entry, prefix = '') {
  yield { owner: entry, key: 'version', label: `${prefix}version` };
  for (const group of ['dependencies', 'devDependencies'])
    for (const name of Object.keys(entry[group] ?? {}))
      if (name.startsWith('@vidvnc/'))
        yield { owner: entry[group], key: name, label: `${prefix}${group}.${name}` };
}

const jsonFile = (file, fields) => ({
  file,
  read: (text) =>
    [...fields(JSON.parse(text))].map(({ owner, key, label }) => {
      if (typeof owner[key] !== 'string') throw new Error(`${file}: ${label} is missing`);
      return { label, version: owner[key] };
    }),
  write(text, version) {
    const data = JSON.parse(text);
    for (const { owner, key } of fields(data)) owner[key] = version;
    return `${JSON.stringify(data, null, 2)}\n`;
  },
});

// pattern captures (text before)(version)(text after).
const textFile = (file, label, pattern, { format = (v) => v, parse = (v) => v } = {}) => ({
  file,
  read(text) {
    const match = pattern.exec(text);
    if (!match) throw new Error(`${file}: ${label} is missing`);
    return [{ label, version: parse(match[2]) }];
  },
  write: (text, version) =>
    text.replace(pattern, (_, before, current, after) => before + format(version) + after),
});

function addChangelogSection(text, version) {
  if (text.includes(`\n## [${version}]`)) return text;
  const heading = `## [${version}] - Unreleased\n\n`;
  const first = text.search(/^## \[/m);
  return first < 0
    ? `${text.trimEnd()}\n\n${heading.trimEnd()}\n`
    : text.slice(0, first) + heading + text.slice(first);
}

const TARGETS = [
  jsonFile('package.json', packageFields),
  ...WORKSPACES.map((directory) => jsonFile(`${directory}/package.json`, packageFields)),
  jsonFile('package-lock.json', function* (lock) {
    yield { owner: lock, key: 'version', label: 'version' };
    for (const directory of ['', ...WORKSPACES])
      yield* packageFields(lock.packages?.[directory] ?? {}, `packages["${directory}"].`);
  }),
  textFile('apps/windows-host/VidVnc.Host.csproj', 'Version', /(<Version>)([^<]*)(<\/Version>)/),
  textFile(
    'apps/windows-host/app.manifest',
    'assemblyIdentity version',
    /(<assemblyIdentity version=")([^"]*)(" name="VidVnc\.Host")/,
    { format: msixVersion, parse: (v) => (/^\d+\.\d+\.\d+\.0$/.test(v) ? v.slice(0, -2) : v) },
  ),
  textFile('CMakeLists.txt', 'project VERSION', /^(project\(VidVNC VERSION )([^\s)]+)([\s)])/m),
  { file: 'CHANGELOG.md', read: () => [], write: addChangelogSection },
];

export const VERSION_FILES = TARGETS.map((target) => target.file);

// Accepts major.minor.patch with an optional leading v; MSIX limits each part to 65535.
export function normalizeVersion(input) {
  const version = String(input).replace(/^v/, '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error(`Expected a version like 1.2.3, not "${input}"`);
  msixVersion(version);
  return version;
}

export async function readVersions(directory = root) {
  const found = [];
  for (const target of TARGETS) {
    const text = await readFile(path.join(directory, target.file), 'utf8');
    for (const entry of target.read(text)) found.push({ file: target.file, ...entry });
  }
  return found;
}

// Checks every file before writing any, so a missing field leaves the checkout unchanged.
export async function setVersion(input, directory = root) {
  const version = normalizeVersion(input);
  const updates = [];
  for (const target of TARGETS) {
    const before = await readFile(path.join(directory, target.file), 'utf8');
    target.read(before);
    const after = target.write(before, version);
    if (after !== before) updates.push({ file: target.file, text: after });
  }
  for (const { file, text } of updates) await writeFile(path.join(directory, file), text);
  return { version, changed: updates.map((update) => update.file) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args[0]?.startsWith('-'))
      throw new Error('Usage: version.mjs [major.minor.patch]');
    if (args.length) {
      const { version, changed } = await setVersion(args[0]);
      for (const file of changed) console.log(`Updated: ${file}`);
      console.log(`Version ${version}: ${changed.length} file(s) updated.`);
    } else {
      const found = await readVersions();
      for (const { file, label, version } of found)
        console.log(`${version.padEnd(10)} ${file} ${label}`);
      const versions = new Set(found.map((entry) => entry.version));
      if (versions.size === 1) console.log(`Version: ${[...versions][0]}`);
      else {
        console.error('Versions differ. Set one with: npm run set-version -- <major.minor.patch>');
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(`Version failed: ${error.message}`);
    process.exitCode = 1;
  }
}
