/**
 * HEAD response header application and ETag telemetry for storage metadata.
 *
 * @remarks
 * ## RFC 9110 §9.3.2 HEAD Response Header Parity with GET
 *
 * The HTTP HEAD method requests metadata identical to what would have been delivered in
 * a 200 (OK) response to an equivalent GET request (RFC 9110 §9.3.2 recommendation).
 *
 * When querying metadata from Google Cloud Storage via `file.getMetadata()`, GCS returns the
 * stored object metadata (e.g., `metadata.size` indicating the stored compressed byte count,
 * `metadata.contentEncoding`). Unlike `file.createReadStream()` with default `decompress: true`,
 * `file.getMetadata()` does not download or stream payload bytes. Because the GCS SDK always
 * requests `Accept-Encoding: gzip` when fetching object media, an object with stored metadata
 * `contentEncoding: 'gzip'` will be served with `Content-Encoding: gzip` and automatically
 * decompressed by the SDK during GET requests.
 *
 * To maintain header parity with GET responses under RFC 9110 §9.3.2:
 * 1. **Content-Length & Content-Encoding Omission (Implementation Decision for GET Parity)**:
 *    Because an equivalent GET request auto-decompresses the stream and omits `Content-Length`
 *    (the decompressed length is unknown in stream mode) and `Content-Encoding`, the HEAD response
 *    also omits both headers when `metadata.contentEncoding?.trim() === 'gzip'`. RFC 9110 §9.3.2
 *    permits omitting header fields that are only known while generating content. Emitting
 *    `metadata.size` on HEAD would misrepresent the representation length as the compressed size
 *    when GET delivers uncompressed bytes.
 * 2. **Weak ETag Conversion (Implementation Decision for GET Parity)**: The ETag is formatted with
 *    a weak prefix (`W/"..."`) to match the weak validator emitted in GET responses for
 *    decompressed entities under RFC 9110 §8.8.1/§8.8.3.
 * 3. **Non-Gzip or Case-Mismatched Encodings**: For objects without exact `'gzip'` encoding
 *    (e.g., `'GZIP'`, `'deflate'`, `'br'`, or uncompressed), GET streams the raw compressed bytes
 *    with `Content-Length`, `Content-Encoding`, and strong ETag preserved; HEAD maintains exact
 *    parity by returning `metadata.size` as `Content-Length`, `metadata.contentEncoding`, and a strong ETag.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import { HTTP_STATUS_OK } from '../http/http_status_codes.ts';
import { logStorageEtagDecision } from './storage_etag_telemetry.ts';
import type { StorageHeadOptions } from './storage_head_handler.ts';

interface MetadataLike {
  readonly size?: number | string;
  readonly etag?: string;
  readonly contentEncoding?: string;
}

function applySizeHeader(res: ServerResponse, size?: number | string): void {
  if (size !== undefined) res.setHeader('Content-Length', String(size));
}

function isPassthroughEncoding(encoding: string): boolean {
  return encoding !== '' && encoding.toLowerCase() !== 'identity';
}

function applyEncodingHeader(res: ServerResponse, rawEncoding?: string): void {
  const trimmed = rawEncoding ? rawEncoding.trim() : '';
  if (isPassthroughEncoding(trimmed)) res.setHeader('Content-Encoding', trimmed);
}

function applyUncompressedHeaders(res: ServerResponse, metadata: MetadataLike): void {
  applySizeHeader(res, metadata.size);
  applyEncodingHeader(res, metadata.contentEncoding);
}

function formatHeadEtag(metadata: MetadataLike, isGzip: boolean, opts: StorageHeadOptions): string {
  if (!metadata.etag) return '';
  return opts.etagFormatter.formatEtag(metadata.etag, isGzip);
}

function applyHeadEtag(res: ServerResponse, formatted: string): string {
  if (formatted !== '') res.setHeader('ETag', formatted);
  return formatted;
}

function etagInput(meta: MetadataLike, formattedEtag: string, isGzip: boolean, fullPath: string) {
  const rawEtag = meta.etag;
  const contentEncoding = meta.contentEncoding;
  return { rawEtag, formattedEtag, contentEncoding, isGzip, fullPath };
}

function logHeadEtag(
  meta: MetadataLike,
  formattedEtag: string,
  isGzip: boolean,
  opts: StorageHeadOptions,
): void {
  logStorageEtagDecision(opts.logger, etagInput(meta, formattedEtag, isGzip, opts.fullPath));
}

function writeBody(res: ServerResponse, meta: MetadataLike, opts: StorageHeadOptions): void {
  const isGzip = meta.contentEncoding?.trim() === 'gzip';
  if (!isGzip) applyUncompressedHeaders(res, meta);
  logHeadEtag(meta, applyHeadEtag(res, formatHeadEtag(meta, isGzip, opts)), isGzip, opts);
}

function setHeadBaseHeaders(res: ServerResponse, opts: StorageHeadOptions): void {
  res.statusCode = HTTP_STATUS_OK;
  res.setHeader('Content-Type', opts.contentType);
  res.setHeader('Cache-Control', opts.cacheControl);
}

/**
 * Writes successful HTTP HEAD headers for a storage object and concludes the response.
 *
 * @remarks
 * Sets base status and MIME headers, conditionally emits length/encoding headers, applies
 * RFC 9110 compliant weak/strong ETags, logs telemetry decisions, and closes the response stream.
 *
 * @param res - The active Node.js server response stream.
 * @param metadata - Object metadata retrieved from GCS (`file.getMetadata()`).
 * @param opts - Context options including content type, cache control, logger, and formatter.
 */
export function writeHeadSuccess(
  res: ServerResponse,
  metadata: MetadataLike,
  opts: StorageHeadOptions,
): void {
  setHeadBaseHeaders(res, opts);
  writeBody(res, metadata, opts);
  res.end();
}
