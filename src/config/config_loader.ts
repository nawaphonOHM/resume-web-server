/**
 * Environment configuration loader implementation.
 *
 * @packageDocumentation
 */

import process from 'node:process';
import type { AppLogger } from '../logger/logger.ts';
import {
  type ServerConfig,
  type IConfigValidator,
  type IConfigLoader,
  type EnvConfigLoaderOptions,
  DEFAULT_PORT,
  DEFAULT_HOST,
} from './config_types.ts';
import { assertRequiredVariables } from './config_env_errors.ts';
import { resolveLoaderDeps } from './config_loader_deps.ts';
import { logPortDecision, logHostDecision } from './config_telemetry.ts';
import { logBucketDecision, logPrefixDecision } from './config_storage_telemetry.ts';

function collectMissingVars(bucketName: string, prefix: string): string[] {
  const missing: string[] = [];
  if (bucketName === '') missing.push('GCS_BUCKET_NAME');
  if (prefix === '') missing.push('GCS_PREFIX');
  return missing;
}

/**
 * Environment-variable backed configuration loader (Single Responsibility & Dependency Inversion).
 */
export class EnvConfigLoader implements IConfigLoader {
  private readonly validator: IConfigValidator;
  private readonly logger?: AppLogger;
  private readonly exitFn: (code: number, message: string) => void;

  /**
   * Creates a new `EnvConfigLoader` instance.
   *
   * @param validatorOrOptions - Injected validator implementing {@link IConfigValidator} or {@link EnvConfigLoaderOptions}. Defaults to {@link DefaultConfigValidator}.
   * @param logger - Optional injected {@link AppLogger}.
   * @param exitFn - Optional injected process exit handler.
   */
  public constructor(
    validatorOrOptions?: IConfigValidator | EnvConfigLoaderOptions,
    logger?: AppLogger,
    exitFn?: (code: number, message: string) => void,
  ) {
    const deps = resolveLoaderDeps(validatorOrOptions, logger, exitFn);
    this.validator = deps.validator;
    this.logger = deps.logger;
    this.exitFn = deps.exitFn;
  }

  private resolvePrefix(rawPrefix: string | undefined): string {
    return rawPrefix !== undefined ? this.validator.normalizePrefix(rawPrefix) : '';
  }

  private logResolvedDecisions(env: NodeJS.ProcessEnv, cfg: ServerConfig): void {
    logPortDecision(this.logger, env['PORT'], cfg.port);
    logHostDecision(this.logger, env['HOST'], cfg.host);
    logBucketDecision(this.logger, cfg.bucketName);
    logPrefixDecision(this.logger, cfg.prefix);
  }

  /**
   * Loads and validates configuration from the given environment record.
   *
   * @param env - Environment variable map. Defaults to `process.env`.
   * @returns The resolved {@link ServerConfig}.
   */
  public load(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const bucketName = this.validator.normalizeString(env['GCS_BUCKET_NAME'], '');
    const prefix = this.resolvePrefix(env['GCS_PREFIX']);
    assertRequiredVariables(collectMissingVars(bucketName, prefix), this.logger, this.exitFn);
    const port = this.validator.validatePort(env['PORT'], DEFAULT_PORT);
    const host = this.validator.normalizeString(env['HOST'], DEFAULT_HOST);
    const result: ServerConfig = { port, host, bucketName, prefix };
    this.logResolvedDecisions(env, result);
    return result;
  }
}

function isAppLogger(
  loggerOrOptions: AppLogger | EnvConfigLoaderOptions,
): loggerOrOptions is AppLogger {
  return 'info' in loggerOrOptions && typeof loggerOrOptions.info === 'function';
}

function resolveFallbackOptions(opts?: EnvConfigLoaderOptions): EnvConfigLoaderOptions {
  return opts ?? {};
}

function resolveLoadConfigOptions(
  loggerOrOpts?: AppLogger | EnvConfigLoaderOptions,
  opts?: EnvConfigLoaderOptions,
): EnvConfigLoaderOptions {
  if (!loggerOrOpts) return resolveFallbackOptions(opts);
  if (isAppLogger(loggerOrOpts)) return { logger: loggerOrOpts, ...opts };
  return loggerOrOpts;
}

/**
 * Loads and validates server configuration from the environment.
 *
 * @param env - Key-value environment variable map. Defaults to `process.env`.
 * @param loggerOrOptions - Optional {@link AppLogger} instance or {@link EnvConfigLoaderOptions}.
 * @param options - Additional loader options if `loggerOrOptions` is a logger.
 * @returns Fully validated {@link ServerConfig} object.
 *
 * @remarks
 * If `GCS_BUCKET_NAME` or `GCS_PREFIX` are missing, invalid, or empty,
 * an error message is output via `exitFn` (or stderr) and an exception is thrown.
 *
 * @example
 * ```ts
 * const customConfig = loadConfig({
 *   PORT: '9000',
 *   GCS_BUCKET_NAME: 'my-bucket',
 *   GCS_PREFIX: '/assets/',
 * });
 * console.log(customConfig.prefix); // 'assets'
 * ```
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  loggerOrOptions?: AppLogger | EnvConfigLoaderOptions,
  options?: EnvConfigLoaderOptions,
): ServerConfig {
  const loaderOptions = resolveLoadConfigOptions(loggerOrOptions, options);
  return new EnvConfigLoader(loaderOptions).load(env);
}
