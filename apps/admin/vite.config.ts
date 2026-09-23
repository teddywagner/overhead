import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Admin board dev server. Reads the repo-root .env so it signs in against
 * the same Supabase project the API uses, and proxies /admin/v1 and /api/v1 to
 * the API so no CORS configuration is needed. Only the Supabase URL and the
 * publishable key (both safe for browsers) reach the page.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const api = env.ADMIN_API_URL || `http://localhost:${env.API_PORT || 3001}`;
  return {
    plugins: [react()],
    define: {
      'import.meta.env.SUPABASE_URL': JSON.stringify(env.SUPABASE_URL ?? ''),
      'import.meta.env.SUPABASE_PUBLISHABLE_KEY': JSON.stringify(
        env.SUPABASE_PUBLISHABLE_KEY ?? '',
      ),
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/admin/v1': { target: api, changeOrigin: true },
        // The signed-in admin's own records (e.g. their locations, with coordinates).
        '/api/v1': { target: api, changeOrigin: true },
      },
    },
  };
});
