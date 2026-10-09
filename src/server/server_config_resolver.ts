/**
 * Server startup configuration resolution and storage service initialization.
 *
 * @packageDocumentation
 */

import process from 'node:process';
import { type ServerConfig, loadConfig } from '../config/config.ts';
import { createStorageService, type StorageService } from '../storage/storage.ts';
import { logger as defaultLogger, type AppLogger } from '../logger/logger.ts';
import { logBootstrapOverrides } from './server_bootstrap_telemetry.ts';
import type { StartServerOptions } from './server_types.ts';

function resolveConfigPort(cfg: Partial<ServerConfig> | undefined, env: ServerConfig): number {
  return cfg?.port ?? env.port;
}

function resolveConfigHost(cfg: Partial<ServerConfig> | undefined, env: ServerConfig): string {
  return cfg?.host ?? env.host;
}

function resolveConfigBucket(cfg: Partial<ServerConfig> | undefined, env: ServerConfig): string {
  return cfg?.bucketName ?? env.bucketName;
}

function resolveConfigPrefix(cfg: Partial<ServerConfig> | undefined, env: ServerConfig): string {
  return cfg?.prefix ?? env.prefix;
}

function mergeConfig(cfg: Partial<ServerConfig> | undefined, env: ServerConfig): ServerConfig {
  return {
    port: resolveConfigPort(cfg, env),
    host: resolveConfigHost(cfg, env),
    bucketName: resolveConfigBucket(cfg, env),
    prefix: resolveConfigPrefix(cfg, env),
  };
}

/**
 * Resolves effective server configuration by merging environment variables and options overrides.
 */
export function resolveEffectiveConfig(
  options: StartServerOptions,
  appLogger: AppLogger,
): ServerConfig {
  const env = loadConfig(process.env, appLogger);
  return mergeConfig(options.config, env);
}

/**
 * Resolves or instantiates the storage service instance.
 */
export function resolveStorage(
  options: StartServerOptions,
  config: ServerConfig,
  appLogger: AppLogger,
): StorageService {
  return options.storageService ?? createStorageService({ config, logger: appLogger });
}

/**
 * Emits telemetry when explicit configuration overrides were supplied.
 */
export function logOverridesIfPresent(
  options: StartServerOptions,
  config: ServerConfig,
  defaultLog: typeof defaultLogger,
): void {
  if (options.config) {
    const logger = options.logger ?? defaultLog;
    logBootstrapOverrides(logger, options.config, config);
  }
}
