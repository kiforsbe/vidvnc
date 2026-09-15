// Builds Windows packages from project inputs:
//   node packaging/windows/build.mjs windows-cli [--include-runtime-installers]
//   node packaging/windows/build.mjs windows-server [--include-runtime-installers] [--include-node]
// Both bundle the Release worker, allowlisted GStreamer plugins and their SDK dependencies.
// General runtimes are declared prerequisites and never copied from the build machine.
// windows-cli is a portable ZIP; --include-runtime-installers puts the pinned installers in it.
// windows-server adds the WinUI host and is an MSIX signed with the development certificate
// from npm run package:prepare. MSIX cannot run installers, so --include-runtime-installers
// writes a ZIP holding the MSIX, its certificate and the installers. --include-node bundles
// the pinned Node.js, used only by the host.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
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

const FLAGS = { installers: '--include-runtime-installers', node: '--include-node' };
const [target, ...flags] = process.argv.slice(2);
const server = target === 'windows-server';
if (
  !['windows-cli', 'windows-server'].includes(target) ||
  flags.some((flag) => !Object.values(FLAGS).includes(flag)) ||
  new Set(flags).size !== flags.length ||
  (!server && flags.includes(FLAGS.node))
)
  throw new Error(
    `Usage: node packaging/windows/build.mjs windows-cli [${FLAGS.installers}]\n` +
      `       node packaging/windows/build.mjs windows-server [${FLAGS.installers}] [${FLAGS.node}]`,
  );
if (process.platform !== 'win32') throw new Error('Windows packages must be built on Windows');
const includeInstallers = flags.includes(FLAGS.installers);
const includeNode = flags.includes(FLAGS.node);
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
  ([id, item]) => item.products.includes(target) && !(includeNode && id === 'nodejs'),
);
const tar = path.join(process.env.SystemRoot, 'System32/tar.exe');
const { stage, installers } = outputLocations(root, { target, configuration, version });
const packageVersion = server ? msixVersion(version) : null;

// quiet: keep the tool's output (MakeAppx lists every file) unless it fails.
function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (quiet) process.stderr.write(`${result.stdout}${result.stderr}`);
    throw new Error(`${path.basename(command)} failed with exit code ${result.status}`);
  }
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
const bundledInstallers = !includeInstallers
  ? []
  : declared
      .filter(([, prerequisite]) => prerequisite.installer)
      .map(([id, { installer }]) => ({
        id,
        source: verified(installer),
        path: `prerequisites/${installer.file}`,
      }));

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
let tools;
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
  const toolsRoot = path.join(nugetPath('Microsoft.Windows.SDK.BuildTools'), 'bin');
  const tool = (file) => {
    const found = readdirSync(toolsRoot)
      .map((sdkVersion) => path.join(toolsRoot, sdkVersion, 'x64', file))
      .filter((candidate) => existsSync(candidate));
    if (found.length !== 1) throw new Error(`Expected one ${file} under ${toolsRoot}`);
    return found[0];
  };
  tools = { makeappx: tool('makeappx.exe'), signtool: tool('signtool.exe') };
  for (const file of [msix.certificate, msix.certificate.replace(/\.pfx$/i, '.cer')])
    if (!existsSync(fromRoot(file)))
      throw new Error(`Missing ${file}; run npm run package:prepare`);
}

