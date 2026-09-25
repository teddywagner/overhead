import {
  APP_VERSION,
  EnvValidationError,
  appName,
  appSlug,
  createLogger,
  loadEnv,
  type Logger,
  providerUserAgent,
  workerEnvSchema,
  type WorkerEnv,
} from '@overhead/core';
import { createAdminClient, createSql, type Sql } from '@overhead/database';
import {
  AdsbLolProvider,
  AdsbdbClient,
  AirplanesLiveProvider,
  MOCK_SCENARIOS,
  MockAircraftProvider,
  type AircraftPositionProvider,
} from '@overhead/flight-tracking';
import { RembgRemover, RemoveBgRemover, type BackgroundRemover } from './background-removers';
import { PostgresCutoutStore } from './cutout-store';
import { CutoutWorker } from './cutouts';
import { DisplayScheduler, PostgresDisplayStore } from './display-scheduler';
import { Enricher } from './enricher';
import { PostgresEnrichmentStore } from './enrichment-store';
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
  const userAgent = providerUserAgent(env);
  if (env.AIRCRAFT_PROVIDER === 'airplanes_live') {
    return new AirplanesLiveProvider({ baseUrl: env.AIRPLANES_LIVE_BASE_URL, userAgent });
  }
  return new AdsbLolProvider({ baseUrl: env.ADSB_LOL_BASE_URL, userAgent });
}

/** adsbdb enrichment, unless disabled or running on synthetic mock traffic. */
export function createEnricher(env: WorkerEnv, sql: Sql, logger: Logger): Enricher | null {
  if (env.ENRICHMENT_PROVIDER === 'none' || env.AIRCRAFT_PROVIDER === 'mock') return null;
  return new Enricher({
    client: new AdsbdbClient({ baseUrl: env.ADSBDB_BASE_URL, userAgent: providerUserAgent(env) }),
    store: new PostgresEnrichmentStore(sql),
    logger,
    intervalS: env.ENRICHMENT_INTERVAL_SECONDS,
    batchSize: env.ENRICHMENT_BATCH_SIZE,
  });
}

/** Background removal for requested cutouts, unless CUTOUT_PROVIDER=none. */
export function createCutoutWorker(env: WorkerEnv, sql: Sql, logger: Logger): CutoutWorker | null {
  if (env.CUTOUT_PROVIDER === 'none') return null;
  const remover: BackgroundRemover =
    env.CUTOUT_PROVIDER === 'rembg'
      ? new RembgRemover({ baseUrl: env.CUTOUT_REMBG_URL, model: env.CUTOUT_REMBG_MODEL })
      : new RemoveBgRemover({ apiKey: env.CUTOUT_REMOVE_BG_API_KEY });
  const storage = createAdminClient({
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
    SUPABASE_PUBLISHABLE_KEY: '',
  });
  return new CutoutWorker({
    remover,
    store: new PostgresCutoutStore(sql, storage),
    logger,
    intervalS: env.CUTOUT_INTERVAL_SECONDS,
    batchSize: 3,
    // Wikimedia asks for a descriptive User-Agent with contact details.
    userAgent: providerUserAgent(env) || `${appSlug(env)}/${APP_VERSION}`,
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
  const enricher = createEnricher(env, sql, logger);
  const display = new DisplayScheduler({
    store: new PostgresDisplayStore(sql),
    logger,
    intervalS: env.DISPLAY_INTERVAL_SECONDS,
  });
  const cutouts = createCutoutWorker(env, sql, logger);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    poller.stop();
    enricher?.stop();
    display.stop();
    cutouts?.stop();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info('worker starting', {
    app: appName(env),
    version: APP_VERSION,
    provider: provider.name,
    poll_interval_s: env.WORKER_POLL_INTERVAL_SECONDS,
    enrichment: enricher ? 'adsbdb' : 'off',
    display_interval_s: env.DISPLAY_INTERVAL_SECONDS,
    cutouts: env.CUTOUT_PROVIDER,
  });
  try {
    await Promise.all([poller.start(), enricher?.start(), display.start(), cutouts?.start()]);
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
