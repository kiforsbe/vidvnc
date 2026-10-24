// Product command selection and the portable CLI launcher.
export function packageOptions([target, ...flags]) {
  if (
    !['windows-cli', 'windows-server'].includes(target) ||
    (flags.length && !(target === 'windows-server' && flags.length === 1 && flags[0] === '--msix'))
  )
    throw new Error(
      'Usage: node packaging/windows/build.mjs windows-cli\n       node packaging/windows/build.mjs windows-server [--msix]',
    );
  return {
    target,
    server: target === 'windows-server',
    format: target === 'windows-cli' ? 'zip' : flags.length ? 'msix' : 'msi',
  };
}

export function launcher({ version, vc }) {
  const vcMinor = Number(vc.minimumVersion.split('.')[1]);
  return String.raw`@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem VidVNC Server ${version}. Uses only its bundled Node.js; changes no system settings.
set "NODE_OPTIONS="
set "VIDVNC_RUNTIME_MANIFEST=%~dp0runtime.json"
set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" goto need_node
for %%k in ("HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "HKLM\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64") do for /f "tokens=3" %%v in ('reg query "%%~k" /v Minor 2^>nul ^| findstr /c:"REG_DWORD"') do if %%v GEQ ${vcMinor} goto run
>&2 echo VidVNC Server needs the ${vc.name} ${vc.minimumVersion} or newer.
>&2 echo Install it from ${vc.download}, then run this command again.
exit /b 1
:need_node
>&2 echo VidVNC's bundled Node.js is missing. Extract the complete CLI ZIP again.
exit /b 1
:run
"%NODE%" "%~dp0app\node_modules\@vidvnc\server\src\main.mjs" %*
exit /b %ERRORLEVEL%
`.replaceAll('\n', '\r\n');
}
