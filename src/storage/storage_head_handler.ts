/**
 * Storage HEAD request handler fetching metadata and formatting RFC 9110 headers.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import type { File } from '@google-cloud/storage';
import { isResponseWritable } from '../http/http_response_state.ts';
import type { AppLogger } from '../logger/logger_types.ts';
import { handleHeadStorageError } from './storage_error_responder.ts';
import { writeHeadSuccess } from './storage_head_headers.ts';
import type { IEtagFormatter, IStorageErrorClassifier } from './storage_types.ts';

export interface StorageHeadOptions {
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

function toHeadErrorContext(opts: StorageHeadOptions, err: unknown) {
  const { res, fullPath, errorClassifier, logger, notFoundStatusCode } = opts;
  return { err, res, fullPath, errorClassifier, logger, notFoundStatusCode, isHead: true };
}

function handleHeadCatch(opts: StorageHeadOptions, err: unknown): void {
  handleHeadStorageError(toHeadErrorContext(opts, err));
}

export async function executeHeadRequest(opts: StorageHeadOptions): Promise<void> {
  try {
    const [metadata] = await opts.file.getMetadata();
    if (isResponseWritable(opts.res)) writeHeadSuccess(opts.res, metadata, opts);
  } catch (err: unknown) {
    handleHeadCatch(opts, err);
  }
}
