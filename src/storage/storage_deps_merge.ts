/**
 * Merge helpers for storage service options and positional constructor arguments.
 *
 * @packageDocumentation
 */

import type { Storage } from '@google-cloud/storage';
import type { AppLogger } from '../logger/logger_types.ts';
import type {
  IEtagFormatter,
  IStorageErrorClassifier,
  IStorageKeyResolver,
  StorageServiceOptions,
} from './storage_types.ts';

export type RestStorageDeps = [
  IStorageKeyResolver?,
  IEtagFormatter?,
  IStorageErrorClassifier?,
  AppLogger?,
];

export interface RawStorageDeps {
  readonly storageClient?: Storage;
  readonly pathResolver?: IStorageKeyResolver;
  readonly etagFormatter?: IEtagFormatter;
  readonly errorClassifier?: IStorageErrorClassifier;
  readonly logger?: AppLogger;
}

function mergeField<T>(optionValue: T | undefined, positional: T | undefined): T | undefined {
  return optionValue ?? positional;
}

function mergeClientFields(
  opts: StorageServiceOptions,
  positional: RawStorageDeps,
): RawStorageDeps {
  return {
    storageClient: mergeField(opts.storageClient, positional.storageClient),
    pathResolver: mergeField(opts.pathResolver, positional.pathResolver),
    etagFormatter: mergeField(opts.etagFormatter, positional.etagFormatter),
  };
}

function mergeOptionFields(
  opts: StorageServiceOptions,
  positional: RawStorageDeps,
): RawStorageDeps {
  return {
    ...mergeClientFields(opts, positional),
    errorClassifier: mergeField(opts.errorClassifier, positional.errorClassifier),
    logger: mergeField(opts.logger, positional.logger),
  };
}

export function extractRestDeps(
  client: Storage | undefined,
  rest: RestStorageDeps,
): RawStorageDeps {
  const [pathResolver, etagFormatter, errorClassifier, logger] = rest;
  return { storageClient: client, pathResolver, etagFormatter, errorClassifier, logger };
}

export function mergeDeps(
  opts: StorageServiceOptions | undefined,
  client: Storage | undefined,
  rest: RestStorageDeps,
): RawStorageDeps {
  const positional = extractRestDeps(client, rest);
  if (!opts) return positional;
  return mergeOptionFields(opts, positional);
}
