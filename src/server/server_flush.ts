/**
 * Process Stream Flushing and Fatal Exception Handlers Module.
 *
 * Provides safe stream draining for asynchronous stdout/stderr buffers
 * and global process exception / unhandled rejection traps.
 *
 * @packageDocumentation
 */

import process from 'node:process';
import { logger as defaultLogger, type AppLogger } from '../logger/logger.ts';
import {
  DEFAULT_FLUSH_FALLBACK_MS,
  DRAIN_STREAM_COUNT,
  EXIT_CODE_ERROR,
} from './server_constants.ts';

function yieldEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function flushStream(stream: NodeJS.WriteStream, onDone: () => void): void {
  if (stream.writableLength === 0) {
    onDone();
    return;
  }
  stream.write('', () => {
    onDone();
  });
}

class StreamDrainCoordinator {
  private pending = DRAIN_STREAM_COUNT;
  private settled = false;
  private readonly onComplete: () => void;

  public constructor(onComplete: () => void) {
    this.onComplete = onComplete;
  }

  public step(): void {
    this.pending -= 1;
    if (this.pending <= 0 && !this.settled) {
      this.settled = true;
      this.onComplete();
    }
  }

  public expire(): void {
    if (!this.settled) {
      this.settled = true;
      this.onComplete();
    }
  }
}

function scheduleDrainTimer(coordinator: StreamDrainCoordinator, fallbackMs: number): void {
  const timer = setTimeout(() => {
    coordinator.expire();
  }, fallbackMs);
  timer.unref();
}

function dispatchDrainStreams(coordinator: StreamDrainCoordinator): void {
  flushStream(process.stdout, () => {
    coordinator.step();
  });
  flushStream(process.stderr, () => {
    coordinator.step();
  });
}

function drainOutputStreams(fallbackMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const coordinator = new StreamDrainCoordinator(resolve);
    scheduleDrainTimer(coordinator, fallbackMs);
    dispatchDrainStreams(coordinator);
  });
}

/**
 * Safely flushes pending stdout and stderr stream buffers before terminating the Node.js process.
 *
 * @param code - Process exit status code.
 * @param fallbackMs - Maximum duration in milliseconds to wait for stream draining. Defaults to 1000ms.
 */
export async function flushAndExit(
  code: number,
  fallbackMs: number = DEFAULT_FLUSH_FALLBACK_MS,
): Promise<void> {
  process.exitCode = code;
  await yieldEventLoop();
  await drainOutputStreams(fallbackMs);
  process.exit(code);
}

/**
 * Registers process-level fatal exception and rejection listeners that log errors and flush streams before exiting.
 *
 * @param logger - Application logger instance to record fatal errors with. Defaults to {@link defaultLogger}.
 */
export function registerFatalProcessHandlers(logger: AppLogger = defaultLogger): void {
  process.on('uncaughtException', (err: unknown) => {
    logger.error('Uncaught Exception:', { error: err });
    void flushAndExit(EXIT_CODE_ERROR);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled Promise Rejection:', { error: reason });
    void flushAndExit(EXIT_CODE_ERROR);
  });
}
