/**
 * Storage GET request handler streaming read stream bytes to HTTP response.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_OK } from '../http/http_status_codes.ts';
import { type GcsHeaders, writeGetStreamHeaders } from './storage_get_headers.ts';
import type { StorageHeadOptions } from './storage_head_handler.ts';
import { handleGetStorageError } from './storage_error_responder.ts';

export type StorageGetOptions = StorageHeadOptions;

interface ResponseMeta {
  readonly statusCode?: number;
  readonly headers?: GcsHeaders;
}

function isErrorStatus(code?: number): boolean {
  return typeof code === 'number' && code >= HTTP_STATUS_BAD_REQUEST;
}

function shouldSkipGetResponse(res: ServerResponse, meta: ResponseMeta, stream: Readable): boolean {
  if (isErrorStatus(meta.statusCode)) {
    stream.unpipe(res);
    return true;
  }
  return res.headersSent || res.destroyed;
}

function handleGetResponse(meta: ResponseMeta, stream: Readable, opts: StorageGetOptions): void {
  if (shouldSkipGetResponse(opts.res, meta, stream)) return;
  if (meta.headers) writeGetStreamHeaders(meta.headers, opts);
}

function initGetHeaders(res: ServerResponse, contentType: string, cacheControl: string): void {
  if (!res.headersSent) {
    res.statusCode = HTTP_STATUS_OK;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);
  }
}

function toGetErrorContext(opts: StorageGetOptions, err: unknown) {
  const { res, fullPath, errorClassifier, logger, notFoundStatusCode } = opts;
  return { err, res, fullPath, errorClassifier, logger, notFoundStatusCode, isHead: false };
}

class GetStreamManager {
  private settled = false;
  private readonly opts: StorageGetOptions;
  private readonly stream: Readable;
  private readonly resolve: () => void;

  public constructor(opts: StorageGetOptions, stream: Readable, resolveFn: () => void) {
    this.opts = opts;
    this.stream = stream;
    this.resolve = resolveFn;
    this.bindEvents();
  }

  private readonly onError = (err: unknown): void => {
    handleGetStorageError(toGetErrorContext(this.opts, err));
    this.finish();
  };

  private readonly onResponse = (meta: ResponseMeta): void => {
    handleGetResponse(meta, this.stream, this.opts);
  };

  private cleanup(): void {
    this.opts.res.off('close', this.onClose);
    this.opts.res.off('finish', this.finish);
    this.stream.off('error', this.onError);
    this.stream.off('response', this.onResponse);
    this.stream.on('error', () => {
      /* noop */
    });
  }

  private bindEvents(): void {
    this.opts.res.on('close', this.onClose);
    this.opts.res.on('finish', this.finish);
    this.stream.on('error', this.onError);
    this.stream.on('response', this.onResponse);
  }

  private readonly onClose = (): void => {
    if (!this.opts.res.writableEnded) this.stream.destroy();
    this.finish();
  };

  private readonly finish = (): void => {
    if (!this.settled) {
      this.settled = true;
      this.cleanup();
      this.resolve();
    }
  };

  public start(): void {
    initGetHeaders(this.opts.res, this.opts.contentType, this.opts.cacheControl);
    this.stream.pipe(this.opts.res);
  }
}

export function executeGetRequest(opts: StorageGetOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const stream = opts.file.createReadStream();
    new GetStreamManager(opts, stream, resolve).start();
  });
}
