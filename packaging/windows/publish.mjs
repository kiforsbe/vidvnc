import { existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Keep a previous artifact/sidecar pair recoverable if either publication rename fails.
export function publishArtifact(artifact, metadata, destination) {
  const sources = [artifact, metadata];
  const targets = [destination, `${destination}.json`];
  for (const source of sources)
    if (!lstatSync(source).isFile()) throw new Error(`Not a regular artifact file: ${source}`);
  for (const target of targets)
    if (existsSync(target) && !lstatSync(target).isFile())
      throw new Error(`Not a regular publication target: ${target}`);
  const backups = targets.map((target) => `${target}.${randomUUID()}.previous`);
  const saved = [],
    promoted = [];
  try {
    for (let i = 0; i < targets.length; i++) {
      if (existsSync(targets[i])) {
        renameSync(targets[i], backups[i]);
        saved.push(i);
      }
    }
    for (let i = 0; i < targets.length; i++) {
      renameSync(sources[i], targets[i]);
      promoted.push(i);
    }
  } catch (error) {
    for (const i of promoted.reverse()) renameSync(targets[i], sources[i]);
    for (const i of saved.reverse()) renameSync(backups[i], targets[i]);
    throw error;
  }
  for (const i of saved) rmSync(backups[i]);
}
