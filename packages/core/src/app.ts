/**
 * Single source of truth for the product name. Rename the application by
 * setting APP_NAME in the environment (or changing DEFAULT_APP_NAME here).
 */
export const DEFAULT_APP_NAME = 'Overhead';

export const APP_VERSION = '0.1.0';

export function appName(
  env: { APP_NAME?: string | undefined } = { APP_NAME: process.env.APP_NAME },
): string {
  const name = env.APP_NAME?.trim();
  return name && name.length > 0 ? name : DEFAULT_APP_NAME;
}

/** Lowercase, URL-safe form of the app name, e.g. for User-Agent strings. */
export function appSlug(
  env: { APP_NAME?: string | undefined } = { APP_NAME: process.env.APP_NAME },
): string {
  return appName(env)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
