import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import type { Storage, Bucket, File } from '@google-cloud/storage';
import {
  Router,
  createRouter,
  validateAndSanitizePath,
  sanitizeUrlForLogging,
  SECURITY_HEADERS,
  DefenseInDepthPathSanitizer,
  StandardSecurityHeadersPolicy,
  StandardHttpMethodValidator,
  SystemHealthStatusProvider,
  DefaultHealthCheckHandler,
  type HealthPayload,
} from '../src/router/router.ts';
import { GcsStorageService, type StorageService } from '../src/storage/storage.ts';
import type { ServerConfig } from '../src/config/config.ts';
import { createAppLogger, type AppLogger, type DecisionLogPayload } from '../src/logger/logger.ts';
import winston from 'winston';

const silentLogger = createAppLogger({ silent: true });

/**
 * Custom memory writable stream to capture formatted log output in router tests.
 */
class MemoryLogStream extends Writable {
  readonly lines: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.lines.push(chunk.toString());
    callback();
  }

  get output(): string {
    return this.lines.join('');
  }

  clear(): void {
    this.lines.length = 0;
  }
}

interface CapturedLog {
  level: string;
  message: string | Error;
  meta: unknown[];
}

/**
 * Creates a mock {@link AppLogger} that captures emitted decisions and log messages.
 */
function createCapturingLogger(): {
  logger: AppLogger;
  decisions: DecisionLogPayload[];
  logs: CapturedLog[];
} {
  const decisions: DecisionLogPayload[] = [];
  const logs: CapturedLog[] = [];

  const capturingLogger: AppLogger = {
    info: (msg, ...meta) => logs.push({ level: 'info', message: msg, meta }),
    warn: (msg, ...meta) => logs.push({ level: 'warn', message: msg, meta }),
    error: (msg, ...meta) => logs.push({ level: 'error', message: msg, meta }),
    http: (msg, ...meta) => logs.push({ level: 'http', message: msg, meta }),
    debug: (msg, ...meta) => logs.push({ level: 'debug', message: msg, meta }),
    decision: (payload: DecisionLogPayload) => {
      decisions.push(payload);
    },
  };

  return { logger: capturingLogger, decisions, logs };
}

/**
 * Configuration options for creating a mock Google Cloud Storage {@link File} object for router tests.
 */
interface MockFileOptions {
  /**
   * String content payload to return when the file's read stream is consumed.
   *
   * @defaultValue `'sample content'`
   */
  content?: string;

  /**
   * Whether the file exists in the simulated storage bucket.
   *
   * @defaultValue `true`
   */
  exists?: boolean;

  /**
   * Metadata attributes returned by {@link File.getMetadata} and emitted on the read stream's `response` event.
   */
  metadata?: { size?: number; etag?: string; contentEncoding?: string };

  /**
   * Error to emit from the read stream upon consumption.
   */
  errorOnStream?: Error;

  /**
   * Error to reject with when {@link File.getMetadata} is called.
   */
  errorOnMetadata?: Error;
}

/**
 * Factory function creating a mocked `@google-cloud/storage` {@link File} instance with automatic `response` event emission.
 *
 * @param options - Configuration options for stream payload, headers, metadata, and error conditions.
 * @returns A mocked {@link File} instance.
 */
function createMockFile(options: MockFileOptions, name = ''): File {
  const content = options.content ?? 'sample content';
  const metadata = {
    size: options.metadata?.size ?? Buffer.byteLength(content),
    etag: options.metadata?.etag ?? '"etag-123"',
    contentEncoding: options.metadata?.contentEncoding,
  };

  return {
    name,
    exists: () => Promise.resolve([options.exists ?? true]),
    getMetadata: () => {
      if (options.errorOnMetadata) {
        return Promise.reject(options.errorOnMetadata);
      }
      return Promise.resolve([metadata]);
    },
    createReadStream: () => {
      if (options.errorOnStream) {
        const stream = new Readable({
          read() {
            process.nextTick(() => {
              this.emit('error', options.errorOnStream);
            });
          },
        });
        return stream;
      }

      let responseEmitted = false;
      const stream = new Readable({
        read() {
          if (!responseEmitted) {
            responseEmitted = true;
            this.emit('response', {
              statusCode: 200,
              headers: {
                'content-length': String(metadata.size),
                etag: metadata.etag,
                ...(metadata.contentEncoding
                  ? { 'content-encoding': metadata.contentEncoding }
                  : {}),
              },
            });
          }
          this.push(Buffer.from(content));
          this.push(null);
        },
      });

      return stream;
    },
  } as unknown as File;
}

/**
 * Factory function creating a mocked `@google-cloud/storage` {@link Storage} client.
 *
 * @param fileMap - Mapping of object names to their respective {@link MockFileOptions} configurations.
 * @returns A mocked {@link Storage} instance routing bucket and file queries.
 */
function createMockStorage(fileMap: Map<string, MockFileOptions>): Storage {
  const mockBucket: Bucket = {
    file: (name: string) => {
      const opts = fileMap.get(name) ?? {
        errorOnStream: Object.assign(new Error(`No such object: ${name}`), { code: 404 }),
        errorOnMetadata: Object.assign(new Error(`No such object: ${name}`), { code: 404 }),
        exists: false,
      };
      return createMockFile(opts, name);
    },
    getFiles: (query?: { prefix?: string }) => {
      const pfx = query?.prefix ?? '';
      const matchedFiles: File[] = [];
      for (const [name, opts] of fileMap.entries()) {
        if (opts.exists === false) continue;
        if (!pfx || name.startsWith(pfx)) {
          matchedFiles.push(createMockFile(opts, name));
        }
      }
      return Promise.resolve([matchedFiles, null]);
    },
  } as unknown as Bucket;

  return {
    bucket: () => mockBucket,
  } as unknown as Storage;
}

/**
 * Default test server configuration fixture for router test suites.
 */
const testConfig: ServerConfig = {
  port: 8080,
  host: '0.0.0.0',
  bucketName: 'test-bucket',
  prefix: 'resume_cloudbuild/angular',
};

/**
 * Snapshot of an HTTP response captured during integration test execution.
 */
interface ResponseResult {
  /**
   * HTTP status code returned by the server.
   */
  statusCode: number;

  /**
   * Parsed HTTP response headers.
   */
  headers: http.IncomingHttpHeaders;

  /**
   * UTF-8 decoded HTTP response body string.
   */
  body: string;
}

/**
 * Executes an HTTP request against a test server listening on the specified port.
 *
 * @param port - TCP port number of the active HTTP server.
 * @param options - Request options specifying the URL path, HTTP method, and optional request headers.
 * @returns A promise resolving to the captured {@link ResponseResult}.
 */
