// Builds the macOS packages from project inputs, signed with the owner's Developer ID and
// notarized (design D9, Channel A):
//   node packaging/macos/build.mjs macos-server [--no-notarize]   VidVNC.app in a DMG
//   node packaging/macos/build.mjs macos-cli [--no-notarize]      the command-line server ZIP
// Both carry the Release worker in the VidVNC Capture helper bundle with the allow-listed
// GStreamer libraries and plugins, the pinned Node.js renamed to VidVNC Server, the server,
// and the vidvnc launcher. Signing inputs come from the environment, never the repository:
//   VIDVNC_SIGN_IDENTITY    a Developer ID Application identity in the keychain (required)
//   VIDVNC_NOTARY_PROFILE   a notarytool keychain profile (required unless --no-notarize)
//   VIDVNC_APP_PROFILE      Developer ID provisioning profile for the app (optional)
//   VIDVNC_CAPTURE_PROFILE  Developer ID provisioning profile for the capture helper (optional)
// --no-notarize stops after signing, for local checks; its outputs say "not-notarized".
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeManifest } from '../../native/media-worker/runtime-manifest.mjs';
import { readMachO, resolveDependencies } from '../shared/macho-dependencies.mjs';
import { outputLocations, replaceDirectory, siblingDirectory } from '../shared/staging.mjs';

const [target, ...flags] = process.argv.slice(2);
const server = target === 'macos-server';
if (
  !['macos-server', 'macos-cli'].includes(target) ||
  flags.some((flag) => flag !== '--no-notarize') ||
  flags.length > 1
)
  throw new Error('Usage: node packaging/macos/build.mjs macos-server|macos-cli [--no-notarize]');
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('macOS packages must be built on an Apple Silicon Mac');
const notarize = !flags.includes('--no-notarize');
const configuration = 'Release';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fromRoot = (...parts) => path.join(root, ...parts);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const inputs = readJson(fromRoot('packaging/macos/inputs.json'));
const { gstreamer, nodejs, app, captureHelper, signing } = inputs;
const version = readJson(fromRoot('apps/server/package.json')).version;
const { stage, installers } = outputLocations(root, { target, configuration, version });

// quiet: keep the tool's output unless it fails.
function run(command, args, { quiet = false, capture = false, input } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: quiet || capture || input !== undefined ? 'pipe' : 'inherit',
    encoding: 'utf8',
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (quiet || capture) process.stderr.write(`${result.stdout}${result.stderr}`);
    throw new Error(`${path.basename(command)} ${args[0]} failed with exit code ${result.status}`);
  }
  return result.stdout;
}
function scratchDirectory() {
  const directory = siblingDirectory(stage);
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// 1. Signing inputs, before anything is built.
const environment = (name) => process.env[name]?.trim() || null;
const identity = environment(signing.identity);
const notaryProfile = environment(signing.notaryProfile);
if (!identity)
  throw new Error(
    `Set ${signing.identity} to your Developer ID Application identity, for example ` +
      `${signing.identity}="Developer ID Application". List them with: security find-identity -v -p codesigning`,
  );
if (notarize && !notaryProfile)
  throw new Error(
    `Set ${signing.notaryProfile} to a notarytool keychain profile (create one with ` +
      `xcrun notarytool store-credentials <name> --apple-id <id> --team-id <team>), or pass --no-notarize.`,
  );
const identities = run('security', ['find-identity', '-v', '-p', 'codesigning'], { capture: true });
const identityNames = [...identities.matchAll(/^\s*\d+\) [0-9A-F]{40} "(.+)"$/gm)].map(
  (match) => match[1],
);
const matching = identityNames.filter((name) => name.startsWith(identity));
if (matching.length !== 1)
  throw new Error(
    `${signing.identity} must match exactly one code-signing identity; "${identity}" matches ${matching.length}`,
  );
if (!matching[0].startsWith('Developer ID Application:'))
  throw new Error(`${signing.identity} must name a Developer ID Application identity`);
