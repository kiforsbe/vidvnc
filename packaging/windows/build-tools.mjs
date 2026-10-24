// No shell interpolation: the product adapter exchanges structured data via new files.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export function invokeBuildTools(request, { root = repository } = {}) {
  for (const file of [
    'VERSION',
    'common/Tools.ps1',
    'common/Artifacts.ps1',
    'msi/package.ps1',
    'msix/package.ps1',
  ])
    if (!existsSync(path.join(root, 'external/winbuildtools', file)))
      throw new Error(
        'winbuildtools checkout is missing or incomplete. Run: git submodule update --init --recursive',
      );
  const scratch = mkdtempSync(path.join(tmpdir(), 'vidvnc-build-tools-'));
  try {
    const input = path.join(scratch, 'request.json');
    const output = path.join(scratch, 'response.json');
    writeFileSync(input, JSON.stringify(request));
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(root, 'packaging/windows/build-tools.ps1'),
        '-Request',
        input,
        '-Response',
        output,
      ],
      {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    if (result.error)
      throw new Error(`PowerShell 7.4+ (pwsh) is required: ${result.error.message}`);
    if (result.status !== 0)
      throw new Error(`Windows build tools ${request.operation} failed (exit ${result.status})`);
    return JSON.parse(readFileSync(output, 'utf8').replace(/^\uFEFF/, ''));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
