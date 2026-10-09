/**
 * Strips query parameters and hash fragments from a raw URL to prevent sensitive information from being logged.
 *
 * @packageDocumentation
 */

function extractBaseUrl(url: string): string {
  const parts = url.split(/[?#]/);
  return parts[0] ?? '';
}

/**
 * Strips query parameters and hash fragments from a raw URL to prevent sensitive query tokens or parameters from being logged.
 *
 * @param rawUrl - The raw URL string or undefined.
 * @returns Sanitized path portion of the URL without query string or hash fragment.
 */
export function sanitizeUrlForLogging(rawUrl: string | undefined): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return '';
  }
  return extractBaseUrl(rawUrl);
}