// The team is read from the keychain at build time and never written to the repository.
const team = /\(([A-Z0-9]{10})\)$/.exec(matching[0])?.[1];
if (!team) throw new Error(`Cannot read the team of the identity ${signing.identity} names`);

// A provisioning profile, when given, must belong to this team and bundle identifier; its
// managed entitlements (persistent content capture, Q7) are added to the signature.
const MANAGED = ['com.apple.developer.persistent-content-capture'];
function provisioningProfile(variable, bundleIdentifier) {
  const file = environment(variable);
  if (!file) return null;
  if (!existsSync(file)) throw new Error(`${variable} names ${file}, which does not exist`);
  const plist = run('security', ['cms', '-D', '-i', file], { capture: true });
  const entitlements = JSON.parse(
    run('plutil', ['-extract', 'Entitlements', 'json', '-o', '-', '-'], {
      capture: true,
      input: plist,
    }),
  );
  if (entitlements['com.apple.application-identifier'] !== `${team}.${bundleIdentifier}`)
    throw new Error(`${variable} is not a profile for ${bundleIdentifier} in your team`);
  return {
    file,
    entitlements: {
      'com.apple.application-identifier': `${team}.${bundleIdentifier}`,
      'com.apple.developer.team-identifier': team,
      ...Object.fromEntries(
        MANAGED.filter((key) => key in entitlements).map((key) => [key, entitlements[key]]),
      ),
    },
  };
}
const appProfile = server ? provisioningProfile(signing.appProfile, app.bundleIdentifier) : null;
const captureProfile = provisioningProfile(signing.captureProfile, captureHelper.bundleIdentifier);

// 2. Build the worker, and the host, from project inputs.
run(fromRoot('build-native.sh'), [configuration]);
const derivedData = fromRoot('out/macos-host/DerivedData');
if (server)
  run('xcodebuild', [
    '-project',
    fromRoot('apps/macos-host/VidVNC.xcodeproj'),
    '-scheme',
    'VidVNC',
    '-configuration',
    configuration,
    '-destination',
    'platform=macOS,arch=arm64',
    '-derivedDataPath',
    derivedData,
    '-quiet',
    'build',
    // Signed again below, inside out, with the package's identity and entitlements.
    'CODE_SIGN_STYLE=Manual',
    'CODE_SIGN_IDENTITY=-',
    'DEVELOPMENT_TEAM=',
  ]);

// 3. Validate every input before any output is replaced.
const framework = process.env.GSTREAMER_ROOT
  ? path.resolve(process.env.GSTREAMER_ROOT)
  : [path.join(homedir(), gstreamer.framework), path.join('/', gstreamer.framework)].find(
      existsSync,
    );
if (!framework)
  throw new Error(
    `Install the GStreamer ${gstreamer.version} framework (${gstreamer.installer.url})`,
  );
const recipeVersions = new Map(
  readFileSync(path.join(framework, 'share/versions.txt'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes(' '))
    .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]),
);
if (recipeVersions.get('gstreamer-1.0') !== gstreamer.version)
  throw new Error(`${framework} is not GStreamer ${gstreamer.version}`);
const worker = fromRoot('out/native/macos-arm64', configuration, 'media-worker');
const pluginFolder = path.join(framework, 'lib/gstreamer-1.0');
const plugins = gstreamer.plugins.map((name) => path.join(pluginFolder, name));
const hostApp = path.join(derivedData, 'Build/Products', configuration, 'VidVNC.app');
const launcherSource = fromRoot('packaging/macos/launcher/vidvnc.c');
for (const file of [worker, ...plugins, launcherSource, ...(server ? [hostApp] : [])])
  if (!existsSync(file)) throw new Error(`Missing build input ${file}`);
const nodeArchive = fromRoot('.deps/downloads', nodejs.file);
if (!existsSync(nodeArchive) || sha256(nodeArchive) !== nodejs.sha256)
  throw new Error(`${nodejs.file} is missing or unverified; run npm run package:prepare:macos`);

