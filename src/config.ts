/**
 * Server Configuration Module.
 *
 * Provides environment variable parsing, default configuration values,
 * network port range validation, and object storage prefix normalization
 * for the web server application following SOLID principles.
 *
 * @remarks
 * Configuration values are resolved with precedence given to environment variables
 * (`PORT`, `HOST`, `GCS_BUCKET_NAME`, `GCS_PREFIX`), falling back to sensible
 * production defaults when variables are absent or invalid (note that a set-but-empty
 * `GCS_PREFIX` normalizes to the bucket root `''` rather than the default).
 *
 * @packageDocumentation
 */

import process from 'node:process';
import type { AppLogger } from './logger.ts';

/**
 * Immutable configuration options for the web server instance.
 */
export interface ServerConfig {
  /**
   * The TCP port number on which the HTTP server listens.
   *
   * @remarks
   * Must be a valid positive integer in the range 1 through 65535.
   *
   * @defaultValue `8080`
   */
  readonly port: number;

  /**
   * The network host address or IP interface to bind to.
   *
   * @defaultValue `'0.0.0.0'` (all network interfaces)
   */
  readonly host: string;

  /**
   * The Google Cloud Storage (GCS) bucket name containing the static assets.
   *
   * @defaultValue `'resume_cloudbuild'`
   */
  readonly bucketName: string;

  /**
   * The object key prefix (subfolder) within the GCS bucket where assets are located.
   *
   * @remarks
   * Leading and trailing forward slashes are stripped during normalization.
   * When `GCS_PREFIX` is set to an empty string, whitespace only, or slashes only,
   * it normalizes to the bucket root (`''`) rather than the default fallback.
   *
   * @defaultValue `'resume_cloudbuild/angular'`
   */
  readonly prefix: string;
}

/**
 * Contract for validating and normalizing raw configuration values (Single Responsibility Principle).
 */
export interface IConfigValidator {
  /**
   * Validates and parses a raw port number string, falling back to a default if invalid.
   *
   * @param rawPort - The raw port string from environment or options.
   * @param defaultPort - Fallback port number.
   * @returns Validated TCP port number in range 1..65535.
   */
  validatePort(rawPort: string | undefined, defaultPort: number): number;

  /**
   * Normalizes a string value with trimming and default fallback.
   *
   * @param rawValue - The raw string value.
   * @param defaultValue - Fallback string if value is empty or unset.
   * @returns Trimmed string value or default.
   */
  normalizeString(rawValue: string | undefined, defaultValue: string): string;

  /**
   * Normalizes a GCS object key prefix by trimming slashes.
   *
   * @param rawPrefix - The raw prefix string from environment.
   * @param defaultPrefix - Fallback prefix when unset.
   * @returns Normalized prefix string.
   */
  normalizePrefix(rawPrefix: string | undefined, defaultPrefix: string): string;
}

/**
 * Contract for loading and building {@link ServerConfig} objects (Interface Segregation Principle).
 */
export interface IConfigLoader {
  /**
   * Loads and validates server configuration from an environment map.
   *
   * @param env - Key-value environment variable map.
   * @returns Fully resolved {@link ServerConfig}.
   */
  load(env?: NodeJS.ProcessEnv): ServerConfig;
}

/**
 * Default TCP port number used when the `PORT` environment variable is omitted or invalid.
 */
export const DEFAULT_PORT = 8080;

/**
 * Default network host interface used when `HOST` is omitted or empty.
 */
export const DEFAULT_HOST = '0.0.0.0';

/**
 * Default Google Cloud Storage bucket name used when `GCS_BUCKET_NAME` is omitted or empty.
 */
export const DEFAULT_BUCKET_NAME = 'resume_cloudbuild';

/**
 * Default GCS object key prefix used only when `GCS_PREFIX` is unset; empty, whitespace-only, or slash-only values normalize to the bucket root (`''`).
 */
export const DEFAULT_PREFIX = 'resume_cloudbuild/angular';

/**
 * Default validator implementation for server configuration parameters.
 */
export class DefaultConfigValidator implements IConfigValidator {
  /**
   * Validates and parses a raw port number string.
   *
   * @param rawPort - The raw port string.
   * @param defaultPort - Fallback port number.
   * @returns Validated port number.
   */
  public validatePort(rawPort: string | undefined, defaultPort: number): number {
    if (rawPort !== undefined && rawPort.trim() !== '') {
      const parsed = Number.parseInt(rawPort.trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
        return parsed;
      }
    }
    return defaultPort;
  }

