import type { ProviderName } from '@overhead/core';

/**
 * Provider-neutral aircraft position. Every provider adapter maps its own
 * wire format to this shape; nothing provider-specific leaks past it.
 * Unknown values are always `null`, never empty strings or sentinels.
 */
export interface NormalizedAircraftPosition {
  icao24: string;
  callsign: string | null;
  registration: string | null;
  icaoTypeCode: string | null;
  typeDescription: string | null;
  operatorName: string | null;
  latitude: number;
  longitude: number;
  /** Barometric altitude in feet; null when unknown. */
  altitudeFt: number | null;
  onGround: boolean;
  groundspeedKnots: number | null;
  trackDegrees: number | null;
  /** When the position was measured (not when it was fetched). */
  observedAt: Date;
  /** Transponder/message source reported by the provider, e.g. "adsb_icao". */
  source: string | null;
}

export interface AircraftQuery {
  latitude: number;
  longitude: number;
  radiusNm: number;
}

export interface AircraftPositionProvider {
  readonly name: ProviderName;
  getAircraftNear(input: AircraftQuery): Promise<NormalizedAircraftPosition[]>;
}

/** Safe-to-log provider failure. Messages never include request URLs. */
export class ProviderError extends Error {
  constructor(
    public readonly code:
      | 'timeout'
      | 'rate_limited'
      | 'access_denied'
      | 'http_error'
      | 'invalid_response'
      | 'network_error',
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