const dependencies = resolveDependencies({
  roots: [worker, ...plugins],
  directories: [path.join(framework, 'lib')],
});
const componentOf = new Map();
for (const [id, component] of Object.entries(gstreamer.components)) {
  if (!recipeVersions.has(id)) throw new Error(`GStreamer framework has no recipe ${id}`);
  for (const name of component.files) {
    if (componentOf.has(name)) throw new Error(`${name} is listed twice in inputs.json`);
    componentOf.set(name, id);
  }
}
const frameworkFiles = [...gstreamer.plugins, ...dependencies.files.map((file) => file.name)];
const unmapped = frameworkFiles.filter((name) => !componentOf.has(name));
const unused = [...componentOf.keys()].filter((name) => !frameworkFiles.includes(name));
if (unmapped.length || unused.length)
  throw new Error(
    `Update gstreamer.components in packaging/macos/inputs.json. Unlisted: ${unmapped.join(', ') || 'none'}. Not shipped: ${unused.join(', ') || 'none'}.`,
  );
const thirdParty = Object.entries(gstreamer.components).map(([id, component]) => ({
  id,
  name: id,
  version: recipeVersions.get(id),
  license: component.license,
  origin: `GStreamer ${gstreamer.version} macOS framework (${gstreamer.installer.file})`,
  noticeFiles: (
    component.licenseFiles ??
    readdirSync(path.join(framework, 'share/licenses', id)).map(
      (name) => `share/licenses/${id}/${name}`,
    )
  ).map((relative) => path.join(framework, relative)),
  ...(component.note && { note: component.note }),
}));

const extracted = scratchDirectory();
const top = nodejs.file.replace(/\.tar\.gz$/, '');
run('tar', ['-x', '-z', '-f', nodeArchive, '-C', extracted, `${top}/bin/node`, `${top}/LICENSE`]);
const nodeBinary = path.join(extracted, top, 'bin/node');
thirdParty.push({
  id: 'nodejs',
  name: 'Node.js',
  version: nodejs.version,
  license: nodejs.license,
  origin: `${nodejs.url} (sha256 ${nodejs.sha256})`,
  noticeFiles: [path.join(extracted, top, 'LICENSE')],
});

// The package layout (spec D9). Inside the app, the manifest sits in Contents/Resources and
// names the rest of Contents (root ".."); the CLI keeps everything under one folder.
const helperName = `${captureHelper.name}.app`;
const layout = server
  ? {
      top: `${app.name}.app`,
      contents: `${app.name}.app/Contents`,
      node: `MacOS/${app.server}`,
      launcher: 'Helpers/vidvnc',
      helper: `Helpers/${helperName}`,
      server: 'Resources/server',
      notices: 'Resources/notices',
      manifest: 'Resources/runtime.json',
      manifestRoot: '..',
    }
  : {
      top: `VidVNC-CLI-${version}-macos-arm64`,
      contents: `VidVNC-CLI-${version}-macos-arm64`,
      node: `runtime/${app.server}`,
      launcher: 'vidvnc',
      helper: `runtime/${helperName}`,
      server: 'app',
      notices: 'notices',
      manifest: 'runtime.json',
      manifestRoot: null,
    };
const serverMain = `${layout.server}/node_modules/@vidvnc/server/src/main.mjs`;
const helperExecutable = `${layout.helper}/Contents/MacOS/media-worker`;
const helperFrameworks = `${layout.helper}/Contents/Frameworks`;
const helperPlugins = `${layout.helper}/Contents/Library/GStreamer`;

// 4. Stage into a fresh sibling directory, then swap it into place.
const built = siblingDirectory(stage);
const contents = path.join(built, layout.contents);
const records = [];
const destination = (relative, component) => {
  const file = path.join(contents, relative);
  if (existsSync(file)) throw new Error(`Two inputs map to ${relative}`);
  mkdirSync(path.dirname(file), { recursive: true });
  records.push({ path: relative, component });
  return file;
};
const place = (source, relative, component) =>
  copyFileSync(source, destination(relative, component));
