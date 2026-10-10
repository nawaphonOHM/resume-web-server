import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import winston from 'winston';
import {
  startServer,
  shutdownServer,
  registerSignalHandlers,
  isMainModule,
  SocketConnectionTracker,
  GracefulShutdownManager,
  SignalHandlerRegistry,
  HttpServerLauncher,
  type ServerInstance,
  type ServerLogger,
} from '../src/index.ts';
import {
  createAppLogger,
  type AppLogger,
  type DecisionLogPayload,
  type LogLevel,
} from '../src/logger/logger.ts';
import type { StorageService } from '../src/storage/storage.ts';
import {
  attachResponseSocketDrainer,
  createShutdownRequestInterceptor,
} from '../src/shutdown/shutdown_interceptor.ts';
import { isResponseWritable } from '../src/http/http_response_state.ts';
import { createHttpRequestHandler } from '../src/server/server_request_handler.ts';
import {
  write500InternalServerError,
  write400BadRequest,
} from '../src/router/router_error_responder.ts';

// Ensure process.env has baseline mock values for server startup in tests
process.env['GCS_BUCKET_NAME'] = 'test-bucket';
process.env['GCS_PREFIX'] = 'test-prefix';

/**
 * Custom memory writable stream to capture formatted log output in tests.
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

/**
 * Creates a test logger writing to a memory stream using createAppLogger.
 */
function createMemoryLogger(
  options: {
    level?: LogLevel;
    silent?: boolean;
  } = {},
): {
  appLogger: AppLogger;
  stream: MemoryLogStream;
} {
  const stream = new MemoryLogStream();

  const appLogger = createAppLogger({
    level: options.level ?? 'debug',
    silent: options.silent,
    transports: [
      new winston.transports.Stream({
        stream,
      }),
    ],
  });

  return {
    appLogger,
    stream,
  };
}

/**
 * Creates a spy logger capturing decision payloads.
 */
function createDecisionSpyLogger(): {
  logger: AppLogger;
  decisions: DecisionLogPayload[];
} {
  const decisions: DecisionLogPayload[] = [];
  const logger: AppLogger = {
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
  return { logger, decisions };
}

/**
 * Snapshot of an HTTP response collected during server integration test requests.
 */
interface MockResponse {
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
 * Executes an HTTP request against a running server on loopback (`127.0.0.1`) and returns the response.
 *
 * @param port - TCP port number of the target test server.
 * @param path - URL path and optional query parameters to request.
 * @param method - HTTP request method (e.g. `'GET'`, `'HEAD'`). Defaults to `'GET'`.
 * @returns A promise resolving to the captured {@link MockResponse}.
 */
function requestHelper(port: number, path: string, method = 'GET'): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

/**
 * Creates a mocked {@link StorageService} implementation for testing server routing and static streaming.
 *
 * @remarks
 * Canned behavior: `streamFile` always responds with status `200`, the given `Content-Type`, a
 * `Cache-Control` of immutable (hashed) or `no-cache` (unhashed), and the body
 * `mock-content-for-<objectName>`; for HEAD requests the body is empty. `fileExists` always resolves
 * `true` and `resolveObjectName` prefixes names with `resume_cloudbuild/angular/`.
 *
 * @returns A mocked {@link StorageService} instance.
 */
const createMockStorageService = (): StorageService => ({
  streamFile: (objectName, res, contentType, isHashed, isHead) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', isHashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (isHead) {
      res.end();
    } else {
      res.end(`mock-content-for-${objectName}`);
    }
    return Promise.resolve();
  },
  fileExists: () => Promise.resolve(true),
  resolveObjectName: (name) => `resume_cloudbuild/angular/${name}`,
});

/**
 * Creates a silent {@link ServerLogger} implementation to suppress diagnostic log output during tests.
 *
 * @returns A {@link ServerLogger} instance with no-op log methods.
 */
const createSilentLogger = (): ServerLogger => ({
  info: () => {
    /* silent in tests */
  },
  error: () => {
    /* silent in tests */
  },
  warn: () => {
    /* silent in tests */
  },
});

/**
 * Integration and unit test suites for server bootstrap, graceful shutdown, socket tracking, and signal traps.
 *
 * @remarks
 * Validates:
 * - Dynamic port allocation, configuration binding, `/health` endpoint serving, and `EADDRINUSE` port collision rejection in {@link startServer}.
 * - Idempotency and isolation of graceful shutdowns via {@link shutdownServer} across single and multiple server instances.
 * - Forced connection termination when shutdown timeout triggers on hanging client sockets.
 * - Fast draining of in-flight keep-alive requests upon shutdown initiation.
 * - Signal trap registration and unbinding for `SIGTERM` and `SIGINT` in {@link registerSignalHandlers}.
 * - Main module entrypoint detection in {@link isMainModule}.
 */
