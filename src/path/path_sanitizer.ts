/**
 * Defense-in-depth path sanitizer enforcing URI validation rules.
 *
 * @packageDocumentation
 */

import { posix } from 'node:path';
import { HTTP_STATUS_BAD_REQUEST } from '../http/http_status_codes.ts';
import type { AppLogger, DecisionLogPayload } from '../logger/logger_types.ts';
import {
  checkDecodedPath,
  checkNormalizedSecurity,
  checkRawPathSecurity,
  stripSchemeAndHost,
} from './path_security_checks.ts';
import type { IPathSanitizer, PathValidationResult } from '../router/router_types.ts';
import { sanitizeUrlForLogging } from '../url_logger_sanitizer.ts';

function makeRejectPayload(safeUrl: string, error: string): DecisionLogPayload {
  const meta = { level: 'debug' as const, path: safeUrl, statusCode: HTTP_STATUS_BAD_REQUEST };
  return { action: 'PathSanitizer', choice: 'reject request (400)', reason: error, ...meta };
}

function makeAcceptPayload(normalized: string): DecisionLogPayload {
  const reason = 'Path passed all security and traversal validation checks';
  return {
    action: 'PathSanitizer',
    choice: `normalize path to '${normalized}'`,
    reason,
    level: 'debug',
    path: normalized,
  };
}

function normalizePath(decoded: string): string {
  const prefix = decoded.startsWith('/') ? decoded : `/${decoded}`;
  return posix.normalize(prefix);
}

function decodeUrl(rawPath: string): string | undefined {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
}

function runDecodedValidation(decoded: string): string | { normalized: string } {
  const err = checkDecodedPath(decoded);
  if (err) return err;
  const normalized = normalizePath(decoded);
  const normErr = checkNormalizedSecurity(normalized);
  return normErr ?? { normalized };
}

function isNonEmptyUrl(url: string | undefined): url is string {
  if (typeof url !== 'string') return false;
  return url.trim() !== '';
}

function extractRawPath(rawUrl: string): string {
  const parts = rawUrl.split(/[?#]/);
  return stripSchemeAndHost(parts[0]);
}

function runValidationPipeline(rawUrl: string): string | { normalized: string } {
  const rawPath = extractRawPath(rawUrl);
  const rawErr = checkRawPathSecurity(rawPath);
  if (rawErr) return rawErr;
  const decoded = decodeUrl(rawPath);
  if (decoded === undefined) return 'Malformed percent-encoded URL';
  return runDecodedValidation(decoded);
}

/**
 * Defense-in-depth URL path sanitizer protecting against directory traversal attacks.
 *
 * Implements a strict multi-layered security validation pipeline:
 * 1. Missing / non-string / empty URL rejection.
 * 2. URL decomposition: strips query parameters (`?`) and hash fragments (`#`).
 * 3. Raw null byte rejection (`\0`).
 * 4. Raw backslash rejection (`\`).
 * 5. Raw encoded null byte rejection (`%00`, `%0`).
 * 6. Raw encoded separator rejection (`%2f`, `%2F`, `%5c`, `%5C`).
 * 7. Double-encoded traversal sequence rejection (e.g. `%252e`, `%255c`, `%252f`).
 * 8. Traversal token sequence rejection (e.g. `../`, `/..`, `..`).
 * 9. Safe URI decoding with malformed percent-encoding trap.
 * 10. Decoded null byte and control character inspection.
 * 11. POSIX path normalization and root-escape verification.
 * 12. Allowed static file extension validation across all single-level and nested paths.
 */
export class DefenseInDepthPathSanitizer implements IPathSanitizer {
  private readonly logger?: AppLogger;

  /**
   * Creates a new `DefenseInDepthPathSanitizer`.
   *
   * @param logger - Optional injected application logger for recording validation decisions.
   */
  public constructor(logger?: AppLogger) {
    this.logger = logger;
  }

  private reject(safeUrl: string, error: string): PathValidationResult {
    if (this.logger) this.logger.decision(makeRejectPayload(safeUrl, error));
    return { valid: false, path: '', error };
  }

  private accept(normalized: string): PathValidationResult {
    if (this.logger) this.logger.decision(makeAcceptPayload(normalized));
    return { valid: true, path: normalized };
  }

  /**
   * Validates and sanitizes a raw request URL through the multi-layer security pipeline.
   *
   * @param rawUrl - The incoming raw URL string from `req.url` (or `undefined`).
   * @returns A {@link PathValidationResult} indicating whether the path is valid and safe.
   */
  public validateAndSanitize(rawUrl: string | undefined): PathValidationResult {
    const safeUrl = sanitizeUrlForLogging(rawUrl);
    if (!isNonEmptyUrl(rawUrl)) {
      return this.reject(safeUrl, 'Missing or empty request URL');
    }
    const res = runValidationPipeline(rawUrl);
    if (typeof res === 'string') return this.reject(safeUrl, res);
    return this.accept(res.normalized);
  }
}

/**
 * Default singleton instance of the defense-in-depth path sanitizer.
 */
export const defaultPathSanitizer = new DefenseInDepthPathSanitizer();

/**
 * Validates and sanitizes a raw request URL against directory traversal attacks.
 *
 * @remarks
 * Applies the complete multi-layer defense-in-depth sanitization pipeline.
 *
 * @param rawUrl - The raw request URL string from `req.url`.
 * @returns A {@link PathValidationResult} containing the sanitization outcome.
 *
 * @example
 * ```ts
 * validateAndSanitizePath('/main.css');      // { valid: true, path: '/main.css' }
 * validateAndSanitizePath('/../etc/passwd'); // { valid: false, path: '', error: '...' }
 * ```
 */
export function validateAndSanitizePath(rawUrl: string | undefined): PathValidationResult {
  return defaultPathSanitizer.validateAndSanitize(rawUrl);
}
