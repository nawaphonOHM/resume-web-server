/**
 * Recursive Google Cloud Storage object locator with timestamp-based prioritization.
 *
 * @packageDocumentation
 */

import type { Bucket, File } from '@google-cloud/storage';
import { HTTP_STATUS_NOT_FOUND } from '../http/http_status_codes.ts';
import type { AppLogger } from '../logger/logger_types.ts';
import { findMatchingCandidates, resolveRecursiveResult } from './storage_candidate_filter.ts';
import { logStorageErrorClassification } from './storage_error_telemetry.ts';
import { logStorageLocateDecision } from './storage_locate_telemetry.ts';
import {
  collectFilesUnderPrefix,
  computeDirectPath,
  formatSearchPrefix,
} from './storage_prefix_scanner.ts';
import { GcsErrorClassifier } from './storage_error_classifier.ts';
import type {
  IStorageErrorClassifier,
  IStorageObjectLocator,
  LocateResult,
} from './storage_types.ts';

export { parseTimestampFromDirectory } from './storage_timestamp_parser.ts';
export {
  computeDirectPath,
  formatSearchPrefix,
  collectFilesUnderPrefix,
} from './storage_prefix_scanner.ts';
export { extractCandidateMatch, compareCandidates } from './storage_candidate_filter.ts';
export { logStorageLocateDecision } from './storage_locate_telemetry.ts';

function logDirect404(logger: AppLogger | undefined, name: string): void {
  if (logger) {
    logStorageErrorClassification(logger, {
      is404: true,
      fullPath: name,
      notFoundStatusCode: HTTP_STATUS_NOT_FOUND,
    });
  }
}

/**
 * Recursive object locator searching GCS buckets under `GCS_PREFIX` and prioritizing newest timestamped deployments.
 */
export class StorageObjectLocator implements IStorageObjectLocator {
  private readonly errorClassifier: IStorageErrorClassifier;
  private readonly logger?: AppLogger;

  /**
   * Creates a new `StorageObjectLocator` instance.
   *
   * @param errorClassifier - Optional custom storage error classifier.
   * @param logger - Optional injected application logger.
   */
  public constructor(errorClassifier?: IStorageErrorClassifier, logger?: AppLogger) {
    this.errorClassifier = errorClassifier ?? new GcsErrorClassifier();
    this.logger = logger;
  }

  private async checkDirectExists(file: File): Promise<boolean> {
    try {
      const [exists] = await file.exists();
      return exists;
    } catch (err: unknown) {
      if (!this.errorClassifier.isNotFoundError(err)) throw err;
      logDirect404(this.logger, file.name);
      return false;
    }
  }

  private async tryDirectLookup(bucket: Bucket, directPath: string): Promise<File | null> {
    const directFile = bucket.file(directPath);
    const exists = await this.checkDirectExists(directFile);
    return exists ? directFile : null;
  }

  private async scanRecursive(
    bucket: Bucket,
    prefix: string,
    name: string,
  ): Promise<LocateResult | null> {
    const searchPrefix = formatSearchPrefix(prefix);
    const files = await collectFilesUnderPrefix(bucket, searchPrefix);
    const candidates = findMatchingCandidates(files, prefix, name);
    return resolveRecursiveResult(candidates);
  }

  private async findDirect(
    bucket: Bucket,
    cleanName: string,
    prefix: string,
  ): Promise<LocateResult | null> {
    const directPath = computeDirectPath(cleanName, prefix);
    const directFile = await this.tryDirectLookup(bucket, directPath);
    return directFile ? { file: directFile, fullPath: directPath, strategy: 'direct' } : null;
  }

  private async resolveCandidate(
    bucket: Bucket,
    cleanName: string,
    prefix: string,
  ): Promise<LocateResult | null> {
    const direct = await this.findDirect(bucket, cleanName, prefix);
    return direct ?? (await this.scanRecursive(bucket, prefix, cleanName));
  }

  /**
   * Locates a file by relative object name, attempting direct lookup first and falling back to recursive listing under prefix.
   *
   * @param bucket - The GCS Bucket instance to search within.
   * @param objectName - The relative asset filename / path.
   * @param prefix - The configured bucket prefix string.
   * @returns A promise resolving to {@link LocateResult} if found, or `null` if not found.
   */
  public async locateFile(
    bucket: Bucket,
    objectName: string,
    prefix: string,
  ): Promise<LocateResult | null> {
    const cleanName = objectName.replace(/^\/+/, '');
    const result = cleanName ? await this.resolveCandidate(bucket, cleanName, prefix) : null;
    logStorageLocateDecision(this.logger, { objectName, prefix, result });
    return result;
  }
}
