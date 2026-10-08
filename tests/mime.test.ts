import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMimeType,
  isStaticAsset,
  isHashedAsset,
  getCacheControlHeader,
  CACHE_CONTROL_IMMUTABLE,
  CACHE_CONTROL_NO_CACHE,
  DEFAULT_MIME_TYPE,
  DefaultMimeTypeResolver,
  DefaultAssetClassifier,
  DefaultCachePolicyResolver,
  type IAssetClassifier,
} from '../src/mime.ts';
import type { AppLogger, DecisionLogPayload } from '../src/logger.ts';

/**
 * Creates a mock {@link AppLogger} that captures emitted decisions and log messages.
 */
function createCapturingLogger(): {
  logger: AppLogger;
  decisions: DecisionLogPayload[];
} {
  const decisions: DecisionLogPayload[] = [];
  const capturingLogger: AppLogger = {
    info: () => {
      /* noop */
    },
    warn: () => {
      /* noop */
    },
    error: () => {
      /* noop */
    },
    http: () => {
      /* noop */
    },
    debug: () => {
      /* noop */
    },
    decision: (payload: DecisionLogPayload) => {
      decisions.push(payload);
    },
  };

  return { logger: capturingLogger, decisions };
}

/**
 * Test suite for MIME type detection and HTTP cache header generation utilities.
 *
 * @remarks
 * Validates:
 * - Content-Type mapping for standard web assets, image formats, font types, and text files.
 * - Fallback behavior for unknown or missing file extensions.
 * - Differentiation between static asset requests and client-side SPA navigation routes.
 * - Regular expression matching for hashed Angular / esbuild output chunks and exclusion of mutable files.
 * - HTTP Cache-Control header assignment (`public, max-age=31536000, immutable` vs `public, max-age=0, must-revalidate`).
 * - SOLID components: {@link DefaultMimeTypeResolver}, {@link DefaultAssetClassifier}, and {@link DefaultCachePolicyResolver}.
 */