const write = (relative, text, component) => writeFileSync(destination(relative, component), text);
const copyTree = (source, relative) => {
  const stats = lstatSync(source);
  if (stats.isDirectory())
    for (const name of readdirSync(source).sort())
      copyTree(path.join(source, name), `${relative}/${name}`);
  else if (stats.isFile()) place(source, relative, 'vidvnc');
  else throw new Error(`Refusing to package ${source}: not a regular file or directory`);
};
const tool = (name, ...args) => run(`/usr/bin/${name}`, args, { quiet: true });
// The arm64 slice only: the framework is universal, and VidVNC runs on Apple Silicon only.
function placeThin(source, relative, component) {
  const file = destination(relative, component);
  if (run('/usr/bin/lipo', ['-archs', source], { capture: true }).trim() === 'arm64')
    copyFileSync(source, file);
  else tool('lipo', source, '-thin', 'arm64', '-output', file);
  chmodSync(file, 0o755);
  return file;
}
// Every library the image loads from the framework becomes @rpath/<name>, and its only
// rpath is `rpath`, inside the helper bundle.
function rebind(file, rpath, id) {
  const image = readMachO(readFileSync(file));
  const args = [];
  if (id) args.push('-id', `@rpath/${id}`);
  for (const library of image.libraries)
    if (library.startsWith('@') && library !== `@rpath/${path.posix.basename(library)}`)
      args.push('-change', library, `@rpath/${path.posix.basename(library)}`);
  for (const existing of new Set(image.rpaths)) args.push('-delete_rpath', existing);
  args.push('-add_rpath', rpath);
  tool('install_name_tool', ...args, file);
}

