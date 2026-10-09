/**
 * Unix timestamp parser for deployment directories.
 *
 * @packageDocumentation
 */

import { RADIX_DECIMAL } from '../logger/logger_types.ts';

const TIMESTAMP_DIR_PATTERN = /^(\d+)_(.*)$/;

function parseSafeNonNegativeInt(raw: string): number | null {
  const parsed = Number.parseInt(raw, RADIX_DECIMAL);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Extracts a Unix timestamp from a deployment directory name following `<unixtime>_<SomeString>`.
 *
 * @param directoryName - First-level directory name under storage prefix.
 * @returns Parsed unix timestamp integer, or `null` if unparseable or invalid.
 */
export function parseTimestampFromDirectory(directoryName: string): number | null {
  const match = TIMESTAMP_DIR_PATTERN.exec(directoryName);
  if (!match) return null;
  return parseSafeNonNegativeInt(match[1]);
}
