/**
 * `bun run dev`: run the API and worker in watch mode side by side.
 *
 * Deliberately not `bun run --parallel`: on Windows its children never
 * receive Ctrl+C, so the dev servers keep running after you press it.
 * Plain child processes share this console, so Ctrl+C reaches all of them.
 */
const apps = ['api', 'worker'] as const;

const children = apps.map((app) =>
  Bun.spawn([process.execPath, '--watch', `apps/${app}/src/index.ts`], {
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
);

const stopAll = () => {
  for (const child of children) if (child.exitCode === null) child.kill();
};

// The console delivers Ctrl+C to the children directly; this handler only
// keeps the runner alive long enough to make sure none are left behind.
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

// If either app exits (crash or Ctrl+C), stop the other and exit too.
const code = await Promise.race(children.map((child) => child.exited));
stopAll();
await Promise.all(children.map((child) => child.exited));
process.exit(code);