  /**
   * Normalizes a string value.
   *
   * @param rawValue - The raw string.
   * @param defaultValue - Fallback string.
   * @returns Trimmed string or default.
   */
  public normalizeString(rawValue: string | undefined, defaultValue: string): string {
    return rawValue !== undefined && rawValue.trim() !== '' ? rawValue.trim() : defaultValue;
  }

  /**
   * Normalizes a GCS storage prefix.
   *
   * @param rawPrefix - The raw prefix string.
   * @param defaultPrefix - Fallback prefix.
   * @returns Normalized prefix.
   */
  public normalizePrefix(rawPrefix: string | undefined, defaultPrefix: string): string {
    const prefixInput = rawPrefix !== undefined ? rawPrefix.trim() : defaultPrefix;
    return prefixInput.replace(/^\/+|\/+$/g, '');
  }
}

/**
 * Configuration options for {@link EnvConfigLoader}.
 */
export interface EnvConfigLoaderOptions {
  /**
   * The configuration validator instance.
   *
   * @defaultValue {@link DefaultConfigValidator}
   */
  readonly validator?: IConfigValidator;

  /**
   * Optional application logger for recording configuration resolution decisions.
   */
  readonly logger?: AppLogger;
}

/**
 * Environment-variable backed configuration loader (Single Responsibility & Dependency Inversion).
 */
export class EnvConfigLoader implements IConfigLoader {
  /**
   * The configuration validator instance.
   */
  private readonly validator: IConfigValidator;

  /**
   * Optional application logger instance.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `EnvConfigLoader` instance.
   *
   * @param validatorOrOptions - Injected validator implementing {@link IConfigValidator} or {@link EnvConfigLoaderOptions}. Defaults to {@link DefaultConfigValidator}.
   * @param logger - Optional injected {@link AppLogger}.
   */
  public constructor(
    validatorOrOptions?: IConfigValidator | EnvConfigLoaderOptions,
    logger?: AppLogger,
  ) {
    if (validatorOrOptions && 'validatePort' in validatorOrOptions) {
      this.validator = validatorOrOptions;
      this.logger = logger;
    } else {
      this.validator = validatorOrOptions?.validator ?? new DefaultConfigValidator();
      this.logger = validatorOrOptions?.logger ?? logger;
    }
  }