void describe('MIME & Cache Utilities', () => {
  /**
   * Unit tests for {@link getMimeType}.
   *
   * @remarks
   * Tests extension-to-MIME resolution across standard web file types, case-insensitivity,
   * charset appending, and default fallback handling.
   */
  void describe('getMimeType', () => {
    void it('should resolve standard web asset MIME types', () => {
      assert.equal(getMimeType('index.html'), 'text/html; charset=utf-8');
      assert.equal(getMimeType('app.htm'), 'text/html; charset=utf-8');
      assert.equal(getMimeType('main.js'), 'application/javascript; charset=utf-8');
      assert.equal(getMimeType('bundle.mjs'), 'application/javascript; charset=utf-8');
      assert.equal(getMimeType('styles.css'), 'text/css; charset=utf-8');
      assert.equal(getMimeType('data.json'), 'application/json; charset=utf-8');
      assert.equal(getMimeType('main.js.map'), 'application/json; charset=utf-8');
      assert.equal(getMimeType('manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
    });

    void it('should resolve image MIME types', () => {
      assert.equal(getMimeType('favicon.ico'), 'image/x-icon');
      assert.equal(getMimeType('logo.svg'), 'image/svg+xml');
      assert.equal(getMimeType('photo.png'), 'image/png');
      assert.equal(getMimeType('photo.jpg'), 'image/jpeg');
      assert.equal(getMimeType('photo.jpeg'), 'image/jpeg');
      assert.equal(getMimeType('image.webp'), 'image/webp');
      assert.equal(getMimeType('image.avif'), 'image/avif');
      assert.equal(getMimeType('graphic.gif'), 'image/gif');
    });

    void it('should resolve font and other asset MIME types', () => {
      assert.equal(getMimeType('font.woff'), 'font/woff');
      assert.equal(getMimeType('font.woff2'), 'font/woff2');
      assert.equal(getMimeType('font.ttf'), 'font/ttf');
      assert.equal(getMimeType('font.otf'), 'font/otf');
      assert.equal(getMimeType('font.eot'), 'application/vnd.ms-fontobject');
      assert.equal(getMimeType('robots.txt'), 'text/plain; charset=utf-8');
      assert.equal(getMimeType('sitemap.xml'), 'application/xml; charset=utf-8');
      assert.equal(getMimeType('module.wasm'), 'application/wasm');
    });

    void it('should handle uppercase file extensions', () => {
      assert.equal(getMimeType('MAIN.JS'), 'application/javascript; charset=utf-8');
      assert.equal(getMimeType('IMAGE.PNG'), 'image/png');
      assert.equal(getMimeType('STYLES.CSS'), 'text/css; charset=utf-8');
    });

    void it('should return default fallback for unknown file extensions', () => {
      assert.equal(getMimeType('archive.zip'), DEFAULT_MIME_TYPE);
      assert.equal(getMimeType('binary.dat'), DEFAULT_MIME_TYPE);
      assert.equal(getMimeType('noextension'), DEFAULT_MIME_TYPE);
    });

    void it('should support custom resolver instances with injected lookup maps', () => {
      const customResolver = new DefaultMimeTypeResolver(
        { '.custom': 'text/custom' },
        'text/unknown',
      );
      assert.equal(customResolver.getMimeType('file.custom'), 'text/custom');
      assert.equal(customResolver.getMimeType('file.other'), 'text/unknown');
    });
  });

  /**
   * Unit tests for {@link isStaticAsset}.
   *
   * @remarks
   * Tests classification of paths having recognized static extensions vs HTML files
   * and extensionless SPA routing paths.
   */
  void describe('isStaticAsset', () => {
    void it('should return true for paths with static asset extensions', () => {
      assert.equal(isStaticAsset('/main.js'), true);
      assert.equal(isStaticAsset('/styles.css'), true);
      assert.equal(isStaticAsset('/favicon.ico'), true);
      assert.equal(isStaticAsset('/assets/icons/logo.svg'), true);
      assert.equal(isStaticAsset('/manifest.webmanifest'), true);
      assert.equal(isStaticAsset('/robots.txt'), true);
    });

    void it('should return false for SPA navigation routes without extensions', () => {
      assert.equal(isStaticAsset('/'), false);
      assert.equal(isStaticAsset('/experience'), false);
      assert.equal(isStaticAsset('/skills/frontend'), false);
      assert.equal(isStaticAsset(''), false);
    });

    void it('should return false for html files (handled via SPA flow)', () => {
      assert.equal(isStaticAsset('/index.html'), false);
      assert.equal(isStaticAsset('/index.htm'), false);
    });
  });

  /**
   * Unit tests for {@link isHashedAsset}.
   *
   * @remarks
   * Tests regex pattern matching against content-addressed file names produced by
   * Angular CLI and esbuild, as well as exclusions for mutable static files.
   */
  void describe('isHashedAsset', () => {
    void it('should identify hashed Angular asset bundles', () => {
      assert.equal(isHashedAsset('main-5T7P2N6K.js'), true);
      assert.equal(isHashedAsset('/dist/main-5T7P2N6K.js'), true);
      assert.equal(isHashedAsset('polyfills-FFR24OXZ.js'), true);
      assert.equal(isHashedAsset('chunk-6XJ6P424.js'), true);
      assert.equal(isHashedAsset('chunk-b-4s_SpF.js'), true);
      assert.equal(isHashedAsset('styles-5INURTSO.css'), true);
      assert.equal(isHashedAsset('main-5T7P2N6K.js.map'), true);
      assert.equal(isHashedAsset('styles-5INURTSO.css.map'), true);
      assert.equal(isHashedAsset('media/roboto-latin-400-6G54T7R3.woff2'), true);
    });

    void it('should return false for unhashed files and icons', () => {
      assert.equal(isHashedAsset('index.html'), false);
      assert.equal(isHashedAsset('/index.html'), false);
      assert.equal(isHashedAsset('main.js'), false);
      assert.equal(isHashedAsset('styles.css'), false);
      assert.equal(isHashedAsset('favicon.ico'), false);
      assert.equal(isHashedAsset('favicon-16x16.png'), false);
      assert.equal(isHashedAsset('favicon-32x32.png'), false);
      assert.equal(isHashedAsset('apple-touch-icon.png'), false);
      assert.equal(isHashedAsset('apple-touch-icon-180x180.png'), false);
      assert.equal(isHashedAsset('android-chrome-192x192.png'), false);
      assert.equal(isHashedAsset('android-chrome-512x512.png'), false);
      assert.equal(isHashedAsset('safari-pinned-tab.svg'), false);
      assert.equal(isHashedAsset('mstile-150x150.png'), false);
      assert.equal(isHashedAsset('browserconfig.xml'), false);
      assert.equal(isHashedAsset('site.webmanifest'), false);
      assert.equal(isHashedAsset('ngsw.json'), false);
      assert.equal(isHashedAsset('robots.txt'), false);
    });
  });

  /**
   * Unit tests for {@link getCacheControlHeader}.
   *
   * @remarks
   * Tests dynamic computation of HTTP `Cache-Control` header directives based on
   * file path and content-hash determination.
   */
  void describe('getCacheControlHeader', () => {
    void it('should return immutable cache header for hashed assets', () => {
      assert.equal(getCacheControlHeader('main-5T7P2N6K.js'), CACHE_CONTROL_IMMUTABLE);
      assert.equal(getCacheControlHeader('styles-5INURTSO.css'), CACHE_CONTROL_IMMUTABLE);
      assert.equal(getCacheControlHeader('unhashed.js', true), CACHE_CONTROL_IMMUTABLE);
    });

    void it('should return no-cache / revalidate header for unhashed assets and index.html', () => {
      assert.equal(getCacheControlHeader('index.html'), CACHE_CONTROL_NO_CACHE);
      assert.equal(getCacheControlHeader('/index.html'), CACHE_CONTROL_NO_CACHE);
      assert.equal(getCacheControlHeader('main.js'), CACHE_CONTROL_NO_CACHE);
      assert.equal(getCacheControlHeader('favicon.ico'), CACHE_CONTROL_NO_CACHE);
      assert.equal(getCacheControlHeader('hashed-12345678.js', false), CACHE_CONTROL_NO_CACHE);
    });

    void it('should support custom classifier injection in DefaultCachePolicyResolver', () => {
      const classifier = new DefaultAssetClassifier();
      assert.equal(classifier.isStaticAsset('main.js'), true);
      assert.equal(classifier.isHashedAsset('main-5T7P2N6K.js'), true);

      const mockClassifier: IAssetClassifier = {
        isStaticAsset: () => true,
        isHashedAsset: (path) => path.includes('custom-hashed'),
      };
      const policyResolver = new DefaultCachePolicyResolver(mockClassifier);
      assert.equal(
        policyResolver.getCacheControlHeader('custom-hashed.js'),
        CACHE_CONTROL_IMMUTABLE,
      );
      assert.equal(policyResolver.getCacheControlHeader('regular.js'), CACHE_CONTROL_NO_CACHE);
    });
  });

  /**
   * Unit tests for decision and reason logging in MIME and caching components.
   */
  void describe('Decision and Reason Logging', () => {
    void it('should log decisions in DefaultMimeTypeResolver for known and fallback types', () => {
      const { logger, decisions } = createCapturingLogger();
      const resolver = new DefaultMimeTypeResolver(undefined, undefined, logger);

      const cssMime = resolver.getMimeType('styles.css');
      assert.equal(cssMime, 'text/css; charset=utf-8');
      assert.equal(decisions.length, 1);
      assert.deepEqual(decisions[0], {
        action: 'MimeResolver',
        choice: "MIME type 'text/css; charset=utf-8'",
        reason: "Extension '.css' mapped from known MIME table",
        level: 'debug',
        filePath: 'styles.css',
        extension: '.css',
        mimeType: 'text/css; charset=utf-8',
      });

      const fallbackMime = resolver.getMimeType('unknown.xyz');
      assert.equal(fallbackMime, DEFAULT_MIME_TYPE);
      assert.equal(decisions.length, 2);
      assert.deepEqual(decisions[1], {
        action: 'MimeResolver',
        choice: "MIME type 'application/octet-stream'",
        reason:
          "Extension '.xyz' unrecognized or absent, falling back to 'application/octet-stream'",
        level: 'debug',
        filePath: 'unknown.xyz',
        extension: '.xyz',
        mimeType: 'application/octet-stream',
      });
    });

    void it('should log decisions in DefaultAssetClassifier for static vs SPA and hashed vs unhashed assets', () => {
      const { logger, decisions } = createCapturingLogger();
      const classifier = new DefaultAssetClassifier(logger);

      const isStatic = classifier.isStaticAsset('main.js');
      assert.equal(isStatic, true);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.action, 'AssetClassifier');
      assert.equal(decisions[0]?.choice, 'static asset');
      assert.equal(decisions[0]?.reason, "Path has non-HTML extension '.js'");
      assert.equal(decisions[0]?.level, 'debug');

      const isSpa = classifier.isStaticAsset('/profile');
      assert.equal(isSpa, false);
      assert.equal(decisions.length, 2);
      assert.equal(decisions[1]?.action, 'AssetClassifier');
      assert.equal(decisions[1]?.choice, 'SPA navigation route / HTML');
      assert.equal(decisions[1]?.reason, 'Path is extensionless');
      assert.equal(decisions[1]?.level, 'debug');

      const isHashed = classifier.isHashedAsset('main-5T7P2N6K.js');
      assert.equal(isHashed, true);
      assert.equal(decisions.length, 3);
      assert.equal(decisions[2]?.action, 'AssetClassifier');
      assert.equal(decisions[2]?.choice, 'content-hashed asset');
      assert.equal(
        decisions[2]?.reason,
        "Asset 'main-5T7P2N6K.js' matched content-hash regex pattern",
      );
      assert.equal(decisions[2]?.level, 'debug');

      const isMutable = classifier.isHashedAsset('favicon.ico');
      assert.equal(isMutable, false);
      assert.equal(decisions.length, 4);
      assert.equal(decisions[3]?.action, 'AssetClassifier');
      assert.equal(decisions[3]?.choice, 'mutable asset (unhashed)');
      assert.equal(
        decisions[3]?.reason,
        "Asset 'favicon.ico' is a well-known mutable/root configuration file",
      );
      assert.equal(decisions[3]?.level, 'debug');
    });

    void it('should log decisions in DefaultCachePolicyResolver for immutable vs revalidate caching', () => {
      const { logger, decisions } = createCapturingLogger();
      const policyResolver = new DefaultCachePolicyResolver(undefined, logger);

      const immutableHeader = policyResolver.getCacheControlHeader('main-5T7P2N6K.js');
      assert.equal(immutableHeader, CACHE_CONTROL_IMMUTABLE);
      assert.equal(decisions.length, 1);
      assert.deepEqual(decisions[0], {
        action: 'CachePolicy',
        choice: 'immutable (31536000s)',
        reason: "Asset 'main-5T7P2N6K.js' matched content-hashed filename pattern",
        level: 'debug',
        filePath: 'main-5T7P2N6K.js',
        isHashed: true,
        cacheControl: CACHE_CONTROL_IMMUTABLE,
      });

      const noCacheHeader = policyResolver.getCacheControlHeader('index.html');
      assert.equal(noCacheHeader, CACHE_CONTROL_NO_CACHE);
      assert.equal(decisions.length, 2);
      assert.deepEqual(decisions[1], {
        action: 'CachePolicy',
        choice: 'no-cache (must-revalidate)',
        reason: "Asset 'index.html' is unhashed or mutable and requires origin revalidation",
        level: 'debug',
        filePath: 'index.html',
        isHashed: false,
        cacheControl: CACHE_CONTROL_NO_CACHE,
      });
    });
  });
});
