/**
 * Server Configuration Module.
 *
 * Provides environment variable parsing, default configuration values,
 * network port range validation, object storage prefix normalization,
 * and mandatory environment variable enforcement for the web server application
 * following SOLID principles.
 *
 * @remarks
 * Configuration values are resolved from environment variables (`PORT`, `HOST`,
 * `GCS_BUCKET_NAME`, `GCS_PREFIX`). `PORT` and `HOST` fall back to sensible defaults
 * (`8080` and `'0.0.0.0'`), while `GCS_BUCKET_NAME` and `GCS_PREFIX` are required.
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
 * Default TCP port number used when the `PORT` environment variable is omitted or invalid.
 */
export const DEFAULT_PORT = 8080;

/**
 * Default network host interface used when `HOST` is omitted or empty.
 */
export const DEFAULT_HOST = '0.0.0.0';

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
   * Normalizes a GCS storage prefix by trimming whitespace and leading/trailing forward slashes.
   *
   * @param rawPrefix - The raw prefix string.
   * @returns Normalized prefix.
   */
  public normalizePrefix(rawPrefix: string): string {
    return rawPrefix.trim().replace(/^\/+|\/+$/g, '');
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

  /**
   * Optional process exit handler for dependency injection and testing.
   *
   * @defaultValue `(code, msg) => { console.error(msg); process.exit(code); }`
   */
  readonly exitFn?: (code: number, message: string) => void;
}

/**
 * Default process exit handler that writes the error message to stderr and terminates the Node.js process.
 */
