interface ImportMetaEnv {
  /** Injected by vite.config.ts from the repo-root .env. */
  readonly SUPABASE_URL: string;
  readonly SUPABASE_PUBLISHABLE_KEY: string;
}