try {
  if (server) {
    // The host from Xcode is the bundle everything else goes into.
    cpSync(hostApp, path.join(built, layout.top), { recursive: true, verbatimSymlinks: true });
    rmSync(path.join(contents, '_CodeSignature'), { recursive: true, force: true });
    const record = (relative) => {
      const file = path.join(contents, relative);
      const stats = lstatSync(file);
      if (stats.isDirectory())
        for (const name of readdirSync(file).sort()) record(path.posix.join(relative, name));
      else if (stats.isFile()) records.push({ path: relative, component: 'vidvnc' });
      else throw new Error(`Unexpected entry in the host build: ${relative}`);
    };
    for (const name of readdirSync(contents).sort()) record(name);
  }

  for (const directory of ['apps/server', 'apps/web-client', 'native/media-worker']) {
    const manifest = readJson(fromRoot(directory, 'package.json'));
    const packageRoot = `${layout.server}/node_modules/${manifest.name}`;
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

  // The capture helper: the worker (also media-net and the sandbox launcher) with its own
  // libraries and plugins, so the same bundle serves the app and the CLI.
  place(fromRoot(captureHelper.infoPlist), `${layout.helper}/Contents/Info.plist`, 'vidvnc');
  write(`${layout.helper}/Contents/PkgInfo`, 'APPL????', 'vidvnc');
  rebind(placeThin(worker, helperExecutable, 'vidvnc'), '@executable_path/../Frameworks');
  for (const file of dependencies.files)
    rebind(
      placeThin(file.path, `${helperFrameworks}/${file.name}`, componentOf.get(file.name)),
      '@loader_path',
      file.name,
    );
  gstreamer.plugins.forEach((name, index) =>
    rebind(
      placeThin(plugins[index], `${helperPlugins}/${name}`, componentOf.get(name)),
      '@loader_path/../../Frameworks',
      name,
    ),
  );
  if (captureProfile)
    place(captureProfile.file, `${layout.helper}/Contents/embedded.provisionprofile`, 'vidvnc');
  if (appProfile) place(appProfile.file, 'embedded.provisionprofile', 'vidvnc');

  placeThin(nodeBinary, layout.node, 'nodejs');
  // The launcher, built for this layout: paths relative to its own folder.
  const relativeTo = (from, to) => path.posix.relative(path.posix.dirname(from), to);
  const launcherFile = destination(layout.launcher, 'vidvnc');
  run('/usr/bin/xcrun', [
    'clang',
    '-O2',
    '-Wall',
    '-Werror',
    '-arch',
    'arm64',
    '-mmacosx-version-min=27.0',
    `-DVIDVNC_NODE="${relativeTo(layout.launcher, layout.node)}"`,
    `-DVIDVNC_SERVER="${relativeTo(layout.launcher, serverMain)}"`,
    `-DVIDVNC_MANIFEST="${relativeTo(layout.launcher, layout.manifest)}"`,
    '-o',
    launcherFile,
    launcherSource,
  ]);

  const vidvncNotices = ['LICENSE', 'LICENSING.md'].map((file) => {
    const relative = `${layout.notices}/vidvnc/${file === 'LICENSE' ? 'LICENSE.txt' : file}`;
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
      const relative = `${layout.notices}/${component.id}/${path.basename(file)}`;
      place(file, relative, component.id);
      return relative;
    });
    components.push({ ...component, ...(notices.length && { notices }) });
  }
  const product = server ? app.name : 'VidVNC Server';
  write(
    `${layout.notices}/THIRD-PARTY-NOTICES.txt`,
    [
      `${product} ${version} for macOS arm64 (Developer ID${notarize ? ', notarized' : ', not notarized'})`,
      '',
      'Generated from build inputs. This inventory supports review; it is not a legal approval.',
      '',
      'Included components:',
      ...components.map((component) =>
        [
          `- ${component.name} ${component.version ?? ''}`,
          component.license,
          component.origin,
          component.notices && `${layout.notices}/${component.id}/`,
          component.note,
        ]
          .filter(Boolean)
          .join(' | '),
      ),
      '',
    ].join('\n'),
    'vidvnc',
  );
  // Paths relative to the manifest's root: Contents in the app, the top folder in the CLI.
  const fromManifestRoot = (relative) =>
    layout.manifestRoot
      ? relative
      : path.posix.relative(path.posix.dirname(layout.manifest), relative);
  write(
    layout.manifest,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'packaged',
        configuration,
        os: 'macos',
        architecture: 'arm64',
        ...(layout.manifestRoot && { root: layout.manifestRoot }),
        node: fromManifestRoot(layout.node),
        server: fromManifestRoot(serverMain),
        worker: fromManifestRoot(helperExecutable),
        mediaBin: fromManifestRoot(helperFrameworks),
        plugins: fromManifestRoot(helperPlugins),
      },
      null,
      2,
    )}\n`,
    'vidvnc',
  );
  loadRuntimeManifest(path.join(contents, layout.manifest), { platform: 'darwin' });

  // 5. Sign inside out: libraries and plugins, the helper, the programs, then the app.
  const entitlementsFile = (base, extra = {}) => {
    const file = path.join(extracted, `${randomUUID()}.plist`);
    copyFileSync(fromRoot('packaging/macos/entitlements', base), file);
    for (const [key, value] of Object.entries(extra))
      tool(
        'plutil',
        '-insert',
        key,
        typeof value === 'boolean' ? '-bool' : '-string',
        String(value),
        file,
      );
    return file;
  };
  const sign = (relative, { entitlements, identifier } = {}) =>
    run(
      '/usr/bin/codesign',
      [
        '--force',
        '--sign',
        matching[0],
        '--timestamp',
        '--options',
        'runtime',
        ...(entitlements ? ['--entitlements', entitlements] : []),
        ...(identifier ? ['--identifier', identifier] : []),
        path.join(contents, relative),
      ],
      { quiet: true },
    );
  console.log('Signing...');
  for (const file of dependencies.files) sign(`${helperFrameworks}/${file.name}`);
  for (const name of gstreamer.plugins) sign(`${helperPlugins}/${name}`);
  sign(layout.helper, {
    entitlements: entitlementsFile('capture.plist', captureProfile?.entitlements),
  });
  sign(layout.node, {
    entitlements: entitlementsFile('server.plist'),
    identifier: `${app.bundleIdentifier}.server`,
  });
  sign(layout.launcher, { identifier: `${app.bundleIdentifier}.cli` });
  if (server) {
    const appContents = contents;
    // The app's own resources and executable last; the bundle seals everything inside it.
    run(
      '/usr/bin/codesign',
      [
        '--force',
        '--sign',
        matching[0],
        '--timestamp',
        '--options',
        'runtime',
        '--entitlements',
        entitlementsFile('host.plist', appProfile?.entitlements),
        path.dirname(appContents),
      ],
      { quiet: true },
    );
  }
  // The app seals everything inside it; the CLI folder is not a bundle, so each program is
  // checked on its own.
  for (const relative of server ? ['.'] : [layout.helper, layout.node, layout.launcher])
    run(
      '/usr/bin/codesign',
      [
        '--verify',
        '--deep',
        '--strict',
        path.join(server ? path.dirname(contents) : contents, relative),
      ],
      {
        quiet: true,
      },
    );

  const files = records
    .map(({ path: relative, component }) => {
      const file = path.join(contents, relative);
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
        architecture: 'arm64',
        signature: 'developer-id',
        bundle: layout.top,
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

// 6. Notarize, staple and produce the artifact, replacing a previous one only once complete.
function publishFile(filename, create) {
  const temporary = path.join(installers, `.${randomUUID()}${path.extname(filename)}`);
  try {
    create(temporary);
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function submit(file) {
  console.log(`Notarizing ${path.basename(file)}; this waits for Apple's answer...`);
  const result = spawnSync(
    '/usr/bin/xcrun',
    [
      'notarytool',
      'submit',
      file,
      '--keychain-profile',
      notaryProfile,
      '--wait',
      '--output-format',
      'json',
    ],
    { encoding: 'utf8' },
  );
  let answer = {};
  try {
    answer = JSON.parse(result.stdout);
  } catch {}
  if (answer.status !== 'Accepted') {
    if (answer.id)
      spawnSync(
        '/usr/bin/xcrun',
        ['notarytool', 'log', answer.id, '--keychain-profile', notaryProfile],
        { stdio: 'inherit' },
      );
    throw new Error(
      `Notarization of ${path.basename(file)} ended ${answer.status ?? 'with an error'}: ${result.stderr || result.stdout}`,
    );
  }
  console.log(`Notarization accepted (${answer.id})`);
}
const zip = (directory, file) =>
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', directory, file], {
    quiet: true,
  });