function performHttpRequest(
  port: number,
  options: { path: string; method?: string; headers?: Record<string, string> },
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: {
          connection: 'close',
          ...(options.headers ?? {}),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Comprehensive test suites for HTTP routing, request dispatching, security headers, and path traversal validation.
 *
 * @remarks
 * Validates:
 * - Injection of mandatory baseline security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) on all responses.
 * - Defense-in-depth URL path validation and traversal sanitization in {@link validateAndSanitizePath}.
 * - Unit dispatching of `/health` probes, static assets, and SPA navigation fallbacks.
 * - End-to-end integration with a real Node.js HTTP server and simulated GCS backend.
 */
void describe('HTTP Router & Request Handler', () => {
  void it('should export standard security headers matching requirements', () => {
    assert.deepEqual(SECURITY_HEADERS, {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
  });

  /**
   * Unit tests for {@link validateAndSanitizePath}.
   *
   * @remarks
   * Validates the 11-step URL validation and path sanitization pipeline covering standard paths,
   * query/hash stripping, redundant slash normalization, absolute URL parsing, percent-decoding,
   * null-byte injection detection, backslash blocking, encoded separator rejection, and dot-dot traversal sequences.
   */
  void describe('validateAndSanitizePath', () => {
    void it('should accept valid standard paths', () => {
      assert.deepEqual(validateAndSanitizePath('/'), { valid: true, path: '/' });
      assert.deepEqual(validateAndSanitizePath('/health'), { valid: true, path: '/health' });
      assert.deepEqual(validateAndSanitizePath('/main.js'), { valid: true, path: '/main.js' });
      assert.deepEqual(validateAndSanitizePath('/logo.png'), {
        valid: true,
        path: '/logo.png',
      });
      assert.deepEqual(validateAndSanitizePath('/about/team'), {
        valid: true,
        path: '/about/team',
      });
    });

    void it('should ignore query strings and hash fragments', () => {
      assert.deepEqual(validateAndSanitizePath('/health?probe=liveness'), {
        valid: true,
        path: '/health',
      });
      assert.deepEqual(validateAndSanitizePath('/main.js?v=123&ts=456'), {
        valid: true,
        path: '/main.js',
      });
      assert.deepEqual(validateAndSanitizePath('/main.js?x=%00'), {
        valid: true,
        path: '/main.js',
      });
      assert.deepEqual(validateAndSanitizePath('/main.js?v=..'), {
        valid: true,
        path: '/main.js',
      });
      assert.deepEqual(validateAndSanitizePath('/experience?debug=../test'), {
        valid: true,
        path: '/experience',
      });
      assert.deepEqual(validateAndSanitizePath('/about#section-2'), {
        valid: true,
        path: '/about',
      });
      assert.deepEqual(validateAndSanitizePath('/health?a=1#b=2'), {
        valid: true,
        path: '/health',
      });
    });

    void it('should handle paths without leading slashes and redundant slashes', () => {
      assert.deepEqual(validateAndSanitizePath('health'), { valid: true, path: '/health' });
      assert.deepEqual(validateAndSanitizePath('main.js'), { valid: true, path: '/main.js' });
      assert.deepEqual(validateAndSanitizePath('//health'), { valid: true, path: '/health' });
      assert.deepEqual(validateAndSanitizePath('///logo.png'), {
        valid: true,
        path: '/logo.png',
      });
    });

    void it('should handle absolute URLs with scheme and host', () => {
      assert.deepEqual(validateAndSanitizePath('http://localhost:8080/health'), {
        valid: true,
        path: '/health',
      });
      assert.deepEqual(validateAndSanitizePath('https://example.com/logo.png?v=1'), {
        valid: true,
        path: '/logo.png',
      });
      assert.deepEqual(validateAndSanitizePath('http://example.com'), {
        valid: true,
        path: '/',
      });
    });

    void it('should decode valid percent-encoded characters in asset paths', () => {
      assert.deepEqual(validateAndSanitizePath('/my%20file.png'), {
        valid: true,
        path: '/my file.png',
      });
      assert.deepEqual(validateAndSanitizePath('/%E4%BD%A0%E5%A5%BD.png'), {
        valid: true,
        path: '/你好.png',
      });
    });

    void it('should accept valid nested static asset paths with supported extensions', () => {
      assert.deepEqual(validateAndSanitizePath('/assets/logo.png'), {
        valid: true,
        path: '/assets/logo.png',
      });
      assert.deepEqual(validateAndSanitizePath('/nested/styles.css'), {
        valid: true,
        path: '/nested/styles.css',
      });
      assert.deepEqual(validateAndSanitizePath('/dist/browser/main.js'), {
        valid: true,
        path: '/dist/browser/main.js',
      });
      assert.deepEqual(validateAndSanitizePath('/a/b/c/bundle.js'), {
        valid: true,
        path: '/a/b/c/bundle.js',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/sub/icon.svg'), {
        valid: true,
        path: '/assets/sub/icon.svg',
      });
      assert.deepEqual(validateAndSanitizePath('/.well-known/security.txt'), {
        valid: true,
        path: '/.well-known/security.txt',
      });
      assert.deepEqual(validateAndSanitizePath('/media/font-6G54T7R3.woff2'), {
        valid: true,
        path: '/media/font-6G54T7R3.woff2',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/images/photo.webp'), {
        valid: true,
        path: '/assets/images/photo.webp',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/images/photo.avif'), {
        valid: true,
        path: '/assets/images/photo.avif',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/fonts/font.woff'), {
        valid: true,
        path: '/assets/fonts/font.woff',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/fonts/font.ttf'), {
        valid: true,
        path: '/assets/fonts/font.ttf',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/fonts/font.otf'), {
        valid: true,
        path: '/assets/fonts/font.otf',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/fonts/font.eot'), {
        valid: true,
        path: '/assets/fonts/font.eot',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/wasm/module.wasm'), {
        valid: true,
        path: '/assets/wasm/module.wasm',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/sitemap.xml'), {
        valid: true,
        path: '/assets/sitemap.xml',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/config.json'), {
        valid: true,
        path: '/assets/config.json',
      });
      assert.deepEqual(validateAndSanitizePath('/dist/bundle.mjs'), {
        valid: true,
        path: '/dist/bundle.mjs',
      });
      assert.deepEqual(validateAndSanitizePath('/dist/bundle.cjs'), {
        valid: true,
        path: '/dist/bundle.cjs',
      });
      assert.deepEqual(validateAndSanitizePath('/dist/main.js.map'), {
        valid: true,
        path: '/dist/main.js.map',
      });
      assert.deepEqual(validateAndSanitizePath('/assets/icons/favicon.ico'), {
        valid: true,
        path: '/assets/icons/favicon.ico',
      });
    });

    void it('should reject disallowed file extensions for single-level and nested paths', () => {
      assert.equal(validateAndSanitizePath('/app.exe').valid, false);
      assert.equal(validateAndSanitizePath('/secret.php').valid, false);
      assert.equal(validateAndSanitizePath('/assets/secret.php').valid, false);
      assert.equal(validateAndSanitizePath('/user/john.doe').valid, false);
      assert.equal(validateAndSanitizePath('/user/profile.data').valid, false);
      assert.equal(validateAndSanitizePath('/blog/post.1').valid, false);
      assert.equal(validateAndSanitizePath('/profile/a@b.com').valid, false);
      assert.equal(validateAndSanitizePath('/nested/malicious.exe').valid, false);
      assert.equal(validateAndSanitizePath('/config.env').valid, false);
      assert.equal(validateAndSanitizePath('/sub/config.env').valid, false);
      assert.equal(validateAndSanitizePath('/backup.tar.gz').valid, false);
      assert.equal(validateAndSanitizePath('/script.sh').valid, false);
      assert.equal(validateAndSanitizePath('/test.py').valid, false);
      assert.equal(validateAndSanitizePath('/secrets.yaml').valid, false);
      assert.equal(validateAndSanitizePath('/data.bin').valid, false);
    });

    void it('should accept all standard single-level allowed extensions', () => {
      assert.deepEqual(validateAndSanitizePath('/main.js'), { valid: true, path: '/main.js' });
      assert.deepEqual(validateAndSanitizePath('/styles.css'), {
        valid: true,
        path: '/styles.css',
      });
      assert.deepEqual(validateAndSanitizePath('/index.html'), {
        valid: true,
        path: '/index.html',
      });
      assert.deepEqual(validateAndSanitizePath('/app.json'), { valid: true, path: '/app.json' });
      assert.deepEqual(validateAndSanitizePath('/bundle.js.map'), {
        valid: true,
        path: '/bundle.js.map',
      });
      assert.deepEqual(validateAndSanitizePath('/manifest.webmanifest'), {
        valid: true,
        path: '/manifest.webmanifest',
      });
      assert.deepEqual(validateAndSanitizePath('/manifest.json'), {
        valid: true,
        path: '/manifest.json',
      });
      assert.deepEqual(validateAndSanitizePath('/favicon.ico'), {
        valid: true,
        path: '/favicon.ico',
      });
      assert.deepEqual(validateAndSanitizePath('/logo.svg'), { valid: true, path: '/logo.svg' });
      assert.deepEqual(validateAndSanitizePath('/photo.jpg'), { valid: true, path: '/photo.jpg' });
      assert.deepEqual(validateAndSanitizePath('/photo.webp'), {
        valid: true,
        path: '/photo.webp',
      });
      assert.deepEqual(validateAndSanitizePath('/photo.avif'), {
        valid: true,
        path: '/photo.avif',
      });
      assert.deepEqual(validateAndSanitizePath('/font.woff2'), {
        valid: true,
        path: '/font.woff2',
      });
      assert.deepEqual(validateAndSanitizePath('/font.woff'), { valid: true, path: '/font.woff' });
      assert.deepEqual(validateAndSanitizePath('/module.wasm'), {
        valid: true,
        path: '/module.wasm',
      });
      assert.deepEqual(validateAndSanitizePath('/robots.txt'), {
        valid: true,
        path: '/robots.txt',
      });
      assert.deepEqual(validateAndSanitizePath('/sitemap.xml'), {
        valid: true,
        path: '/sitemap.xml',
      });
      assert.deepEqual(validateAndSanitizePath('/MAIN.JS'), { valid: true, path: '/MAIN.JS' });
      assert.deepEqual(validateAndSanitizePath('/file.JS'), { valid: true, path: '/file.JS' });
    });

    void it('should preserve multi-level and nested HTML routes as SPA navigation routes', () => {
      assert.deepEqual(validateAndSanitizePath('/about/page.html'), {
        valid: true,
        path: '/about/page.html',
      });
      assert.deepEqual(validateAndSanitizePath('/docs/index.html'), {
        valid: true,
        path: '/docs/index.html',
      });
      assert.deepEqual(validateAndSanitizePath('/docs/guide.htm'), {
        valid: true,
        path: '/docs/guide.htm',
      });
      assert.deepEqual(validateAndSanitizePath('/app.htm'), {
        valid: true,
        path: '/app.htm',
      });
    });

    void it('should preserve multi-level SPA navigation routes with dotted intermediate directory segments and dotfiles', () => {
      assert.deepEqual(validateAndSanitizePath('/v1.2/overview'), {
        valid: true,
        path: '/v1.2/overview',
      });
      assert.deepEqual(validateAndSanitizePath('/dashboard/v2.0/settings'), {
        valid: true,
        path: '/dashboard/v2.0/settings',
      });
      assert.deepEqual(validateAndSanitizePath('/release-1.0/overview'), {
        valid: true,
        path: '/release-1.0/overview',
      });
      assert.deepEqual(validateAndSanitizePath('/.git/config'), {
        valid: true,
        path: '/.git/config',
      });
      assert.deepEqual(validateAndSanitizePath('/sub/.hidden'), {
        valid: true,
        path: '/sub/.hidden',
      });
    });

    void it('should handle trailing slashes and percent-encoded extensions on static assets', () => {
      assert.deepEqual(validateAndSanitizePath('/main.js/'), {
        valid: true,
        path: '/main.js/',
      });
      assert.deepEqual(validateAndSanitizePath('/styles.css/'), {
        valid: true,
        path: '/styles.css/',
      });
      assert.deepEqual(validateAndSanitizePath('/main%2Ejs'), {
        valid: true,
        path: '/main.js',
      });
      assert.deepEqual(validateAndSanitizePath('/ma%69n.js'), {
        valid: true,
        path: '/main.js',
      });
      assert.deepEqual(validateAndSanitizePath('/main.%6As'), {
        valid: true,
        path: '/main.js',
      });
      assert.deepEqual(validateAndSanitizePath('/logo%2Epng'), {
        valid: true,
        path: '/logo.png',
      });
      assert.deepEqual(validateAndSanitizePath('/styles.%63%73%73'), {
        valid: true,
        path: '/styles.css',
      });
    });

    void it('should preserve multi-level SPA navigation routes without extensions', () => {
      assert.deepEqual(validateAndSanitizePath('/skills/frontend/angular'), {
        valid: true,
        path: '/skills/frontend/angular',
      });
      assert.deepEqual(validateAndSanitizePath('/dashboard/settings/profile'), {
        valid: true,
        path: '/dashboard/settings/profile',
      });
      assert.deepEqual(validateAndSanitizePath('/about/team'), {
        valid: true,
        path: '/about/team',
      });
      assert.deepEqual(validateAndSanitizePath('/experience'), {
        valid: true,
        path: '/experience',
      });
    });

    void it('should reject missing or empty URLs', () => {
      assert.equal(validateAndSanitizePath(undefined).valid, false);
      assert.equal(validateAndSanitizePath('').valid, false);
      assert.equal(validateAndSanitizePath('   ').valid, false);
    });

    void it('should reject null byte injections', () => {
      assert.equal(validateAndSanitizePath('/health\0').valid, false);
      assert.equal(validateAndSanitizePath('/%00evil').valid, false);
      assert.equal(validateAndSanitizePath('/evil%00').valid, false);
    });

    void it('should reject raw backslashes and encoded separators', () => {
      assert.equal(validateAndSanitizePath('/assets\\secret').valid, false);
      assert.equal(validateAndSanitizePath('\\windows\\system32').valid, false);
      assert.equal(validateAndSanitizePath('/assets%2flogo.png').valid, false);
      assert.equal(validateAndSanitizePath('/assets%2Flogo.png').valid, false);
      assert.equal(validateAndSanitizePath('/assets%5csecret').valid, false);
      assert.equal(validateAndSanitizePath('/assets%5Csecret').valid, false);
    });

    void it('should reject double-encoded traversal and separator attacks', () => {
      assert.equal(validateAndSanitizePath('/%252e%252e/passwd').valid, false);
      assert.equal(validateAndSanitizePath('/%252e/passwd').valid, false);
      assert.equal(validateAndSanitizePath('/%252fpasswd').valid, false);
      assert.equal(validateAndSanitizePath('/%255cpasswd').valid, false);
      assert.equal(validateAndSanitizePath('/%2500passwd').valid, false);
    });

    void it('should reject directory traversal sequences before and after normalization', () => {
      assert.equal(validateAndSanitizePath('/../etc/passwd').valid, false);
      assert.equal(validateAndSanitizePath('/assets/../main.js').valid, false);
      assert.equal(validateAndSanitizePath('/assets/sub/../../etc/passwd').valid, false);
      assert.equal(validateAndSanitizePath('/media/../font.woff2').valid, false);
      assert.equal(validateAndSanitizePath('/..').valid, false);
      assert.equal(validateAndSanitizePath('/%2e%2e/etc/passwd').valid, false);
      assert.equal(validateAndSanitizePath('/%2E%2E/secret').valid, false);
      assert.equal(validateAndSanitizePath('/%2e./secret').valid, false);
      assert.equal(validateAndSanitizePath('/.%2e/secret').valid, false);
      assert.equal(validateAndSanitizePath('/.%2E/secret').valid, false);
      assert.equal(validateAndSanitizePath('/%2E./secret').valid, false);
      assert.equal(validateAndSanitizePath('/assets/%2e%2e/secret.png').valid, false);
      assert.equal(validateAndSanitizePath('/nested/%2E%2E/styles.css').valid, false);
    });

    void it('should reject malformed percent encodings', () => {
      assert.equal(validateAndSanitizePath('/%invalid').valid, false);
      assert.equal(validateAndSanitizePath('/%E0%A4%A').valid, false);
    });
  });

  /**
   * Unit tests for {@link Router.handle} using mock `StorageService` implementations.
   *
   * @remarks
   * Validates method restriction (405 for non-GET/HEAD), `/health` endpoint JSON and HEAD dispatch,
   * 400 Bad Request responses for traversal violations, static asset routing, and SPA navigation routing to `index.html`.
   */
  void describe('Router Unit Dispatch with Mock Storage', () => {
    void it('should reject non-GET and non-HEAD methods with 405 Method Not Allowed', async () => {
      let streamCalled = false;
      const mockStorage: StorageService = {
        streamFile: () => {
          streamCalled = true;
          return Promise.resolve();
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({ storageService: mockStorage, logger: silentLogger });

      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        const headers: Record<string, string> = {};
        let endedBody = '';
        const res = {
          statusCode: 200,
          setHeader: (name: string, value: string) => {
            headers[name.toLowerCase()] = value;
          },
          end: (data?: string) => {
            if (data) {
              endedBody = data;
            }
          },
        } as unknown as ServerResponse;

        const req = {
          method,
          url: '/health',
        } as unknown as IncomingMessage;

        await router.handle(req, res);

        assert.equal(res.statusCode, 405);
        assert.equal(headers['allow'], 'GET, HEAD');
        assert.equal(headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(headers['cache-control'], 'no-cache');
        assert.equal(headers['x-content-type-options'], 'nosniff');
        assert.equal(headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(endedBody, 'Method Not Allowed');
        assert.equal(streamCalled, false);
      }
    });

    void it('should handle GET /health with 200 OK and JSON status payload without GCS call', async () => {
      let streamCalled = false;
      const mockStorage: StorageService = {
        streamFile: () => {
          streamCalled = true;
          return Promise.resolve();
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({ storageService: mockStorage, logger: silentLogger });
      const headers: Record<string, string> = {};
      let body = '';
      const res = {
        statusCode: 0,
        setHeader: (name: string, value: string) => {
          headers[name.toLowerCase()] = value;
        },
        end: (data?: string) => {
          if (data) {
            body = data;
          }
        },
      } as unknown as ServerResponse;

      const req = {
        method: 'GET',
        url: '/health',
      } as unknown as IncomingMessage;

      await router.handle(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(headers['cache-control'], 'no-cache, no-store, must-revalidate');
      assert.equal(headers['x-content-type-options'], 'nosniff');
      assert.equal(headers['x-frame-options'], 'SAMEORIGIN');
      assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.equal(streamCalled, false);

      const parsed = JSON.parse(body) as HealthPayload;
      assert.equal(parsed.status, 'UP');
      assert.equal(typeof parsed.timestamp, 'string');
      assert.equal(typeof parsed.uptime, 'number');
    });

    void it('should handle HEAD /health with 200 OK and empty body without GCS call', async () => {
      let streamCalled = false;
      const mockStorage: StorageService = {
        streamFile: () => {
          streamCalled = true;
          return Promise.resolve();
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({ storageService: mockStorage, logger: silentLogger });
      const headers: Record<string, string> = {};
      let bodyCalled = false;
      const res = {
        statusCode: 0,
        setHeader: (name: string, value: string) => {
          headers[name.toLowerCase()] = value;
        },
        end: (data?: string) => {
          if (data) {
            bodyCalled = true;
          }
        },
      } as unknown as ServerResponse;

      const req = {
        method: 'HEAD',
        url: '/health',
      } as unknown as IncomingMessage;

      await router.handle(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(headers['cache-control'], 'no-cache, no-store, must-revalidate');
      assert.ok(typeof headers['content-length'] === 'string');
      assert.equal(bodyCalled, false);
      assert.equal(streamCalled, false);
    });

    void it('should reject traversal attempts with 400 Bad Request', async () => {
      let streamCalled = false;
      const mockStorage: StorageService = {
        streamFile: () => {
          streamCalled = true;
          return Promise.resolve();
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({ storageService: mockStorage, logger: silentLogger });
      const headers: Record<string, string> = {};
      let body = '';
      const res = {
        statusCode: 0,
        setHeader: (name: string, value: string) => {
          headers[name.toLowerCase()] = value;
        },
        end: (data?: string) => {
          if (data) {
            body = data;
          }
        },
      } as unknown as ServerResponse;

      const req = {
        method: 'GET',
        url: '/../etc/passwd',
      } as unknown as IncomingMessage;

      await router.handle(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(headers['cache-control'], 'no-cache');
      assert.equal(headers['x-content-type-options'], 'nosniff');
      assert.equal(headers['x-frame-options'], 'SAMEORIGIN');
      assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.equal(body, 'Bad Request');
      assert.equal(streamCalled, false);
    });

    void it('should route static asset requests with correct MIME and hashed flags', async () => {
      interface StreamCall {
        objectName: string;
        contentType: string;
        isHashed: boolean;
        isHead?: boolean;
      }
      const streamCalls: StreamCall[] = [];

      const mockStorage: StorageService = {
        streamFile: (objectName, _res, contentType, isHashed, isHead) => {
          streamCalls.push({ objectName, contentType, isHashed, isHead });
          return Promise.resolve();
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({ storageService: mockStorage, logger: silentLogger });
      const dummyRes = {
        setHeader: () => {
          /* noop */
        },
        end: () => {
          /* noop */
        },
      } as unknown as ServerResponse;

      // Hashed JS bundle
      await router.handle({ method: 'GET', url: '/main-5T7P2N6K.js' } as IncomingMessage, dummyRes);
      assert.deepEqual(streamCalls[0], {
        objectName: 'main-5T7P2N6K.js',
        contentType: 'application/javascript; charset=utf-8',
        isHashed: true,
        isHead: false,
      });

      // Unhashed static asset
      await router.handle({ method: 'GET', url: '/logo.svg' } as IncomingMessage, dummyRes);
      assert.deepEqual(streamCalls[1], {
        objectName: 'logo.svg',
        contentType: 'image/svg+xml',
        isHashed: false,
        isHead: false,
      });

      // HEAD request for hashed CSS
      await router.handle(
        { method: 'HEAD', url: '/styles-5INURTSO.css' } as IncomingMessage,
        dummyRes,
      );
      assert.deepEqual(streamCalls[2], {
        objectName: 'styles-5INURTSO.css',
        contentType: 'text/css; charset=utf-8',
        isHashed: true,
        isHead: true,
      });

      // Nested unhashed static asset
      await router.handle({ method: 'GET', url: '/assets/logo.png' } as IncomingMessage, dummyRes);
      assert.deepEqual(streamCalls[3], {
        objectName: 'assets/logo.png',
        contentType: 'image/png',
        isHashed: false,
        isHead: false,
      });

      // Nested hashed JS bundle
      await router.handle(
        { method: 'GET', url: '/dist/browser/main-5T7P2N6K.js' } as IncomingMessage,
        dummyRes,
      );
      assert.deepEqual(streamCalls[4], {
        objectName: 'dist/browser/main-5T7P2N6K.js',
        contentType: 'application/javascript; charset=utf-8',
        isHashed: true,
        isHead: false,
      });

      // Nested hashed font (HEAD)
      await router.handle(
        { method: 'HEAD', url: '/media/font-6G54T7R3.woff2' } as IncomingMessage,
        dummyRes,
      );
      assert.deepEqual(streamCalls[5], {
        objectName: 'media/font-6G54T7R3.woff2',
        contentType: 'font/woff2',
        isHashed: true,
        isHead: true,
      });

      // Nested hashed CSS
      await router.handle(
        { method: 'GET', url: '/nested/deep/styles-5INURTSO.css' } as IncomingMessage,
        dummyRes,
      );
      assert.deepEqual(streamCalls[6], {
        objectName: 'nested/deep/styles-5INURTSO.css',
        contentType: 'text/css; charset=utf-8',
        isHashed: true,
        isHead: false,
      });
    });

    void it('should route SPA navigation requests to index.html', async () => {
      interface StreamCall {
        objectName: string;
        contentType: string;
        isHashed: boolean;
        isHead?: boolean;
        notFoundStatusCode?: number;
      }
      const streamCalls: StreamCall[] = [];

      const mockStorage: StorageService = {
        streamFile: (objectName, _res, contentType, isHashed, isHead, notFoundStatusCode) => {
          streamCalls.push({ objectName, contentType, isHashed, isHead, notFoundStatusCode });
          return Promise.resolve();
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({ storageService: mockStorage, logger: silentLogger });
      const dummyRes = {
        setHeader: () => {
          /* noop */
        },
        end: () => {
          /* noop */
        },
      } as unknown as ServerResponse;

      // Root path
      await router.handle({ method: 'GET', url: '/' } as IncomingMessage, dummyRes);
      assert.deepEqual(streamCalls[0], {
        objectName: 'index.html',
        contentType: 'text/html; charset=utf-8',
        isHashed: false,
        isHead: false,
        notFoundStatusCode: 502,
      });

      // Direct index.html request
      await router.handle({ method: 'GET', url: '/index.html' } as IncomingMessage, dummyRes);
      assert.deepEqual(streamCalls[1], {
        objectName: 'index.html',
        contentType: 'text/html; charset=utf-8',
        isHashed: false,
        isHead: false,
        notFoundStatusCode: 502,
      });

      // SPA deep route
      await router.handle({ method: 'GET', url: '/experience' } as IncomingMessage, dummyRes);
      assert.deepEqual(streamCalls[2], {
        objectName: 'index.html',
        contentType: 'text/html; charset=utf-8',
        isHashed: false,
        isHead: false,
        notFoundStatusCode: 502,
      });

      // HEAD request on deep route
      await router.handle({ method: 'HEAD', url: '/skills/frontend' } as IncomingMessage, dummyRes);
      assert.deepEqual(streamCalls[3], {
        objectName: 'index.html',
        contentType: 'text/html; charset=utf-8',
        isHashed: false,
        isHead: true,
        notFoundStatusCode: 502,
      });
    });

    void it('should return 500 Internal Server Error with security headers when storageService throws', async () => {
      let statusCode = 0;
      const headers = new Map<string, string>();
      let body = '';

      const mockStorage: StorageService = {
        streamFile: () => Promise.reject(new Error('Unexpected disk failure')),
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({ storageService: mockStorage, logger: silentLogger });
      const dummyRes = {
        get statusCode() {
          return statusCode;
        },
        set statusCode(val: number) {
          statusCode = val;
        },
        setHeader: (name: string, value: string) => {
          headers.set(name.toLowerCase(), value);
        },
        end: (chunk?: string) => {
          if (chunk) body = chunk;
        },
        headersSent: false,
        destroyed: false,
        writableEnded: false,
      } as unknown as ServerResponse;

      await router.handle({ method: 'GET', url: '/main.js' } as IncomingMessage, dummyRes);

      assert.equal(statusCode, 500);
      assert.equal(body, 'Internal Server Error');
      assert.equal(headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(headers.get('cache-control'), 'no-cache');
      assert.equal(headers.get('x-content-type-options'), 'nosniff');
      assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    });
  });

  /**
   * End-to-end integration tests combining {@link Router}, {@link GcsStorageService}, and real Node.js `http.Server`.
   *
   * @remarks
   * Verifies full HTTP wire lifecycle, socket handling, immutable vs revalidate caching, 404 missing asset handling,
   * 502 Bad Gateway fallback on missing `index.html` or GCS outages, query string preservation, and GET/HEAD header parity.
   */
  void describe('Real HTTP Server Integration Tests', () => {
    let server: http.Server;
    let serverPort: number;

    const files = new Map<string, MockFileOptions>([
      [
        'resume_cloudbuild/angular/index.html',
        {
          content: '<!DOCTYPE html><html><head><title>Resume</title></head><body>App</body></html>',
          metadata: { etag: '"index-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/main.js',
        {
          content: 'console.log("main bundle");',
          metadata: { etag: '"main-plain-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/main-5T7P2N6K.js',
        {
          content: 'console.log("main bundle");',
          metadata: { etag: '"main-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/styles-5INURTSO.css',
        {
          content: 'body { margin: 0; }',
          metadata: { etag: '"styles-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/favicon.ico',
        {
          content: 'icon-bytes',
          metadata: { etag: '"favicon-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/assets/logo.png',
        {
          content: 'png-image-bytes',
          metadata: { etag: '"logo-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/dist/browser/main.js',
        {
          content: 'console.log("nested bundle");',
          metadata: { etag: '"nested-js-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/sub/styles.css',
        {
          content: 'h1 { color: red; }',
          metadata: { etag: '"sub-styles-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/nested/deep/icon.svg',
        {
          content: '<svg></svg>',
          metadata: { etag: '"icon-svg-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/static/manifest.json',
        {
          content: '{"name":"app"}',
          metadata: { etag: '"manifest-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/.well-known/security.txt',
        {
          content: 'Contact: security@example.com',
          metadata: { etag: '"sec-txt-etag-1"' },
        },
      ],
      [
        'resume_cloudbuild/angular/media/font-6G54T7R3.woff2',
        {
          content: 'woff2-font-bytes',
          metadata: { etag: '"font-woff2-etag-1"' },
        },
      ],
    ]);

    const mockStorage = createMockStorage(files);
    const storageService = new GcsStorageService({
      config: testConfig,
      storageClient: mockStorage,
      logger: silentLogger,
    });

    const startServer = (): Promise<void> =>
      new Promise((resolve) => {
        const handler = createRouter({ storageService, logger: silentLogger });
        server = http.createServer((req, res) => {
          void handler(req, res);
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          serverPort = addr.port;
          resolve();
        });
      });

    const stopServer = (): Promise<void> =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      });

    void it('should start real server, serve /health probe, and verify JSON payload', async () => {
      await startServer();
      try {
        const res = await performHttpRequest(serverPort, { path: '/health' });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
        assert.equal(res.headers['cache-control'], 'no-cache, no-store, must-revalidate');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');

        const data = JSON.parse(res.body) as HealthPayload;
        assert.equal(data.status, 'UP');
        assert.equal(typeof data.timestamp, 'string');
        assert.equal(typeof data.uptime, 'number');
      } finally {
        await stopServer();
      }
    });

    void it('should handle HEAD /health with 200 OK and empty body', async () => {
      await startServer();
      try {
        const res = await performHttpRequest(serverPort, { path: '/health', method: 'HEAD' });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
        assert.equal(res.headers['cache-control'], 'no-cache, no-store, must-revalidate');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(res.body, '');
      } finally {
        await stopServer();
      }
    });

    void it('should reject POST, PUT, DELETE with 405 Method Not Allowed and Allow header', async () => {
      await startServer();
      try {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
          const res = await performHttpRequest(serverPort, { path: '/health', method });
          assert.equal(res.statusCode, 405);
          assert.equal(res.headers.allow, 'GET, HEAD');
          assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
          assert.equal(res.headers['cache-control'], 'no-cache');
          assert.equal(res.headers['x-content-type-options'], 'nosniff');
          assert.equal(res.body, 'Method Not Allowed');

          const assetRes = await performHttpRequest(serverPort, { path: '/main.js', method });
          assert.equal(assetRes.statusCode, 405);
          assert.equal(assetRes.headers.allow, 'GET, HEAD');
        }
      } finally {
        await stopServer();
      }
    });

    void it('should reject traversal attacks with 400 Bad Request', async () => {
      await startServer();
      try {
        const attackPaths = [
          '/../etc/passwd',
          '/../../shadow',
          '/%2e%2e/etc/passwd',
          '/%252e%252e/passwd',
          '/assets%2f../secret.js',
          '/assets%5csecret.js',
          '/%00secret.js',
          '/nested/../../secret.js',
          '/assets/%2e%2e/secret.js',
          '/assets/..%2fsecret.js',
          '/assets/../main.js',
          '/dist/%252e%252e/main.js',
          '/%00/assets/logo.png',
          '/assets/%5clogo.png',
          '/assets/logo.png%00',
        ];

        for (const path of attackPaths) {
          const res = await performHttpRequest(serverPort, { path });
          assert.equal(res.statusCode, 400);
          assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
          assert.equal(res.headers['cache-control'], 'no-cache');
          assert.equal(res.headers['x-content-type-options'], 'nosniff');
          assert.equal(res.body, 'Bad Request');
        }
      } finally {
        await stopServer();
      }
    });

    void it('should serve hashed static assets with immutable cache headers', async () => {
      await startServer();
      try {
        const res = await performHttpRequest(serverPort, { path: '/main-5T7P2N6K.js' });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
        assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(res.body, 'console.log("main bundle");');
      } finally {
        await stopServer();
      }
    });

    void it('should serve unhashed static assets with no-cache revalidate headers', async () => {
      await startServer();
      try {
        const res = await performHttpRequest(serverPort, { path: '/favicon.ico' });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'image/x-icon');
        assert.equal(res.headers['cache-control'], 'public, max-age=0, must-revalidate');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.body, 'icon-bytes');
      } finally {
        await stopServer();
      }
    });

    void it('should return 404 for missing static assets without falling back to index.html', async () => {
      await startServer();
      try {
        const res = await performHttpRequest(serverPort, { path: '/non-existent.png' });
        assert.equal(res.statusCode, 404);
        assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.body, 'Not Found');
      } finally {
        await stopServer();
      }
    });

    void it('should fall back to index.html for root and SPA navigation routes', async () => {
      await startServer();
      try {
        // Root /
        const rootRes = await performHttpRequest(serverPort, { path: '/' });
        assert.equal(rootRes.statusCode, 200);
        assert.equal(rootRes.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(rootRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
        assert.equal(rootRes.headers['x-content-type-options'], 'nosniff');
        assert.ok(rootRes.body.includes('<title>Resume</title>'));

        // SPA Navigation /experience
        const navRes = await performHttpRequest(serverPort, { path: '/experience' });
        assert.equal(navRes.statusCode, 200);
        assert.equal(navRes.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(navRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
        assert.ok(navRes.body.includes('<title>Resume</title>'));

        // Deep route /skills/frontend/angular
        const deepRes = await performHttpRequest(serverPort, {
          path: '/skills/frontend/angular',
        });
        assert.equal(deepRes.statusCode, 200);
        assert.equal(deepRes.headers['content-type'], 'text/html; charset=utf-8');
        assert.ok(deepRes.body.includes('<title>Resume</title>'));
      } finally {
        await stopServer();
      }
    });

    void it('should handle HEAD requests on static assets and SPA routes', async () => {
      await startServer();
      try {
        const headAsset = await performHttpRequest(serverPort, {
          path: '/main-5T7P2N6K.js',
          method: 'HEAD',
        });
        assert.equal(headAsset.statusCode, 200);
        assert.equal(headAsset.headers['content-type'], 'application/javascript; charset=utf-8');
        assert.equal(headAsset.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal(headAsset.body, '');

        const headSpa = await performHttpRequest(serverPort, {
          path: '/experience',
          method: 'HEAD',
        });
        assert.equal(headSpa.statusCode, 200);
        assert.equal(headSpa.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(headSpa.headers['cache-control'], 'public, max-age=0, must-revalidate');
        assert.equal(headSpa.body, '');
      } finally {
        await stopServer();
      }
    });

    void it('should return 502 Bad Gateway when index.html is missing for SPA navigation fallback', async () => {
      const filesWithoutIndex = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/main-5T7P2N6K.js',
          {
            content: 'console.log("main bundle");',
            metadata: { size: 27, etag: '"main-etag-1"' },
          },
        ],
      ]);
      const emptyStorageService = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(filesWithoutIndex),
        logger: silentLogger,
      });
      let missingIndexServer: http.Server;
      let missingIndexPort = 0;

      await new Promise<void>((resolve) => {
        const handler = createRouter({
          storageService: emptyStorageService,
          logger: silentLogger,
        });
        missingIndexServer = http.createServer((req, res) => {
          void handler(req, res);
        });
        missingIndexServer.listen(0, '127.0.0.1', () => {
          const addr = missingIndexServer.address() as AddressInfo;
          missingIndexPort = addr.port;
          resolve();
        });
      });

      try {
        // GET /
        const rootRes = await performHttpRequest(missingIndexPort, { path: '/' });
        assert.equal(rootRes.statusCode, 502);
        assert.equal(rootRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(rootRes.headers['cache-control'], 'no-cache');
        assert.equal(rootRes.headers['x-content-type-options'], 'nosniff');
        assert.equal(rootRes.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(rootRes.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(rootRes.body, 'Bad Gateway');

        // GET /experience
        const navRes = await performHttpRequest(missingIndexPort, { path: '/experience' });
        assert.equal(navRes.statusCode, 502);
        assert.equal(navRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(navRes.headers['cache-control'], 'no-cache');
        assert.equal(navRes.headers['x-content-type-options'], 'nosniff');
        assert.equal(navRes.body, 'Bad Gateway');

        // HEAD /experience
        const headRes = await performHttpRequest(missingIndexPort, {
          path: '/experience',
          method: 'HEAD',
        });
        assert.equal(headRes.statusCode, 502);
        assert.equal(headRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(headRes.headers['cache-control'], 'no-cache');
        assert.equal(headRes.headers['x-content-type-options'], 'nosniff');
        assert.equal(headRes.body, '');

        // Static missing asset still returns 404 Not Found
        const staticRes = await performHttpRequest(missingIndexPort, { path: '/logo.png' });
        assert.equal(staticRes.statusCode, 404);
        assert.equal(staticRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(staticRes.body, 'Not Found');
      } finally {
        await new Promise<void>((resolve) => {
          missingIndexServer.close(() => {
            resolve();
          });
        });
      }
    });

    void it('should return 502 Bad Gateway during GCS outages/errors on static asset and SPA requests', async () => {
      const outageFiles = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/main-5T7P2N6K.js',
          {
            errorOnStream: new Error('ECONNRESET: connection reset by peer'),
            errorOnMetadata: new Error('ECONNRESET: connection reset by peer'),
          },
        ],
        [
          'resume_cloudbuild/angular/index.html',
          {
            errorOnStream: new Error('GCS 503 Service Unavailable'),
            errorOnMetadata: new Error('GCS 503 Service Unavailable'),
          },
        ],
      ]);
      const outageStorageService = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(outageFiles),
        logger: silentLogger,
      });
      let outageServer: http.Server;
      let outagePort = 0;

      await new Promise<void>((resolve) => {
        const handler = createRouter({
          storageService: outageStorageService,
          logger: silentLogger,
        });
        outageServer = http.createServer((req, res) => {
          void handler(req, res);
        });
        outageServer.listen(0, '127.0.0.1', () => {
          const addr = outageServer.address() as AddressInfo;
          outagePort = addr.port;
          resolve();
        });
      });

      try {
        // GET static asset on outage -> 502
        const getAssetRes = await performHttpRequest(outagePort, { path: '/main-5T7P2N6K.js' });
        assert.equal(getAssetRes.statusCode, 502);
        assert.equal(getAssetRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(getAssetRes.headers['cache-control'], 'no-cache');
        assert.equal(getAssetRes.headers['x-content-type-options'], 'nosniff');
        assert.equal(getAssetRes.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(getAssetRes.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(getAssetRes.body, 'Bad Gateway');

        // HEAD static asset on outage -> 502
        const headAssetRes = await performHttpRequest(outagePort, {
          path: '/main-5T7P2N6K.js',
          method: 'HEAD',
        });
        assert.equal(headAssetRes.statusCode, 502);
        assert.equal(headAssetRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(headAssetRes.headers['cache-control'], 'no-cache');
        assert.equal(headAssetRes.body, '');

        // GET SPA route on outage -> 502
        const spaRes = await performHttpRequest(outagePort, { path: '/experience' });
        assert.equal(spaRes.statusCode, 502);
        assert.equal(spaRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(spaRes.headers['cache-control'], 'no-cache');
        assert.equal(spaRes.headers['x-content-type-options'], 'nosniff');
        assert.equal(spaRes.body, 'Bad Gateway');

        // GET root / on outage -> 502
        const rootRes = await performHttpRequest(outagePort, { path: '/' });
        assert.equal(rootRes.statusCode, 502);
        assert.equal(rootRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(rootRes.body, 'Bad Gateway');
      } finally {
        await new Promise<void>((resolve) => {
          outageServer.close(() => {
            resolve();
          });
        });
      }
    });

    void it('should return 502 Bad Gateway when GCS getFiles listing fails on static asset or SPA requests', async () => {
      const listingErrorStorage: Storage = {
        bucket: () =>
          ({
            file: (name: string) => createMockFile({ exists: false }, name),
            getFiles: () =>
              Promise.reject(
                Object.assign(new Error('Caller lacks storage.objects.list permission'), {
                  code: 403,
                }),
              ),
          }) as unknown as Bucket,
      } as unknown as Storage;

      const listingService = new GcsStorageService({
        config: testConfig,
        storageClient: listingErrorStorage,
        logger: silentLogger,
      });

      let testServer: http.Server;
      let testPort = 0;

      await new Promise<void>((resolve) => {
        const handler = createRouter({
          storageService: listingService,
          logger: silentLogger,
        });
        testServer = http.createServer((req, res) => {
          void handler(req, res);
        });
        testServer.listen(0, '127.0.0.1', () => {
          const addr = testServer.address() as AddressInfo;
          testPort = addr.port;
          resolve();
        });
      });

      try {
        // GET missing static asset when getFiles fails -> 502 (not 500 or 404)
        const getAssetRes = await performHttpRequest(testPort, { path: '/main.js' });
        assert.equal(getAssetRes.statusCode, 502);
        assert.equal(getAssetRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(getAssetRes.body, 'Bad Gateway');

        // HEAD missing static asset when getFiles fails -> 502
        const headAssetRes = await performHttpRequest(testPort, {
          path: '/main.js',
          method: 'HEAD',
        });
        assert.equal(headAssetRes.statusCode, 502);
        assert.equal(headAssetRes.body, '');

        // GET SPA route when index.html missing and getFiles fails -> 502
        const spaRes = await performHttpRequest(testPort, { path: '/' });
        assert.equal(spaRes.statusCode, 502);
        assert.equal(spaRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(spaRes.body, 'Bad Gateway');
      } finally {
        await new Promise<void>((resolve) => {
          testServer.close(() => {
            resolve();
          });
        });
      }
    });

    void it('should serve static assets and SPA routes with query parameters ignored in routing', async () => {
      await startServer();
      try {
        // Query param on static asset
        const assetWithQuery = await performHttpRequest(serverPort, {
          path: '/main-5T7P2N6K.js?v=1.2.3&build=456',
        });
        assert.equal(assetWithQuery.statusCode, 200);
        assert.equal(
          assetWithQuery.headers['content-type'],
          'application/javascript; charset=utf-8',
        );
        assert.equal(
          assetWithQuery.headers['cache-control'],
          'public, max-age=31536000, immutable',
        );
        assert.equal(assetWithQuery.body, 'console.log("main bundle");');

        // Null byte in query parameter should be ignored and route normally
        const assetWithNullQuery = await performHttpRequest(serverPort, {
          path: '/main-5T7P2N6K.js?param=%00',
        });
        assert.equal(assetWithNullQuery.statusCode, 200);
        assert.equal(assetWithNullQuery.body, 'console.log("main bundle");');

        // Traversal segment in query parameter should be ignored and route normally
        const assetWithDotQuery = await performHttpRequest(serverPort, {
          path: '/main-5T7P2N6K.js?v=..',
        });
        assert.equal(assetWithDotQuery.statusCode, 200);
        assert.equal(assetWithDotQuery.body, 'console.log("main bundle");');

        // Query param on SPA route
        const spaWithQuery = await performHttpRequest(serverPort, {
          path: '/experience?tab=skills&filter=angular',
        });
        assert.equal(spaWithQuery.statusCode, 200);
        assert.equal(spaWithQuery.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(spaWithQuery.headers['cache-control'], 'public, max-age=0, must-revalidate');
        assert.ok(spaWithQuery.body.includes('<title>Resume</title>'));
      } finally {
        await stopServer();
      }
    });

    void it('should verify HEAD and GET header parity for static assets and SPA routes', async () => {
      await startServer();
      try {
        // Hashed static asset parity
        const getAsset = await performHttpRequest(serverPort, { path: '/main-5T7P2N6K.js' });
        const headAsset = await performHttpRequest(serverPort, {
          path: '/main-5T7P2N6K.js',
          method: 'HEAD',
        });
        assert.equal(getAsset.statusCode, 200);
        assert.equal(headAsset.statusCode, 200);
        assert.equal(headAsset.headers['content-type'], getAsset.headers['content-type']);
        assert.equal(headAsset.headers['cache-control'], getAsset.headers['cache-control']);
        assert.equal(headAsset.headers['content-length'], getAsset.headers['content-length']);
        assert.equal(headAsset.headers.etag, getAsset.headers.etag);
        assert.equal(headAsset.headers['x-content-type-options'], 'nosniff');
        assert.equal(headAsset.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(headAsset.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(headAsset.body, '');
        assert.equal(getAsset.body, 'console.log("main bundle");');

        // SPA route parity
        const getSpa = await performHttpRequest(serverPort, { path: '/experience' });
        const headSpa = await performHttpRequest(serverPort, {
          path: '/experience',
          method: 'HEAD',
        });
        assert.equal(getSpa.statusCode, 200);
        assert.equal(headSpa.statusCode, 200);
        assert.equal(headSpa.headers['content-type'], getSpa.headers['content-type']);
        assert.equal(headSpa.headers['cache-control'], getSpa.headers['cache-control']);
        assert.equal(headSpa.headers['content-length'], getSpa.headers['content-length']);
        assert.equal(headSpa.headers.etag, getSpa.headers.etag);
        assert.equal(headSpa.headers['x-content-type-options'], 'nosniff');
        assert.equal(headSpa.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(headSpa.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(headSpa.body, '');
        assert.ok(getSpa.body.includes('<title>Resume</title>'));
      } finally {
        await stopServer();
      }
    });

    void it('should return 500 Internal Server Error when storage service throws unhandled exception in real server', async () => {
      const failingStorageService: StorageService = {
        streamFile: () => Promise.reject(new Error('Fatal unhandled storage fault')),
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      let failServer: http.Server;
      let failPort = 0;

      await new Promise<void>((resolve) => {
        const handler = createRouter({
          storageService: failingStorageService,
          logger: createAppLogger({ silent: true }),
        });
        failServer = http.createServer((req, res) => {
          void handler(req, res);
        });
        failServer.listen(0, '127.0.0.1', () => {
          const addr = failServer.address() as AddressInfo;
          failPort = addr.port;
          resolve();
        });
      });

      try {
        const res = await performHttpRequest(failPort, { path: '/experience' });
        assert.equal(res.statusCode, 500);
        assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(res.headers['cache-control'], 'no-cache');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(res.body, 'Internal Server Error');
      } finally {
        await new Promise<void>((resolve) => {
          failServer.close(() => {
            resolve();
          });
        });
      }
    });

    void it('should successfully route and stream nested static asset paths in real HTTP server', async () => {
      await startServer();
      try {
        const testCases = [
          { path: '/assets/logo.png', contentType: 'image/png', body: 'png-image-bytes' },
          {
            path: '/dist/browser/main.js',
            contentType: 'application/javascript; charset=utf-8',
            body: 'console.log("nested bundle");',
          },
          {
            path: '/sub/styles.css',
            contentType: 'text/css; charset=utf-8',
            body: 'h1 { color: red; }',
          },
          {
            path: '/nested/deep/icon.svg',
            contentType: 'image/svg+xml',
            body: '<svg></svg>',
          },
          {
            path: '/static/manifest.json',
            contentType: 'application/json; charset=utf-8',
            body: '{"name":"app"}',
          },
          {
            path: '/.well-known/security.txt',
            contentType: 'text/plain; charset=utf-8',
            body: 'Contact: security@example.com',
          },
          {
            path: '/media/font-6G54T7R3.woff2',
            contentType: 'font/woff2',
            body: 'woff2-font-bytes',
          },
        ];
        for (const tc of testCases) {
          const res = await performHttpRequest(serverPort, { path: tc.path });
          assert.equal(res.statusCode, 200, `Expected 200 for nested static path ${tc.path}`);
          assert.equal(res.headers['content-type'], tc.contentType);
          assert.equal(res.headers['x-content-type-options'], 'nosniff');
          assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
          assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
          assert.equal(res.body, tc.body);
        }
      } finally {
        await stopServer();
      }
    });

    void it('should successfully serve /health, root /, and SPA routes with nested HTML / dotted intermediate segments in real HTTP server', async () => {
      await startServer();
      try {
        // 1. Health check endpoint
        const healthRes = await performHttpRequest(serverPort, { path: '/health' });
        assert.equal(healthRes.statusCode, 200);
        assert.equal(healthRes.headers['content-type'], 'application/json; charset=utf-8');
        assert.equal(healthRes.headers['cache-control'], 'no-cache, no-store, must-revalidate');
        assert.equal(healthRes.headers['x-content-type-options'], 'nosniff');
        assert.equal(healthRes.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(healthRes.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        const healthBody = JSON.parse(healthRes.body) as { status: string };
        assert.equal(healthBody.status, 'UP');

        // 2. Root route
        const rootRes = await performHttpRequest(serverPort, { path: '/' });
        assert.equal(rootRes.statusCode, 200);
        assert.equal(rootRes.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(rootRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
        assert.ok(rootRes.body.includes('<title>Resume</title>'));

        // 3. Nested HTML routes (preserve SPA fallback)
        const nestedHtmlPaths = ['/about/page.html', '/docs/index.html', '/guide.htm'];
        for (const htmlPath of nestedHtmlPaths) {
          const res = await performHttpRequest(serverPort, { path: htmlPath });
          assert.equal(res.statusCode, 200, `Expected 200 for HTML route ${htmlPath}`);
          assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
          assert.ok(res.body.includes('<title>Resume</title>'));
        }

        // 4. SPA navigation routes with dotted intermediate directory segments
        const dottedPaths = ['/v1.2/overview', '/dashboard/v2.0/settings', '/release-1.0/overview'];
        for (const dottedPath of dottedPaths) {
          const res = await performHttpRequest(serverPort, { path: dottedPath });
          assert.equal(res.statusCode, 200, `Expected 200 for dotted SPA route ${dottedPath}`);
          assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
          assert.ok(res.body.includes('<title>Resume</title>'));
        }
      } finally {
        await stopServer();
      }
    });

    void it('should stream percent-encoded static asset paths in real HTTP server', async () => {
      await startServer();
      try {
        const encodedPaths = ['/main%2Ejs', '/ma%69n.js', '/main.%6As'];
        for (const encPath of encodedPaths) {
          const res = await performHttpRequest(serverPort, { path: encPath });
          assert.equal(res.statusCode, 200, `Expected 200 for encoded static path ${encPath}`);
          assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
          assert.equal(res.body, 'console.log("main bundle");');
        }
      } finally {
        await stopServer();
      }
    });

    void it('should reject disallowed file extensions with 400 Bad Request in real HTTP server', async () => {
      await startServer();
      try {
        const disallowedPaths = [
          '/malicious.exe',
          '/secret.php',
          '/assets/secret.php',
          '/user/john.doe',
          '/user/profile.data',
          '/blog/post.1',
          '/profile/a@b.com',
          '/sub/malicious.exe',
          '/nested/config.env',
          '/config.env',
          '/backup.tar.gz',
          '/script.sh',
          '/test.py',
          '/app.yaml',
        ];
        for (const disallowedPath of disallowedPaths) {
          const res = await performHttpRequest(serverPort, { path: disallowedPath });
          assert.equal(
            res.statusCode,
            400,
            `Expected 400 for disallowed extension path ${disallowedPath}`,
          );
          assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
          assert.equal(res.headers['x-content-type-options'], 'nosniff');
          assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
          assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
          assert.equal(res.body, 'Bad Request');
        }
      } finally {
        await stopServer();
      }
    });

    void it('should verify SOLID Router components individually and with dependency injection', () => {
      const sanitizer = new DefenseInDepthPathSanitizer();
      assert.equal(sanitizer.validateAndSanitize('/test').valid, true);

      const policy = new StandardSecurityHeadersPolicy();
      assert.equal(policy.getHeaders()['X-Frame-Options'], 'SAMEORIGIN');

      const validator = new StandardHttpMethodValidator();
      let rejected405 = false;
      const fakeRes = {
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          rejected405 = true;
        },
      } as unknown as ServerResponse;
      const isValid = validator.validate({ method: 'DELETE' } as IncomingMessage, fakeRes);
      assert.equal(isValid, false);
      assert.equal(rejected405, true);

      const healthProvider = new SystemHealthStatusProvider();
      const payload = healthProvider.getHealthStatus();
      assert.equal(payload.status, 'UP');

      const healthHandler = new DefaultHealthCheckHandler(healthProvider);
      let healthHandled = false;
      const fakeHealthRes = {
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          healthHandled = true;
        },
      } as unknown as ServerResponse;
      assert.equal(healthHandler.handle('health', fakeHealthRes, false), true);
      assert.equal(healthHandled, true);

      // Router DI constructor
      const routerWithDeps = new Router({
        storageService: new GcsStorageService({
          config: testConfig,
          storageClient: createMockStorage(new Map()),
          logger: silentLogger,
        }),
        pathSanitizer: sanitizer,
        securityHeadersPolicy: policy,
        httpMethodValidator: validator,
        healthCheckHandler: healthHandler,
        logger: silentLogger,
      });
      assert.ok(routerWithDeps);
    });
  });

  /**
   * Test suite for decision telemetry, reason tracking, and Java-style error call stack logging.
   */
  void describe('Router Decision Telemetry & Error Logging', () => {
    void it('should correctly sanitize URLs for logging to prevent credential and query leakage', () => {
      assert.equal(sanitizeUrlForLogging(undefined), '');
      assert.equal(sanitizeUrlForLogging(''), '');
      assert.equal(sanitizeUrlForLogging('   '), '');
      assert.equal(sanitizeUrlForLogging('/assets/main.js'), '/assets/main.js');
      assert.equal(
        sanitizeUrlForLogging('/assets/main.js?token=secret123&api_key=xyz'),
        '/assets/main.js',
      );
      assert.equal(sanitizeUrlForLogging('/profile#overview'), '/profile');
      assert.equal(
        sanitizeUrlForLogging('http://localhost:8080/data?auth=Bearer%20secret#fragment'),
        'http://localhost:8080/data',
      );
    });

    void it('should log method validation decisions at debug for permitted and warn for 405 rejections', () => {
      const { logger, decisions } = createCapturingLogger();
      const validator = new StandardHttpMethodValidator(logger);

      const fakeRes = {
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          /* noop */
        },
      } as unknown as ServerResponse;

      // GET permitted
      const getValid = validator.validate({ method: 'GET' } as IncomingMessage, fakeRes);
      assert.equal(getValid, true);
      assert.equal(decisions.length, 1);
      assert.deepEqual(decisions[0], {
        action: 'HttpMethodValidator',
        choice: 'permit request',
        reason: "HTTP method 'GET' is allowed (GET/HEAD permitted)",
        level: 'debug',
        method: 'GET',
      });

      // HEAD permitted
      const headValid = validator.validate({ method: 'HEAD' } as IncomingMessage, fakeRes);
      assert.equal(headValid, true);
      assert.equal(decisions.length, 2);
      assert.deepEqual(decisions[1], {
        action: 'HttpMethodValidator',
        choice: 'permit request',
        reason: "HTTP method 'HEAD' is allowed (GET/HEAD permitted)",
        level: 'debug',
        method: 'HEAD',
      });

      // POST rejected
      const postValid = validator.validate(
        { method: 'POST', url: '/submit?key=secret' } as IncomingMessage,
        fakeRes,
      );
      assert.equal(postValid, false);
      assert.equal(decisions.length, 3);
      assert.deepEqual(decisions[2], {
        action: 'HttpMethodValidator',
        choice: 'reject request (405)',
        reason: "Method 'POST' is not allowed (only GET and HEAD permitted)",
        level: 'debug',
        method: 'POST',
        allowedMethods: 'GET, HEAD',
        statusCode: 405,
        path: '/submit',
      });
    });

    void it('should log path sanitizer decisions on normalization and security rejections', () => {
      const { logger, decisions } = createCapturingLogger();
      const sanitizer = new DefenseInDepthPathSanitizer(logger);

      // Valid path normalization
      const validRes = sanitizer.validateAndSanitize('/main.js?query=123');
      assert.equal(validRes.valid, true);
      assert.equal(validRes.path, '/main.js');
      assert.equal(decisions.length, 1);
      assert.deepEqual(decisions[0], {
        action: 'PathSanitizer',
        choice: "normalize path to '/main.js'",
        reason: 'Path passed all security and traversal validation checks',
        level: 'debug',
        path: '/main.js',
      });

      // Directory traversal rejection
      const traversalRes = sanitizer.validateAndSanitize('/../etc/passwd');
      assert.equal(traversalRes.valid, false);
      assert.equal(decisions.length, 2);
      assert.deepEqual(decisions[1], {
        action: 'PathSanitizer',
        choice: 'reject request (400)',
        reason: 'Directory traversal sequence detected',
        level: 'debug',
        path: '/../etc/passwd',
        statusCode: 400,
      });

      // Null byte injection rejection
      const nullByteRes = sanitizer.validateAndSanitize('/app%00.js');
      assert.equal(nullByteRes.valid, false);
      assert.equal(decisions.length, 3);
      assert.deepEqual(decisions[2], {
        action: 'PathSanitizer',
        choice: 'reject request (400)',
        reason: 'Null byte injection detected',
        level: 'debug',
        path: '/app%00.js',
        statusCode: 400,
      });

      // Encoded path separator rejection
      const encodedSlashRes = sanitizer.validateAndSanitize('/app%2fsub');
      assert.equal(encodedSlashRes.valid, false);
      assert.equal(decisions.length, 4);
      assert.deepEqual(decisions[3], {
        action: 'PathSanitizer',
        choice: 'reject request (400)',
        reason: 'Encoded path separators not allowed',
        level: 'debug',
        path: '/app%2fsub',
        statusCode: 400,
      });

      // Empty URL rejection
      const emptyRes = sanitizer.validateAndSanitize('');
      assert.equal(emptyRes.valid, false);
      assert.equal(decisions.length, 5);
      assert.deepEqual(decisions[4], {
        action: 'PathSanitizer',
        choice: 'reject request (400)',
        reason: 'Missing or empty request URL',
        level: 'debug',
        path: '',
        statusCode: 400,
      });
    });

    void it('should log decisions in DefaultHealthCheckHandler', () => {
      const { logger, decisions } = createCapturingLogger();
      const handler = new DefaultHealthCheckHandler(undefined, logger);
      const fakeRes = {
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          /* noop */
        },
      } as unknown as ServerResponse;

      const handled = handler.handle('health', fakeRes, false);
      assert.equal(handled, true);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.action, 'HealthCheckHandler');
      assert.equal(decisions[0]?.choice, 'handle /health endpoint');
      assert.equal(decisions[0]?.reason, 'Exact match on health check endpoint path');
      assert.equal(decisions[0]?.level, 'debug');
      assert.equal(decisions[0]?.path, 'health');
      assert.equal(decisions[0]?.status, 'UP');
      assert.equal(decisions[0]?.isHead, false);

      const notHandled = handler.handle('other', fakeRes, false);
      assert.equal(notHandled, false);
      assert.equal(decisions.length, 1);
    });

    void it('should log router dispatch decisions for static assets, SPA fallbacks, and 400 errors', async () => {
      const { logger, decisions } = createCapturingLogger();
      const streamedFiles: { name: string; contentType: string; isHashed: boolean }[] = [];

      const mockStorage: StorageService = {
        streamFile: (name, _res, contentType, isHashed) => {
          streamedFiles.push({ name, contentType, isHashed });
          return Promise.resolve();
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({
        storageService: mockStorage,
        logger,
      });

      const fakeRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          /* noop */
        },
      } as unknown as ServerResponse;

      // 1. Static hashed asset dispatch
      await router.handle(
        { method: 'GET', url: '/main-5T7P2N6K.js?v=1#hash' } as IncomingMessage,
        fakeRes,
      );
      assert.equal(streamedFiles.length, 1);
      assert.equal(streamedFiles[0]?.name, 'main-5T7P2N6K.js');
      assert.equal(streamedFiles[0]?.isHashed, true);

      const staticDecision = decisions.find(
        (d) => d.action === 'Router' && d.choice.startsWith('stream static asset'),
      );
      assert.ok(staticDecision);
      assert.equal(staticDecision.choice, "stream static asset 'main-5T7P2N6K.js'");
      assert.equal(staticDecision.contentType, 'application/javascript; charset=utf-8');
      assert.equal(staticDecision.isHashed, true);
      assert.equal(staticDecision.cacheControl, 'public, max-age=31536000, immutable');
      assert.equal(staticDecision.level, 'info');

      // 2. SPA fallback dispatch for extensionless navigation route
      await router.handle(
        { method: 'GET', url: '/profile/settings?token=secret_123' } as IncomingMessage,
        fakeRes,
      );
      assert.equal(streamedFiles.length, 2);
      assert.equal(streamedFiles[1]?.name, 'index.html');
      assert.equal(streamedFiles[1]?.isHashed, false);

      const spaDecision = decisions.find(
        (d) => d.action === 'Router' && d.choice === 'SPA fallback (index.html)',
      );
      assert.ok(spaDecision);
      assert.equal(spaDecision.path, 'profile/settings');
      assert.equal(
        spaDecision.reason,
        "Path 'profile/settings' has no static asset extension, routing to SPA entrypoint",
      );
      assert.equal(spaDecision.level, 'info');

      // 3. 400 Bad Request error logging
      let badRequestEnded = false;
      let badRequestStatusCode = 200;
      const fakeBadReqRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        get statusCode() {
          return badRequestStatusCode;
        },
        set statusCode(code: number) {
          badRequestStatusCode = code;
        },
        setHeader() {
          /* noop */
        },
        end() {
          badRequestEnded = true;
        },
      } as unknown as ServerResponse;

      await router.handle(
        { method: 'GET', url: '/../forbidden/secret.txt?query=leaked' } as IncomingMessage,
        fakeBadReqRes,
      );
      assert.equal(badRequestStatusCode, 400);
      assert.equal(badRequestEnded, true);

      const badReqDecision = decisions.find(
        (d) => d.action === 'Router' && d.choice === 'reject request (400)',
      );
      assert.ok(badReqDecision);
      assert.equal(badReqDecision.reason, 'Directory traversal sequence detected');
      assert.equal(badReqDecision.level, 'warn');
      assert.equal(badReqDecision.path, '/../forbidden/secret.txt');
      assert.equal(badReqDecision.statusCode, 400);
    });

    void it('should log complete Java-style error stack traces on unhandled 500 router errors', async () => {
      const { logger, logs } = createCapturingLogger();
      const nestedCause = new Error('Database connection failed');
      const backendError = new Error('Storage cluster unreachable', { cause: nestedCause });

      const failingStorage: StorageService = {
        streamFile: () => Promise.reject(backendError),
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({
        storageService: failingStorage,
        logger,
      });

      let ended500 = false;
      let statusCode500 = 200;
      const fakeRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        get statusCode() {
          return statusCode500;
        },
        set statusCode(code: number) {
          statusCode500 = code;
        },
        setHeader() {
          /* noop */
        },
        end() {
          ended500 = true;
        },
      } as unknown as ServerResponse;

      await router.handle(
        { method: 'GET', url: '/dashboard?auth=secret_token' } as IncomingMessage,
        fakeRes,
      );

      assert.equal(statusCode500, 500);
      assert.equal(ended500, true);

      const errorLog = logs.find((l) => l.level === 'error');
      assert.ok(errorLog);
      assert.equal(errorLog.message, 'Unhandled router error while processing request');
      assert.equal(errorLog.meta[0], backendError);
      assert.deepEqual(errorLog.meta[1], {
        path: '/dashboard',
        method: 'GET',
        statusCode: 500,
      });
    });

    void it('should format 500 router errors through real Winston logger with Error Detail first, Call Stack next, and Caused by:', async () => {
      const stream = new MemoryLogStream();
      const realLogger = createAppLogger({
        level: 'debug',
        transports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });

      const nestedCause = new Error('Database connection failed');
      const backendError = new Error('Storage cluster unreachable', { cause: nestedCause });

      const failingStorage: StorageService = {
        streamFile: () => Promise.reject(backendError),
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({
        storageService: failingStorage,
        logger: realLogger,
      });

      const fakeRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          /* noop */
        },
      } as unknown as ServerResponse;

      await router.handle(
        { method: 'GET', url: '/dashboard?auth=secret_token' } as IncomingMessage,
        fakeRes,
      );

      const output = stream.output;
      assert.ok(
        output.includes('[error]: Unhandled router error while processing request'),
        `Expected error message in output, got: ${output}`,
      );
      assert.ok(
        output.includes('Path: /dashboard'),
        `Expected sanitized path in output, got: ${output}`,
      );
      assert.ok(!output.includes('secret_token'), 'Query parameter must not leak into logs');
      assert.ok(
        output.includes('Error Detail: Error: Storage cluster unreachable'),
        `Expected Error Detail in output, got: ${output}`,
      );
      assert.ok(
        output.includes('Call Stack:'),
        `Expected Call Stack header in output, got: ${output}`,
      );
      assert.ok(
        output.includes('Caused by: Error: Database connection failed'),
        `Expected Caused by in output, got: ${output}`,
      );

      const errorDetailIdx = output.indexOf('Error Detail:');
      const callStackIdx = output.indexOf('Call Stack:');
      const causedByIdx = output.indexOf('Caused by: Error: Database connection failed');

      assert.ok(
        errorDetailIdx < callStackIdx,
        `Error Detail must precede Call Stack: ${String(errorDetailIdx)} vs ${String(callStackIdx)}`,
      );
      assert.ok(
        callStackIdx < causedByIdx,
        `Call Stack must precede Caused by: ${String(callStackIdx)} vs ${String(causedByIdx)}`,
      );
    });

    void it('should log the same Cache-Control directive that the real storage layer sends', async () => {
      const { logger, decisions } = createCapturingLogger();
      const cacheFiles = new Map<string, MockFileOptions>([
        ['resume_cloudbuild/angular/main-5T7P2N6K.js', { content: 'console.log(1);' }],
        ['resume_cloudbuild/angular/styles.css', { content: 'body{}' }],
      ]);
      const realStorage = new GcsStorageService(testConfig, createMockStorage(cacheFiles));
      const handler = createRouter({ storageService: realStorage, logger });
      const server = http.createServer((req, res) => {
        void handler(req, res);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve();
        });
      });
      const port = (server.address() as AddressInfo).port;

      try {
        for (const assetPath of ['/main-5T7P2N6K.js', '/styles.css']) {
          decisions.length = 0;
          const res = await performHttpRequest(port, { path: assetPath });
          assert.equal(res.statusCode, 200);

          const decision = decisions.find(
            (d) => d.action === 'Router' && d.choice.startsWith('stream static asset'),
          );
          assert.ok(decision, `Expected static asset decision for ${assetPath}`);
          assert.equal(decision.cacheControl, res.headers['cache-control']);
        }
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    });

    void it('should emit router-level summary 405 decision even when custom httpMethodValidator is injected', async () => {
      const { logger, decisions } = createCapturingLogger();
      const customMethodValidator = {
        validate: (_req: IncomingMessage, res: ServerResponse): boolean => {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return false;
        },
      };

      const mockStorage: StorageService = {
        streamFile: () => Promise.resolve(),
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({
        storageService: mockStorage,
        httpMethodValidator: customMethodValidator,
        logger,
      });

      const fakeRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          /* noop */
        },
      } as unknown as ServerResponse;

      await router.handle({ method: 'POST', url: '/main.js' } as IncomingMessage, fakeRes);

      const router405 = decisions.find(
        (d) => d.action === 'Router' && d.choice === 'reject request (405)',
      );
      assert.ok(router405, 'Router must emit 405 summary decision');
      assert.equal(router405.level, 'warn');
      assert.equal(router405.statusCode, 405);
      assert.equal(router405.method, 'POST');
    });

    void it('should emit router-level summary 400 decision even when custom pathSanitizer is injected', async () => {
      const { logger, decisions } = createCapturingLogger();
      const customSanitizer = {
        validateAndSanitize: () => ({
          valid: false,
          path: '',
          error: 'Custom rejection reason',
        }),
      };

      const mockStorage: StorageService = {
        streamFile: () => Promise.resolve(),
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({
        storageService: mockStorage,
        pathSanitizer: customSanitizer,
        logger,
      });

      const fakeRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          /* noop */
        },
      } as unknown as ServerResponse;

      await router.handle({ method: 'GET', url: '/invalid-path' } as IncomingMessage, fakeRes);

      const router400 = decisions.find(
        (d) => d.action === 'Router' && d.choice === 'reject request (400)',
      );
      assert.ok(router400, 'Router must emit 400 summary decision');
      assert.equal(router400.level, 'warn');
      assert.equal(router400.statusCode, 400);
      assert.equal(router400.reason, 'Custom rejection reason');
    });

    void it('should prevent control-character log injection and ANSI escape sequences in console output for hostile URLs', async () => {
      const stream = new MemoryLogStream();
      const realLogger = createAppLogger({
        level: 'debug',
        transports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });

      const mockStorage: StorageService = {
        streamFile: () => Promise.resolve(),
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({
        storageService: mockStorage,
        logger: realLogger,
      });

      const fakeRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          /* noop */
        },
      } as unknown as ServerResponse;

      // Hostile URL with encoded newline, ANSI color escapes, and fake log line
      const hostileUrl = '/profile%0a2026-10-08T00:00:00.000Z [error]: FAKE ENTRY%1b[31mRED';
      await router.handle({ method: 'GET', url: hostileUrl } as IncomingMessage, fakeRes);

      const output = stream.output;
      // Must not contain unescaped newline creating a new forged line starting with [error]
      assert.ok(
        !output.includes('\n2026-10-08T00:00:00.000Z [error]: FAKE ENTRY'),
        'Hostile newline must not create forged log line',
      );
      // Must not contain raw ANSI escape code
      assert.ok(!output.includes('\x1b[31m'), 'Hostile ANSI escape must not be printed raw');
      // Must contain safely escaped representation
      assert.ok(
        output.includes('\\n2026-10-08T00:00:00.000Z [error]: FAKE ENTRY\\x1b[31mRED') ||
          output.includes('\\n'),
        `Expected escaped representation in output, got: ${output}`,
      );
    });

    void it('should preserve non-Error throwables without flattening to [object Object]', async () => {
      const { logger, logs } = createCapturingLogger();
      const customThrowable = { code: 503, reason: 'GCS backend timeout' };

      const failingStorage: StorageService = {
        streamFile: () => Promise.reject(customThrowable),
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router({
        storageService: failingStorage,
        logger,
      });

      const fakeRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        statusCode: 200,
        setHeader() {
          /* noop */
        },
        end() {
          /* noop */
        },
      } as unknown as ServerResponse;

      await router.handle({ method: 'GET', url: '/main.js' } as IncomingMessage, fakeRes);

      const errorLog = logs.find((l) => l.level === 'error');
      assert.ok(errorLog);
      assert.equal(errorLog.meta[0], customThrowable);
    });

    void it('should emit exact decision key order for static asset, SPA fallback, method reject, and path reject', async () => {
      const { logger, decisions } = createCapturingLogger();
      const mockStorage: StorageService = {
        streamFile: () => Promise.resolve(),
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const router = new Router(mockStorage, { logger });

      const createFakeRes = () =>
        ({
          headersSent: false,
          destroyed: false,
          writableEnded: false,
          statusCode: 200,
          setHeader() {},
          end() {},
        }) as unknown as ServerResponse;

      // 1. Static asset
      await router.handle(
        { method: 'GET', url: '/styles.css' } as IncomingMessage,
        createFakeRes(),
      );
      const staticDec = decisions.find(
        (d) => d.action === 'Router' && d.choice.startsWith('stream static asset'),
      );
      assert.ok(staticDec);
      assert.deepEqual(Object.keys(staticDec), [
        'action',
        'choice',
        'reason',
        'level',
        'path',
        'contentType',
        'isHashed',
        'cacheControl',
        'isHead',
      ]);

      // 2. SPA fallback
      await router.handle({ method: 'GET', url: '/dashboard' } as IncomingMessage, createFakeRes());
      const spaDec = decisions.find(
        (d) => d.action === 'Router' && d.choice === 'SPA fallback (index.html)',
      );
      assert.ok(spaDec);
      assert.deepEqual(Object.keys(spaDec), [
        'action',
        'choice',
        'reason',
        'level',
        'path',
        'fallbackTarget',
        'isHead',
      ]);

      // 3. Method reject
      await router.handle({ method: 'POST', url: '/' } as IncomingMessage, createFakeRes());
      const methodDec = decisions.find(
        (d) => d.action === 'Router' && d.choice === 'reject request (405)',
      );
      assert.ok(methodDec);
      assert.deepEqual(Object.keys(methodDec), [
        'action',
        'choice',
        'reason',
        'level',
        'method',
        'allowedMethods',
        'statusCode',
        'path',
      ]);

      // 4. Path reject
      await router.handle(
        { method: 'GET', url: '/../etc/passwd' } as IncomingMessage,
        createFakeRes(),
      );
      const pathDec = decisions.find(
        (d) => d.action === 'Router' && d.choice === 'reject request (400)',
      );
      assert.ok(pathDec);
      assert.deepEqual(Object.keys(pathDec), [
        'action',
        'choice',
        'reason',
        'level',
        'path',
        'statusCode',
      ]);
    });

    void it('should set Content-Length on /health responses for both GET and HEAD', async () => {
      const { logger } = createCapturingLogger();
      const headers: Record<string, string> = {};
      const fakeRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        statusCode: 200,
        setHeader(name: string, value: string) {
          headers[name.toLowerCase()] = String(value);
        },
        end() {},
      } as unknown as ServerResponse;

      const handler = new DefaultHealthCheckHandler(undefined, logger);
      const handledGet = handler.handle('health', fakeRes, false);
      assert.equal(handledGet, true);
      assert.ok(headers['content-length']);
      const getLen = Number(headers['content-length']);
      assert.ok(getLen > 0);

      const handledHead = handler.handle('health', fakeRes, true);
      assert.equal(handledHead, true);
      assert.ok(headers['content-length']);
    });
  });

  /**
   * End-to-end integration tests verifying multi-version recursive asset delivery,
   * timestamp sorting (newest first), direct precedence, deeply nested artifacts,
   * root prefix configuration, unversioned fallbacks, SPA routing, and GCS listing failures over real HTTP.
   */
  void describe('End-to-End Multi-Version Timestamped Asset Delivery Integration Tests', () => {
    let multiVersionServer: http.Server;
    let multiVersionPort: number;

    const multiVersionFiles = new Map<string, MockFileOptions>([
      // Multi-version deployments: v1 (old) vs v2 (new)
      [
        'resume_cloudbuild/angular/1710000000_v1/dist/browser/main.js',
        {
          content: 'console.log("v1-main");',
          metadata: { etag: 'etag-v1-main' },
        },
      ],
      [
        'resume_cloudbuild/angular/1720000000_v2/dist/browser/main.js',
        {
          content: 'console.log("v2-main");',
          metadata: { etag: 'etag-v2-main' },
        },
      ],
      [
        'resume_cloudbuild/angular/1715000000_v1.5/dist/browser/main.js',
        {
          content: 'console.log("v1.5-main");',
          metadata: { etag: 'etag-v1.5-main' },
        },
      ],
      // Multi-version index.html
      [
        'resume_cloudbuild/angular/1710000000_v1/dist/browser/index.html',
        {
          content:
            '<!DOCTYPE html><html><head><title>Resume v1</title></head><body>V1 App</body></html>',
          metadata: { etag: 'etag-v1-index' },
        },
      ],
      [
        'resume_cloudbuild/angular/1720000000_v2/dist/browser/index.html',
        {
          content:
            '<!DOCTYPE html><html><head><title>Resume v2</title></head><body>V2 App</body></html>',
          metadata: { etag: 'etag-v2-index' },
        },
      ],
      // Direct vs nested collision: direct root file must take precedence over newer nested version
      [
        'resume_cloudbuild/angular/direct-precedence.js',
        {
          content: 'console.log("direct-root-hit");',
          metadata: { etag: 'etag-direct-root' },
        },
      ],
      [
        'resume_cloudbuild/angular/1730000000_future/dist/browser/direct-precedence.js',
        {
          content: 'console.log("future-nested-shadowed");',
          metadata: { etag: 'etag-future-nested' },
        },
      ],
      // Deeply nested hashed and unhashed assets
      [
        'resume_cloudbuild/angular/1725000000_rel/dist/browser/nested/deep/artifacts/chunk-5T7P2N6K.js',
        {
          content: 'console.log("deep-chunk-hashed");',
          metadata: { etag: 'etag-deep-chunk' },
        },
      ],
      [
        'resume_cloudbuild/angular/1725000000_rel/assets/deeply/nested/styles-5INURTSO.css',
        {
          content: 'body { color: blue; }',
          metadata: { etag: 'etag-deep-css' },
        },
      ],
      [
        'resume_cloudbuild/angular/1725000000_rel/images/subfolder/logo.png',
        {
          content: 'binary-logo-data',
          metadata: { etag: 'etag-logo-png' },
        },
      ],
      // Nested assets in subdirectories (including same basename across subdirectories)
      [
        'resume_cloudbuild/angular/1725000000_rel/assets/i18n/en/flag.png',
        {
          content: 'en-flag-png',
          metadata: { etag: 'etag-i18n-en' },
        },
      ],
      [
        'resume_cloudbuild/angular/1725000000_rel/assets/i18n/fr/flag.png',
        {
          content: 'fr-flag-png',
          metadata: { etag: 'etag-i18n-fr' },
        },
      ],
      [
        'resume_cloudbuild/angular/1725000000_rel/media/fonts/font-6G54T7R3.woff2',
        {
          content: 'binary-font-woff2',
          metadata: { etag: 'etag-font-woff2' },
        },
      ],
      // Same-deployment exact vs deeper duplicates
      [
        'resume_cloudbuild/angular/1725000000_rel/assets/brand/badge.png',
        {
          content: 'exact-brand-badge',
          metadata: { etag: 'etag-exact-brand-badge' },
        },
      ],
      [
        'resume_cloudbuild/angular/1725000000_rel/a/assets/brand/badge.png',
        {
          content: 'deeper-brand-badge',
          metadata: { etag: 'etag-deeper-brand-badge' },
        },
      ],
      // Same-deployment root vs nested duplicate
      [
        'resume_cloudbuild/angular/1725000000_rel/favicon.ico',
        {
          content: 'root-favicon-data',
          metadata: { etag: 'etag-root-favicon' },
        },
      ],
      [
        'resume_cloudbuild/angular/1725000000_rel/assets/favicon.ico',
        {
          content: 'nested-assets-favicon-data',
          metadata: { etag: 'etag-nested-assets-favicon' },
        },
      ],
      // Same-deployment root override vs dist copy
      [
        'resume_cloudbuild/angular/1720000000_v2/runtime-config.js',
        {
          content: 'console.log("v2-root-runtime-config");',
          metadata: { etag: 'etag-root-runtime-config' },
        },
      ],
      [
        'resume_cloudbuild/angular/1720000000_v2/dist/runtime-config.js',
        {
          content: 'console.log("v2-dist-runtime-config");',
          metadata: { etag: 'etag-dist-runtime-config' },
        },
      ],
      // Non-timestamped / unversioned directory mixed with timestamped
      [
        'resume_cloudbuild/angular/unversioned_backup/common.js',
        {
          content: 'console.log("unversioned-common");',
          metadata: { etag: 'etag-unversioned-common' },
        },
      ],
      [
        'resume_cloudbuild/angular/1720000000_v2/dist/common.js',
        {
          content: 'console.log("v2-common");',
          metadata: { etag: 'etag-v2-common' },
        },
      ],
      [
        'resume_cloudbuild/angular/dist_legacy/legacy-only.js',
        {
          content: 'console.log("legacy-only-content");',
          metadata: { etag: 'etag-legacy-only' },
        },
      ],
    ]);

    const startMultiVersionServer = (): Promise<void> =>
      new Promise((resolve) => {
        const storageService = new GcsStorageService({
          config: testConfig,
          storageClient: createMockStorage(multiVersionFiles),
          logger: silentLogger,
        });
        const handler = createRouter({ storageService, logger: silentLogger });
        multiVersionServer = http.createServer((req, res) => {
          void handler(req, res);
        });
        multiVersionServer.listen(0, '127.0.0.1', () => {
          const addr = multiVersionServer.address() as AddressInfo;
          multiVersionPort = addr.port;
          resolve();
        });
      });

    const stopMultiVersionServer = (): Promise<void> =>
      new Promise((resolve) => {
        multiVersionServer.closeAllConnections?.();
        multiVersionServer.close(() => {
          resolve();
        });
      });

    before(async () => {
      await startMultiVersionServer();
    });

    after(async () => {
      await stopMultiVersionServer();
    });

    void it('should prioritize newest timestamped deployment when serving static assets over real HTTP GET and HEAD (multi-version)', async () => {
      // GET /main.js
      const getRes = await performHttpRequest(multiVersionPort, { path: '/main.js' });
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.equal(getRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
      assert.equal(getRes.headers.etag, '"etag-v2-main"');
      assert.equal(getRes.headers['content-length'], '23');
      assert.equal(getRes.headers['x-content-type-options'], 'nosniff');
      assert.equal(getRes.headers['x-frame-options'], 'SAMEORIGIN');
      assert.equal(getRes.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.equal(getRes.body, 'console.log("v2-main");');

      // HEAD /main.js
      const headRes = await performHttpRequest(multiVersionPort, {
        path: '/main.js',
        method: 'HEAD',
      });
      assert.equal(headRes.statusCode, 200);
      assert.equal(headRes.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.equal(headRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
      assert.equal(headRes.headers.etag, '"etag-v2-main"');
      assert.equal(headRes.headers['content-length'], '23');
      assert.equal(headRes.body, '');
    });

    void it('should prioritize direct root prefix file over newer timestamped deployments (direct precedence)', async () => {
      // GET /direct-precedence.js
      const getRes = await performHttpRequest(multiVersionPort, { path: '/direct-precedence.js' });
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.equal(getRes.headers.etag, '"etag-direct-root"');
      assert.equal(getRes.headers['content-length'], '31');
      assert.equal(getRes.body, 'console.log("direct-root-hit");');

      // HEAD /direct-precedence.js
      const headRes = await performHttpRequest(multiVersionPort, {
        path: '/direct-precedence.js',
        method: 'HEAD',
      });
      assert.equal(headRes.statusCode, 200);
      assert.equal(headRes.headers.etag, '"etag-direct-root"');
      assert.equal(headRes.headers['content-length'], '31');
      assert.equal(headRes.body, '');
    });

    void it('should locate and stream deeply nested hashed and unhashed assets in timestamped deployment directories', async () => {
      // Deeply nested hashed JS asset -> immutable cache
      const jsRes = await performHttpRequest(multiVersionPort, { path: '/chunk-5T7P2N6K.js' });
      assert.equal(jsRes.statusCode, 200);
      assert.equal(jsRes.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.equal(jsRes.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(jsRes.headers.etag, '"etag-deep-chunk"');
      assert.equal(jsRes.headers['content-length'], '33');
      assert.equal(jsRes.body, 'console.log("deep-chunk-hashed");');

      // Deeply nested hashed CSS asset -> immutable cache
      const cssRes = await performHttpRequest(multiVersionPort, { path: '/styles-5INURTSO.css' });
      assert.equal(cssRes.statusCode, 200);
      assert.equal(cssRes.headers['content-type'], 'text/css; charset=utf-8');
      assert.equal(cssRes.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(cssRes.headers.etag, '"etag-deep-css"');
      assert.equal(cssRes.headers['content-length'], '21');
      assert.equal(cssRes.body, 'body { color: blue; }');

      // Deeply nested unhashed image -> no-cache revalidate
      const imgRes = await performHttpRequest(multiVersionPort, { path: '/logo.png' });
      assert.equal(imgRes.statusCode, 200);
      assert.equal(imgRes.headers['content-type'], 'image/png');
      assert.equal(imgRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
      assert.equal(imgRes.headers.etag, '"etag-logo-png"');
      assert.equal(imgRes.headers['content-length'], '16');
      assert.equal(imgRes.body, 'binary-logo-data');
    });

    void it('should serve nested static assets with 200 OK and correct MIME types and disambiguate identically named assets in subdirectories over real HTTP', async () => {
      // 1. Nested unhashed PNG asset: /assets/i18n/en/flag.png
      const enRes = await performHttpRequest(multiVersionPort, {
        path: '/assets/i18n/en/flag.png',
      });
      assert.equal(enRes.statusCode, 200);
      assert.equal(enRes.headers['content-type'], 'image/png');
      assert.equal(enRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
      assert.equal(enRes.headers.etag, '"etag-i18n-en"');
      assert.equal(enRes.headers['content-length'], '11');
      assert.equal(enRes.body, 'en-flag-png');

      // 2. Disambiguated nested unhashed PNG asset with same basename: /assets/i18n/fr/flag.png
      const frRes = await performHttpRequest(multiVersionPort, {
        path: '/assets/i18n/fr/flag.png',
      });
      assert.equal(frRes.statusCode, 200);
      assert.equal(frRes.headers['content-type'], 'image/png');
      assert.equal(frRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
      assert.equal(frRes.headers.etag, '"etag-i18n-fr"');
      assert.equal(frRes.headers['content-length'], '11');
      assert.equal(frRes.body, 'fr-flag-png');

      // 3. Nested hashed font asset: /media/fonts/font-6G54T7R3.woff2
      const fontRes = await performHttpRequest(multiVersionPort, {
        path: '/media/fonts/font-6G54T7R3.woff2',
      });
      assert.equal(fontRes.statusCode, 200);
      assert.equal(fontRes.headers['content-type'], 'font/woff2');
      assert.equal(fontRes.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(fontRes.headers.etag, '"etag-font-woff2"');
      assert.equal(fontRes.headers['content-length'], '17');
      assert.equal(fontRes.body, 'binary-font-woff2');

      // 4. Nested hashed font asset HEAD: /media/fonts/font-6G54T7R3.woff2
      const headFontRes = await performHttpRequest(multiVersionPort, {
        path: '/media/fonts/font-6G54T7R3.woff2',
        method: 'HEAD',
      });
      assert.equal(headFontRes.statusCode, 200);
      assert.equal(headFontRes.headers['content-type'], 'font/woff2');
      assert.equal(headFontRes.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(headFontRes.headers.etag, '"etag-font-woff2"');
      assert.equal(headFontRes.headers['content-length'], '17');
      assert.equal(headFontRes.body, '');
    });

    void it('should prioritize exact relative path over deeper path duplicate in same deployment over HTTP', async () => {
      // /assets/brand/badge.png matches both 1725000000_rel/assets/brand/badge.png and 1725000000_rel/a/assets/brand/badge.png
      const res = await performHttpRequest(multiVersionPort, {
        path: '/assets/brand/badge.png',
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'image/png');
      assert.equal(res.headers.etag, '"etag-exact-brand-badge"');
      assert.equal(res.body, 'exact-brand-badge');
    });

    void it('should prioritize root asset over nested duplicate when root asset is requested over HTTP', async () => {
      // /favicon.ico matches both 1725000000_rel/favicon.ico and 1725000000_rel/assets/favicon.ico
      const res = await performHttpRequest(multiVersionPort, {
        path: '/favicon.ico',
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'image/x-icon');
      assert.equal(res.headers.etag, '"etag-root-favicon"');
      assert.equal(res.body, 'root-favicon-data');
    });

    void it('should prioritize root copy over dist copy in same deployment and resolve fallback-only dist/main.js over HTTP', async () => {
      // /runtime-config.js matches both 1720000000_v2/runtime-config.js and 1720000000_v2/dist/runtime-config.js
      const rootOverrideRes = await performHttpRequest(multiVersionPort, {
        path: '/runtime-config.js',
      });
      assert.equal(rootOverrideRes.statusCode, 200);
      assert.equal(rootOverrideRes.headers.etag, '"etag-root-runtime-config"');
      assert.equal(rootOverrideRes.body, 'console.log("v2-root-runtime-config");');

      // /main.js only exists in dist/browser/main.js in 1720000000_v2 -> resolves correctly
      const mainRes = await performHttpRequest(multiVersionPort, {
        path: '/main.js',
      });
      assert.equal(mainRes.statusCode, 200);
      assert.equal(mainRes.headers.etag, '"etag-v2-main"');
      assert.equal(mainRes.body, 'console.log("v2-main");');
    });

    void it('should prioritize timestamped deployments over unversioned directories, but fallback to unversioned when no timestamped match exists', async () => {
      // /common.js exists in both 1720000000_v2 and unversioned_backup -> selects 1720000000_v2
      const commonRes = await performHttpRequest(multiVersionPort, { path: '/common.js' });
      assert.equal(commonRes.statusCode, 200);
      assert.equal(commonRes.headers.etag, '"etag-v2-common"');
      assert.equal(commonRes.body, 'console.log("v2-common");');

      // /legacy-only.js exists ONLY in dist_legacy -> falls back to unversioned folder
      const legacyRes = await performHttpRequest(multiVersionPort, { path: '/legacy-only.js' });
      assert.equal(legacyRes.statusCode, 200);
      assert.equal(legacyRes.headers.etag, '"etag-legacy-only"');
      assert.equal(legacyRes.body, 'console.log("legacy-only-content");');
    });

    void it('should route root / and SPA navigation to relocated index.html from newest timestamped deployment', async () => {
      // GET / -> serves newest v2 index.html
      const rootRes = await performHttpRequest(multiVersionPort, { path: '/' });
      assert.equal(rootRes.statusCode, 200);
      assert.equal(rootRes.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(rootRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
      assert.equal(rootRes.headers.etag, '"etag-v2-index"');
      assert.ok(rootRes.body.includes('<title>Resume v2</title>'));

      // GET /experience -> serves newest v2 index.html
      const navRes = await performHttpRequest(multiVersionPort, { path: '/experience' });
      assert.equal(navRes.statusCode, 200);
      assert.equal(navRes.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(navRes.headers['cache-control'], 'public, max-age=0, must-revalidate');
      assert.equal(navRes.headers.etag, '"etag-v2-index"');
      assert.ok(navRes.body.includes('<title>Resume v2</title>'));

      // HEAD /experience -> serves 200 with empty body and matching headers
      const headNavRes = await performHttpRequest(multiVersionPort, {
        path: '/experience',
        method: 'HEAD',
      });
      assert.equal(headNavRes.statusCode, 200);
      assert.equal(headNavRes.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(headNavRes.headers['content-length'], '84');
      assert.equal(headNavRes.headers.etag, '"etag-v2-index"');
      assert.equal(headNavRes.body, '');
    });

    void it('should stream relocated assets and SPA fallback when GCS_PREFIX is configured as empty root', async () => {
      const rootPrefixFiles = new Map<string, MockFileOptions>([
        [
          '1720000000_v2/dist/browser/app-bundle.js',
          {
            content: 'console.log("root-prefix-bundle");',
            metadata: { etag: 'etag-root-bundle', size: 34 },
          },
        ],
        [
          '1720000000_v2/dist/browser/index.html',
          {
            content: '<!DOCTYPE html><html><title>Root Prefix Resume</title></html>',
            metadata: { etag: 'etag-root-index', size: 61 },
          },
        ],
      ]);

      const rootPrefixStorage = new GcsStorageService({
        config: { ...testConfig, prefix: '' },
        storageClient: createMockStorage(rootPrefixFiles),
        logger: silentLogger,
      });

      let rootServer: http.Server;
      let rootPort = 0;

      await new Promise<void>((resolve) => {
        const handler = createRouter({ storageService: rootPrefixStorage, logger: silentLogger });
        rootServer = http.createServer((req, res) => {
          void handler(req, res);
        });
        rootServer.listen(0, '127.0.0.1', () => {
          const addr = rootServer.address() as AddressInfo;
          rootPort = addr.port;
          resolve();
        });
      });

      try {
        // GET /app-bundle.js
        const assetRes = await performHttpRequest(rootPort, { path: '/app-bundle.js' });
        assert.equal(assetRes.statusCode, 200);
        assert.equal(assetRes.headers['content-type'], 'application/javascript; charset=utf-8');
        assert.equal(assetRes.headers.etag, '"etag-root-bundle"');
        assert.equal(assetRes.body, 'console.log("root-prefix-bundle");');

        // GET /dashboard (SPA route)
        const spaRes = await performHttpRequest(rootPort, { path: '/dashboard' });
        assert.equal(spaRes.statusCode, 200);
        assert.equal(spaRes.headers['content-type'], 'text/html; charset=utf-8');
        assert.ok(spaRes.body.includes('<title>Root Prefix Resume</title>'));
      } finally {
        await new Promise<void>((resolve) => {
          rootServer.closeAllConnections?.();
          rootServer.close(() => {
            resolve();
          });
        });
      }
    });

    void it('should return 404 Not Found for missing static assets without falling back to index.html', async () => {
      // GET missing asset
      const getRes = await performHttpRequest(multiVersionPort, { path: '/nonexistent-asset.js' });
      assert.equal(getRes.statusCode, 404);
      assert.equal(getRes.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(getRes.headers['x-content-type-options'], 'nosniff');
      assert.equal(getRes.headers['x-frame-options'], 'SAMEORIGIN');
      assert.equal(getRes.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.equal(getRes.body, 'Not Found');

      // HEAD missing asset
      const headRes = await performHttpRequest(multiVersionPort, {
        path: '/nonexistent-asset.js',
        method: 'HEAD',
      });
      assert.equal(headRes.statusCode, 404);
      assert.equal(headRes.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(headRes.body, '');
    });

    void it('should return 502 Bad Gateway when recursive GCS listing fails on static asset requests and SPA fallback routes', async () => {
      const failingListingStorage: Storage = {
        bucket: () =>
          ({
            file: (name: string) => createMockFile({ exists: false }, name),
            getFiles: () =>
              Promise.reject(
                Object.assign(new Error('Storage service unavailable'), { code: 503 }),
              ),
          }) as unknown as Bucket,
      } as unknown as Storage;

      const failingService = new GcsStorageService({
        config: testConfig,
        storageClient: failingListingStorage,
        logger: silentLogger,
      });

      let failServer: http.Server;
      let failPort = 0;

      await new Promise<void>((resolve) => {
        const handler = createRouter({ storageService: failingService, logger: silentLogger });
        failServer = http.createServer((req, res) => {
          void handler(req, res);
        });
        failServer.listen(0, '127.0.0.1', () => {
          const addr = failServer.address() as AddressInfo;
          failPort = addr.port;
          resolve();
        });
      });

      try {
        // GET missing static asset when getFiles fails -> 502
        const getAssetRes = await performHttpRequest(failPort, { path: '/bundle.js' });
        assert.equal(getAssetRes.statusCode, 502);
        assert.equal(getAssetRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(getAssetRes.headers['x-content-type-options'], 'nosniff');
        assert.equal(getAssetRes.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(getAssetRes.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal(getAssetRes.body, 'Bad Gateway');

        // HEAD missing static asset when getFiles fails -> 502
        const headAssetRes = await performHttpRequest(failPort, {
          path: '/bundle.js',
          method: 'HEAD',
        });
        assert.equal(headAssetRes.statusCode, 502);
        assert.equal(headAssetRes.body, '');

        // GET SPA navigation route when index.html missing and getFiles fails -> 502
        const getSpaRes = await performHttpRequest(failPort, { path: '/skills' });
        assert.equal(getSpaRes.statusCode, 502);
        assert.equal(getSpaRes.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(getSpaRes.body, 'Bad Gateway');

        // HEAD SPA navigation route -> 502
        const headSpaRes = await performHttpRequest(failPort, {
          path: '/skills',
          method: 'HEAD',
        });
        assert.equal(headSpaRes.statusCode, 502);
        assert.equal(headSpaRes.body, '');
      } finally {
        await new Promise<void>((resolve) => {
          failServer.closeAllConnections?.();
          failServer.close(() => {
            resolve();
          });
        });
      }
    });
  });
});
