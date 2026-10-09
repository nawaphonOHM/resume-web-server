/**
 * Static and hashed asset classifier implementation.
 *
 * @packageDocumentation
 */

import { extname } from 'node:path';
import type { AppLogger } from './logger/logger.ts';
import { type IAssetClassifier, HASHED_ASSET_REGEX } from './mime/mime_types.ts';

const MUTABLE_PREFIXES = ['index.', 'ngsw', 'favicon', 'manifest', 'browserconfig'];

function isStaticExtension(ext: string): boolean {
  if (ext === '') {
    return false;
  }
  return ext !== '.html' && ext !== '.htm';
}

function getStaticReason(ext: string, isStatic: boolean): string {
  if (isStatic) {
    return `Path has non-HTML extension '${ext}'`;
  }
  return ext === '' ? 'Path is extensionless' : `Path has HTML extension '${ext}'`;
}

function extractBaseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

function isWellKnownMutableAsset(baseName: string): boolean {
  return MUTABLE_PREFIXES.some((prefix) => baseName.startsWith(prefix));
}

function getHashedReason(baseName: string, matched: boolean): string {
  if (matched) {
    return `Asset '${baseName}' matched content-hash regex pattern`;
  }
  return `Asset '${baseName}' does not match content-hash regex pattern`;
}

function getHashedChoice(matched: boolean): string {
  return matched ? 'content-hashed asset' : 'unhashed asset';
}

function makeStaticPayload(filePath: string, ext: string, isStatic: boolean) {
  const meta = { filePath, extension: ext };
  return {
    action: 'AssetClassifier' as const,
    choice: isStatic ? 'static asset' : 'SPA navigation route / HTML',
    reason: getStaticReason(ext, isStatic),
    level: 'debug' as const,
    ...meta,
  };
}

function getMutableReason(baseName: string): string {
  return `Asset '${baseName}' is a well-known mutable/root configuration file`;
}

function makeMutablePayload(filePath: string, baseName: string) {
  const meta = { filePath, baseName, isHashed: false };
  return {
    action: 'AssetClassifier' as const,
    choice: 'mutable asset (unhashed)',
    reason: getMutableReason(baseName),
    level: 'debug' as const,
    ...meta,
  };
}

function makeHashedPayload(filePath: string, baseName: string, matched: boolean) {
  const meta = { filePath, baseName, isHashed: matched };
  return {
    action: 'AssetClassifier' as const,
    choice: getHashedChoice(matched),
    reason: getHashedReason(baseName, matched),
    level: 'debug' as const,
    ...meta,
  };
}

/**
 * Default implementation of {@link IAssetClassifier} for Angular / SPA assets.
 */
export class DefaultAssetClassifier implements IAssetClassifier {
  /**
   * Optional injected application logger for recording classification decisions.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `DefaultAssetClassifier`.
   *
   * @param logger - Optional injected application logger.
   */
  public constructor(logger?: AppLogger) {
    this.logger = logger;
  }

  private logStaticDecision(filePath: string, ext: string, isStatic: boolean): void {
    if (this.logger) this.logger.decision(makeStaticPayload(filePath, ext, isStatic));
  }

  /**
   * Determines whether a request path targets a static asset file rather than an HTML document or SPA navigation route.
   *
   * @param filePath - The cleaned relative request path or filename.
   * @returns `true` if the path has a non-HTML file extension, `false` otherwise.
   */
  public isStaticAsset(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    const isStatic = isStaticExtension(ext);
    this.logStaticDecision(filePath, ext, isStatic);
    return isStatic;
  }

  private logMutableDecision(filePath: string, baseName: string): void {
    if (this.logger) this.logger.decision(makeMutablePayload(filePath, baseName));
  }

  private logHashedDecision(filePath: string, baseName: string, matched: boolean): void {
    if (this.logger) this.logger.decision(makeHashedPayload(filePath, baseName, matched));
  }

  private checkHashed(filePath: string, baseName: string): boolean {
    const matched = HASHED_ASSET_REGEX.test(baseName);
    this.logHashedDecision(filePath, baseName, matched);
    return matched;
  }

  /**
   * Evaluates whether a static asset file is content-hashed (fingerprinted) and safe for long-term immutable caching.
   *
   * @param filePath - The file path or filename to inspect.
   * @returns `true` if the asset is fingerprinted and safe for immutable caching; `false` otherwise.
   */
  public isHashedAsset(filePath: string): boolean {
    const baseName = extractBaseName(filePath);
    if (isWellKnownMutableAsset(baseName)) {
      this.logMutableDecision(filePath, baseName);
      return false;
    }
    return this.checkHashed(filePath, baseName);
  }
}
