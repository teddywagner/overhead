import { createClient } from '@supabase/supabase-js';

export const supabaseConfigured = Boolean(
  import.meta.env.SUPABASE_URL && import.meta.env.SUPABASE_PUBLISHABLE_KEY,
);

export const supabase = createClient(
  import.meta.env.SUPABASE_URL || 'http://localhost',
  import.meta.env.SUPABASE_PUBLISHABLE_KEY || 'missing',
  { auth: { persistSession: true, autoRefreshToken: true } },
);
