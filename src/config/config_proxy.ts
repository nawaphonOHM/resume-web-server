/**
 * Lazy reflective configuration proxy singleton.
 *
 * @packageDocumentation
 */

import process from 'node:process';
import type { ServerConfig } from './config_types.ts';
import { loadConfig } from './config_loader.ts';

/**
 * Mutable backing target object for the lazily-initialized default {@link ServerConfig} singleton.
 */
const targetConfig: ServerConfig = {} as ServerConfig;
let isConfigInitialized = false;

/**
 * Node.js custom inspection symbol for formatted debugging output.
 */
const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

/**
 * Ensures that the backing configuration target is initialized with a snapshot from `process.env`.
 */
function ensureConfigInitialized(): ServerConfig {
  if (!isConfigInitialized) {
    const loaded = loadConfig(process.env);
    Object.assign(targetConfig, loaded);
    isConfigInitialized = true;
  }
  return targetConfig;
}

function inspectTargetConfig(): Record<string, unknown> {
  ensureConfigInitialized();
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(targetConfig)) {
    result[key] = (targetConfig as unknown as Record<string, unknown>)[key];
  }
  return result;
}

Object.defineProperty(targetConfig, customInspectSymbol, {
  value: inspectTargetConfig,
  enumerable: false,
  configurable: true,
  writable: true,
});

/**
 * Default singleton server configuration loaded lazily from the runtime `process.env`.
 *
 * @remarks
 * Uses a reflective Proxy backed by a mutable target object that is populated on first access.
 * This preserves standard JavaScript object invariants (`Object.freeze`, `Object.keys`, `util.inspect`,
 * property descriptors, setters, deleters, etc.) while deferring configuration loading and validation
 * until actual property access.
 */
export const config: ServerConfig = new Proxy(targetConfig, {
  get(target, prop, receiver) {
    ensureConfigInitialized();
    return Reflect.get(target, prop, receiver) as unknown;
  },
  set(target, prop, value, receiver) {
    ensureConfigInitialized();
    return Reflect.set(target, prop, value, receiver);
  },
  has(target, prop) {
    ensureConfigInitialized();
    return Reflect.has(target, prop);
  },
  deleteProperty(target, prop) {
    ensureConfigInitialized();
    return Reflect.deleteProperty(target, prop);
  },
  ownKeys(target) {
    ensureConfigInitialized();
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, prop) {
    ensureConfigInitialized();
    return Reflect.getOwnPropertyDescriptor(target, prop);
  },
  defineProperty(target, prop, attributes) {
    ensureConfigInitialized();
    return Reflect.defineProperty(target, prop, attributes);
  },
  preventExtensions(target) {
    ensureConfigInitialized();
    return Reflect.preventExtensions(target);
  },
  isExtensible(target) {
    ensureConfigInitialized();
    return Reflect.isExtensible(target);
  },
  getPrototypeOf(target) {
    ensureConfigInitialized();
    return Reflect.getPrototypeOf(target);
  },
  setPrototypeOf(target, proto) {
    ensureConfigInitialized();
    return Reflect.setPrototypeOf(target, proto);
  },
});