const manifest = readJson(path.join(stage, 'files.json'));
const bundle = path.join(stage, manifest.bundle);
const bytes = manifest.files.reduce((total, file) => total + file.size, 0);
console.log(
  `\nStaged ${manifest.files.length} files (${(bytes / 2 ** 20).toFixed(1)} MiB): ${bundle}`,
);
const suffix = notarize ? '' : '-not-notarized';
if (server) {
  if (notarize) {
    const upload = path.join(scratchDirectory(), `${app.name}.zip`);
    zip(bundle, upload);
    submit(upload);
    tool('xcrun', 'stapler', 'staple', bundle);
  }
  const dmg = path.join(installers, `VidVNC-${version}-macos-arm64${suffix}.dmg`);
  publishFile(dmg, (temporary) => {
    const folder = scratchDirectory();
    run('/usr/bin/ditto', [bundle, path.join(folder, path.basename(bundle))], { quiet: true });
    symlinkSync('/Applications', path.join(folder, 'Applications'));
    tool(
      'hdiutil',
      'create',
      '-volname',
      app.name,
      '-srcfolder',
      folder,
      '-format',
      'UDZO',
      '-ov',
      temporary,
    );
    run('/usr/bin/codesign', ['--force', '--sign', matching[0], '--timestamp', temporary], {
      quiet: true,
    });
    if (notarize) {
      submit(temporary);
      tool('xcrun', 'stapler', 'staple', temporary);
    }
  });
  console.log(
    `${notarize ? 'Notarized' : 'Signed, not notarized,'} DMG: ${dmg}\nSHA-256: ${sha256(dmg)}`,
  );
} else {
  const file = path.join(installers, `${manifest.bundle}${suffix}.zip`);
  publishFile(file, (temporary) => {
    zip(bundle, temporary);
    if (notarize) submit(temporary);
  });
  console.log(
    `${notarize ? 'Notarized' : 'Signed, not notarized,'} ZIP: ${file}\nSHA-256: ${sha256(file)}`,
  );
}
