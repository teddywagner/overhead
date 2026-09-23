import { ReadsbV2PointProvider, type ReadsbV2Options } from './readsb-v2';

/**
 * Airplanes.live REST API. Since roughly August 2026 it only serves
 * Airplanes.live feeders (non-feeders get HTTP 403). Kept for feeders.
 */
export const AIRPLANES_LIVE_DEFAULT_BASE_URL = 'https://api.airplanes.live';

export class AirplanesLiveProvider extends ReadsbV2PointProvider {
  constructor(options: ReadsbV2Options) {
    super('airplanes_live', 'Airplanes.live', options);
  }
}
