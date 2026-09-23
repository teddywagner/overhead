import type { TypedSupabaseClient } from '@overhead/database';
import type { AppDeps } from '../deps';

export interface AppEnv {
  Variables: {
    requestId: string;
    deps: AppDeps;
    userId: string;
    db: TypedSupabaseClient;
    /** Set by device auth: the authenticated frame. */
    deviceId: string;
  };
}
