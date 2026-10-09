/**
 * Helper routines for GcsStorageService file existence checks, error dispatch, and missing-object responses.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import type { Bucket, File } from '@google-cloud/storage';
import { HTTP_STATUS_NOT_FOUND } from '../http/http_status_codes.ts';
import type { AppLogger } from '../logger/logger_types.ts';
import type { ResolvedStorageDeps } from './storage_deps_resolver.ts';
import type { StorageErrorContext } from './storage_error_responder.ts';
import { handleGetStorageError, handleHeadStorageError } from './storage_error_responder.ts';
import { logStorageErrorClassification } from './storage_error_telemetry.ts';
import type { StreamDispatchContext, StreamFileParams } from './storage_stream_options.ts';
import { dispatchStream } from './storage_stream_options.ts';
import type { IStorageErrorClassifier, LocateResult } from './storage_types.ts';

const alwaysBackendClassifier: IStorageErrorClassifier = {
  isNotFoundError: () => false,
};

function logExistsError(logger: AppLogger, is404: boolean, fullPath: string): number {
  const input = { is404, fullPath, notFoundStatusCode: HTTP_STATUS_NOT_FOUND };
  return logStorageErrorClassification(logger, input).statusCode;
}

export function handleExistsError(
  err: unknown,
  fullPath: string,
  deps: ResolvedStorageDeps,
): never {
  const statusCode = logExistsError(deps.logger, false, fullPath);
  deps.logger.error('Storage error checking file existence', err, { path: fullPath, statusCode });
  throw err;
}

type ErrorBase = Pick<StorageErrorContext, 'res' | 'fullPath' | 'notFoundStatusCode' | 'isHead'>;

function streamMeta(res: ServerResponse, fullPath: string, p: StreamFileParams): ErrorBase {
  return { res, fullPath, notFoundStatusCode: p.status, isHead: p.isHead };
}

function makeErrorCtx(
  base: ErrorBase,
  err: unknown,
  errorClassifier: IStorageErrorClassifier,
  logger: AppLogger,
): StorageErrorContext {
  return { ...base, err, errorClassifier, logger };
}

function dispatchError(p: StreamFileParams, ctx: StorageErrorContext): void {
  (p.isHead ? handleHeadStorageError : handleGetStorageError)(ctx);
}

export function sendNotFound(
  res: ServerResponse,
  fullPath: string,
  p: StreamFileParams,
  deps: ResolvedStorageDeps,
): void {
  const err = Object.assign(new Error(`No such object: ${fullPath}`), { code: 404 });
  const base = streamMeta(res, fullPath, p);
  dispatchError(p, makeErrorCtx(base, err, deps.errorClassifier, deps.logger));
}

export function handleLocatorError(
  p: StreamFileParams,
  fullPath: string,
  err: unknown,
  deps: ResolvedStorageDeps,
): void {
  const base = streamMeta(p.res, fullPath, p);
  dispatchError(p, makeErrorCtx(base, err, alwaysBackendClassifier, deps.logger));
}

function catchLocError(
  p: StreamFileParams,
  fullPath: string,
  deps: ResolvedStorageDeps,
): (err: unknown) => undefined {
  return (err: unknown) => {
    handleLocatorError(p, fullPath, err, deps);
    return undefined;
  };
}

async function locateTarget(
  bucket: Bucket,
  deps: ResolvedStorageDeps,
  p: StreamFileParams,
  fullPath: string,
): Promise<LocateResult | null | undefined> {
  const onErr = catchLocError(p, fullPath, deps);
  return deps.objectLocator.locateFile(bucket, p.objectName, deps.config.prefix).catch(onErr);
}

async function locateOrRespondMissing(
  bucket: Bucket,
  deps: ResolvedStorageDeps,
  p: StreamFileParams,
): Promise<LocateResult | null | undefined> {
  const fullPath = deps.pathResolver.resolveObjectName(p.objectName);
  const loc = await locateTarget(bucket, deps, p, fullPath);
  if (loc === null) sendNotFound(p.res, fullPath, p, deps);
  return loc;
}

type CtxFactory = (file: File, fullPath: string) => StreamDispatchContext;

export async function executeStreamDispatch(
  bucket: Bucket,
  deps: ResolvedStorageDeps,
  p: StreamFileParams,
  ctxFactory: CtxFactory,
): Promise<void> {
  const loc = await locateOrRespondMissing(bucket, deps, p);
  if (loc) await dispatchStream(ctxFactory(loc.file, loc.fullPath), p);
}