  /**
   * Loads and validates configuration from the given environment record.
   *
   * @param env - Environment variable map. Defaults to `process.env`.
   * @returns The resolved {@link ServerConfig}.
   */
  public load(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const rawPort = env['PORT'];
    const port = this.validator.validatePort(rawPort, DEFAULT_PORT);
    if (this.logger) {
      const choice = `port: ${String(port)}`;
      let reason: string;
      if (rawPort === undefined) {
        reason =
          port === DEFAULT_PORT
            ? `PORT environment variable not set, falling back to DEFAULT_PORT (${String(DEFAULT_PORT)})`
            : `PORT environment variable not set, resolved to ${String(port)} via validator`;
      } else if (rawPort.trim() === '') {
        reason =
          port === DEFAULT_PORT
            ? `PORT environment variable is empty, falling back to DEFAULT_PORT (${String(DEFAULT_PORT)})`
            : `PORT environment variable is empty, resolved to ${String(port)} via validator`;
      } else if (port === DEFAULT_PORT && rawPort.trim() !== String(DEFAULT_PORT)) {
        reason = `PORT environment variable value '${rawPort}' is invalid, falling back to DEFAULT_PORT (${String(DEFAULT_PORT)})`;
      } else {
        reason = `Resolved from PORT environment variable`;
      }
      this.logger.decision({
        action: 'Config',
        choice,
        reason,
        level: 'debug',
        variable: 'PORT',
        resolved: port,
      });
    }

    const rawHost = env['HOST'];
    const host = this.validator.normalizeString(rawHost, DEFAULT_HOST);
    if (this.logger) {
      const choice = `host: '${host}'`;
      let reason: string;
      if (rawHost === undefined) {
        reason =
          host === DEFAULT_HOST
            ? `HOST environment variable not set, falling back to DEFAULT_HOST ('${DEFAULT_HOST}')`
            : `HOST environment variable not set, resolved to '${host}' via validator`;
      } else if (rawHost.trim() === '') {
        reason =
          host === DEFAULT_HOST
            ? `HOST environment variable is empty, falling back to DEFAULT_HOST ('${DEFAULT_HOST}')`
            : `HOST environment variable is empty, resolved to '${host}' via validator`;
      } else {
        reason = `Resolved from HOST environment variable`;
      }
      this.logger.decision({
        action: 'Config',
        choice,
        reason,
        level: 'debug',
        variable: 'HOST',
        resolved: host,
      });
    }

    const rawBucket = env['GCS_BUCKET_NAME'];
    const bucketName = this.validator.normalizeString(rawBucket, DEFAULT_BUCKET_NAME);
    if (this.logger) {
      const choice = `bucketName: '${bucketName}'`;
      let reason: string;
      if (rawBucket === undefined) {
        reason =
          bucketName === DEFAULT_BUCKET_NAME
            ? `GCS_BUCKET_NAME environment variable not set, falling back to DEFAULT_BUCKET_NAME ('${DEFAULT_BUCKET_NAME}')`
            : `GCS_BUCKET_NAME environment variable not set, resolved to '${bucketName}' via validator`;
      } else if (rawBucket.trim() === '') {
        reason =
          bucketName === DEFAULT_BUCKET_NAME
            ? `GCS_BUCKET_NAME environment variable is empty, falling back to DEFAULT_BUCKET_NAME ('${DEFAULT_BUCKET_NAME}')`
            : `GCS_BUCKET_NAME environment variable is empty, resolved to '${bucketName}' via validator`;
      } else {
        reason = `Resolved from GCS_BUCKET_NAME environment variable`;
      }
      this.logger.decision({
        action: 'Config',
        choice,
        reason,
        level: 'debug',
        variable: 'GCS_BUCKET_NAME',
        resolved: bucketName,
      });
    }

    const rawPrefix = env['GCS_PREFIX'];
    const prefix = this.validator.normalizePrefix(rawPrefix, DEFAULT_PREFIX);
    if (this.logger) {
      const choice = `prefix: '${prefix}'`;
      let reason: string;
      if (rawPrefix === undefined) {
        reason =
          prefix === DEFAULT_PREFIX
            ? `GCS_PREFIX environment variable not set, falling back to DEFAULT_PREFIX ('${DEFAULT_PREFIX}')`
            : `GCS_PREFIX environment variable not set, resolved to '${prefix}' via validator`;
      } else if (prefix === '') {
        reason = `GCS_PREFIX environment variable is empty or root-only, normalized to bucket root ('')`;
      } else {
        reason = `Resolved from GCS_PREFIX environment variable and normalized`;
      }
      this.logger.decision({
        action: 'Config',
        choice,
        reason,
        level: 'debug',
        variable: 'GCS_PREFIX',
        resolved: prefix,
      });
    }

    return {
      port,
      host,
      bucketName,
      prefix,
    };
  }
}

/**
 * Default singleton configuration loader instance.
 */
const defaultConfigLoader: IConfigLoader = new EnvConfigLoader();

/**
 * Loads and validates the server configuration from the provided environment map.
 *
 * @remarks
 * Performs sanitization and validation on environment variables:
 * - `PORT`: Trimmed and parsed as a base-10 integer. Must be between 1 and 65535 (inclusive);
 *   otherwise falls back to {@link DEFAULT_PORT}.
 * - `HOST`: Trimmed string; falls back to {@link DEFAULT_HOST} if empty or unset.
 * - `GCS_BUCKET_NAME`: Trimmed string; falls back to {@link DEFAULT_BUCKET_NAME} if empty or unset.
 * - `GCS_PREFIX`: Trimmed string; normalized by removing leading and trailing slashes (`/`).
 *   Falls back to {@link DEFAULT_PREFIX} only when unset; empty, whitespace-only, or slash-only values normalize to the bucket root (`''`).
 *
 * @param env - Environment variable key-value map. Defaults to `process.env`.
 * @param logger - Optional {@link AppLogger} for recording decision telemetry.
 * @returns The validated and normalized {@link ServerConfig} object.
 *
 * @example
 * ```ts
 * // Load configuration from default process.env
 * const config = loadConfig();
 *
 * // Load configuration with custom overrides
 * const customConfig = loadConfig({
 *   PORT: '3000',
 *   HOST: '127.0.0.1',
 *   GCS_BUCKET_NAME: 'my-bucket',
 *   GCS_PREFIX: '/assets/',
 * });
 * console.log(customConfig.prefix); // 'assets'
 * ```
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, logger?: AppLogger): ServerConfig {
  if (logger) {
    return new EnvConfigLoader({ logger }).load(env);
  }
  return defaultConfigLoader.load(env);
}

/**
 * Default singleton server configuration loaded from the runtime `process.env`.
 */
export const config: ServerConfig = loadConfig();