let nodeBundle;
if (includeNode) {
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
  // An MSIX cannot run installers; the server product ships them beside the package instead.
  if (!server)
    for (const installer of bundledInstallers)
      place(installer.source, installer.path, installer.id);

  const components = [
    { id: 'vidvnc', name: 'VidVNC', version, license: 'NOASSERTION', origin: 'This repository' },
  ];
  for (const { noticeFiles, ...component } of thirdParty) {
    const notices = noticeFiles.map((file) => {
      const relative = `notices/${component.id}/${path.basename(file)}`;
      place(file, relative, component.id);
      return relative;
    });
    components.push({ ...component, ...(notices.length && { notices }) });
  }
  if (!server)
    for (const { id } of bundledInstallers)
      components.push({
        id,
        name: `${prerequisites[id].name} installer`,
        license: prerequisites[id].installer.license,
        origin: `${prerequisites[id].installer.url} (sha256 ${prerequisites[id].installer.sha256})`,
      });
  const declaredRecords = declared.map(([id, prerequisite]) => ({
    id,
    name: prerequisite.name,
    minimumVersion: prerequisite.minimumVersion,
    download: prerequisite.download,
    ...(imports[id] && { imports: imports[id] }),
    ...(!server &&
      bundledInstallers.some((installer) => installer.id === id) && {
        installer: `prerequisites/${prerequisite.installer.file}`,
      }),
  }));

  write(
    'notices/THIRD-PARTY-NOTICES.txt',
    [
      `${product} ${version} for Windows x64 (${server ? 'development build, self-signed' : 'unsigned development build'})`,
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
        ...(nodeBundle && { node: 'runtime/node/node.exe' }),
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
    for (const [file, size] of [
      ['StoreLogo.png', 50],
      ['Square44x44Logo.png', 44],
      ['Square150x150Logo.png', 150],
    ])
      write(`Assets/${file}`, placeholderLogo(size), 'vidvnc');
    write(
      'AppxManifest.xml',
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
      'vidvnc',
    );
  } else {
    write('VidVNC.Server.cmd', launcher(), 'vidvnc');
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
        signature: server ? 'development-self-signed' : 'none',
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

// 4. Produce the artifacts, replacing any previous file only once it is complete.
function publishFile(filename, create) {
  const temporary = path.join(installers, `.${randomUUID()}${path.extname(filename)}`);
  try {
    create(temporary);
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}
const zipDirectory = (directory, zip) =>
  publishFile(zip, (temporary) =>
    run(tar, ['-a', '-c', '-f', temporary, '-C', directory, ...readdirSync(directory).sort()]),
  );

const manifest = readJson(path.join(stage, 'files.json'));
const bytes = manifest.files.reduce((total, file) => total + file.size, 0);
console.log(
  `\nStaged ${manifest.files.length} files (${(bytes / 2 ** 20).toFixed(1)} MiB): ${stage}`,
);
console.log(
  `Prerequisites: ${manifest.prerequisites.map((item) => `${item.name} ${item.minimumVersion}+`).join(', ')}`,
);
if (!server) {
  const zip = path.join(
    installers,
    `VidVNC-Server-${version}-windows-x64-unsigned${includeInstallers ? '-with-installers' : ''}.zip`,
  );
  zipDirectory(stage, zip);
  console.log(`Unsigned development ZIP: ${zip}\nSHA-256: ${sha256(zip)}`);
} else {
  const base = `VidVNC-${version}-windows-x64-selfsigned${nodeBundle ? '-with-node' : ''}`;
  const msixFile = path.join(installers, `${base}.msix`);
  publishFile(msixFile, (temporary) => {
    run(tools.makeappx, ['pack', '/o', '/h', 'SHA256', '/d', stage, '/p', temporary], {
      quiet: true,
    });
    run(tools.signtool, ['sign', '/fd', 'SHA256', '/f', fromRoot(msix.certificate), temporary], {
      quiet: true,
    });
  });
  const certificateFile = path.join(installers, 'VidVNC-Development.cer');
  copyFileSync(fromRoot(msix.certificate.replace(/\.pfx$/i, '.cer')), certificateFile);
  // Trusts or removes the certificate beside it.
  const certificateScript = path.join(installers, 'VidVNC-Development-Certificate.ps1');
  copyFileSync(fromRoot('packaging/windows/development-certificate.ps1'), certificateScript);
  console.log(`Self-signed development MSIX: ${msixFile}\nSHA-256: ${sha256(msixFile)}`);
  console.log(`Development certificate: ${certificateFile} (trust it with ${certificateScript})`);
  if (includeInstallers) {
    const bundle = scratchDirectory();
    for (const file of [msixFile, certificateFile, certificateScript])
      copyFileSync(file, path.join(bundle, path.basename(file)));
    mkdirSync(path.join(bundle, 'prerequisites'));
    for (const installer of bundledInstallers)
      copyFileSync(installer.source, path.join(bundle, installer.path));
    writeFileSync(path.join(bundle, 'INSTALL.txt'), installText(path.basename(msixFile)));
    const zip = path.join(installers, `${base}-with-installers.zip`);
    zipDirectory(bundle, zip);
    console.log(`MSIX with prerequisite installers: ${zip}\nSHA-256: ${sha256(zip)}`);
  }
}

function installText(msixName) {
  const steps = declared.map(([id, item]) => {
    if (!item.installer)
      return `   - ${item.name} ${item.minimumVersion} or newer: ${item.download}`;
    const file = `prerequisites\\${item.installer.file}`;
    return item.installer.file.endsWith('.msix')
      ? `   - ${item.name}: Add-AppxPackage -Path .\\${file}`
      : `   - ${item.name}: run ${file}`;
  });
  return [
    `VidVNC ${version} for Windows x64 - development build, self-signed`,
    '',
    '1. Once per PC, trust the development certificate. In an administrator PowerShell',
    '   opened in this folder:',
    '   powershell -ExecutionPolicy Bypass -File .\\VidVNC-Development-Certificate.ps1 install',
    '2. Install what this PC does not have yet:',
    ...steps,
    `3. Open ${msixName} to install VidVNC, then open VidVNC from the Start menu.`,
    '',
    'Uninstall VidVNC from Settings > Apps. Your settings in %LOCALAPPDATA%\\VidVNC are kept.',
    'To stop trusting the certificate, run the same command with uninstall instead of install.',
    '',
  ].join('\r\n');
}

// Checks prerequisites, then runs the server with the installed Node.js. Arguments pass through
// untouched; `where $PATH:` ignores a node.exe in the current directory.
function launcher() {
  const node = prerequisites.nodejs;
  const vcMinor = Number(vc.minimumVersion.split('.')[1]);
  // Joined outside the raw template: a backslash there would escape the interpolation.
  const bundledInstaller = ['prerequisites', vc.installer.file].join(path.win32.sep);
  const text = String.raw`@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem VidVNC Server ${version}. Uses the installed Node.js; changes no system settings.
set "NODE_OPTIONS="
set "VIDVNC_RUNTIME_MANIFEST=%~dp0runtime.json"
set "NODE="
for /f "delims=" %%n in ('where $PATH:node.exe 2^>nul') do if not defined NODE set "NODE=%%n"
if not defined NODE goto need_node
"%NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= ${node.minimumVersion} ? 0 : 1)"
if errorlevel 1 goto need_node
for %%k in ("HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "HKLM\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64") do for /f "tokens=3" %%v in ('reg query "%%~k" /v Minor 2^>nul ^| findstr /c:"REG_DWORD"') do if %%v GEQ ${vcMinor} goto run
>&2 echo VidVNC Server needs the ${vc.name} ${vc.minimumVersion} or newer.
if exist "%~dp0${bundledInstaller}" goto bundled_vc
>&2 echo Install it from ${vc.download}, then run this command again.
exit /b 1
:bundled_vc
>&2 echo Run ${bundledInstaller} from this folder, then run this command again.
exit /b 1
:need_node
>&2 echo VidVNC Server needs ${node.name} ${node.minimumVersion} or newer. Install it from ${node.download}, then run this command again.
exit /b 1
:run
"%NODE%" "%~dp0app\node_modules\@vidvnc\server\src\main.mjs" %*
exit /b %ERRORLEVEL%
`;
  if (text.includes('${')) throw new Error('Launcher template left a placeholder unexpanded');
  return text.split('\n').join('\r\n');
}
