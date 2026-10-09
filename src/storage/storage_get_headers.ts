/**
 * GCS response header extractor and HTTP response header setter for GET streaming.
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

function applyEncoding(res: StorageHeadOptions['res'], raw?: string, encoding?: string): void {
  if (raw && encoding !== 'identity') res.setHeader('Content-Encoding', raw);
}

function applyLengthAndEncoding(
  opts: StorageHeadOptions,
  headers: GcsHeaders,
  encoding?: string,
): void {
  const length = stringHeader(headers['content-length']);
  if (length) opts.res.setHeader('Content-Length', length);
  applyEncoding(opts.res, stringHeader(headers['content-encoding']), encoding);
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
  encoding: string | undefined,
  isGzip: boolean,
): void {
  if (!isGzip) applyLengthAndEncoding(opts, headers, encoding);
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

export function writeGetStreamHeaders(gcsHeaders: GcsHeaders, opts: StorageHeadOptions): void {
  setBaseGetHeaders(opts);
  const rawEncoding = stringHeader(gcsHeaders['content-encoding']);
  const encoding = rawEncoding?.trim().toLowerCase();
  const isGzip = encoding === 'gzip';
  writeConditionalHeaders(gcsHeaders, opts, encoding, isGzip);
  logGetEtag(gcsHeaders, opts, isGzip);
}
