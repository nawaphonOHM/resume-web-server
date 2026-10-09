/**
 * Stack trace limit configuration for un-truncated diagnostic traces.
 *
 * @packageDocumentation
 */

import process from 'node:process';
import { RADIX_DECIMAL } from '../logger/logger_types.ts';

function isValidTraceLimit(val: number): boolean {
  return !Number.isNaN(val) && val >= 0;
}

function parseTraceLimit(envLimit: string | undefined): number | undefined {
  if (envLimit === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(envLimit, RADIX_DECIMAL);
  return isValidTraceLimit(parsed) ? parsed : undefined;
}

/**
 * Configures V8's stack trace frame limit to ensure complete, un-truncated call stacks.
 *
 * @remarks
 * By default, V8 / Node.js limits captured stack trace depth to 10 frames (`Error.stackTraceLimit = 10`),
 * which truncates deep diagnostic call stacks in complex asynchronous pipelines.
 * Setting this property globally to `Infinity` (or a positive integer from `process.env.STACK_TRACE_LIMIT`)
 * satisfies the architectural requirement for full diagnostic call stacks.
 */
export function configureStackTraceLimit(): void {
  const parsed = parseTraceLimit(process.env['STACK_TRACE_LIMIT']);
  Error.stackTraceLimit = parsed ?? Number.POSITIVE_INFINITY;
}

// Initialize stack trace limit at module load time to guarantee un-truncated stack traces across all application components
configureStackTraceLimit();