const defaultExitFn = (code: number, message: string): void => {
  console.error(message);
  process.exit(code);
};

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
   * Process exit handler.
   */
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
    if (validatorOrOptions && 'validatePort' in validatorOrOptions) {
      this.validator = validatorOrOptions;
      this.logger = logger;
      this.exitFn = exitFn ?? defaultExitFn;
    } else {
      this.validator = validatorOrOptions?.validator ?? new DefaultConfigValidator();
      this.logger = validatorOrOptions?.logger ?? logger;
      this.exitFn = validatorOrOptions?.exitFn ?? exitFn ?? defaultExitFn;
    }
  }

  /**
   * Loads and validates configuration from the given environment record.
   *
   * @param env - Environment variable map. Defaults to `process.env`.
   * @returns The resolved {@link ServerConfig}.
   */
  public load(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const rawBucket = env['GCS_BUCKET_NAME'];
    const bucketName = this.validator.normalizeString(rawBucket, '');

    const rawPrefix = env['GCS_PREFIX'];
    const prefix = rawPrefix !== undefined ? this.validator.normalizePrefix(rawPrefix) : '';

    const missingVars: string[] = [];
    if (bucketName === '') {
      missingVars.push('GCS_BUCKET_NAME');
    }
    if (prefix === '') {
      missingVars.push('GCS_PREFIX');
    }

    if (missingVars.length > 0) {
      const errorMessage = `Missing required environment variable(s): ${missingVars.join(', ')}. Please set ${missingVars.join(' and ')} before running the server.`;
      if (this.logger) {
        this.logger.error(errorMessage);
      }
      this.exitFn(1, errorMessage);
      throw new Error(errorMessage);
    }

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

    if (this.logger) {
      this.logger.decision({
        action: 'Config',
        choice: `bucketName: '${bucketName}'`,
        reason: 'Resolved from GCS_BUCKET_NAME environment variable',
        level: 'debug',
        variable: 'GCS_BUCKET_NAME',
        resolved: bucketName,
      });
    }

    if (this.logger) {
      this.logger.decision({
        action: 'Config',
        choice: `prefix: '${prefix}'`,
        reason: 'Resolved from GCS_PREFIX environment variable and normalized',
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
 * Type guard to determine if a value is an {@link AppLogger}.
 */
function isAppLogger(
  loggerOrOptions: AppLogger | EnvConfigLoaderOptions,
): loggerOrOptions is AppLogger {
  return 'info' in loggerOrOptions && typeof loggerOrOptions.info === 'function';
}

/**
 * Loads and validates the server configuration from the provided environment map.
 *
 * @remarks
 * Performs sanitization and validation on environment variables:
 * - `PORT`: Trimmed and parsed as a base-10 integer. Must be between 1 and 65535 (inclusive);
 *   otherwise falls back to {@link DEFAULT_PORT}.
 * - `HOST`: Trimmed string; falls back to {@link DEFAULT_HOST} if empty or unset.
 * - `GCS_BUCKET_NAME`: Required non-empty string; missing or whitespace-only values cause exit code 1.
 * - `GCS_PREFIX`: Required non-empty string normalized by removing leading and trailing slashes (`/`);
 *   missing, whitespace-only, or slash-only values cause exit code 1.
 *
 * @param env - Environment variable key-value map. Defaults to `process.env`.
 * @param loggerOrOptions - Optional {@link AppLogger} or {@link EnvConfigLoaderOptions}.
 * @param options - Optional {@link EnvConfigLoaderOptions} when logger is supplied as second argument.
 * @returns The validated and normalized {@link ServerConfig} object.
 *
 * @example
 * ```ts
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
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  loggerOrOptions?: AppLogger | EnvConfigLoaderOptions,
  options?: EnvConfigLoaderOptions,
): ServerConfig {
  let loaderOptions: EnvConfigLoaderOptions = {};
  if (loggerOrOptions) {
    if (isAppLogger(loggerOrOptions)) {
      loaderOptions = { logger: loggerOrOptions, ...options };
    } else {
      loaderOptions = loggerOrOptions;
    }
  } else if (options) {
    loaderOptions = options;
  }
  return new EnvConfigLoader(loaderOptions).load(env);
}

/**
 * Mutable backing target object for the lazily-initialized default {@link ServerConfig} singleton.
 */
const targetConfig: ServerConfig = {} as ServerConfig;
let isConfigInitialized = false;

/**
 * Node.js custom inspection symbol for formatted debugging output.
 */
const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

/**
 * Ensures that the backing configuration target is initialized with a snapshot from `process.env`.
 */
function ensureConfigInitialized(): ServerConfig {
  if (!isConfigInitialized) {
    const loaded = loadConfig(process.env);
    Object.assign(targetConfig, loaded);
    isConfigInitialized = true;
  }
  return targetConfig;
}

Object.defineProperty(targetConfig, customInspectSymbol, {
  value: function (): Record<string, unknown> {
    ensureConfigInitialized();
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(targetConfig)) {
      result[key] = (targetConfig as unknown as Record<string, unknown>)[key];
    }
    return result;
  },
  enumerable: false,
  configurable: true,
  writable: true,
});

/**
 * Default singleton server configuration loaded lazily from the runtime `process.env`.
 *
 * @remarks
 * Uses a reflective Proxy backed by a mutable target object that is populated on first access.
 * This preserves standard JavaScript object invariants (`Object.freeze`, `Object.keys`, `util.inspect`,
 * property descriptors, setters, deleters, etc.) while deferring configuration loading and validation
 * until actual property access.
 */
export const config: ServerConfig = new Proxy(targetConfig, {
  get(target, prop, receiver) {
    ensureConfigInitialized();
    return Reflect.get(target, prop, receiver) as unknown;
  },
  set(target, prop, value, receiver) {
    ensureConfigInitialized();
    return Reflect.set(target, prop, value, receiver);
  },
  has(target, prop) {
    ensureConfigInitialized();
    return Reflect.has(target, prop);
  },
  deleteProperty(target, prop) {
    ensureConfigInitialized();
    return Reflect.deleteProperty(target, prop);
  },
  ownKeys(target) {
    ensureConfigInitialized();
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, prop) {
    ensureConfigInitialized();
    return Reflect.getOwnPropertyDescriptor(target, prop);
  },
  defineProperty(target, prop, attributes) {
    ensureConfigInitialized();
    return Reflect.defineProperty(target, prop, attributes);
  },
  preventExtensions(target) {
    ensureConfigInitialized();
    return Reflect.preventExtensions(target);
  },
  isExtensible(target) {
    ensureConfigInitialized();
    return Reflect.isExtensible(target);
  },
  getPrototypeOf(target) {
    ensureConfigInitialized();
    return Reflect.getPrototypeOf(target);
  },
  setPrototypeOf(target, proto) {
    ensureConfigInitialized();
    return Reflect.setPrototypeOf(target, proto);
  },
});
