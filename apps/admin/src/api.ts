import createClient from 'openapi-fetch';
import type { components, paths } from './api-schema';
import { supabase } from './supabase';

export type Schemas = components['schemas'];
export type AdminDevice = Schemas['AdminDevice'];
export type AdminLocation = Schemas['AdminLocation'];
export type AdminUser = Schemas['AdminUser'];
export type DisplayItem = Schemas['DisplayItem'];
export type DisplayPreview = Schemas['DisplayPreview'];
export type DisplaySelection = Schemas['DisplaySelection'];
export type DisplaySettings = Schemas['DisplaySettings'];
export type ScoredCandidate = Schemas['ScoredCandidate'];

/** Same-origin: the Vite dev server proxies /admin/v1 to the API. */
export const api = createClient<paths>({ baseUrl: '' });

api.use({
  async onRequest({ request }) {
    const { data } = await supabase.auth.getSession();
    if (data.session) request.headers.set('Authorization', `Bearer ${data.session.access_token}`);
    return request;
  },
});

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Resolve an openapi-fetch call to its envelope's data, or throw its error message. */
export async function unwrap<T>(
  call: Promise<{ data?: { data: T }; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (data) return data.data;
  const e = error as {
    error?: { message?: string; details?: Array<{ path: string; message: string }> };
  };
  const details = e?.error?.details?.map((d) => `${d.path}: ${d.message}`).join('; ');
  throw new ApiError(
    response.status,
    [e?.error?.message ?? `HTTP ${response.status}`, details].filter(Boolean).join(' — '),
  );
}
