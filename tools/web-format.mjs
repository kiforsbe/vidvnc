import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
let workspace;
let projectKey;

// Use the version-pinned WASM bindings directly, without the alpha JS wrapper or
// the full native CLI's updater, network and XML-reporting dependencies.
export function formatWebSource(source, file) {
  if (!workspace) {
    const biome = require('@biomejs/wasm-nodejs');
    biome.main();
    const candidate = new biome.Workspace();
    try {
      const project = candidate.openProject({ path: '', openUninitialized: true });
      const settings = candidate.updateSettings({
        projectKey: project.projectKey,
        configuration: JSON.parse(readFileSync(path.join(root, 'biome.json'), 'utf8')),
        workspaceDirectory: './',
      });
      if (settings.diagnostics.length)
        throw new Error(`Biome configuration diagnostics: ${JSON.stringify(settings.diagnostics)}`);
      projectKey = project.projectKey;
      workspace = candidate;
    } catch (error) {
      candidate.free();
      throw error;
    }
  }
  const filePath = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  workspace.openFile({
    projectKey,
    path: filePath,
    content: { type: 'fromClient', content: source, version: 0 },
  });
  try {
    const diagnostics = workspace.pullDiagnostics({
      projectKey,
      path: filePath,
      categories: ['syntax'],
      pullCodeActions: false,
    });
    if (diagnostics.errors || diagnostics.parseErrors)
      throw new Error(`Biome failed for ${file}: ${JSON.stringify(diagnostics.diagnostics)}`);
    return workspace.formatFile({ projectKey, path: filePath }).code;
  } finally {
    workspace.closeFile({ projectKey, path: filePath });
  }
}
