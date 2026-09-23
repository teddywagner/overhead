import { ReadsbV2PointProvider, type ReadsbV2Options } from './readsb-v2';

/**
 * adsb.lol public API (https://api.adsb.lol, ODbL data). Same readsb v2
 * JSON and /v2/point path as Airplanes.live. No key is required today;
 * adsb.lol has said feeder-issued API keys will be required in the future.
 * Rate limits are dynamic, so requests keep the same >=1.1 s spacing.
 */
export const ADSB_LOL_DEFAULT_BASE_URL = 'https://api.adsb.lol';

export class AdsbLolProvider extends ReadsbV2PointProvider {
  constructor(options: ReadsbV2Options) {
    super('adsb_lol', 'adsb.lol', options);
  }
}
