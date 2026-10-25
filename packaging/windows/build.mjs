// Windows product staging. Shared winbuildtools owns installer creation and inspection.
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeManifest } from '../../native/media-worker/runtime-manifest.mjs';
import { resolveDependencies } from '../shared/pe-dependencies.mjs';
import { outputLocations, replaceDirectory, siblingDirectory } from '../shared/staging.mjs';
import { fillManifest, msixVersion, placeholderLogo } from './msix.mjs';
import { packageOptions, launcher } from './launcher.mjs';
import { invokeBuildTools } from './build-tools.mjs';
import { publishArtifact } from './publish.mjs';
import { resolveMsiConfiguration } from './msi.mjs';

const { target, server, format } = packageOptions(process.argv.slice(2));
if (process.platform !== 'win32') throw new Error('Windows packages must be built on Windows');
const configuration = 'Release';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fromRoot = (...parts) => path.join(root, ...parts);
// NuGet-provided JSON (WindowsAppSDK-VersionInfo.json) starts with a byte-order mark.
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const inputs = readJson(fromRoot('packaging/windows/inputs.json'));
const { gstreamer, prerequisites, host, msix } = inputs;
const version = readJson(fromRoot('apps/server/package.json')).version;
const sdk = fromRoot(gstreamer.sdk);
const vc = prerequisites['vc-redist-x64'];
const product = server ? msix.displayName : 'VidVNC Server';
// This product's prerequisites; a bundled Node.js replaces the Node.js prerequisite.
const declared = Object.entries(prerequisites).filter(
  ([id, item]) => item.products.includes(target) && id !== 'nodejs',
);
const tar = path.join(process.env.SystemRoot, 'System32/tar.exe');
const { stage, installers } = outputLocations(root, { target, configuration, version });
const packageVersion = server ? msixVersion(version) : null;

// Keep per-run diagnostics outside payloads, including failed packer output.
const runRoot = fromRoot('out/packaging/windows', `${target}-${format}-${randomUUID()}`);
mkdirSync(runRoot, { recursive: true });
invokeBuildTools({ operation: 'preflight', format });
function run(tool, args) {
  invokeBuildTools({
    operation: 'run',
    tool,
    arguments: args,
    log: path.join(runRoot, 'tools.log'),
  });
}
// Scratch directories next to the stage, removed however the build ends.
function scratchDirectory() {
  const directory = siblingDirectory(stage);
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// 1. Build the worker, and publish the host, from project inputs.
if (process.env.GSTREAMER_ROOT && path.resolve(process.env.GSTREAMER_ROOT) !== path.resolve(sdk))
  throw new Error(`Packages use the project SDK ${sdk}; unset GSTREAMER_ROOT.`);
run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', fromRoot('build-native.cmd'), 'Release']);
const hostPublish = server ? scratchDirectory() : null;
if (server)
  run('dotnet', [
    'publish',
    fromRoot(host.project),
    '-c',
    configuration,
    '-nologo',
    `-p:PublishDir=${hostPublish}${path.sep}`,
  ]);

// 2. Validate every input before any output is replaced.
const recipeVersions = new Map(
  readFileSync(path.join(sdk, 'share/versions.txt'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes(' '))
    .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]),
);
if (recipeVersions.get('gstreamer-1.0') !== gstreamer.version)
  throw new Error(`${sdk} is not GStreamer SDK ${gstreamer.version}`);
const worker = fromRoot('out/native/windows-x64/Release/media-worker.exe');
const plugins = gstreamer.plugins.map((name) => path.join(sdk, 'lib/gstreamer-1.0', name));
for (const file of [worker, ...plugins])
  if (!existsSync(file)) throw new Error(`Missing build input ${file}`);

