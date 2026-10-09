/**
 * Stream option builder and decision logger for storage streaming.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import type { Bucket, File } from '@google-cloud/storage';
import { HTTP_STATUS_NOT_FOUND } from '../http/http_status_codes.ts';
import type { AppLogger } from '../logger/logger_types.ts';
import { CACHE_CONTROL_IMMUTABLE, CACHE_CONTROL_NO_CACHE } from '../mime/mime.ts';
import { executeGetRequest } from './storage_get_handler.ts';
import { executeHeadRequest } from './storage_head_handler.ts';
import { logStorageStreamDecision } from './storage_stream_telemetry.ts';
import type { IEtagFormatter, IStorageErrorClassifier } from './storage_types.ts';

export interface StreamDispatchContext {
  readonly bucket: Bucket;
  readonly fullPath: string;
  readonly etagFormatter: IEtagFormatter;
  readonly errorClassifier: IStorageErrorClassifier;
  readonly logger: AppLogger;
}

export interface StreamFileParams {
  readonly objectName: string;
  readonly res: ServerResponse;
  readonly contentType: string;
  readonly isHashed: boolean;
  readonly isHead: boolean;
  readonly status: number;
}

export interface BuiltStreamOptions {
  readonly file: File;
  readonly res: ServerResponse;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly notFoundStatusCode: number;
  readonly fullPath: string;
  readonly etagFormatter: IEtagFormatter;
  readonly errorClassifier: IStorageErrorClassifier;
  readonly logger: AppLogger;
}

function resolveCacheControl(isHashed: boolean): string {
  return isHashed ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_NO_CACHE;
}

function logDispatchDecision(ctx: StreamDispatchContext, p: StreamFileParams): void {
  logStorageStreamDecision(ctx.logger, {
    objectName: p.objectName,
    fullPath: ctx.fullPath,
    contentType: p.contentType,
    isHashedAsset: p.isHashed,
    isHeadRequest: p.isHead,
    notFoundStatusCode: p.status,
  });
}

function streamIdentity(ctx: StreamDispatchContext, p: StreamFileParams) {
  return {
    file: ctx.bucket.file(ctx.fullPath),
    res: p.res,
    contentType: p.contentType,
    fullPath: ctx.fullPath,
  };
}

function streamStrategies(ctx: StreamDispatchContext, cacheControl: string, status: number) {
  return {
    cacheControl,
    notFoundStatusCode: status,
    etagFormatter: ctx.etagFormatter,
    errorClassifier: ctx.errorClassifier,
    logger: ctx.logger,
  };
}

export function buildStreamOptions(
  ctx: StreamDispatchContext,
  p: StreamFileParams,
): BuiltStreamOptions {
  logDispatchDecision(ctx, p);
  const cacheControl = resolveCacheControl(p.isHashed);
  return { ...streamIdentity(ctx, p), ...streamStrategies(ctx, cacheControl, p.status) };
}

function restToFlags(
  rest: [boolean, boolean?, number?],
): Pick<StreamFileParams, 'isHashed' | 'isHead' | 'status'> {
  const [isHashed, isHead, status] = rest;
  return {
    isHashed,
    isHead: isHead ?? false,
    status: status ?? HTTP_STATUS_NOT_FOUND,
  };
}

export function createStreamParams(
  name: string,
  res: ServerResponse,
  type: string,
  rest: [boolean, boolean?, number?],
): StreamFileParams {
  return { objectName: name, res, contentType: type, ...restToFlags(rest) };
}

export function dispatchStream(ctx: StreamDispatchContext, p: StreamFileParams): Promise<void> {
  const opts = buildStreamOptions(ctx, p);
  return p.isHead ? executeHeadRequest(opts) : executeGetRequest(opts);
}