void describe('Server Bootstrap & Lifecycle (server/index.ts)', () => {
  /**
   * Tests for {@link startServer} initialization and basic HTTP request handling.
   *
   * @remarks
   * Verifies dynamic port binding, health probe serving, router integration, and port collision error rejections.
   */
  void describe('startServer & HTTP serving', () => {
    void it('should start HTTP server on dynamic port and respond to /health probe', async () => {
      const mockStorage = createMockStorageService();
      const logger = createSilentLogger();

      const instance: ServerInstance = await startServer({
        config: {
          port: 0,
          host: '127.0.0.1',
          bucketName: 'test-bucket',
          prefix: 'test-prefix',
        },
        storageService: mockStorage,
        bindSignals: false,
        logger,
      });

      try {
        assert.ok(instance.port > 0);
        assert.equal(instance.host, '127.0.0.1');
        assert.equal(instance.config.bucketName, 'test-bucket');

        const healthRes = await requestHelper(instance.port, '/health');
        assert.equal(healthRes.statusCode, 200);
        assert.equal(healthRes.headers['content-type'], 'application/json; charset=utf-8');

        const healthPayload = JSON.parse(healthRes.body) as {
          status: string;
          timestamp: string;
          uptime: number;
        };
        assert.equal(healthPayload.status, 'UP');
        assert.ok(healthPayload.timestamp);
        assert.equal(typeof healthPayload.uptime, 'number');

        // Test static asset streaming through router
        const assetRes = await requestHelper(instance.port, '/main-5T7P2N6K.js');
        assert.equal(assetRes.statusCode, 200);
        assert.equal(assetRes.body, 'mock-content-for-main-5T7P2N6K.js');

        // Test SPA fallback
        const spaRes = await requestHelper(instance.port, '/experience');
        assert.equal(spaRes.statusCode, 200);
        assert.equal(spaRes.body, 'mock-content-for-index.html');
      } finally {
        await instance.close();
      }
    });

    void it('should reject startServer when port is already occupied', async () => {
      const logger = createSilentLogger();
      const instance1 = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger,
      });

      const occupiedPort = instance1.port;

      try {
        await assert.rejects(
          async () => {
            await startServer({
              config: { port: occupiedPort, host: '127.0.0.1' },
              bindSignals: false,
              logger,
            });
          },
          (err: Error) => {
            assert.ok(
              err.message.includes('EADDRINUSE') ||
                (err as { code?: string }).code === 'EADDRINUSE',
            );
            return true;
          },
        );
      } finally {
        await instance1.close();
      }
    });
  });

  /**
   * Tests for {@link shutdownServer} and {@link ServerInstance.close}.
   *
   * @remarks
   * Verifies idle connection cleanup, promise reuse / idempotency, multi-instance isolation,
   * timeout fallback socket destruction, and active request draining.
   */
  void describe('Graceful Shutdown', () => {
    void it('should gracefully close server and idle connections', async () => {
      const logger = createSilentLogger();
      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger,
      });

      const port = instance.port;
      assert.ok(instance.server.listening);

      await instance.close();
      assert.equal(instance.server.listening, false);

      // Subsequent requests should fail because server is closed
      await assert.rejects(async () => {
        await requestHelper(port, '/health');
      });
    });

    void it('should be idempotent across multiple shutdown calls and return the same promise', async () => {
      const logger = createSilentLogger();
      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger,
      });

      const closePromise1 = instance.close();
      const closePromise2 = instance.close();
      const closePromise3 = shutdownServer(instance.server, { exitProcess: false, logger });

      assert.equal(closePromise1, closePromise2);
      assert.equal(closePromise1, closePromise3);

      await closePromise2;
      assert.equal(instance.server.listening, false);
    });

    void it('should isolate shutdown state across multiple concurrent server instances', async () => {
      const logger = createSilentLogger();

      const serverA = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger,
      });

      const serverB = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger,
      });

      try {
        const portA = serverA.port;
        const portB = serverB.port;

        assert.ok(serverA.server.listening);
        assert.ok(serverB.server.listening);

        // Verify both servers are reachable
        const resA1 = await requestHelper(portA, '/health');
        assert.equal(resA1.statusCode, 200);

        const resB1 = await requestHelper(portB, '/health');
        assert.equal(resB1.statusCode, 200);

        // Close server A
        await serverA.close();
        assert.equal(serverA.server.listening, false);

        // Server A is closed, but Server B must STILL be listening and healthy
        assert.equal(serverB.server.listening, true);
        const resB2 = await requestHelper(portB, '/health');
        assert.equal(resB2.statusCode, 200);

        // Subsequent request to server A fails
        await assert.rejects(async () => {
          await requestHelper(portA, '/health');
        });

        // Close server B
        await serverB.close();
        assert.equal(serverB.server.listening, false);

        // Subsequent request to server B fails
        await assert.rejects(async () => {
          await requestHelper(portB, '/health');
        });
      } finally {
        if (serverA.server.listening) {
          await serverA.close();
        }
        if (serverB.server.listening) {
          await serverB.close();
        }
      }
    });

    void it('should force close lingering connections when shutdown timeout elapses', async () => {
      let warnLogged = false;
      const testLogger: ServerLogger = {
        info: () => {
          /* noop */
        },
        error: () => {
          /* noop */
        },
        warn: (msg: string | Error) => {
          const text = typeof msg === 'string' ? msg : msg.message;
          if (text.includes('Shutdown timeout reached')) {
            warnLogged = true;
          }
        },
      };

      let onStreamStarted: () => void;
      const streamStartedPromise = new Promise<void>((resolve) => {
        onStreamStarted = resolve;
      });

      const hangingStorage: StorageService = {
        streamFile: (_obj, res) => {
          onStreamStarted();
          return new Promise<void>((resolve) => {
            res.on('close', () => {
              resolve();
            });
          });
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        storageService: hangingStorage,
        bindSignals: false,
        shutdownTimeoutMs: 50,
        logger: testLogger,
      });

      let clientReq: http.ClientRequest | undefined;
      try {
        // Open an in-flight HTTP GET request that is held open by hangingStorage
        clientReq = http.request({
          hostname: '127.0.0.1',
          port: instance.port,
          path: '/hang.js',
          method: 'GET',
        });
        clientReq.on('error', () => {
          /* expected connection reset on forced destroy */
        });
        clientReq.end();

        // Deterministically await stream entry before initiating shutdown
        await streamStartedPromise;

        await instance.close();
        assert.equal(instance.server.listening, false);
        assert.equal(warnLogged, true);
      } finally {
        clientReq?.destroy();
        if (instance.server.listening) {
          await instance.close();
        }
      }
    });

    void it('should promptly drain active keep-alive requests on graceful close without waiting for timeout', async () => {
      const logger = createSilentLogger();
      let onStreamStarted: () => void;
      const streamStartedPromise = new Promise<void>((resolve) => {
        onStreamStarted = resolve;
      });

      const mockStorage: StorageService = {
        streamFile: (_obj, res) => {
          onStreamStarted();
          return new Promise((resolve) => {
            setTimeout(() => {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/plain');
              res.end('delayed-in-flight-content');
              resolve();
            }, 80);
          });
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        storageService: mockStorage,
        bindSignals: false,
        shutdownTimeoutMs: 5000,
        logger,
      });

      const agent = new http.Agent({ keepAlive: true });
      let responseBody = '';
      let statusCode = 0;

      let clientReq: http.ClientRequest | undefined;
      try {
        clientReq = http.request(
          {
            hostname: '127.0.0.1',
            port: instance.port,
            path: '/test-keep-alive',
            agent,
          },
          (res) => {
            statusCode = res.statusCode ?? 0;
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              responseBody += chunk;
            });
          },
        );
        clientReq.end();

        // Wait until request is actively being processed by the server
        await streamStartedPromise;

        const startTime = Date.now();
        await instance.close();
        const durationMs = Date.now() - startTime;

        agent.destroy();

        assert.equal(statusCode, 200);
        assert.equal(responseBody, 'delayed-in-flight-content');
        assert.equal(instance.server.listening, false);
        // Must drain quickly without waiting for the 5000ms timeout
        assert.ok(
          durationMs < 2000,
          `Expected graceful drain in < 2000ms, but took ${String(durationMs)}ms`,
        );
      } finally {
        agent.destroy();
        clientReq?.destroy();
        if (instance.server.listening) {
          await instance.close();
        }
      }
    });
  });

  /**
   * Tests for {@link registerSignalHandlers}.
   *
   * @remarks
   * Verifies listener binding and cleanup for `SIGTERM` and `SIGINT` process events.
   */
  void describe('registerSignalHandlers', () => {
    void it('should attach and detach SIGTERM and SIGINT listeners cleanly', async () => {
      const logger = createSilentLogger();
      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger,
      });

      const sigtermBefore = process.listenerCount('SIGTERM');
      const sigintBefore = process.listenerCount('SIGINT');

      const unbind = registerSignalHandlers(instance, {
        exitProcess: false,
        logger,
      });

      assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1);
      assert.equal(process.listenerCount('SIGINT'), sigintBefore + 1);

      unbind();

      assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);
      assert.equal(process.listenerCount('SIGINT'), sigintBefore);

      await instance.close();
    });
  });

  /**
   * Unit tests for {@link isMainModule}.
   *
   * @remarks
   * Verifies CLI invocation detection when comparing module URLs and command line arguments.
   */
  void describe('isMainModule', () => {
    void it('should return false when argv1 does not match import.meta.url', () => {
      assert.equal(isMainModule('file:///path/to/server/index.ts', undefined), false);
      assert.equal(
        isMainModule('file:///path/to/server/index.ts', '/path/to/other/script.ts'),
        false,
      );
    });
  });

  /**
   * Unit tests for SOLID server lifecycle components: {@link SocketConnectionTracker}, {@link GracefulShutdownManager}, {@link SignalHandlerRegistry}, {@link HttpServerLauncher}.
   */
  void describe('SOLID Server Lifecycle Components', () => {
    void it('should track socket connections via SocketConnectionTracker', () => {
      const tracker = new SocketConnectionTracker();
      const server = http.createServer();
      tracker.track(server);
      assert.equal(tracker.getSockets().size, 0);
      tracker.destroyAll();
    });

    void it('should manage graceful shutdown via GracefulShutdownManager', async () => {
      const server = http.createServer();
      const shutdownManager = new GracefulShutdownManager();
      assert.equal(shutdownManager.isShuttingDown(server), false);

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve();
        });
      });

      await shutdownManager.shutdown(server, { exitProcess: false, logger: createSilentLogger() });
      assert.equal(shutdownManager.isShuttingDown(server), true);
      assert.equal(server.listening, false);
    });

    void it('should register signals via SignalHandlerRegistry', () => {
      const shutdownManager = new GracefulShutdownManager();
      const registry = new SignalHandlerRegistry(shutdownManager);
      const server = http.createServer();
      const fakeInstance: ServerInstance = {
        server,
        port: 8080,
        host: '127.0.0.1',
        config: { port: 8080, host: '127.0.0.1', bucketName: 'b', prefix: 'p' },
        close: () => Promise.resolve(),
      };

      const sigtermBefore = process.listenerCount('SIGTERM');
      const unbind = registry.register(fakeInstance, {
        exitProcess: false,
        logger: createSilentLogger(),
      });
      assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1);
      unbind();
      assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);
    });

    void it('should instantiate and start server via HttpServerLauncher', async () => {
      const launcher = new HttpServerLauncher();
      const instance = await launcher.start({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger: createSilentLogger(),
        storageService: createMockStorageService(),
      });

      assert.ok(instance.port > 0);
      assert.equal(instance.server.listening, true);
      await instance.close();
    });
  });

  /**
   * Test suite for server lifecycle decision telemetry and structured operational reasons.
   */
  void describe('Server Lifecycle Decision Telemetry', () => {
    void it('should log ServerBinding decision on successful server startup', async () => {
      const { logger, decisions } = createDecisionSpyLogger();
      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1', bucketName: 'my-bucket', prefix: 'my-prefix' },
        bindSignals: false,
        logger,
        storageService: createMockStorageService(),
      });

      try {
        assert.ok(instance.port > 0);
        const bindingDecision = decisions.find((d) => d.action === 'ServerBinding');
        assert.ok(bindingDecision);
        assert.equal(
          bindingDecision.choice,
          `bound to http://${instance.host}:${String(instance.port)}`,
        );
        assert.ok(
          bindingDecision.reason.includes(
            'Server successfully bound to network interface and listening',
          ),
        );
        assert.equal(bindingDecision['port'], instance.port);
        assert.equal(bindingDecision['host'], '127.0.0.1');
        assert.equal(bindingDecision['bucketName'], 'my-bucket');
        assert.equal(bindingDecision['prefix'], 'my-prefix');

        const bootstrapDecision = decisions.find((d) => d.action === 'ServerBootstrap');
        assert.ok(bootstrapDecision);
        assert.equal(bootstrapDecision.choice, 'apply explicit config overrides');
      } finally {
        await instance.close();
      }
    });

    void it('should log ServerBinding failure decision when port is already occupied', async () => {
      const { logger: firstLogger } = createDecisionSpyLogger();
      const instance1 = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger: firstLogger,
        storageService: createMockStorageService(),
      });

      const occupiedPort = instance1.port;
      const { logger: failLogger, decisions } = createDecisionSpyLogger();

      try {
        await assert.rejects(async () => {
          await startServer({
            config: { port: occupiedPort, host: '127.0.0.1' },
            bindSignals: false,
            logger: failLogger,
            storageService: createMockStorageService(),
          });
        });

        const failureDecision = decisions.find(
          (d) => d.action === 'ServerBinding' && d.choice === 'binding failure',
        );
        assert.ok(failureDecision);
        assert.equal(failureDecision.level, 'error');
        assert.ok(failureDecision.reason.includes('failed to bind'));
      } finally {
        await instance1.close();
      }
    });

    void it('should log ServerShutdown decisions during graceful shutdown sequence', async () => {
      const { logger, decisions } = createDecisionSpyLogger();
      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger,
        storageService: createMockStorageService(),
      });

      await instance.close();

      const initiateDecision = decisions.find(
        (d) => d.action === 'ServerShutdown' && d.choice === 'initiate graceful shutdown',
      );
      assert.ok(initiateDecision);
      assert.equal(initiateDecision.level, 'info');

      const completeDecision = decisions.find(
        (d) => d.action === 'ServerShutdown' && d.choice === 'shutdown complete',
      );
      assert.ok(completeDecision);
      assert.equal(completeDecision.level, 'info');
      assert.ok(completeDecision.reason.includes('All active connections drained'));
    });

    void it('should log ServerShutdown timeout forced socket closure decision', async () => {
      const { logger, decisions } = createDecisionSpyLogger();

      let onStreamStarted: () => void;
      const streamStartedPromise = new Promise<void>((resolve) => {
        onStreamStarted = resolve;
      });

      const hangingStorage: StorageService = {
        streamFile: (_obj, res) => {
          onStreamStarted();
          return new Promise<void>((resolve) => {
            res.on('close', () => {
              resolve();
            });
          });
        },
        fileExists: () => Promise.resolve(true),
        resolveObjectName: (n) => n,
      };

      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        shutdownTimeoutMs: 50,
        logger,
        storageService: hangingStorage,
      });

      let clientReq: http.ClientRequest | undefined;
      try {
        // Open an in-flight HTTP GET request that is held open by hangingStorage
        clientReq = http.request({
          hostname: '127.0.0.1',
          port: instance.port,
          path: '/hang.js',
          method: 'GET',
        });
        clientReq.on('error', () => {
          /* expected socket termination */
        });
        clientReq.end();

        // Deterministically await stream entry before initiating shutdown
        await streamStartedPromise;

        await instance.close();

        const forceDecision = decisions.find(
          (d) =>
            d.action === 'ServerShutdown' && d.choice === 'force-destroy remaining connections',
        );
        assert.ok(forceDecision);
        assert.equal(forceDecision.level, 'warn');
        assert.ok(forceDecision.reason.includes('Shutdown timeout reached'));
      } finally {
        clientReq?.destroy();
        if (instance.server.listening) {
          await instance.close();
        }
      }
    });

    void it('should log ProcessSignal decision when OS process signal is intercepted', () => {
      const mockShutdownManager = {
        shutdown: () => Promise.resolve(),
        isShuttingDown: () => false,
      };
      const registry = new SignalHandlerRegistry(mockShutdownManager);
      const server = http.createServer();
      const fakeInstance: ServerInstance = {
        server,
        port: 8080,
        host: '127.0.0.1',
        config: { port: 8080, host: '127.0.0.1', bucketName: 'b', prefix: 'p' },
        close: () => Promise.resolve(),
      };

      const { logger, decisions } = createDecisionSpyLogger();
      const unbind = registry.register(fakeInstance, {
        exitProcess: false,
        logger,
      });

      try {
        process.emit('SIGTERM');
        const signalDecision = decisions.find((d) => d.action === 'ProcessSignal');
        assert.ok(signalDecision);
        assert.equal(signalDecision.choice, 'handle SIGTERM');
        assert.ok(signalDecision.reason.includes('OS signal SIGTERM received'));
      } finally {
        unbind();
      }
    });

    void it('should log ignore duplicate signal when shutdown is already running', () => {
      const mockShutdownManager = {
        shutdown: () => Promise.resolve(),
        isShuttingDown: () => true,
      };
      const registry = new SignalHandlerRegistry(mockShutdownManager);
      const server = http.createServer();
      const fakeInstance: ServerInstance = {
        server,
        port: 8080,
        host: '127.0.0.1',
        config: { port: 8080, host: '127.0.0.1', bucketName: 'b', prefix: 'p' },
        close: () => Promise.resolve(),
      };

      const { logger, decisions } = createDecisionSpyLogger();
      const unbind = registry.register(fakeInstance, {
        exitProcess: false,
        logger,
      });

      try {
        process.emit('SIGINT');
        const dupDecision = decisions.find(
          (d) => d.action === 'ProcessSignal' && d.choice === 'ignore duplicate SIGINT',
        );
        assert.ok(dupDecision);
        assert.ok(dupDecision.reason.includes('already in progress'));
      } finally {
        unbind();
      }
    });

    void it('should log close idle keep-alive connections decision when supported', async () => {
      const server = http.createServer();
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve();
        });
      });
      let closedIdle = false;
      (server as unknown as { closeIdleConnections: () => void }).closeIdleConnections = () => {
        closedIdle = true;
      };
      const shutdownManager = new GracefulShutdownManager();
      const { logger, decisions } = createDecisionSpyLogger();

      await shutdownManager.shutdown(server, { exitProcess: false, logger });
      assert.equal(closedIdle, true);
      const idleDecision = decisions.find(
        (d) => d.action === 'ServerShutdown' && d.choice === 'close idle keep-alive connections',
      );
      assert.ok(idleDecision);
      assert.equal(idleDecision.level, 'debug');
    });

    void it('should log ServerShutdown shutdown failure decision on server close error', async () => {
      const server = http.createServer();
      const shutdownManager = new GracefulShutdownManager();
      const { logger, decisions } = createDecisionSpyLogger();

      server.close = (callback?: (err?: Error) => void) => {
        callback?.(new Error('Simulated close error'));
        return server;
      };

      await assert.rejects(async () => {
        await shutdownManager.shutdown(server, { exitProcess: false, logger });
      }, /Simulated close error/);

      const failDecision = decisions.find(
        (d) => d.action === 'ServerShutdown' && d.choice === 'shutdown failure',
      );
      assert.ok(failDecision);
      assert.equal(failDecision.level, 'error');
      assert.ok(failDecision.reason.includes('Simulated close error'));
    });

    void it('should support minimal ServerLogger (without decision) via toAppLogger adapter', async () => {
      const infoLogs: string[] = [];
      const errorLogs: { msg: string | Error; errObj?: unknown }[] = [];
      const minimalLogger: ServerLogger = {
        info: (msg) => {
          infoLogs.push(msg);
        },
        error: (msg, ...args) => {
          errorLogs.push({ msg, errObj: args[0] });
        },
      };

      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger: minimalLogger,
        storageService: createMockStorageService(),
      });

      assert.ok(instance.port > 0);
      assert.ok(infoLogs.some((l) => l.includes('ServerBinding')));
      assert.equal(
        infoLogs.some((l) => l.includes('Decision [Config]')),
        false,
      );

      const occupiedPort = instance.port;
      await assert.rejects(async () => {
        await startServer({
          config: { port: occupiedPort, host: '127.0.0.1' },
          bindSignals: false,
          logger: minimalLogger,
          storageService: createMockStorageService(),
        });
      });

      const bindingError = errorLogs.find(
        (e) => typeof e.msg === 'string' && e.msg.includes('ServerBinding'),
      );
      assert.ok(bindingError);
      assert.ok(bindingError.errObj instanceof Error);

      await instance.close();
    });

    void it('should flow config decisions to injected logger during startServer', async () => {
      const { logger, decisions } = createDecisionSpyLogger();
      const instance = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger,
        storageService: createMockStorageService(),
      });

      try {
        const configDecisions = decisions.filter((d) => d.action === 'Config');
        assert.ok(configDecisions.length >= 4);
      } finally {
        await instance.close();
      }
    });
  });

  /**
   * Test suite for Java-style error formatting and Winston integration in Server lifecycle.
   */
  void describe('Server Java-Style Error Formatting & Winston Logger', () => {
    void it('should format server binding error with Java-style call stack when port is occupied', async () => {
      const { appLogger: firstLogger } = createMemoryLogger({ silent: true });
      const instance1 = await startServer({
        config: { port: 0, host: '127.0.0.1' },
        bindSignals: false,
        logger: firstLogger,
        storageService: createMockStorageService(),
      });

      const occupiedPort = instance1.port;
      const { appLogger: winstonLogger, stream } = createMemoryLogger();

      try {
        await assert.rejects(async () => {
          await startServer({
            config: { port: occupiedPort, host: '127.0.0.1' },
            bindSignals: false,
            logger: winstonLogger,
            storageService: createMockStorageService(),
          });
        });

        const output = stream.output;
        assert.ok(output.includes('ServerBinding') || output.includes('binding failure'));
        assert.ok(output.includes('Error Detail:'));
        assert.ok(output.includes('Call Stack:'));
        assert.ok(output.includes('EADDRINUSE') || output.includes('listen'));
      } finally {
        await instance1.close();
      }
    });

    async function runCliProcess(
      scriptPath = 'src/index.ts',
      args: string[] = [],
      envOverrides: Record<string, string | undefined> = {},
      timeoutMs = 10000,
    ): Promise<{ exitCode: number | null; output: string; stdout: string; stderr: string }> {
      const { spawn } = await import('node:child_process');
      const { promises: fs } = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const tempOutFile = path.join(
        os.tmpdir(),
        `test-cli-out-${String(Date.now())}-${String(Math.random()).slice(2)}.txt`,
      );
      const tempErrFile = path.join(
        os.tmpdir(),
        `test-cli-err-${String(Date.now())}-${String(Math.random()).slice(2)}.txt`,
      );
      const outFd = await fs.open(tempOutFile, 'w');
      const errFd = await fs.open(tempErrFile, 'w');

      const effectiveEnv = Object.fromEntries(
        Object.entries({ ...process.env, ...envOverrides }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );

      try {
        const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
          cwd: projectRoot,
          env: effectiveEnv,
          stdio: ['ignore', outFd.fd, errFd.fd],
        });

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`CLI child process timed out after ${String(timeoutMs)}ms`));
          }, timeoutMs);

          child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });

          child.on('close', (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });

        await outFd.close();
        await errFd.close();
        const stdout = await fs.readFile(tempOutFile, 'utf-8');
        const stderr = await fs.readFile(tempErrFile, 'utf-8');
        const output = stdout + stderr;
        return { exitCode, output, stdout, stderr };
      } finally {
        try {
          await outFd.close();
        } catch {
          /* ignore */
        }
        try {
          await errFd.close();
        } catch {
          /* ignore */
        }
        try {
          await fs.unlink(tempOutFile);
        } catch {
          /* ignore */
        }
        try {
          await fs.unlink(tempErrFile);
        } catch {
          /* ignore */
        }
      }
    }

    void it(
      'should exit with code 1 and log missing required environment variables to stderr when run via CLI without GCS env',
      { timeout: 15000 },
      async () => {
        const { exitCode, stderr, output } = await runCliProcess('src/index.ts', [], {
          GCS_BUCKET_NAME: undefined,
          GCS_PREFIX: undefined,
        });

        assert.equal(exitCode, 1);
        assert.ok(
          stderr.includes('Missing required environment variable(s): GCS_BUCKET_NAME, GCS_PREFIX'),
          `Expected missing variable error message on stderr, got stderr: ${stderr}`,
        );
        assert.ok(
          stderr.includes('Please set GCS_BUCKET_NAME and GCS_PREFIX before running the server.'),
        );
        assert.ok(
          output.includes('Missing required environment variable(s): GCS_BUCKET_NAME, GCS_PREFIX'),
        );
      },
    );

    void it(
      'should flush fatal error logs to redirected file before process termination',
      { timeout: 15000 },
      async () => {
        const holder = http.createServer();
        await new Promise<void>((resolve) => {
          holder.listen(0, '127.0.0.1', () => {
            resolve();
          });
        });
        const holderPort = (holder.address() as import('node:net').AddressInfo).port;

        try {
          const { exitCode, output } = await runCliProcess('src/index.ts', [], {
            PORT: String(holderPort),
            HOST: '127.0.0.1',
            GCS_BUCKET_NAME: 'test-bucket',
            GCS_PREFIX: 'test-prefix',
          });

          assert.equal(exitCode, 1);
          assert.ok(output.length > 0, 'Fatal log file should not be empty');
          assert.ok(output.includes('ServerBinding') || output.includes('binding failure'));
          assert.ok(output.includes('Error Detail:'));
          assert.ok(output.includes('Call Stack:'));
        } finally {
          await new Promise<void>((resolve) => {
            holder.close(() => {
              resolve();
            });
          });
        }
      },
    );

    void it(
      'should handle CLI uncaughtException with Error instance, format Java-style error, flush, and exit 1',
      { timeout: 15000 },
      async () => {
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli_fatal.ts', [
          'uncaught-error',
        ]);

        assert.equal(exitCode, 1);
        assert.ok(output.includes('Uncaught Exception:'));
        assert.ok(output.includes('Error Detail:'));
        assert.ok(output.includes('Call Stack:'));
        assert.ok(output.includes('Simulated uncaught exception'));
      },
    );

    void it(
      'should handle CLI uncaughtException with primitive string, format Java-style error, flush, and exit 1',
      { timeout: 15000 },
      async () => {
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli_fatal.ts', [
          'uncaught-string',
        ]);

        assert.equal(exitCode, 1);
        assert.ok(output.includes('Uncaught Exception:'));
        assert.ok(output.includes('Error Detail: Error: Simulated uncaught string error'));
        assert.ok(output.includes('Call Stack:'));
        assert.ok(output.includes('Simulated uncaught string error'));
      },
    );

    void it(
      'should handle CLI unhandledRejection with Error instance, format Java-style error, flush, and exit 1',
      { timeout: 15000 },
      async () => {
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli_fatal.ts', [
          'unhandled-error',
        ]);

        assert.equal(exitCode, 1);
        assert.ok(output.includes('Unhandled Promise Rejection:'));
        assert.ok(output.includes('Error Detail:'));
        assert.ok(output.includes('Call Stack:'));
        assert.ok(output.includes('Simulated unhandled promise rejection'));
      },
    );

    void it(
      'should handle CLI unhandledRejection with non-Error plain object, sanitize secrets, format Java-style error, flush, and exit 1',
      { timeout: 15000 },
      async () => {
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli_fatal.ts', [
          'unhandled-object',
        ]);

        assert.equal(exitCode, 1);
        assert.ok(output.includes('Unhandled Promise Rejection:'));
        assert.ok(output.includes('Error Detail:'));
        assert.ok(output.includes('Call Stack:'));
        assert.ok(!output.includes('[object Object]'), 'Output should not contain [object Object]');
        assert.ok(
          output.includes('500') || output.includes('Plain object rejection reason'),
          'Output should preserve object diagnostic details',
        );
        assert.ok(
          !output.includes('super-secret-token'),
          'Output should not leak sensitive token values',
        );
        assert.ok(
          !output.includes('SECRET-KEY-12345'),
          'Output should not leak sensitive API key values',
        );
        assert.ok(
          !output.includes('authorization'),
          'Output should not leak authorization field name',
        );
        assert.ok(!output.includes('apiKey'), 'Output should not leak apiKey field name');
      },
    );

    void it(
      'should handle CLI unhandledRejection with primitive string, format Java-style error, flush, and exit 1',
      { timeout: 15000 },
      async () => {
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli_fatal.ts', [
          'unhandled-string',
        ]);

        assert.equal(exitCode, 1);
        assert.ok(output.includes('Unhandled Promise Rejection:'));
        assert.ok(output.includes('Error Detail: Error: Plain string rejection reason'));
        assert.ok(output.includes('Call Stack:'));
        assert.ok(output.includes('Plain string rejection reason'));
      },
    );
  });

  /**
   * Regression tests for shutdown socket draining, signal telemetry payloads and `isMainModule` defaults.
   */
  void describe('Lifecycle regressions', () => {
    void it('should end the socket captured at attach time after Node detaches res.socket', () => {
      const socket = new Socket();
      const res = new http.ServerResponse(new http.IncomingMessage(socket));
      res.assignSocket(socket);
      const end = mock.method(socket, 'end', () => socket);
      attachResponseSocketDrainer(res);
      res.detachSocket(socket);
      assert.equal(res.socket, null);
      res.emit('finish');
      assert.equal(end.mock.callCount(), 1);
    });

    void it('should destroy the captured socket when the response closes before ending', () => {
      const socket = new Socket();
      const res = new http.ServerResponse(new http.IncomingMessage(socket));
      res.assignSocket(socket);
      const destroy = mock.method(socket, 'destroy', () => socket);
      attachResponseSocketDrainer(res);
      res.detachSocket(socket);
      res.emit('close');
      assert.equal(destroy.mock.callCount(), 1);
    });

    void it('should capture req.socket when the shutdown interceptor handles a request', () => {
      const socket = new Socket();
      const req = new http.IncomingMessage(socket);
      const res = new http.ServerResponse(req);
      res.assignSocket(socket);
      const end = mock.method(socket, 'end', () => socket);
      createShutdownRequestInterceptor()(req, res);
      res.detachSocket(socket);
      res.emit('finish');
      assert.equal(res.getHeader('Connection'), 'close');
      assert.equal(end.mock.callCount(), 1);
    });

    void it('should log ProcessSignal decision with only signal, timeoutMs and exitProcess extras', () => {
      const manager = { shutdown: () => Promise.resolve(), isShuttingDown: () => false };
      const server = http.createServer();
      const instance: ServerInstance = {
        server,
        port: 8080,
        host: '127.0.0.1',
        config: { port: 8080, host: '127.0.0.1', bucketName: 'b', prefix: 'p' },
        close: () => Promise.resolve(),
        sockets: new Set(),
      };
      const { logger, decisions } = createDecisionSpyLogger();
      const unbind = new SignalHandlerRegistry(manager).register(instance, {
        exitProcess: false,
        shutdownTimeoutMs: 1234,
        logger,
      });
      try {
        process.emit('SIGTERM');
        const payload = decisions.find((d) => d.action === 'ProcessSignal');
        assert.ok(payload);
        const extras = Object.keys(payload)
          .filter((k) => !['action', 'choice', 'reason', 'level'].includes(k))
          .sort();
        assert.deepEqual(extras, ['exitProcess', 'signal', 'timeoutMs']);
        assert.equal(payload['timeoutMs'], 1234);
      } finally {
        unbind();
      }
    });

    void it('should default isMainModule() to the index.ts module URL', () => {
      const indexPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));
      assert.equal(isMainModule(undefined, indexPath), true);
      assert.equal(isMainModule(), false);
    });
  });

  /**
   * Tests for HTTP response writability checks, router error responders, and request dispatcher error handling.
   */
  void describe('HTTP Request Handler & Response Writability State', () => {
    void describe('isResponseWritable', () => {
      void it('should return true when response is writable and not sent/ended/destroyed', () => {
        const fakeRes = {
          headersSent: false,
          destroyed: false,
          writableEnded: false,
        } as unknown as http.ServerResponse;
        assert.equal(isResponseWritable(fakeRes), true);
      });

      void it('should return false when headers have already been sent', () => {
        const fakeRes = {
          headersSent: true,
          destroyed: false,
          writableEnded: false,
        } as unknown as http.ServerResponse;
        assert.equal(isResponseWritable(fakeRes), false);
      });

      void it('should return false when response is destroyed', () => {
        const fakeRes = {
          headersSent: false,
          destroyed: true,
          writableEnded: false,
        } as unknown as http.ServerResponse;
        assert.equal(isResponseWritable(fakeRes), false);
      });

      void it('should return false when writable has ended', () => {
        const fakeRes = {
          headersSent: false,
          destroyed: false,
          writableEnded: true,
        } as unknown as http.ServerResponse;
        assert.equal(isResponseWritable(fakeRes), false);
      });

      void it('should accurately reflect state transitions during HTTP request lifecycle', async () => {
        let capturedRes!: http.ServerResponse;
        const server = http.createServer((_req, res) => {
          capturedRes = res;
          assert.equal(isResponseWritable(res), true);
          res.end('ok');
          assert.equal(isResponseWritable(res), false);
        });

        await new Promise<void>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            http.get(`http://127.0.0.1:${String(addr.port)}/`, (clientRes) => {
              clientRes.resume();
              clientRes.on('end', () => {
                server.close(() => resolve());
              });
            });
          });
        });
        assert.equal(isResponseWritable(capturedRes), false);
      });

      void it('should return false when response socket is destroyed mid-stream', async () => {
        let capturedRes!: http.ServerResponse;
        const server = http.createServer((_req, res) => {
          capturedRes = res;
          assert.equal(isResponseWritable(res), true);
          res.destroy();
          assert.equal(isResponseWritable(res), false);
        });

        await new Promise<void>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            const req = http.get(`http://127.0.0.1:${String(addr.port)}/`);
            req.on('error', () => {
              server.close(() => resolve());
            });
          });
        });
        assert.equal(isResponseWritable(capturedRes), false);
      });
    });

    void describe('write500InternalServerError & write400BadRequest', () => {
      void it('should write 500 Internal Server Error when response is writable', () => {
        let statusCode = 0;
        let ended = false;
        const headers: Record<string, string> = {};
        const fakeRes = {
          headersSent: false,
          destroyed: false,
          writableEnded: false,
          set statusCode(code: number) {
            statusCode = code;
          },
          setHeader(k: string, v: string) {
            headers[k] = v;
          },
          end(body?: string) {
            ended = true;
            assert.equal(body, 'Internal Server Error');
          },
        } as unknown as http.ServerResponse;

        write500InternalServerError(fakeRes);
        assert.equal(statusCode, 500);
        assert.equal(headers['Content-Type'], 'text/plain; charset=utf-8');
        assert.equal(headers['Cache-Control'], 'no-cache');
        assert.equal(ended, true);
      });

      void it('should skip writing 500 when response is not writable', () => {
        let writeAttempted = false;
        const fakeRes = {
          headersSent: true,
          destroyed: false,
          writableEnded: false,
          set statusCode(_code: number) {
            writeAttempted = true;
          },
          setHeader(_k: string, _v: string) {
            writeAttempted = true;
          },
          end(_body?: string) {
            writeAttempted = true;
          },
        } as unknown as http.ServerResponse;

        write500InternalServerError(fakeRes);
        assert.equal(writeAttempted, false);
      });

      void it('should write 400 Bad Request directly to response', () => {
        let statusCode = 0;
        let ended = false;
        const headers: Record<string, string> = {};
        const fakeRes = {
          set statusCode(code: number) {
            statusCode = code;
          },
          setHeader(k: string, v: string) {
            headers[k] = v;
          },
          end(body?: string) {
            ended = true;
            assert.equal(body, 'Bad Request');
          },
        } as unknown as http.ServerResponse;

        write400BadRequest(fakeRes);
        assert.equal(statusCode, 400);
        assert.equal(headers['Content-Type'], 'text/plain; charset=utf-8');
        assert.equal(headers['Cache-Control'], 'no-cache');
        assert.equal(ended, true);
      });

      void it('should skip writing 400 when response is not writable', () => {
        let writeAttempted = false;
        const fakeRes = {
          headersSent: true,
          destroyed: false,
          writableEnded: false,
          set statusCode(_code: number) {
            writeAttempted = true;
          },
          setHeader(_k: string, _v: string) {
            writeAttempted = true;
          },
          end(_body?: string) {
            writeAttempted = true;
          },
        } as unknown as http.ServerResponse;

        write400BadRequest(fakeRes);
        assert.equal(writeAttempted, false);
      });
    });

    void describe('createHttpRequestHandler', () => {
      void it('should catch unhandled router promise rejection, log error with stack, and send 500', async () => {
        const logs: Array<{ message: string; meta: unknown[] }> = [];
        const spyLogger: AppLogger = {
          info: () => {},
          warn: () => {},
          http: () => {},
          debug: () => {},
          decision: () => {},
          error: (msg: string | Error, ...meta: unknown[]) => {
            logs.push({ message: typeof msg === 'string' ? msg : msg.message, meta });
          },
        };

        const routerError = new Error('Unexpected database failure');
        const router = () => Promise.reject(routerError);
        const shutdownManager = { isShuttingDown: () => false };
        const server = http.createServer();
        const handler = createHttpRequestHandler(
          router,
          shutdownManager as unknown as GracefulShutdownManager,
          server,
          spyLogger,
        );

        let statusCode = 0;
        let ended = false;
        const headers: Record<string, string> = {};
        const fakeRes = {
          headersSent: false,
          destroyed: false,
          writableEnded: false,
          set statusCode(code: number) {
            statusCode = code;
          },
          setHeader(k: string, v: string) {
            headers[k] = v;
          },
          end(body?: string) {
            ended = true;
            assert.equal(body, 'Internal Server Error');
          },
          on: () => fakeRes,
        } as unknown as http.ServerResponse;

        const fakeReq = {
          url: '/api/v1/resource?token=secret123',
          method: 'GET',
          socket: new Socket(),
        } as unknown as http.IncomingMessage;

        handler(fakeReq, fakeRes);

        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(statusCode, 500);
        assert.equal(ended, true);
        assert.equal(headers['Content-Type'], 'text/plain; charset=utf-8');
        assert.equal(headers['Cache-Control'], 'no-cache');

        assert.equal(logs.length, 1);
        assert.equal(logs[0].message, 'Unhandled router error while processing request');
        assert.equal(logs[0].meta[0], routerError);
        assert.deepEqual(logs[0].meta[1], {
          path: '/api/v1/resource',
          method: 'GET',
          statusCode: 500,
        });
      });

      void it('should write 500 and not produce unhandled rejection when logger.error throws', async () => {
        const throwingLogger: AppLogger = {
          info: () => {},
          warn: () => {},
          http: () => {},
          debug: () => {},
          decision: () => {},
          error: () => {
            throw new Error('Logger sink crashed');
          },
        };

        const rejections: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
          rejections.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);

        try {
          const routerError = new Error('Database disconnected');
          const router = () => Promise.reject(routerError);
          const shutdownManager = { isShuttingDown: () => false };
          const server = http.createServer();
          const handler = createHttpRequestHandler(
            router,
            shutdownManager as unknown as GracefulShutdownManager,
            server,
            throwingLogger,
          );

          let statusCode = 0;
          let ended = false;
          const headers: Record<string, string> = {};
          const fakeRes = {
            headersSent: false,
            destroyed: false,
            writableEnded: false,
            set statusCode(code: number) {
              statusCode = code;
            },
            setHeader(k: string, v: string) {
              headers[k] = v;
            },
            end(body?: string) {
              ended = true;
              assert.equal(body, 'Internal Server Error');
            },
            on: () => fakeRes,
          } as unknown as http.ServerResponse;

          const fakeReq = {
            url: '/failing/endpoint',
            method: 'GET',
            socket: new Socket(),
          } as unknown as http.IncomingMessage;

          handler(fakeReq, fakeRes);

          await new Promise((resolve) => setImmediate(resolve));

          assert.equal(statusCode, 500);
          assert.equal(ended, true);
          assert.equal(headers['Content-Type'], 'text/plain; charset=utf-8');
          assert.equal(headers['Cache-Control'], 'no-cache');
          assert.equal(rejections.length, 0);
        } finally {
          process.removeListener('unhandledRejection', onUnhandled);
        }
      });

      void it('should still log unhandled router error when response is unwritable without throwing', async () => {
        const logs: Array<{ message: string; meta: unknown[] }> = [];
        const spyLogger: AppLogger = {
          info: () => {},
          warn: () => {},
          http: () => {},
          debug: () => {},
          decision: () => {},
          error: (msg: string | Error, ...meta: unknown[]) => {
            logs.push({ message: typeof msg === 'string' ? msg : msg.message, meta });
          },
        };

        const routerError = new Error('Stream pipe broke');
        const router = () => Promise.reject(routerError);
        const shutdownManager = { isShuttingDown: () => false };
        const server = http.createServer();
        const handler = createHttpRequestHandler(
          router,
          shutdownManager as unknown as GracefulShutdownManager,
          server,
          spyLogger,
        );

        let writeAttempted = false;
        const fakeRes = {
          headersSent: true,
          destroyed: false,
          writableEnded: true,
          set statusCode(_code: number) {
            writeAttempted = true;
          },
          setHeader(_k: string, _v: string) {
            writeAttempted = true;
          },
          end(_body?: string) {
            writeAttempted = true;
          },
          on: () => fakeRes,
        } as unknown as http.ServerResponse;

        const fakeReq = {
          url: '/download/file.tar.gz',
          method: 'GET',
          socket: new Socket(),
        } as unknown as http.IncomingMessage;

        handler(fakeReq, fakeRes);

        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(writeAttempted, false);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].message, 'Unhandled router error while processing request');
        assert.equal(logs[0].meta[0], routerError);
      });

      void it('should format Winston error output with Error Detail and Call Stack on router rejection', async () => {
        const { appLogger, stream } = createMemoryLogger();
        const innerError = new Error('GCS connection reset');
        const routerError = new Error('Unhandled router crash', { cause: innerError });
        const router = () => Promise.reject(routerError);
        const shutdownManager = { isShuttingDown: () => false };
        const server = http.createServer();
        const handler = createHttpRequestHandler(
          router,
          shutdownManager as unknown as GracefulShutdownManager,
          server,
          appLogger,
        );

        const fakeRes = {
          headersSent: false,
          destroyed: false,
          writableEnded: false,
          statusCode: 200,
          setHeader: () => {},
          end: () => {},
          on: () => fakeRes,
        } as unknown as http.ServerResponse;

        const fakeReq = {
          url: '/test-error-path?key=private',
          method: 'POST',
          socket: new Socket(),
        } as unknown as http.IncomingMessage;

        handler(fakeReq, fakeRes);

        await new Promise((resolve) => setImmediate(resolve));

        const output = stream.output;
        assert.ok(output.includes('[error]: Unhandled router error while processing request'));
        assert.ok(output.includes('Path: /test-error-path'));
        assert.ok(!output.includes('private'), 'Should not leak query parameters');
        assert.ok(output.includes('Error Detail: Error: Unhandled router crash'));
        assert.ok(output.includes('Call Stack:'));
        assert.ok(output.includes('Caused by: Error: GCS connection reset'));
      });

      void it('should use defaultLogger when logger argument is omitted', async () => {
        const routerError = new Error('Default logger fallback test');
        const router = () => Promise.reject(routerError);
        const shutdownManager = { isShuttingDown: () => false };
        const server = http.createServer();
        const handler = createHttpRequestHandler(
          router,
          shutdownManager as unknown as GracefulShutdownManager,
          server,
        );

        let statusCode = 0;
        let ended = false;
        const fakeRes = {
          headersSent: false,
          destroyed: false,
          writableEnded: false,
          set statusCode(code: number) {
            statusCode = code;
          },
          setHeader: () => {},
          end: (body?: string) => {
            ended = true;
            assert.equal(body, 'Internal Server Error');
          },
          on: () => fakeRes,
        } as unknown as http.ServerResponse;

        const fakeReq = {
          url: '/test-default-logger',
          method: 'GET',
          socket: new Socket(),
        } as unknown as http.IncomingMessage;

        handler(fakeReq, fakeRes);

        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(statusCode, 500);
        assert.equal(ended, true);
      });
    });
  });
});
