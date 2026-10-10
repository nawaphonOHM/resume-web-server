/**
 * GCS response header extractor and HTTP response header setter for GET streaming.
 *
 * @remarks
 * ## RFC 9110 & GCS Automatic Stream Decompression Semantics
 *
 * In the Google Cloud Storage Node.js SDK (`@google-cloud/storage`), `file.createReadStream()`
 * automatically decompresses object payloads on the fly via an internal gunzip transform stream
 * when `options.decompress !== false` (default `true`) and the parsed HTTP response header is
 * exactly `content-encoding === 'gzip'` (after HTTP header whitespace stripping per RFC 9110 §5.5).
 *
 * Because the delivered representation body consists of decompressed plaintext/binary bytes
 * rather than the raw compressed entity stored in the bucket, transmitting original metadata
 * headers would violate HTTP transport semantics:
 * 1. **Content-Length Omission (RFC 9110 §8.6)**: The stored `Content-Length` represents the
 *    compressed byte count. Sending this value would cause downstream clients to prematurely
 *    truncate or error on the decompressed stream. Because the uncompressed stream size is not
 *    predetermined without fully buffering the object, `Content-Length` is omitted, allowing
 *    chunked transfer framing.
 * 2. **Content-Encoding Omission (RFC 9110 §8.4)**: `Content-Encoding: gzip` indicates that the
 *    client must decode the payload using gzip. Because the SDK already decompressed the stream,
 *    omitting `Content-Encoding` informs the client that the received payload is identity-encoded.
 * 3. **Weak ETag Conversion (RFC 9110 §8.8.1 & §8.8.3)**: Strong validators guarantee byte-for-byte
 *    equality of stored entities. Because the representation bytes have undergone transformation
 *    (gzip decompression), the strong ETag is converted to a weak validator (`W/"..."`).
 *
 * Non-gzip or case-mismatched encodings (e.g., `'GZIP'`, `'br'`) do not trigger SDK automatic
 * decompression, so their `Content-Length`, `Content-Encoding`, and strong ETags are preserved as-is.
 *
 * @packageDocumentation
 */

import { HTTP_STATUS_OK } from '../http/http_status_codes.ts';
import { logStorageEtagDecision } from './storage_etag_telemetry.ts';
import type { StorageHeadOptions } from './storage_head_handler.ts';
import type { IEtagFormatter } from './storage_types.ts';

export type GcsHeaders = Record<string, string | string[] | undefined>;

function stringHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function isPassthroughEncoding(encoding: string): boolean {
  return encoding !== '' && encoding.toLowerCase() !== 'identity';
}

function applyEncoding(res: StorageHeadOptions['res'], raw?: string): void {
  const trimmed = raw ? raw.trim() : '';
  if (isPassthroughEncoding(trimmed)) res.setHeader('Content-Encoding', trimmed);
}

function applyLengthAndEncoding(opts: StorageHeadOptions, headers: GcsHeaders): void {
  const length = stringHeader(headers['content-length']);
  if (length) opts.res.setHeader('Content-Length', length);
  applyEncoding(opts.res, stringHeader(headers['content-encoding']));
}

function extractFormattedEtag(
  rawEtag: string | undefined,
  isGzip: boolean,
  formatter: IEtagFormatter,
): string {
  if (!rawEtag) return '';
  return formatter.formatEtag(rawEtag, isGzip);
}

function applyEtag(opts: StorageHeadOptions, formatted: string): void {
  if (formatted !== '') opts.res.setHeader('ETag', formatted);
}

function writeConditionalHeaders(
  headers: GcsHeaders,
  opts: StorageHeadOptions,
  isGzip: boolean,
): void {
  if (!isGzip) applyLengthAndEncoding(opts, headers);
  const rawEtag = stringHeader(headers['etag']);
  applyEtag(opts, extractFormattedEtag(rawEtag, isGzip, opts.etagFormatter));
}

function toGetEtagInput(headers: GcsHeaders, opts: StorageHeadOptions, isGzip: boolean) {
  const rawEtag = stringHeader(headers['etag']);
  return {
    rawEtag,
    formattedEtag: extractFormattedEtag(rawEtag, isGzip, opts.etagFormatter),
    contentEncoding: stringHeader(headers['content-encoding']),
    isGzip,
    fullPath: opts.fullPath,
  };
}

function logGetEtag(headers: GcsHeaders, opts: StorageHeadOptions, isGzip: boolean): void {
  logStorageEtagDecision(opts.logger, toGetEtagInput(headers, opts, isGzip));
}

function setBaseGetHeaders(opts: StorageHeadOptions): void {
  opts.res.statusCode = HTTP_STATUS_OK;
  opts.res.setHeader('Content-Type', opts.contentType);
  opts.res.setHeader('Cache-Control', opts.cacheControl);
}

/**
 * Applies HTTP headers to the response based on GCS streaming response headers.
 *
 * @remarks
 * Handles base headers (status 200, Content-Type, Cache-Control), conditional headers
 * (Content-Length and Content-Encoding for non-gzip payloads, formatted weak/strong ETags per RFC 9110),
 * and logs telemetry decisions for the emitted headers.
 *
 * @param gcsHeaders - Header map received from the GCS read stream response event.
 * @param opts - Context options including response stream, logger, formatter, and path.
 */
export function writeGetStreamHeaders(gcsHeaders: GcsHeaders, opts: StorageHeadOptions): void {
  setBaseGetHeaders(opts);
  const rawEncoding = stringHeader(gcsHeaders['content-encoding']);
  const isGzip = rawEncoding?.trim() === 'gzip';
  writeConditionalHeaders(gcsHeaders, opts, isGzip);
  logGetEtag(gcsHeaders, opts, isGzip);
}
