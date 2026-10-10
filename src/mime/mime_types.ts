/**
 * MIME types and cache policy definitions, constants, and interfaces.
 *
 * @packageDocumentation
 */

/**
 * Immutable lookup map associating lowercase file extensions to their corresponding
 * standard MIME content-type and character encoding strings.
 */
export const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.manifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
});

/**
 * Fallback MIME type returned when a file extension is not recognized or absent.
 */
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Set of HTML file extensions that are treated as SPA entry points / navigation routes rather than static assets.
 */
export const KNOWN_HTML_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm']);

/**
 * Set of recognized static asset extensions (all extensions in {@link MIME_TYPES} excluding HTML documents).
 */
export const KNOWN_STATIC_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(MIME_TYPES).filter((ext) => !KNOWN_HTML_EXTENSIONS.has(ext)),
);

/**
 * Set of all allowed file extensions defined in {@link MIME_TYPES}.
 */
export const ALLOWED_STATIC_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(MIME_TYPES));

/**
 * Cache-Control header directive for immutable, content-hashed static assets.
 *
 * @remarks
 * Instructs browsers and intermediary CDNs to cache the asset for up to 1 year (31,536,000 seconds)
 * without revalidation, as the content hash guarantees uniqueness across builds.
 */
export const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Cache-Control header directive for mutable resources (e.g. `index.html`, unhashed icons, service worker configs).
 *
 * @remarks
 * Instructs caches that the response may be cached, but must be revalidated with the origin server
 * via conditional requests (e.g., `If-None-Match` with ETags) before use.
 */
export const CACHE_CONTROL_NO_CACHE = 'public, max-age=0, must-revalidate';

/**
 * Regular expression matching Angular CLI / esbuild content-hashed asset filenames.
 *
 * @remarks
 * Angular and esbuild output fingerprinted asset bundles with a format such as:
 * - `main-5T7P2N6K.js`
 * - `chunk-b-4s_SpF.js`
 * - `styles-5INURTSO.css`
 * - `media/font-6G54T7R3.woff2`
 * - `main-5T7P2N6K.js.map`
 *
 * The pattern matches an 8-character hash segment following a hyphen (`-`), containing
 * alphanumeric, underscore, or hyphen characters (`[A-Za-z0-9_-]{8}`), requiring at least one
 * digit or uppercase letter (`(?=[^.]*[0-9A-Z])`), positioned immediately prior to a supported
 * web asset extension (with an optional trailing `.map` source map extension).
 */
export const HASHED_ASSET_REGEX =
  /-(?=[A-Za-z0-9_-]{8}\.(?:[a-z0-9]+\.)?[a-z0-9]+$)(?=[^.]*[0-9A-Z])[A-Za-z0-9_-]{8}\.(?:js|mjs|cjs|css|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|webp|avif|ico|wasm|pdf)(?:\.map)?$/;

/**
 * Contract for resolving MIME types from file paths (Interface Segregation Principle).
 */
export interface IMimeTypeResolver {
  /**
   * Resolves the MIME content-type string for a given file path based on its extension.
   *
   * @param filePath - The file path or filename to evaluate.
   * @returns The associated MIME content-type string.
   */
  getMimeType(filePath: string): string;
}

/**
 * Contract for classifying web assets and determining fingerprinting (Interface Segregation Principle).
 */
export interface IAssetClassifier {
  /**
   * Determines whether a request path targets a static asset file rather than an HTML document or SPA navigation route.
   *
   * @param filePath - The cleaned relative request path or filename.
   * @returns `true` if the path has a non-HTML file extension, `false` otherwise.
   */
  isStaticAsset(filePath: string): boolean;

  /**
   * Evaluates whether a static asset file is content-hashed (fingerprinted) and safe for long-term immutable caching.
   *
   * @param filePath - The file path or filename to inspect.
   * @returns `true` if the asset is fingerprinted and safe for immutable caching; `false` otherwise.
   */
  isHashedAsset(filePath: string): boolean;
}

/**
 * Contract for resolving HTTP cache control header policies (Interface Segregation Principle).
 */
export interface ICachePolicyResolver {
  /**
   * Computes the appropriate HTTP `Cache-Control` header value for a given file path.
   *
   * @param filePath - The file path or filename to determine cache policy for.
   * @param isHashed - Optional precomputed boolean indicating if the asset is hashed.
   * @returns The HTTP `Cache-Control` header string directive.
   */
  getCacheControlHeader(filePath: string, isHashed?: boolean): string;
}
