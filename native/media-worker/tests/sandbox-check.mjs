// The media-net sandbox check, for this platform: gates P3 and P4 on Windows
// (sandbox-check-windows.mjs), gate MG4 on macOS (sandbox-check-macos.mjs).
//
// Usage: node sandbox-check.mjs [--diagnose]   (--diagnose: Windows only)
if (process.platform === 'win32') await import('./sandbox-check-windows.mjs');
else if (process.platform === 'darwin') await import('./sandbox-check-macos.mjs');
else throw new Error('The sandbox check runs on Windows and macOS only');
