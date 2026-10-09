/**
 * Configuration validator implementation.
 *
 * @packageDocumentation
 */

import { type IConfigValidator, MIN_PORT, MAX_PORT, RADIX_DECIMAL } from './config_types.ts';

function isValidPortNumber(port: number): boolean {
  return !Number.isNaN(port) && port >= MIN_PORT && port <= MAX_PORT;
}

function parsePortNumber(rawPort: string): number {
  const trimmed = rawPort.trim();
  return trimmed === '' ? Number.NaN : Number.parseInt(trimmed, RADIX_DECIMAL);
}

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
    if (rawPort === undefined) {
      return defaultPort;
    }
    const parsed = parsePortNumber(rawPort);
    return isValidPortNumber(parsed) ? parsed : defaultPort;
  }

  /**
   * Normalizes a string value.
   *
   * @param rawValue - The raw string.
   * @param defaultValue - Fallback string.
   * @returns Trimmed string or default.
   */
  public normalizeString(rawValue: string | undefined, defaultValue: string): string {
    if (rawValue === undefined) {
      return defaultValue;
    }
    const trimmed = rawValue.trim();
    return trimmed === '' ? defaultValue : trimmed;
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
