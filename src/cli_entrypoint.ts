/**
 * CLI Entrypoint Module.
 *
 * Provides utilities for determining whether an ES module was executed directly
 * from the command-line interface.
 *
 * @packageDocumentation
 */

import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Checks if the resolved file URL matches the CLI entry-point script path.
 *
 * @param metaUrl - The file URL to check.
 * @param argv1 - The entry script path from `process.argv[1]`.
 */
function isMatchingScriptPath(metaUrl: string, argv1: string): boolean {
  try {
    const scriptPath = fileURLToPath(metaUrl);
    return realpathSync(scriptPath) === realpathSync(argv1);
  } catch {
    return false;
  }
}

function resolveArgv1(argv1?: string): string | undefined {
  return argv1 ?? process.argv[1];
}

/**
 * Determines whether the current ES module was executed directly as the process entry point.
 *
 * @remarks
 * Compares the canonical filesystem paths of the module URL against `process.argv[1]`.
 * Returns `false` if `argv1` is falsy or if path resolution throws.
 *
 * @param metaUrl - The file URL of the module being checked (callers pass their own `import.meta.url`).
 * @param argv1 - The entry-point script path from `process.argv[1]`. Defaults to `process.argv[1]`.
 * @returns `true` if the module represented by `metaUrl` is the executed entry-point script; otherwise `false`.
 */
export function isEntrypointModule(metaUrl: string, argv1?: string): boolean {
  const targetArgv = resolveArgv1(argv1);
  if (!targetArgv) {
    return false;
  }
  return isMatchingScriptPath(metaUrl, targetArgv);
}
