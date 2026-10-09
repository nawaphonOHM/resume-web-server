/**
 * Google Cloud Storage (GCS) Integration and Asset Streaming Service.
 *
 * Provides object storage abstractions, streaming file delivery to Node.js HTTP responses,
 * RFC 9110 compliant ETag and gzip handling, GCS error inspection and categorization,
 * and socket teardown management following SOLID principles.
 *
 * @remarks
 * In Google Cloud Storage, objects stored with `Content-Encoding: gzip` are automatically
 * decompressed on the fly during read streaming by default (`createReadStream`).
 * Because the delivered representation bytes differ from the stored compressed entity,
 * this module adjusts headers per RFC 9110:
 * - Omits `Content-Length` and `Content-Encoding` on decompressed responses.
 * - Formats ETags as weak validators (`W/"..."`) when auto-decompression occurs.
 * - Mirrors GET response headers for HEAD requests per RFC 9110 §9.3.2 recommendation (SHOULD).
 *
 * @packageDocumentation
 */

export {
  type IStorageKeyResolver,
  type IStorageExistenceChecker,
  type IStorageStreamer,
  type IEtagFormatter,
  type IStorageErrorClassifier,
  type IStorageObjectLocator,
  type LocateResult,
  type CandidateFileMatch,
  type StorageService,
  type StorageServiceOptions,
} from './storage_types.ts';

export { RFC9110EtagFormatter, defaultEtagFormatter, formatEtag } from '../etag_formatter.ts';
export {
  GcsErrorClassifier,
  defaultErrorClassifier,
  isNotFoundError,
} from './storage_error_classifier.ts';
export { StoragePathResolver } from './storage_path_resolver.ts';
export {
  StorageObjectLocator,
  parseTimestampFromDirectory,
  computeDirectPath,
  formatSearchPrefix,
  collectFilesUnderPrefix,
  extractCandidateMatch,
  compareCandidates,
} from './storage_object_locator.ts';
export { resolveStorageDeps, type ResolvedStorageDeps } from './storage_deps_resolver.ts';
export { GcsStorageService, createStorageService } from '../gcs_storage_service.ts';
