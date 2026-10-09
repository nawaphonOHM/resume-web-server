/**
 * Dependency resolver and option parser for storage service initialization.
 *
 * @packageDocumentation
 */

import { Storage } from '@google-cloud/storage';
import { type ServerConfig, config as defaultConfig } from '../config/config.ts';
import { logger as defaultLogger, type AppLogger } from '../logger/logger.ts';
import { RFC9110EtagFormatter } from '../etag_formatter.ts';
import { GcsErrorClassifier } from './storage_error_classifier.ts';
import { mergeDeps, type RawStorageDeps, type RestStorageDeps } from './storage_deps_merge.ts';
import { StorageObjectLocator } from './storage_object_locator.ts';
import { StoragePathResolver } from './storage_path_resolver.ts';
import type {
  IEtagFormatter,
  IStorageErrorClassifier,
  IStorageKeyResolver,
  IStorageObjectLocator,
  StorageServiceOptions,
} from './storage_types.ts';

export type { RestStorageDeps } from './storage_deps_merge.ts';

export interface ResolvedStorageDeps {
  readonly config: ServerConfig;
  readonly storage: Storage;
  readonly pathResolver: IStorageKeyResolver;
  readonly etagFormatter: IEtagFormatter;
  readonly errorClassifier: IStorageErrorClassifier;
  readonly objectLocator: IStorageObjectLocator;
  readonly logger: AppLogger;
}

const STORAGE_OPTION_KEYS = ['storageClient', 'pathResolver', 'etagFormatter', 'locator'];

function hasStorageField(obj: Record<string, unknown>): boolean {
  return STORAGE_OPTION_KEYS.some((key) => key in obj);
}

function hasConfigObject(obj: Record<string, unknown>): boolean {
  return 'config' in obj && typeof obj['config'] === 'object';
}

function hasOptionField(obj: Record<string, unknown>): boolean {
  return 'errorClassifier' in obj || 'logger' in obj || hasConfigObject(obj);
}

function isObjectRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === 'object' && obj !== null;
}

export function isStorageServiceOptions(obj: unknown): obj is StorageServiceOptions {
  if (!isObjectRecord(obj)) return false;
  return hasStorageField(obj) || hasOptionField(obj);
}

function resolveConfig(configOrOpts: ServerConfig | StorageServiceOptions): ServerConfig {
  if (isStorageServiceOptions(configOrOpts)) {
    return configOrOpts.config ?? defaultConfig;
  }
  return configOrOpts;
}

function getLogger(log?: AppLogger): AppLogger {
  return log ?? defaultLogger;
}

function getStorage(client?: Storage): Storage {
  return client ?? new Storage();
}

function getPath(prefix: string, resolver?: IStorageKeyResolver, log?: AppLogger) {
  return resolver ?? new StoragePathResolver(prefix, log);
}

function getEtag(form?: IEtagFormatter): IEtagFormatter {
  return form ?? new RFC9110EtagFormatter();
}

function getErr(cls?: IStorageErrorClassifier): IStorageErrorClassifier {
  return cls ?? new GcsErrorClassifier();
}

function getLocator(
  loc?: IStorageObjectLocator,
  cls?: IStorageErrorClassifier,
  log?: AppLogger,
): IStorageObjectLocator {
  return loc ?? new StorageObjectLocator(cls, log);
}

function buildResolvedDeps(config: ServerConfig, raw: RawStorageDeps): ResolvedStorageDeps {
  const logger = getLogger(raw.logger);
  const pathResolver = getPath(config.prefix, raw.pathResolver, logger);
  const storage = getStorage(raw.storageClient);
  const etagFormatter = getEtag(raw.etagFormatter);
  const errorClassifier = getErr(raw.errorClassifier);
  const objectLocator = getLocator(raw.locator, errorClassifier, logger);
  return { config, storage, pathResolver, etagFormatter, errorClassifier, objectLocator, logger };
}

export function resolveStorageDeps(
  configOrOpts: ServerConfig | StorageServiceOptions = defaultConfig,
  client?: Storage,
  ...rest: RestStorageDeps
): ResolvedStorageDeps {
  const opts = isStorageServiceOptions(configOrOpts) ? configOrOpts : undefined;
  const config = resolveConfig(configOrOpts);
  const raw = mergeDeps(opts, client, rest);
  return buildResolvedDeps(config, raw);
}
