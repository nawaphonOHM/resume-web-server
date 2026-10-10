/**
 * GCS response header extractor and HTTP response header setter for GET streaming.
 *
 * @remarks
 * ## RFC 9110 & GCS Automatic Stream Decompression Semantics
 *
 * In the Google Cloud Storage Node.js SDK (`@google-cloud/storage`), `file.createReadStream()`
 * automatically decompresses object payloads on the fly via an internal gunzip transform stream
 * when `options.decompress !== false` (default `true`) and the parsed HTTP response header is
 * exactly `content-encoding === 'gzip'`. The HTTP parser/transport layer strips optional whitespace
 * (OWS) around field values per RFC 9110 §5.5 before header values reach client code, and our
 * `.trim()` check defensively normalizes any surrounding whitespace.
 *
 * Because the delivered representation body consists of decompressed plaintext/binary bytes
 * rather than the raw compressed entity stored in the bucket:
 * 1. **Content-Length Omission (RFC 9110 §8.6 Invariant)**: RFC 9110 §8.6 requires `Content-Length`
 *    to represent the actual octet count of the emitted message payload. Because the payload has
 *    been decompressed and the uncompressed byte count is unknown in a streaming pipeline without
 *    buffering the entire object, `Content-Length` must be omitted (falling back to chunked transfer
 *    encoding). Sending the stored compressed byte count would cause downstream clients to prematurely
 *    truncate the stream or fail on framing.
 * 2. **Content-Encoding Omission (RFC 9110 §8.4 Invariant)**: RFC 9110 §8.4 defines `Content-Encoding`
 *    as a modifier indicating what coding transformations have been applied to the representation.
 *    Because the SDK already decompressed the stream, the emitted payload is identity-encoded, so
 *    `Content-Encoding` must be omitted.
 * 3. **Weak ETag Conversion (Implementation Decision for RFC 9110 §8.8.1 & §8.8.3)**: RFC 9110
 *    forbids reusing a strong validator for two representations with different byte content
 *    (decompressed representation vs stored compressed entity). Converting the GCS strong ETag to
 *    a weak validator (`W/"..."`) is our chosen implementation strategy to satisfy validator semantics
 *    while preserving cache validation utility.
 *
 * Non-gzip or case-mismatched encodings (e.g., `'GZIP'`, `'br'`, `'deflate'`) do not trigger SDK automatic
 * decompression (the SDK checks `=== 'gzip'` exactly), so their compressed bytes, `Content-Length`,
 * `Content-Encoding`, and strong ETags are preserved as-is.
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
