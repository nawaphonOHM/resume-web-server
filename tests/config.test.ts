import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  config,
  DefaultConfigValidator,
  EnvConfigLoader,
  DEFAULT_PORT,
  DEFAULT_HOST,
} from '../src/config.ts';
import type { AppLogger, DecisionLogPayload } from '../src/logger.ts';

// Ensure process.env has baseline mock values so the singleton config proxy can initialize safely
process.env['GCS_BUCKET_NAME'] = 'test-bucket';
process.env['GCS_PREFIX'] = 'test-prefix';

/**
 * Creates a spy logger that captures emitted decision payloads and log calls.
 */
function createDecisionSpyLogger(): {
  logger: AppLogger;
  decisions: DecisionLogPayload[];
  errors: string[];
} {
  const decisions: DecisionLogPayload[] = [];
  const errors: string[] = [];
  const logger: AppLogger = {
    info: () => {
      /* noop */
    },
    warn: () => {
      /* noop */
    },
    error: (message: string | Error) => {
      errors.push(typeof message === 'string' ? message : message.message);
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
  return { logger, decisions, errors };
}

/**
 * Test suite for server configuration loading, required variable validation, and environment sanitation.
 *
 * @remarks
 * Validates:
 * - Mandatory Google Cloud Storage environment variables (`GCS_BUCKET_NAME`, `GCS_PREFIX`) and peaceful exit handling (code 1).
 * - Default fallback values for optional parameters (`PORT=8080`, `HOST=0.0.0.0`).
 * - Port number parsing and boundary validation (`1..65535` range check, fallback on invalid or negative values).
 * - Custom host, bucket name, and prefix parsing.
 * - Leading and trailing slash normalization on `GCS_PREFIX` and rejection of slash-only strings.
 * - Singleton default exported `config` object lazy initialization and reflective proxy invariants.
 * - SOLID components: {@link DefaultConfigValidator} and {@link EnvConfigLoader}.
 * - Structured decision logging and rationale telemetry across all configuration parameters.
 */
void describe('Server Config', () => {
  void describe('Required Environment Variable Validation & Exit Handling', () => {
    void it('should exit with code 1 and descriptive error when GCS_BUCKET_NAME is unset', () => {
      let exitCode: number | undefined;
      let exitMessage: string | undefined;

      assert.throws(
        () => {
          loadConfig(
            { GCS_PREFIX: 'web-prefix' },
            {
              exitFn: (code, msg) => {
                exitCode = code;
                exitMessage = msg;
              },
            },
          );
        },
        (err: Error) => {
          assert.ok(
            err.message.includes('Missing required environment variable(s): GCS_BUCKET_NAME'),
          );
          return true;
        },
      );

      assert.equal(exitCode, 1);
      assert.ok(exitMessage?.includes('GCS_BUCKET_NAME'));
      assert.equal(exitMessage.includes('GCS_PREFIX'), false);
      assert.ok(exitMessage.includes('Please set GCS_BUCKET_NAME before running the server.'));
    });

    void it('should exit with code 1 and descriptive error when GCS_PREFIX is unset', () => {
      let exitCode: number | undefined;
      let exitMessage: string | undefined;

      assert.throws(
        () => {
          loadConfig(
            { GCS_BUCKET_NAME: 'web-bucket' },
            {
              exitFn: (code, msg) => {
                exitCode = code;
                exitMessage = msg;
              },
            },
          );
        },
        (err: Error) => {
          assert.ok(err.message.includes('Missing required environment variable(s): GCS_PREFIX'));
          return true;
        },
      );

      assert.equal(exitCode, 1);
      assert.ok(exitMessage?.includes('GCS_PREFIX'));
      assert.equal(exitMessage.includes('GCS_BUCKET_NAME'), false);
      assert.ok(exitMessage.includes('Please set GCS_PREFIX before running the server.'));
    });

    void it('should exit with code 1 and list both variables when both GCS_BUCKET_NAME and GCS_PREFIX are unset', () => {
      let exitCode: number | undefined;
      let exitMessage: string | undefined;

      assert.throws(
        () => {
          loadConfig(
            {},
            {
              exitFn: (code, msg) => {
                exitCode = code;
                exitMessage = msg;
              },
            },
          );
        },
        (err: Error) => {
          assert.ok(
            err.message.includes(
              'Missing required environment variable(s): GCS_BUCKET_NAME, GCS_PREFIX',
            ),
          );
          return true;
        },
      );

      assert.equal(exitCode, 1);
      assert.ok(exitMessage?.includes('GCS_BUCKET_NAME'));
      assert.ok(exitMessage.includes('GCS_PREFIX'));
      assert.ok(
        exitMessage.includes(
          'Please set GCS_BUCKET_NAME and GCS_PREFIX before running the server.',
        ),
      );
    });

    const invalidRequiredEnvCases: {
      name: string;
      env: Record<string, string>;
      expectedMissing: string[];
      unexpectedMissing: string[];
    }[] = [
      {
        name: 'GCS_BUCKET_NAME is empty string with valid GCS_PREFIX',
        env: { GCS_BUCKET_NAME: '', GCS_PREFIX: 'valid-prefix' },
        expectedMissing: ['GCS_BUCKET_NAME'],
        unexpectedMissing: ['GCS_PREFIX'],
      },
      {
        name: 'GCS_BUCKET_NAME is whitespace-only with valid GCS_PREFIX',
        env: { GCS_BUCKET_NAME: '   ', GCS_PREFIX: 'valid-prefix' },
        expectedMissing: ['GCS_BUCKET_NAME'],
        unexpectedMissing: ['GCS_PREFIX'],
      },
      {
        name: 'GCS_PREFIX is empty string with valid GCS_BUCKET_NAME',
        env: { GCS_BUCKET_NAME: 'valid-bucket', GCS_PREFIX: '' },
        expectedMissing: ['GCS_PREFIX'],
        unexpectedMissing: ['GCS_BUCKET_NAME'],
      },
      {
        name: 'GCS_PREFIX is whitespace-only with valid GCS_BUCKET_NAME',
        env: { GCS_BUCKET_NAME: 'valid-bucket', GCS_PREFIX: '   ' },
        expectedMissing: ['GCS_PREFIX'],
        unexpectedMissing: ['GCS_BUCKET_NAME'],
      },
      {
        name: 'GCS_PREFIX is slash-only with valid GCS_BUCKET_NAME',
        env: { GCS_BUCKET_NAME: 'valid-bucket', GCS_PREFIX: '///' },
        expectedMissing: ['GCS_PREFIX'],
        unexpectedMissing: ['GCS_BUCKET_NAME'],
      },
      {
        name: 'both GCS_BUCKET_NAME and GCS_PREFIX are empty strings',
        env: { GCS_BUCKET_NAME: '', GCS_PREFIX: '' },
        expectedMissing: ['GCS_BUCKET_NAME', 'GCS_PREFIX'],
        unexpectedMissing: [],
      },
      {
        name: 'both GCS_BUCKET_NAME and GCS_PREFIX are whitespace-only',
        env: { GCS_BUCKET_NAME: '   ', GCS_PREFIX: '   ' },
        expectedMissing: ['GCS_BUCKET_NAME', 'GCS_PREFIX'],
        unexpectedMissing: [],
      },
      {
        name: 'GCS_BUCKET_NAME is empty and GCS_PREFIX is whitespace-only',
        env: { GCS_BUCKET_NAME: '', GCS_PREFIX: '   ' },
        expectedMissing: ['GCS_BUCKET_NAME', 'GCS_PREFIX'],
        unexpectedMissing: [],
      },
      {
        name: 'GCS_BUCKET_NAME is whitespace-only and GCS_PREFIX is empty',
        env: { GCS_BUCKET_NAME: '   ', GCS_PREFIX: '' },
        expectedMissing: ['GCS_BUCKET_NAME', 'GCS_PREFIX'],
        unexpectedMissing: [],
      },
      {
        name: 'GCS_BUCKET_NAME is whitespace-only and GCS_PREFIX is slash-only',
        env: { GCS_BUCKET_NAME: '   ', GCS_PREFIX: '///' },
        expectedMissing: ['GCS_BUCKET_NAME', 'GCS_PREFIX'],
        unexpectedMissing: [],
      },
    ];

    for (const testCase of invalidRequiredEnvCases) {
      void it(`should exit with code 1 reporting only offending variables when ${testCase.name}`, () => {
        let exitCode: number | undefined;
        let exitMessage: string | undefined;

        assert.throws(
          () => {
            loadConfig(testCase.env, {
              exitFn: (code, msg) => {
                exitCode = code;
                exitMessage = msg;
              },
            });
          },
          (err: Error) => {
            for (const expectedVar of testCase.expectedMissing) {
              assert.ok(
                err.message.includes(expectedVar),
                `Error message should include ${expectedVar}`,
              );
            }
            return true;
          },
        );

        assert.equal(exitCode, 1);
        assert.ok(exitMessage !== undefined);
        for (const expectedVar of testCase.expectedMissing) {
          assert.ok(
            exitMessage.includes(expectedVar),
            `Exit message should include ${expectedVar}`,
          );
        }
        for (const unexpectedVar of testCase.unexpectedMissing) {
          assert.equal(
            exitMessage.includes(unexpectedVar),
            false,
            `Exit message should NOT include ${unexpectedVar}`,
          );
        }
        if (testCase.expectedMissing.length === 1) {
          assert.ok(
            exitMessage.includes(
              `Please set ${testCase.expectedMissing[0]} before running the server.`,
            ),
          );
        } else {
          assert.ok(
            exitMessage.includes(
              `Please set ${testCase.expectedMissing.join(' and ')} before running the server.`,
            ),
          );
        }
      });
    }

    void it('should trigger exit code 1 when custom validator returns empty string for required variables', () => {
      const emptyValidator = {
        validatePort: () => 8080,
        normalizeString: () => '',
        normalizePrefix: () => '',
      };
      let exitCode: number | undefined;
      let exitMessage: string | undefined;

      assert.throws(
        () => {
          new EnvConfigLoader(emptyValidator, undefined, (code, msg) => {
            exitCode = code;
            exitMessage = msg;
          }).load({ GCS_BUCKET_NAME: 'non-empty', GCS_PREFIX: 'non-empty' });
        },
        (err: Error) => {
          assert.ok(
            err.message.includes(
              'Missing required environment variable(s): GCS_BUCKET_NAME, GCS_PREFIX',
            ),
          );
          return true;
        },
      );

      assert.equal(exitCode, 1);
      assert.ok(exitMessage?.includes('GCS_BUCKET_NAME'));
      assert.ok(exitMessage.includes('GCS_PREFIX'));
    });

    void it('should log error through AppLogger before exit when required variables are missing', () => {
      const { logger, errors } = createDecisionSpyLogger();
      let exitCode: number | undefined;

      assert.throws(() => {
        loadConfig(
          {},
          {
            logger,
            exitFn: (code) => {
              exitCode = code;
            },
          },
        );
      });

      assert.equal(exitCode, 1);
      assert.equal(errors.length, 1);
      assert.ok(
        errors[0]?.includes(
          'Missing required environment variable(s): GCS_BUCKET_NAME, GCS_PREFIX',
        ),
      );
    });

    void it('should support exitFn injection through both EnvConfigLoaderOptions and constructor parameters', () => {
      let optionExitCode: number | undefined;
      assert.throws(() => {
        const loader = new EnvConfigLoader({
          exitFn: (code) => {
            optionExitCode = code;
          },
        });
        loader.load({});
      });
      assert.equal(optionExitCode, 1);

      let positionalExitCode: number | undefined;
      assert.throws(() => {
        const loader = new EnvConfigLoader(new DefaultConfigValidator(), undefined, (code) => {
          positionalExitCode = code;
        });
        loader.load({});
      });
      assert.equal(positionalExitCode, 1);

      let overloadExitCode: number | undefined;
      assert.throws(() => {
        loadConfig({}, undefined, {
          exitFn: (code) => {
            overloadExitCode = code;
          },
        });
      });
      assert.equal(overloadExitCode, 1);
    });
  });

  void describe('Valid Configuration Parsing & Defaults', () => {
    void it('should parse valid custom PORT, HOST, GCS_BUCKET_NAME, and GCS_PREFIX', () => {
      const cfg = loadConfig({
        PORT: '3000',
        HOST: '127.0.0.1',
        GCS_BUCKET_NAME: 'custom-bucket',
        GCS_PREFIX: 'custom/prefix',
      });
      assert.equal(cfg.port, 3000);
      assert.equal(cfg.host, '127.0.0.1');
      assert.equal(cfg.bucketName, 'custom-bucket');
      assert.equal(cfg.prefix, 'custom/prefix');
    });

    void it('should fallback to DEFAULT_PORT (8080) and DEFAULT_HOST (0.0.0.0) when PORT and HOST are omitted', () => {
      const cfg = loadConfig({
        GCS_BUCKET_NAME: 'my-bucket',
        GCS_PREFIX: 'my-prefix',
      });
      assert.equal(cfg.port, DEFAULT_PORT);
      assert.equal(cfg.host, DEFAULT_HOST);
      assert.equal(cfg.bucketName, 'my-bucket');
      assert.equal(cfg.prefix, 'my-prefix');
    });

    void it('should fallback to default 8080 for invalid PORT values', () => {
      const baseEnv = { GCS_BUCKET_NAME: 'test-bucket', GCS_PREFIX: 'test-prefix' };
      assert.equal(loadConfig({ ...baseEnv, PORT: 'invalid' }).port, 8080);
      assert.equal(loadConfig({ ...baseEnv, PORT: '0' }).port, 8080);
      assert.equal(loadConfig({ ...baseEnv, PORT: '-1' }).port, 8080);
      assert.equal(loadConfig({ ...baseEnv, PORT: '70000' }).port, 8080);
      assert.equal(loadConfig({ ...baseEnv, PORT: '   ' }).port, 8080);
    });

    void it('should fallback to default 0.0.0.0 for empty or whitespace HOST values', () => {
      const baseEnv = { GCS_BUCKET_NAME: 'test-bucket', GCS_PREFIX: 'test-prefix' };
      assert.equal(loadConfig({ ...baseEnv, HOST: '' }).host, '0.0.0.0');
      assert.equal(loadConfig({ ...baseEnv, HOST: '   ' }).host, '0.0.0.0');
    });

    void it('should normalize GCS_PREFIX by removing leading and trailing slashes', () => {
      const baseEnv = { GCS_BUCKET_NAME: 'test-bucket' };
      assert.equal(
        loadConfig({ ...baseEnv, GCS_PREFIX: '/some/nested/path/' }).prefix,
        'some/nested/path',
      );
      assert.equal(loadConfig({ ...baseEnv, GCS_PREFIX: '///root///' }).prefix, 'root');
      assert.equal(
        loadConfig({ ...baseEnv, GCS_PREFIX: '  /deep/sub/path/  ' }).prefix,
        'deep/sub/path',
      );
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
  });

  void describe('DefaultConfigValidator Unit Tests', () => {
    void it('should validate individual fields via DefaultConfigValidator', () => {
      const validator = new DefaultConfigValidator();
      assert.equal(validator.validatePort('4000', DEFAULT_PORT), 4000);
      assert.equal(validator.validatePort('invalid', DEFAULT_PORT), DEFAULT_PORT);
      assert.equal(validator.validatePort('0', DEFAULT_PORT), DEFAULT_PORT);
      assert.equal(validator.validatePort('70000', DEFAULT_PORT), DEFAULT_PORT);
      assert.equal(validator.validatePort(undefined, DEFAULT_PORT), DEFAULT_PORT);
      assert.equal(validator.validatePort('  ', DEFAULT_PORT), DEFAULT_PORT);

      assert.equal(validator.normalizeString('  trimmed  ', DEFAULT_HOST), 'trimmed');
      assert.equal(validator.normalizeString(undefined, DEFAULT_HOST), DEFAULT_HOST);
      assert.equal(validator.normalizeString('', DEFAULT_HOST), DEFAULT_HOST);
      assert.equal(validator.normalizeString('   ', DEFAULT_HOST), DEFAULT_HOST);

      assert.equal(validator.normalizePrefix('/nested/path/'), 'nested/path');
      assert.equal(validator.normalizePrefix('///root///'), 'root');
      assert.equal(validator.normalizePrefix('  /spaces/  '), 'spaces');
      assert.equal(validator.normalizePrefix('/'), '');
    });
  });

  void describe('Config Decision Telemetry', () => {
    void it('should log fallback decisions when PORT and HOST are unset', () => {
      const { logger, decisions } = createDecisionSpyLogger();
      const loader = new EnvConfigLoader({ logger });
      const loaded = loader.load({
        GCS_BUCKET_NAME: 'prod-bucket',
        GCS_PREFIX: 'prod-prefix',
      });

      assert.equal(loaded.port, 8080);
      assert.equal(loaded.host, '0.0.0.0');
      assert.equal(loaded.bucketName, 'prod-bucket');
      assert.equal(loaded.prefix, 'prod-prefix');

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
      assert.equal(bucketDecision.choice, "bucketName: 'prod-bucket'");
      assert.ok(
        bucketDecision.reason.includes('Resolved from GCS_BUCKET_NAME environment variable'),
      );

      const prefixDecision = decisions.find((d) => d['variable'] === 'GCS_PREFIX');
      assert.ok(prefixDecision);
      assert.equal(prefixDecision.action, 'Config');
      assert.equal(prefixDecision.choice, "prefix: 'prod-prefix'");
      assert.ok(prefixDecision.reason.includes('Resolved from GCS_PREFIX environment variable'));
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
        GCS_BUCKET_NAME: 'test-bucket',
        GCS_PREFIX: 'test-prefix',
      });

      assert.equal(loaded.port, 8080);
      assert.equal(loaded.host, '0.0.0.0');
      assert.equal(loaded.bucketName, 'test-bucket');
      assert.equal(loaded.prefix, 'test-prefix');

      const portDecision = decisions.find((d) => d['variable'] === 'PORT');
      assert.ok(portDecision);
      assert.equal(portDecision.choice, 'port: 8080');
      assert.ok(portDecision.reason.includes('invalid'));

      const hostDecision = decisions.find((d) => d['variable'] === 'HOST');
      assert.ok(hostDecision);
      assert.equal(hostDecision.choice, "host: '0.0.0.0'");
      assert.ok(hostDecision.reason.includes('empty'));
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
      assert.equal(loaded.bucketName, 'custom-');
      assert.equal(loaded.prefix, 'custom-prefix');
      assert.equal(decisions.length, 4);
    });
  });

  void describe('Lazy Singleton Proxy & Reflection', () => {
    void it('should provide default exported config object with standard property reflection and snapshot caching', () => {
      assert.ok(config);
      assert.equal(typeof config.port, 'number');
      assert.equal(typeof config.host, 'string');
      assert.equal(typeof config.bucketName, 'string');
      assert.equal(typeof config.prefix, 'string');

      const initialPort = config.port;
      const initialBucket = config.bucketName;

      // Verify that subsequent mutations to process.env do not alter the cached snapshot
      const prevPort = process.env['PORT'];
      const prevBucket = process.env['GCS_BUCKET_NAME'];
      try {
        process.env['PORT'] = '65432';
        process.env['GCS_BUCKET_NAME'] = 'mutated-bucket';
        assert.equal(config.port, initialPort, 'config.port should remain cached');
        assert.equal(config.bucketName, initialBucket, 'config.bucketName should remain cached');
      } finally {
        if (prevPort !== undefined) {
          process.env['PORT'] = prevPort;
        } else {
          delete process.env['PORT'];
        }
        if (prevBucket !== undefined) {
          process.env['GCS_BUCKET_NAME'] = prevBucket;
        } else {
          delete process.env['GCS_BUCKET_NAME'];
        }
      }

      const keys = Object.keys(config);
      assert.ok(keys.includes('port'));
      assert.ok(keys.includes('host'));
      assert.ok(keys.includes('bucketName'));
      assert.ok(keys.includes('prefix'));

      assert.equal('port' in config, true);
      assert.equal('nonExistent' in config, false);

      const descriptor = Object.getOwnPropertyDescriptor(config, 'port');
      assert.ok(descriptor);
      assert.equal(typeof descriptor.value, 'number');

      const spread = { ...config };
      assert.equal(spread.port, config.port);
      assert.equal(spread.host, config.host);
      assert.equal(spread.bucketName, config.bucketName);
      assert.equal(spread.prefix, config.prefix);

      const json = JSON.stringify(config);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      assert.equal(parsed['port'], config.port);
      assert.equal(parsed['host'], config.host);
      assert.equal(parsed['bucketName'], config.bucketName);
      assert.equal(parsed['prefix'], config.prefix);

      assert.equal(Object.isExtensible(config), true);
      assert.equal(Object.getPrototypeOf(config), Object.prototype);

      const inspectSym = Symbol.for('nodejs.util.inspect.custom');
      const inspectFn = (config as unknown as Record<symbol, () => Record<string, unknown>>)[
        inspectSym
      ];
      assert.ok(inspectFn);
      const inspected = inspectFn();
      assert.equal(inspected['port'], config.port);
    });
  });
});
