import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
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
} from '../src/logger.ts';
import type { StorageService } from '../src/storage.ts';

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
      envOverrides: Record<string, string> = {},
      timeoutMs = 10000,
    ): Promise<{ exitCode: number | null; output: string }> {
      const { spawn } = await import('node:child_process');
      const { promises: fs } = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const tempOutputFile = path.join(
        os.tmpdir(),
        `test-cli-flush-${String(Date.now())}-${String(Math.random()).slice(2)}.txt`,
      );
      const outFd = await fs.open(tempOutputFile, 'w');

      try {
        const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
          cwd: projectRoot,
          env: {
            ...process.env,
            ...envOverrides,
          },
          stdio: ['ignore', outFd.fd, outFd.fd],
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
        const output = await fs.readFile(tempOutputFile, 'utf-8');
        return { exitCode, output };
      } finally {
        try {
          await outFd.close();
        } catch {
          /* ignore */
        }
        try {
          await fs.unlink(tempOutputFile);
        } catch {
          /* ignore */
        }
      }
    }

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
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli-fatal.ts', [
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
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli-fatal.ts', [
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
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli-fatal.ts', [
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
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli-fatal.ts', [
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
        const { exitCode, output } = await runCliProcess('tests/fixtures/cli-fatal.ts', [
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
});
