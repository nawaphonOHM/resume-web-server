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

export type {
  ServerConfig,
  IConfigValidator,
  IConfigLoader,
  EnvConfigLoaderOptions,
} from './config_types.ts';

export { DEFAULT_PORT, DEFAULT_HOST, MIN_PORT, MAX_PORT } from './config_types.ts';

export { DefaultConfigValidator } from './config_validator.ts';
export { EnvConfigLoader, loadConfig } from './config_loader.ts';
export { config } from './config_proxy.ts';
