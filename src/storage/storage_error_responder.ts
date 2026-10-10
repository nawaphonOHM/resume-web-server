/**
 * Storage error response formatting, header removal, and error logging.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import { isResponseWritable } from '../http/http_response_state.ts';
import { HTTP_STATUS_NOT_FOUND } from '../http/http_status_codes.ts';
import type { AppLogger } from '../logger/logger_types.ts';
import {
  type ErrorClassificationInput,
  logStorageErrorClassification,
} from './storage_error_telemetry.ts';
import { destroyIfWritable, sendErrorPayload } from './storage_error_write.ts';
import type { IStorageErrorClassifier } from './storage_types.ts';

export interface StorageErrorContext {
  readonly err: unknown;
  readonly res: ServerResponse;
  readonly fullPath: string;
  readonly errorClassifier: IStorageErrorClassifier;
  readonly logger: AppLogger;
  readonly notFoundStatusCode?: number;
  readonly isHead?: boolean;
}

function getMethod(isHead?: boolean): string {
  return isHead ? 'HEAD' : 'GET';
}

function getAction(isHead?: boolean): string {
  return isHead ? 'retrieve metadata for' : 'stream';
}

function logAbortError(ctx: StorageErrorContext): void {
  const method = getMethod(ctx.isHead);
  const action = getAction(ctx.isHead);
  ctx.logger.error(
    `Failed to ${action} asset from storage (connection aborted mid-stream)`,
    ctx.err,
    { path: ctx.fullPath, statusCode: ctx.res.statusCode, method },
  );
}

function pathFields(ctx: StorageErrorContext) {
  return {
    fullPath: ctx.fullPath,
    notFoundStatusCode: ctx.notFoundStatusCode,
    isHead: ctx.isHead,
    currentStatusCode: ctx.res.statusCode,
  };
}

function makeErrorInput(
  ctx: StorageErrorContext,
  is404: boolean,
  headersSent: boolean,
): ErrorClassificationInput {
  return { is404, headersSent, ...pathFields(ctx) };
}

function logPreStreamError(ctx: StorageErrorContext, statusCode: number): void {
  if (statusCode === HTTP_STATUS_NOT_FOUND) return;
  const method = getMethod(ctx.isHead);
  const action = getAction(ctx.isHead);
  ctx.logger.error(`Failed to ${action} asset from storage`, ctx.err, {
    path: ctx.fullPath,
    statusCode,
    method,
  });
}

function respondPreStream(ctx: StorageErrorContext, is404: boolean): void {
  const input = makeErrorInput(ctx, is404, false);
  const { statusCode } = logStorageErrorClassification(ctx.logger, input);
  logPreStreamError(ctx, statusCode);
  sendErrorPayload(ctx.res, statusCode);
}

function respondAborted(ctx: StorageErrorContext, is404: boolean): void {
  const input = makeErrorInput(ctx, is404, ctx.res.headersSent);
  logStorageErrorClassification(ctx.logger, input);
  logAbortError(ctx);
  destroyIfWritable(ctx.res);
}

function classify(ctx: StorageErrorContext): boolean {
  return ctx.errorClassifier.isNotFoundError(ctx.err);
}

export function handleHeadStorageError(ctx: StorageErrorContext): void {
  const is404 = classify(ctx);
  if (isResponseWritable(ctx.res)) {
    respondPreStream(ctx, is404);
    return;
  }
  respondAborted(ctx, is404);
}

export function handleGetStorageError(ctx: StorageErrorContext): void {
  const is404 = classify(ctx);
  if (ctx.res.headersSent) {
    respondAborted(ctx, is404);
    return;
  }
  respondPreStream(ctx, is404);
}
