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
  IStorageObjectLocator,
  StorageServiceOptions,
} from './storage_types.ts';

export type RestStorageDeps = [
  IStorageKeyResolver?,
  IEtagFormatter?,
  IStorageErrorClassifier?,
  AppLogger?,
  IStorageObjectLocator?,
];

export interface RawStorageDeps {
  readonly storageClient?: Storage;
  readonly pathResolver?: IStorageKeyResolver;
  readonly etagFormatter?: IEtagFormatter;
  readonly errorClassifier?: IStorageErrorClassifier;
  readonly logger?: AppLogger;
  readonly locator?: IStorageObjectLocator;
}

function mergeField<T>(optionValue: T | undefined, positional: T | undefined): T | undefined {
  return optionValue ?? positional;
}

function mergeClientFields(opts: StorageServiceOptions, pos: RawStorageDeps): RawStorageDeps {
  const storageClient = mergeField(opts.storageClient, pos.storageClient);
  const pathResolver = mergeField(opts.pathResolver, pos.pathResolver);
  const etagFormatter = mergeField(opts.etagFormatter, pos.etagFormatter);
  const locator = mergeField(opts.locator, pos.locator);
  return { storageClient, pathResolver, etagFormatter, locator };
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
  const [pathResolver, etagFormatter, errorClassifier, logger, locator] = rest;
  return { storageClient: client, pathResolver, etagFormatter, errorClassifier, logger, locator };
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
