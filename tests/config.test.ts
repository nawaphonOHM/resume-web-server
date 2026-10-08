import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  config,
  DefaultConfigValidator,
  EnvConfigLoader,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_BUCKET_NAME,
  DEFAULT_PREFIX,
} from '../src/config.ts';
import type { AppLogger, DecisionLogPayload } from '../src/logger.ts';

/**
 * Creates a spy logger that captures emitted decision payloads.
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
 * Test suite for server configuration loading and environment variable sanitation.
 *
 * @remarks
 * Validates:
 * - Default fallback values when no environment variables are provided (`PORT=8080`, `HOST=0.0.0.0`, default bucket and prefix).
 * - Port number parsing and boundary validation (`1..65535` range check, fallback on invalid or negative values).
 * - Custom host, bucket name, and prefix parsing.
 * - Leading and trailing slash normalization on `GCS_PREFIX`.
 * - Singleton default exported `config` object initialization.
 * - SOLID components: {@link DefaultConfigValidator} and {@link EnvConfigLoader}.
 * - Structured decision logging and rationale telemetry across all configuration parameters.
 */
void describe('Server Config', () => {
  void it('should load default configuration when environment variables are empty', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.bucketName, 'resume_cloudbuild');
    assert.equal(cfg.prefix, 'resume_cloudbuild/angular');
  });

  void it('should parse valid custom PORT', () => {
    const cfg = loadConfig({ PORT: '3000' });
    assert.equal(cfg.port, 3000);
  });

  void it('should fallback to default 8080 for invalid PORT values', () => {
    assert.equal(loadConfig({ PORT: 'invalid' }).port, 8080);
    assert.equal(loadConfig({ PORT: '0' }).port, 8080);
    assert.equal(loadConfig({ PORT: '-1' }).port, 8080);
    assert.equal(loadConfig({ PORT: '70000' }).port, 8080);
    assert.equal(loadConfig({ PORT: '   ' }).port, 8080);
  });

  void it('should parse custom HOST, GCS_BUCKET_NAME, and GCS_PREFIX', () => {
    const cfg = loadConfig({
      HOST: '127.0.0.1',
      GCS_BUCKET_NAME: 'custom-bucket',
      GCS_PREFIX: 'custom/prefix',
    });
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.bucketName, 'custom-bucket');
    assert.equal(cfg.prefix, 'custom/prefix');
  });

  void it('should normalize GCS_PREFIX by removing leading and trailing slashes', () => {
    assert.equal(loadConfig({ GCS_PREFIX: '/some/nested/path/' }).prefix, 'some/nested/path');
    assert.equal(loadConfig({ GCS_PREFIX: '///root///' }).prefix, 'root');
    assert.equal(loadConfig({ GCS_PREFIX: '/' }).prefix, '');
    assert.equal(loadConfig({ GCS_PREFIX: '' }).prefix, '');
  });

  void it('should provide default exported config object', () => {
    assert.ok(config);
    assert.equal(typeof config.port, 'number');
    assert.equal(typeof config.host, 'string');
    assert.equal(typeof config.bucketName, 'string');
    assert.equal(typeof config.prefix, 'string');
  });

  void it('should allow custom validator injection into EnvConfigLoader', () => {
    const customValidator = new DefaultConfigValidator();
    const loader = new EnvConfigLoader(customValidator);
    const loaded = loader.load({
      PORT: '9000',
      HOST: '10.0.0.1',
      GCS_BUCKET_NAME: 'test-bucket',
      GCS_PREFIX: '/test-prefix/',
    });

    assert.equal(loaded.port, 9000);
    assert.equal(loaded.host, '10.0.0.1');
    assert.equal(loaded.bucketName, 'test-bucket');
    assert.equal(loaded.prefix, 'test-prefix');
  });

  void it('should validate individual fields via DefaultConfigValidator', () => {
    const validator = new DefaultConfigValidator();
    assert.equal(validator.validatePort('4000', DEFAULT_PORT), 4000);
    assert.equal(validator.validatePort('invalid', DEFAULT_PORT), DEFAULT_PORT);
    assert.equal(validator.normalizeString('  trimmed  ', DEFAULT_HOST), 'trimmed');
    assert.equal(validator.normalizeString(undefined, DEFAULT_BUCKET_NAME), DEFAULT_BUCKET_NAME);
    assert.equal(validator.normalizePrefix('/nested/path/', DEFAULT_PREFIX), 'nested/path');
    assert.equal(validator.normalizePrefix(undefined, DEFAULT_PREFIX), DEFAULT_PREFIX);
  });

  void describe('Config Decision Telemetry', () => {
    void it('should log fallback decisions when environment variables are unset', () => {
      const { logger, decisions } = createDecisionSpyLogger();
      const loader = new EnvConfigLoader({ logger });
      const loaded = loader.load({});

      assert.equal(loaded.port, 8080);
      assert.equal(loaded.host, '0.0.0.0');
      assert.equal(loaded.bucketName, 'resume_cloudbuild');
      assert.equal(loaded.prefix, 'resume_cloudbuild/angular');

      assert.equal(decisions.length, 4);

      const portDecision = decisions.find((d) => d['variable'] === 'PORT');
      assert.ok(portDecision);
      assert.equal(portDecision.action, 'Config');
      assert.equal(portDecision.choice, 'port: 8080');
      assert.ok(portDecision.reason.includes('PORT environment variable not set'));

      const hostDecision = decisions.find((d) => d['variable'] === 'HOST');
      assert.ok(hostDecision);
      assert.equal(hostDecision.action, 'Config');
      assert.equal(hostDecision.choice, "host: '0.0.0.0'");
      assert.ok(hostDecision.reason.includes('HOST environment variable not set'));

      const bucketDecision = decisions.find((d) => d['variable'] === 'GCS_BUCKET_NAME');
      assert.ok(bucketDecision);
      assert.equal(bucketDecision.action, 'Config');
      assert.equal(bucketDecision.choice, "bucketName: 'resume_cloudbuild'");
      assert.ok(bucketDecision.reason.includes('GCS_BUCKET_NAME environment variable not set'));

      const prefixDecision = decisions.find((d) => d['variable'] === 'GCS_PREFIX');
      assert.ok(prefixDecision);
      assert.equal(prefixDecision.action, 'Config');
      assert.equal(prefixDecision.choice, "prefix: 'resume_cloudbuild/angular'");
      assert.ok(prefixDecision.reason.includes('GCS_PREFIX environment variable not set'));
    });

    void it('should log resolution decisions when environment variables are set', () => {
      const { logger, decisions } = createDecisionSpyLogger();
      const loaded = loadConfig(
        {
          PORT: '9000',
          HOST: '127.0.0.1',
          GCS_BUCKET_NAME: 'prod-bucket',
          GCS_PREFIX: '/web-assets/',
        },
        logger,
      );

      assert.equal(loaded.port, 9000);
      assert.equal(loaded.host, '127.0.0.1');
      assert.equal(loaded.bucketName, 'prod-bucket');
      assert.equal(loaded.prefix, 'web-assets');

      const portDecision = decisions.find((d) => d['variable'] === 'PORT');
      assert.ok(portDecision);
      assert.equal(portDecision.choice, 'port: 9000');
      assert.ok(portDecision.reason.includes('Resolved from PORT environment variable'));

      const hostDecision = decisions.find((d) => d['variable'] === 'HOST');
      assert.ok(hostDecision);
      assert.equal(hostDecision.choice, "host: '127.0.0.1'");
      assert.ok(hostDecision.reason.includes('Resolved from HOST environment variable'));

      const bucketDecision = decisions.find((d) => d['variable'] === 'GCS_BUCKET_NAME');
      assert.ok(bucketDecision);
      assert.equal(bucketDecision.choice, "bucketName: 'prod-bucket'");
      assert.ok(
        bucketDecision.reason.includes('Resolved from GCS_BUCKET_NAME environment variable'),
      );

      const prefixDecision = decisions.find((d) => d['variable'] === 'GCS_PREFIX');
      assert.ok(prefixDecision);
      assert.equal(prefixDecision.choice, "prefix: 'web-assets'");
      assert.ok(prefixDecision.reason.includes('Resolved from GCS_PREFIX environment variable'));
    });

    void it('should log invalid or empty environment variable decisions', () => {
      const { logger, decisions } = createDecisionSpyLogger();
      const loader = new EnvConfigLoader(new DefaultConfigValidator(), logger);
      const loaded = loader.load({
        PORT: 'not-a-number',
        HOST: '   ',
        GCS_BUCKET_NAME: '',
        GCS_PREFIX: '  /  ',
      });

      assert.equal(loaded.port, 8080);
      assert.equal(loaded.host, '0.0.0.0');
      assert.equal(loaded.bucketName, 'resume_cloudbuild');
      assert.equal(loaded.prefix, '');

      const portDecision = decisions.find((d) => d['variable'] === 'PORT');
      assert.ok(portDecision);
      assert.equal(portDecision.choice, 'port: 8080');
      assert.ok(portDecision.reason.includes('invalid'));

      const hostDecision = decisions.find((d) => d['variable'] === 'HOST');
      assert.ok(hostDecision);
      assert.equal(hostDecision.choice, "host: '0.0.0.0'");
      assert.ok(hostDecision.reason.includes('empty'));

      const bucketDecision = decisions.find((d) => d['variable'] === 'GCS_BUCKET_NAME');
      assert.ok(bucketDecision);
      assert.equal(bucketDecision.choice, "bucketName: 'resume_cloudbuild'");
      assert.ok(bucketDecision.reason.includes('empty'));

      const prefixDecision = decisions.find((d) => d['variable'] === 'GCS_PREFIX');
      assert.ok(prefixDecision);
      assert.equal(prefixDecision.choice, "prefix: ''");
      assert.ok(prefixDecision.reason.includes('root'));
    });

    void it('should support custom validator and derive decisions from validator output', () => {
      const { logger, decisions } = createDecisionSpyLogger();
      const customValidator = {
        validatePort: () => 9999,
        normalizeString: (_raw: string | undefined, def: string) => `custom-${def}`,
        normalizePrefix: () => 'custom-prefix',
      };
      const loader = new EnvConfigLoader(customValidator, logger);
      const loaded = loader.load({
        PORT: '1234',
        HOST: 'my-host',
        GCS_BUCKET_NAME: 'my-bucket',
        GCS_PREFIX: '/prefix/',
      });

      assert.equal(loaded.port, 9999);
      assert.equal(loaded.host, 'custom-0.0.0.0');
      assert.equal(loaded.bucketName, 'custom-resume_cloudbuild');
      assert.equal(loaded.prefix, 'custom-prefix');
      assert.equal(decisions.length, 4);
    });
  });
});
