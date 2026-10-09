/**
 * Storage key path resolver applying bucket prefixes and normalizing leading slashes.
 *
 * @packageDocumentation
 */

import type { AppLogger } from '../logger/logger_types.ts';
import type { IStorageKeyResolver } from './storage_types.ts';

function computeKeyWithoutPrefix(cleanPath: string): {
  resolvedKey: string;
  reason: string;
} {
  return {
    resolvedKey: cleanPath,
    reason: 'No bucket prefix configured, using raw object path',
  };
}

function hasMatchingPrefix(path: string, prefix: string): boolean {
  return path.startsWith(`${prefix}/`) || path === prefix;
}

function makePrefixedResult(path: string, prefix: string): { resolvedKey: string; reason: string } {
  return {
    resolvedKey: `${prefix}/${path}`,
    reason: `Applied bucket prefix '${prefix}' to relative path`,
  };
}

function makeAlreadyPrefixedResult(
  path: string,
  prefix: string,
): { resolvedKey: string; reason: string } {
  return {
    resolvedKey: path,
    reason: `Object path already contains configured prefix '${prefix}'`,
  };
}

function computeKeyWithPrefix(
  path: string,
  prefix: string,
): { resolvedKey: string; reason: string } {
  if (hasMatchingPrefix(path, prefix)) {
    return makeAlreadyPrefixedResult(path, prefix);
  }
  return makePrefixedResult(path, prefix);
}

function computeResolvedKey(
  cleanPath: string,
  prefix: string,
): { resolvedKey: string; reason: string } {
  if (prefix === '') {
    return computeKeyWithoutPrefix(cleanPath);
  }
  return computeKeyWithPrefix(cleanPath, prefix);
}

/**
 * Resolves storage object keys with optional bucket prefix prepending (Single Responsibility Principle).
 */
export class StoragePathResolver implements IStorageKeyResolver {
  /**
   * The configured bucket prefix string.
   */
  private readonly prefix: string;

  /**
   * Optional injected application logger.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `StoragePathResolver`.
   *
   * @param prefix - Configured bucket prefix string.
   * @param appLogger - Optional injected application logger.
   */
  public constructor(prefix: string, appLogger?: AppLogger) {
    this.prefix = prefix;
    this.logger = appLogger;
  }

  private logKeyDecision(rawPath: string, choice: string, reason: string): void {
    this.logger?.decision({
      action: 'StorageKey',
      choice,
      reason,
      level: 'debug',
      rawPath,
      prefix: this.prefix,
    });
  }

  /**
   * Resolves a relative asset path into the full GCS object key by prepending the configured prefix.
   *
   * @param objectName - The relative asset path.
   * @returns The fully qualified object key.
   */
  public resolveObjectName(objectName: string): string {
    const cleanPath = objectName.replace(/^\/+/, '');
    const { resolvedKey, reason } = computeResolvedKey(cleanPath, this.prefix);
    this.logKeyDecision(objectName, resolvedKey, reason);
    return resolvedKey;
  }
}
