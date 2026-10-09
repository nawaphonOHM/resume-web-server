/**
 * Server Configuration Types, Interfaces, and Constants.
 *
 * @packageDocumentation
 */

import type { AppLogger } from '../logger/logger.ts';

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
   * @remarks
   * Required parameter resolved from the `GCS_BUCKET_NAME` environment variable.
   * Cannot be empty or whitespace-only.
   */
  readonly bucketName: string;

  /**
   * The object key prefix (subfolder) within the GCS bucket where assets are located.
   *
   * @remarks
   * Required parameter resolved from the `GCS_PREFIX` environment variable.
   * Leading and trailing forward slashes are stripped during normalization.
   * Cannot be empty, whitespace-only, or slash-only.
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
   * Normalizes a GCS object key prefix by trimming whitespace and leading/trailing forward slashes.
   *
   * @param rawPrefix - The raw prefix string from environment.
   * @returns Normalized prefix string.
   */
  normalizePrefix(rawPrefix: string): string;
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

  /**
   * Optional process exit handler for dependency injection and testing.
   *
   * @defaultValue `(code, msg) => { console.error(msg); process.exit(code); }`
   */
  readonly exitFn?: (code: number, message: string) => void;
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
 * Minimum valid TCP port number.
 */
export const MIN_PORT = 1;

/**
 * Maximum valid TCP port number.
 */
export const MAX_PORT = 65535;

/**
 * Decimal radix for parsing integer strings.
 */
export const RADIX_DECIMAL = 10;

/**
 * Standard fatal exit code on configuration validation failure.
 */
export const EXIT_CODE_ERROR = 1;
