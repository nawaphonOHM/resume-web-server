/**
 * Handlers and security policy dependency resolution for router.
 *
 * @packageDocumentation
 */

import { DefaultHealthCheckHandler } from '../health_check_handler.ts';
import { StandardHttpMethodValidator } from '../http/http_method_validator.ts';
import type { AppLogger } from '../logger/logger_types.ts';
import { DefenseInDepthPathSanitizer } from '../path/path_sanitizer.ts';
import type {
  IHealthCheckHandler,
  IHttpMethodValidator,
  IPathSanitizer,
  ISecurityHeadersPolicy,
  RouterDependencies,
} from './router_types.ts';
import { StandardSecurityHeadersPolicy } from '../security_headers_policy.ts';

export interface RouterHandlerDeps {
  readonly pathSanitizer: IPathSanitizer;
  readonly securityHeadersPolicy: ISecurityHeadersPolicy;
  readonly httpMethodValidator: IHttpMethodValidator;
  readonly healthCheckHandler: IHealthCheckHandler;
}

function getPathSanitizer(d: RouterDependencies | undefined, log: AppLogger): IPathSanitizer {
  return d?.pathSanitizer ?? new DefenseInDepthPathSanitizer(log);
}

function getSecurityPolicy(d: RouterDependencies | undefined): ISecurityHeadersPolicy {
  return d?.securityHeadersPolicy ?? new StandardSecurityHeadersPolicy();
}

function getMethodValidator(
  d: RouterDependencies | undefined,
  log: AppLogger,
): IHttpMethodValidator {
  return d?.httpMethodValidator ?? new StandardHttpMethodValidator(log);
}

function getHealthHandler(d: RouterDependencies | undefined, log: AppLogger): IHealthCheckHandler {
  return d?.healthCheckHandler ?? new DefaultHealthCheckHandler(undefined, log);
}

function getSecurityDeps(d: RouterDependencies | undefined, log: AppLogger) {
  return { pathSanitizer: getPathSanitizer(d, log), securityHeadersPolicy: getSecurityPolicy(d) };
}

function getDispatchDeps(d: RouterDependencies | undefined, log: AppLogger) {
  return {
    httpMethodValidator: getMethodValidator(d, log),
    healthCheckHandler: getHealthHandler(d, log),
  };
}

export function resolveHandlerDeps(
  d: RouterDependencies | undefined,
  log: AppLogger,
): RouterHandlerDeps {
  return { ...getSecurityDeps(d, log), ...getDispatchDeps(d, log) };
}
