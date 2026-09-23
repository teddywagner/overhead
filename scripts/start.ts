/**
 * `bun run start`: start the built API or worker, chosen by service name.
 *
 * Hosting platforms that build the whole repo (Railway/Railpack) look for a
 * single root start command. OVERHEAD_SERVICE (api | worker) selects the app;
 * otherwise Railway's RAILWAY_SERVICE_NAME (e.g. "@overhead/worker") is used.
 */
const selector = (
  process.env.OVERHEAD_SERVICE ||
  process.env.RAILWAY_SERVICE_NAME ||
  ''
).toLowerCase();
const app = selector.includes('worker') ? 'worker' : selector.includes('api') ? 'api' : null;

if (!app) {
  process.stderr.write(
    'Cannot tell which app to start. Set OVERHEAD_SERVICE=api or OVERHEAD_SERVICE=worker.\n',
  );
  process.exit(1);
}

const child = Bun.spawn([process.execPath, `apps/${app}/dist/index.js`], {
  stdio: ['inherit', 'inherit', 'inherit'],
});

// Pass shutdown signals from the platform through to the app.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => child.kill(signal));
}

process.exit(await child.exited);
