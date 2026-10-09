/**
 * HEAD response header application and ETag telemetry for storage metadata.
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

function applyEncodingHeader(res: ServerResponse, rawEncoding?: string, encoding?: string): void {
  if (rawEncoding && encoding !== 'identity') res.setHeader('Content-Encoding', rawEncoding);
}

function applyUncompressedHeaders(
  res: ServerResponse,
  metadata: MetadataLike,
  encoding?: string,
): void {
  applySizeHeader(res, metadata.size);
  applyEncodingHeader(res, metadata.contentEncoding, encoding);
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

function gzipState(metadata: MetadataLike): { encoding?: string; isGzip: boolean } {
  const encoding = metadata.contentEncoding?.trim().toLowerCase();
  return { encoding, isGzip: encoding === 'gzip' };
}

function writeBody(res: ServerResponse, meta: MetadataLike, opts: StorageHeadOptions): void {
  const { encoding, isGzip } = gzipState(meta);
  if (!isGzip) applyUncompressedHeaders(res, meta, encoding);
  logHeadEtag(meta, applyHeadEtag(res, formatHeadEtag(meta, isGzip, opts)), isGzip, opts);
}

function setHeadBaseHeaders(res: ServerResponse, opts: StorageHeadOptions): void {
  res.statusCode = HTTP_STATUS_OK;
  res.setHeader('Content-Type', opts.contentType);
  res.setHeader('Cache-Control', opts.cacheControl);
}

export function writeHeadSuccess(
  res: ServerResponse,
  metadata: MetadataLike,
  opts: StorageHeadOptions,
): void {
  setHeadBaseHeaders(res, opts);
  writeBody(res, metadata, opts);
  res.end();
}
