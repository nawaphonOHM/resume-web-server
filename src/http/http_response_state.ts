/**
 * HTTP response writability state evaluation.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';

/**
 * Checks whether an HTTP server response is in a writable state and has not yet completed.
 *
 * @param res - The outgoing HTTP server response.
 * @returns `true` if headers have not been sent, the response is not destroyed, and writable has not ended; otherwise `false`.
 */
export function isResponseWritable(res: ServerResponse): boolean {
  return !res.headersSent && !res.destroyed && !res.writableEnded;
}
