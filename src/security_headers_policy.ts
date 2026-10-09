/**
 * Security headers application policy.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import { SECURITY_HEADERS, type ISecurityHeadersPolicy } from './router/router_types.ts';

/**
 * Applies standard HTTP security headers to all outgoing responses.
 */
export class StandardSecurityHeadersPolicy implements ISecurityHeadersPolicy {
  /**
   * Security headers dictionary.
   */
  private readonly headers: Readonly<Record<string, string>>;

  /**
   * Creates a new `StandardSecurityHeadersPolicy`.
   *
   * @param headers - Optional custom security headers map. Defaults to {@link SECURITY_HEADERS}.
   */
  public constructor(headers: Readonly<Record<string, string>> = SECURITY_HEADERS) {
    this.headers = headers;
  }

  /**
   * Applies configured security headers to the given response.
   *
   * @param res - The outgoing HTTP server response.
   */
  public applyHeaders(res: ServerResponse): void {
    for (const [header, value] of Object.entries(this.headers)) {
      res.setHeader(header, value);
    }
  }

  /**
   * Returns a copy of the active security headers dictionary.
   */
  public getHeaders(): Readonly<Record<string, string>> {
    return this.headers;
  }
}
