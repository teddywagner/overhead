import {
  APP_VERSION,
  EnvValidationError,
  appName,
  appSlug,
  createLogger,
  loadEnv,
  workerEnvSchema,
  type WorkerEnv,
} from '@overhead/core';
import { createSql } from '@overhead/database';
import {
  AirplanesLiveProvider,
  MOCK_SCENARIOS,
  MockAircraftProvider,
  type AircraftPositionProvider,
} from '@overhead/flight-tracking';
import { Poller, safeMessage } from './poller';
import { PostgresWorkerStore } from './store';

export function createProvider(env: WorkerEnv): AircraftPositionProvider {
  if (env.AIRCRAFT_PROVIDER === 'mock') {
    const scenario = MOCK_SCENARIOS[env.MOCK_SCENARIO];
    if (!scenario) {
      throw new EnvValidationError([
        `MOCK_SCENARIO must be one of: ${Object.keys(MOCK_SCENARIOS).join(', ')}`,
      ]);
    }
    // Replay the scenario every 15 minutes so a dev worker keeps producing traffic.
    return new MockAircraftProvider({ scenario, epoch: new Date(), loopS: 900 });
  }
  return new AirplanesLiveProvider({
    baseUrl: env.AIRPLANES_LIVE_BASE_URL,
    userAgent: env.AIRPLANES_LIVE_USER_AGENT,
  });
}

async function main(): Promise<void> {
  let env: WorkerEnv;
  try {
    env = loadEnv(workerEnvSchema);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const logger = createLogger({ level: env.LOG_LEVEL, service: `${appSlug(env)}-worker` });
  const sql = createSql(env.DATABASE_URL, { max: 3 });
  const provider = createProvider(env);
  const poller = new Poller({
    provider,
    store: new PostgresWorkerStore(sql),
    logger,
    pollIntervalS: env.WORKER_POLL_INTERVAL_SECONDS,
    retentionIntervalMs: env.RETENTION_INTERVAL_MINUTES * 60_000,
    detection: {
      gapTimeoutS: env.PASS_GAP_TIMEOUT_SECONDS,
      pointSampleS: env.OVERFLIGHT_POINT_SAMPLE_SECONDS,
      maxPointsPerPass: env.OVERFLIGHT_POINT_MAX_PER_PASS,
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    poller.stop();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info('worker starting', {
    app: appName(env),
    version: APP_VERSION,
    provider: provider.name,
    poll_interval_s: env.WORKER_POLL_INTERVAL_SECONDS,
  });
  try {
    await poller.start();
  } catch (err) {
    logger.error('worker crashed', { error: safeMessage(err) });
    process.exitCode = 1;
  } finally {
    await sql.close();
    logger.info('worker stopped');
  }
}

if (import.meta.main) {
  await main();
}