const cmakeFiles = fromRoot('out/native/windows-x64/CMakeFiles');
const toolsetMinor = readdirSync(cmakeFiles)
  .map((name) => path.join(cmakeFiles, name, 'CMakeCXXCompiler.cmake'))
  .filter((file) => existsSync(file))
  .map((file) => /CMAKE_CXX_COMPILER_VERSION "19\.(\d+)\./.exec(readFileSync(file, 'utf8'))?.[1])
  .find(Boolean);
if (!toolsetMinor || Number(toolsetMinor) > Number(vc.minimumVersion.split('.')[1]))
  throw new Error(
    `The worker was built with MSVC toolset 14.${toolsetMinor}; raise the declared ${vc.name} minimum (${vc.minimumVersion}) in packaging/windows/inputs.json.`,
  );

const assets = server
  ? readJson(fromRoot(path.dirname(host.project), 'obj/project.assets.json'))
  : null;
const nugetPackages = assets && Object.keys(assets.packageFolders)[0];
const nugetPath = (id) => {
  const key = Object.keys(assets.libraries).find((name) => name.startsWith(`${id}/`));
  if (!key) throw new Error(`The host does not reference ${id}`);
  return path.join(nugetPackages, assets.libraries[key].path);
};
function verified(item) {
  const source = item.nuget
    ? path.join(nugetPackages, item.nuget)
    : fromRoot('.deps/downloads', item.file);
  if (!existsSync(source) || sha256(source) !== item.sha256)
    throw new Error(
      `${item.file} is missing or unverified; ${item.nuget ? 'check the host package references' : 'run npm run package:prepare'}`,
    );
  return source;
}
const prerequisiteDlls = Object.fromEntries(
  declared.filter(([, item]) => item.dlls).map(([id, item]) => [id, item.dlls]),
);
const systemDirectory = path.join(process.env.SystemRoot, 'System32');
const dependencies = resolveDependencies({
  roots: [worker, ...plugins],
  directories: [path.join(sdk, 'bin')],
  systemDirectory,
  prerequisites: prerequisiteDlls,
});
const imports = structuredClone(dependencies.prerequisites);

const componentOf = new Map();
for (const [id, component] of Object.entries(gstreamer.components)) {
  if (!recipeVersions.has(id)) throw new Error(`GStreamer SDK has no recipe ${id}`);
  for (const name of component.files) {
    if (componentOf.has(name)) throw new Error(`${name} is listed twice in inputs.json`);
    componentOf.set(name, id);
  }
}
const sdkFiles = [...gstreamer.plugins, ...dependencies.files.map((file) => file.name)];
const unmapped = sdkFiles.filter((name) => !componentOf.has(name));
const unused = [...componentOf.keys()].filter((name) => !sdkFiles.includes(name));
if (unmapped.length || unused.length)
  throw new Error(
    `Update gstreamer.components in packaging/windows/inputs.json. Unlisted: ${unmapped.join(', ') || 'none'}. Not shipped: ${unused.join(', ') || 'none'}.`,
  );
// Third-party components: { id, name, version, license, origin, noticeFiles, note?, licenseUrl? }
const thirdParty = Object.entries(gstreamer.components).map(([id, component]) => ({
  id,
  name: id,
  version: recipeVersions.get(id),
  license: component.license,
  origin: `GStreamer SDK ${gstreamer.version} (${gstreamer.installer.file}, sha256 ${gstreamer.installer.sha256})`,
  noticeFiles: (
    component.licenseFiles ??
    readdirSync(path.join(sdk, 'share/licenses', id)).map((name) => `share/licenses/${id}/${name}`)
  ).map((relative) => path.join(sdk, relative)),
  ...(component.note && { note: component.note }),
}));

// Host: every published file must belong to the project or a NuGet package with a license.
const hostFiles = [];
let windowsAppRuntime;
if (server) {
  const name = path.parse(host.executable).name;
  const { runtimeOptions } = readJson(path.join(hostPublish, `${name}.runtimeconfig.json`));
  if (runtimeOptions.includedFrameworks || !(runtimeOptions.framework || runtimeOptions.frameworks))
    throw new Error('Publish the host framework-dependent: .NET is a declared prerequisite');
  if (existsSync(path.join(hostPublish, 'Microsoft.UI.Xaml.dll')))
    throw new Error(
      'Windows App Runtime is a declared prerequisite; set WindowsAppSDKSelfContained=false',
    );
  // WinUI cannot load the host's XAML without its resource index.
  if (!existsSync(path.join(hostPublish, `${name}.pri`)))
    throw new Error(`The host publish has no ${name}.pri; set EnableMsixTooling=true`);
  const deps = readJson(path.join(hostPublish, `${name}.deps.json`));
  const packageOf = new Map();
  for (const [key, library] of Object.entries(deps.targets[deps.runtimeTarget.name])) {
    if (!['package', 'runtimepack'].includes(deps.libraries[key].type)) continue;
    const [id, libraryVersion] = key.replace(/^runtimepack\./, '').split('/');
    for (const asset of Object.keys({ ...library.runtime, ...library.native }))
      packageOf.set(path.basename(asset).toLowerCase(), { id, version: libraryVersion });
  }
  for (const [file, id] of Object.entries(host.packageOf)) {
    const key = Object.keys(deps.libraries).find((library) => library.startsWith(`${id}/`));
    if (!key || !existsSync(path.join(hostPublish, file)))
      throw new Error(
        `host.packageOf in packaging/windows/inputs.json lists ${file} (${id}), which the host does not ship`,
      );
    packageOf.set(file.toLowerCase(), { id, version: key.split('/')[1] });
  }
  const packages = new Map();
  for (const entry of readdirSync(hostPublish, { withFileTypes: true }).sort((a, b) =>
    byName(a.name, b.name),
  )) {
    if (!entry.isFile()) throw new Error(`Unexpected host publish entry ${entry.name}`);
    if (entry.name.endsWith('.pdb')) continue;
    const owner = entry.name.startsWith(`${name}.`)
      ? null
      : packageOf.get(entry.name.toLowerCase());
    if (!entry.name.startsWith(`${name}.`) && !owner)
      throw new Error(
        `Cannot attribute host file ${entry.name}; update host.packageOf in packaging/windows/inputs.json`,
      );
    if (owner) packages.set(owner.id, owner.version);
    hostFiles.push({
      name: entry.name,
      source: path.join(hostPublish, entry.name),
      component: owner?.id ?? 'vidvnc',
    });
  }
  for (const [id, packageVersionText] of packages) {
    const directory = path.join(nugetPackages, id.toLowerCase(), packageVersionText);
    const nuspec = readFileSync(path.join(directory, `${id.toLowerCase()}.nuspec`), 'utf8');
    const license = /<license type="(expression|file)">([^<]+)<\/license>/.exec(nuspec);
    const licenseUrl = /<licenseUrl>([^<]+)<\/licenseUrl>/.exec(nuspec)?.[1];
    if (!license && !licenseUrl)
      throw new Error(`NuGet package ${id} ${packageVersionText} declares no license`);
    thirdParty.push({
      id,
      name: id,
      version: packageVersionText,
      license:
        license?.[1] === 'expression' ? license[2] : license ? `LicenseRef-${id}` : 'NOASSERTION',
      origin: `NuGet package ${id} ${packageVersionText}`,
      noticeFiles: readdirSync(directory)
        .filter((file) => /^(license|notice)\.txt$/i.test(file) || file === license?.[2])
        .map((file) => path.join(directory, file)),
      ...(!license && { licenseUrl }),
    });
  }
  const hostDependencies = resolveDependencies({
    roots: hostFiles.filter((file) => /\.(dll|exe)$/i.test(file.name)).map((file) => file.source),
    directories: [hostPublish],
    systemDirectory,
    prerequisites: prerequisiteDlls,
  });
  if (hostDependencies.files.length)
    throw new Error(
      `Host files need ${hostDependencies.files.map((file) => file.name).join(', ')}`,
    );
  for (const [id, dlls] of Object.entries(hostDependencies.prerequisites))
    imports[id] = [...new Set([...(imports[id] ?? []), ...dlls])].sort(byName);

  const versionInfo = readJson(
    path.join(nugetPath('Microsoft.WindowsAppSDK.Runtime'), 'WindowsAppSDK-VersionInfo.json'),
  );
  windowsAppRuntime = {
    name: versionInfo.Runtime.Packages.Framework.PackageFamilyName.split('_')[0],
    version: versionInfo.Runtime.Version.DotQuadNumber,
    publisher: versionInfo.Runtime.Identity.Publisher,
  };
  if (
    !windowsAppRuntime.version.startsWith(`${prerequisites['windows-app-runtime'].minimumVersion}.`)
  )
    throw new Error(
      `The host uses Windows App Runtime ${windowsAppRuntime.version}; update windows-app-runtime.minimumVersion in packaging/windows/inputs.json`,
    );
}

let nodeBundle;
{
  const { bundle } = prerequisites.nodejs;
  const extracted = scratchDirectory();
  const top = bundle.file.replace(/\.zip$/, '');
  run(tar, ['-x', '-f', verified(bundle), '-C', extracted, `${top}/node.exe`, `${top}/LICENSE`]);
  nodeBundle = path.join(extracted, top);
  thirdParty.push({
    id: 'nodejs',
    name: 'Node.js',
    version: bundle.version,
    license: bundle.license,
    origin: `${bundle.url} (sha256 ${bundle.sha256})`,
    noticeFiles: [path.join(nodeBundle, 'LICENSE')],
  });
}

// 3. Stage into a fresh sibling directory, then swap it into place.
const built = siblingDirectory(stage);
try {
  const records = [];
  const destination = (relative, component) => {
    const file = path.join(built, relative);
    if (existsSync(file)) throw new Error(`Two inputs map to ${relative}`);
    mkdirSync(path.dirname(file), { recursive: true });
    records.push({ path: relative, component });
    return file;
  };
  const place = (source, relative, component) =>
    copyFileSync(source, destination(relative, component));
  const write = (relative, contents, component) =>
    writeFileSync(destination(relative, component), contents);
  const copyTree = (source, relative) => {
    const stats = lstatSync(source);
    if (stats.isDirectory())
      for (const name of readdirSync(source).sort())
        copyTree(path.join(source, name), `${relative}/${name}`);
    else if (stats.isFile()) place(source, relative, 'vidvnc');
    else throw new Error(`Refusing to package ${source}: not a regular file or directory`);
  };

  for (const directory of ['apps/server', 'apps/web-client', 'native/media-worker']) {
    const manifest = readJson(fromRoot(directory, 'package.json'));
    const packageRoot = `app/node_modules/${manifest.name}`;
    const { name, private: isPrivate, type, exports, dependencies: packages } = manifest;
    const production = { name, version: manifest.version, private: isPrivate, type, exports };
    write(
      `${packageRoot}/package.json`,
      `${JSON.stringify({ ...production, dependencies: packages }, null, 2)}\n`,
      'vidvnc',
    );
    for (const entry of manifest.files)
      copyTree(fromRoot(directory, entry), `${packageRoot}/${entry}`);
  }

  place(worker, 'runtime/media/bin/media-worker.exe', 'vidvnc');
  for (const file of dependencies.files)
    place(file.path, `runtime/media/bin/${file.name}`, componentOf.get(file.name));
  gstreamer.plugins.forEach((name, index) =>
    place(plugins[index], `runtime/media/lib/gstreamer-1.0/${name}`, componentOf.get(name)),
  );
  for (const file of hostFiles) place(file.source, file.name, file.component);
  if (nodeBundle) place(path.join(nodeBundle, 'node.exe'), 'runtime/node/node.exe', 'nodejs');
  const vidvncNotices = ['LICENSE', 'LICENSING.md'].map((file) => {
    const relative = `notices/vidvnc/${file === 'LICENSE' ? 'LICENSE.txt' : file}`;
    place(fromRoot(file), relative, 'vidvnc');
    return relative;
  });
  const components = [
    {
      id: 'vidvnc',
      name: 'VidVNC',
      version,
      license: 'AGPL-3.0-only',
      origin: 'This repository',
      notices: vidvncNotices,
    },
  ];
  for (const { noticeFiles, ...component } of thirdParty) {
    const notices = noticeFiles.map((file) => {
      const relative = `notices/${component.id}/${path.basename(file)}`;
      place(file, relative, component.id);
      return relative;
    });
    components.push({ ...component, ...(notices.length && { notices }) });
  }
  const declaredRecords = declared.map(([id, prerequisite]) => ({
    id,
    name: prerequisite.name,
    minimumVersion: prerequisite.minimumVersion,
    download: prerequisite.download,
    ...(imports[id] && { imports: imports[id] }),
  }));

  write(
    'notices/THIRD-PARTY-NOTICES.txt',
    [
      `${product} ${version} for Windows x64 (unsigned development build)`,
      '',
      'Generated from build inputs. This inventory supports review; it is not a legal approval.',
      '',
      'Included components:',
      ...components.map((component) =>
        [
          `- ${component.name} ${component.version ?? ''}`,
          component.license,
          component.origin,
          component.notices && `notices/${component.id}/`,
          component.licenseUrl,
          component.note,
        ]
          .filter(Boolean)
          .join(' | '),
      ),
      '',
      'Prerequisites (not included unless listed above):',
      ...declaredRecords.map(
        (item) => `- ${item.name} ${item.minimumVersion} or newer: ${item.download}`,
      ),
      '',
    ].join('\r\n'),
    'vidvnc',
  );
  write(
    'runtime.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'packaged',
        configuration,
        architecture: 'x64',
        node: 'runtime/node/node.exe',
        server: 'app/node_modules/@vidvnc/server/src/main.mjs',
        worker: 'runtime/media/bin/media-worker.exe',
        mediaBin: 'runtime/media/bin',
        plugins: 'runtime/media/lib/gstreamer-1.0',
        // What launchers check before starting the server.
        prerequisites: Object.fromEntries(
          declaredRecords.map(({ id, name, minimumVersion, download }) => [
            id,
            { name, minimumVersion, download },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
    'vidvnc',
  );
  loadRuntimeManifest(path.join(built, 'runtime.json'));
  if (server) {
    place(fromRoot('apps/windows-host/Assets/VidVnc.ico'), 'Assets/VidVnc.ico', 'vidvnc');
  }
  if (format === 'msix') {
    for (const [file, size] of [
      ['StoreLogo.png', 50],
      ['Square44x44Logo.png', 44],
      ['Square150x150Logo.png', 150],
    ])
      write(`Assets/${file}`, placeholderLogo(size), 'vidvnc');
    writeFileSync(
      path.join(runRoot, 'AppxManifest.xml'),
      fillManifest(readFileSync(fromRoot('packaging/windows/msix/AppxManifest.xml'), 'utf8'), {
        name: msix.name,
        publisher: msix.publisher,
        version: packageVersion,
        displayName: msix.displayName,
        publisherDisplayName: msix.publisherDisplayName,
        description: msix.description,
        minimumOSVersion: msix.minimumOSVersion,
        windowsAppRuntimeName: windowsAppRuntime.name,
        windowsAppRuntimeVersion: windowsAppRuntime.version,
        windowsAppRuntimePublisher: windowsAppRuntime.publisher,
        executable: host.executable,
      }),
    );
  }
  if (!server) {
    write('VidVNC.Server.cmd', launcher({ version, vc }), 'vidvnc');
  }

  const files = records
    .map(({ path: relative, component }) => {
      const file = path.join(built, relative);
      return { path: relative, size: statSync(file).size, sha256: sha256(file), component };
    })
    .sort((a, b) => byName(a.path, b.path));
  writeFileSync(
    path.join(built, 'files.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: target,
        version,
        configuration,
        architecture: 'x64',
        signature: 'none',
        prerequisites: declaredRecords,
        components,
        files,
      },
      null,
      2,
    )}\n`,
  );
  replaceDirectory(built, stage);
} catch (error) {
  rmSync(built, { recursive: true, force: true });
  throw error;
}

// 4. Inspect first, measure final bytes, then promote the artifact and metadata.
const manifest = readJson(path.join(stage, 'files.json'));
const bytes = manifest.files.reduce((total, file) => total + file.size, 0);
console.log(
  `Staged ${manifest.files.length} files (${(bytes / 2 ** 20).toFixed(1)} MiB): ${stage}`,
);
const filename = `${server ? 'VidVNC' : 'VidVNC-CLI'}-${version}-windows-x64-unsigned.${format}`;
const artifact = path.join(runRoot, filename);
if (format === 'zip') {
  run(tar, ['-a', '-c', '-f', artifact, '-C', stage, ...readdirSync(stage).sort()]);
} else {
  const request = { operation: format, payload: stage, output: path.join(runRoot, 'installer') };
  if (format === 'msix') request.manifest = path.join(runRoot, 'AppxManifest.xml');
  else {
    const config = resolveMsiConfiguration(readJson(fromRoot('packaging/windows/msi.json')), {
      version,
      files: [...manifest.files.map((file) => file.path), 'files.json'],
    });
    request.config = path.join(runRoot, 'msi.json');
    request.version = version;
    writeFileSync(request.config, JSON.stringify(config, null, 2));
  }
  const packed = invokeBuildTools(request);
  copyFileSync(packed.Artifact, artifact);
}
const metadata = path.join(runRoot, `${filename}.json`);
const measured = invokeBuildTools({ operation: 'metadata', artifact, output: metadata, version });
const destination = path.join(installers, filename);
// Both files are on this volume. Publish only the completed artifact.
publishArtifact(artifact, metadata, destination);
// Clean only known obsolete current-version variants, after successful replacement.
const obsolete = server
  ? [
      `VidVNC-${version}-windows-x64-selfsigned.msix`,
      `VidVNC-${version}-windows-x64-selfsigned-with-node.msix`,
      `VidVNC-${version}-windows-x64-selfsigned-with-installers.zip`,
      `VidVNC-${version}-windows-x64-selfsigned-with-node-with-installers.zip`,
    ]
  : [`VidVNC-CLI-${version}-windows-x64-unsigned-with-installers.zip`];
for (const name of obsolete) rmSync(path.join(installers, name), { force: true });
console.log(`Unsigned ${format.toUpperCase()}: ${destination}\nSHA-256: ${measured.SHA256}`);
