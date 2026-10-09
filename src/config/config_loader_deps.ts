/**
 * Dependency resolution for configuration loading.
 *
 * @packageDocumentation
 */

import process from 'node:process';
import type { AppLogger } from '../logger/logger.ts';
import { type IConfigValidator, type EnvConfigLoaderOptions } from './config_types.ts';
import { DefaultConfigValidator } from './config_validator.ts';

/**
 * Default process exit handler that writes the error message to stderr and terminates the Node.js process.
 *
 * @param code - Process exit code.
 * @param msg - Error message string.
 */
export const defaultExitFn = (code: number, msg: string): void => {
  console.error(msg);
  process.exit(code);
};

/**
 * Fully resolved dependencies required by {@link EnvConfigLoader}.
 */
export interface ResolvedLoaderDeps {
  /**
   * Configuration validator instance.
   */
  readonly validator: IConfigValidator;

  /**
   * Optional application logger instance.
   */
  readonly logger?: AppLogger;

  /**
   * Process exit handler function.
   */
  readonly exitFn: (code: number, message: string) => void;
}

function isValidator(target: unknown): target is IConfigValidator {
  return target !== null && typeof target === 'object' && 'validatePort' in target;
}

function resolveValidator(options?: EnvConfigLoaderOptions): IConfigValidator {
  return options?.validator ?? new DefaultConfigValidator();
}

function resolveLogger(
  options?: EnvConfigLoaderOptions,
  fallback?: AppLogger,
): AppLogger | undefined {
  return options?.logger ?? fallback;
}

function getExitHandler(
  options?: EnvConfigLoaderOptions,
  fallback?: (code: number, msg: string) => void,
): ((code: number, msg: string) => void) | undefined {
  return options?.exitFn ?? fallback;
}

function resolveExitFn(
  options?: EnvConfigLoaderOptions,
  fallback?: (code: number, msg: string) => void,
): (code: number, message: string) => void {
  return getExitHandler(options, fallback) ?? defaultExitFn;
}

function resolveDepsFromOptions(
  options?: EnvConfigLoaderOptions,
  fallbackLogger?: AppLogger,
  fallbackExit?: (code: number, msg: string) => void,
): ResolvedLoaderDeps {
  const validator = resolveValidator(options);
  const logger = resolveLogger(options, fallbackLogger);
  const exitFn = resolveExitFn(options, fallbackExit);
  return { validator, logger, exitFn };
}

/**
 * Resolves dependencies from flexible constructor arguments.
 *
 * @param validatorOrOptions - Injected validator or options object.
 * @param logger - Optional fallback logger.
 * @param exitFn - Optional fallback exit handler.
 * @returns Fully resolved loader dependencies.
 */
export function resolveLoaderDeps(
  validatorOrOptions?: IConfigValidator | EnvConfigLoaderOptions,
  logger?: AppLogger,
  exitFn?: (code: number, msg: string) => void,
): ResolvedLoaderDeps {
  if (isValidator(validatorOrOptions)) {
    return { validator: validatorOrOptions, logger, exitFn: exitFn ?? defaultExitFn };
  }
  return resolveDepsFromOptions(validatorOrOptions, logger, exitFn);
}
