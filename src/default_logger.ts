/**
 * Default application logger singleton.
 *
 * @packageDocumentation
 */

import { createAppLogger } from './app_logger.ts';
import type { AppLogger } from './logger/logger_types.ts';

/**
 * Default application logger singleton.
 */
export const defaultLogger: AppLogger = createAppLogger();
