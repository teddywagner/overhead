import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@overhead/core';
import {
  DEFAULT_DISPLAY_SETTINGS,
  type CurrentSelection,
  type DisplayCandidate,
} from '@overhead/display';
import type { DisplayDevice } from '@overhead/display/sql';
import { DisplayScheduler, type DisplayStore } from '../src/display-scheduler';

const DEVICE: DisplayDevice = {
  deviceId: '77777777-0000-4000-8000-000000000001',
  ownerId: '11111111-1111-4111-8111-111111111111',
  locationId: '22222222-2222-4222-8222-222222222222',
  timeZone: 'America/New_York',
  pollIntervalSeconds: 3600,
  rules: { overhead_radius_m: 1200, max_altitude_ft: 15000 },
  settings: { ...DEFAULT_DISPLAY_SETTINGS, min_dwell_minutes: 60, window_hours: 6 },
};

function pass(id: string, seenAt: Date, over: Partial<DisplayCandidate> = {}): DisplayCandidate {
  return {
    overflight_id: id,
    icao24: id.slice(-6),
    registration: null,
    callsign: null,
    flight_number: null,
    origin_code: null,
    destination_code: null,
    origin_name: null,
    destination_name: null,
    closest_seen_at: seenAt.toISOString(),
    status: 'qualified',
    minimum_distance_m: 300,
    closest_altitude_ft: 4000,
    icao_type_code: null,
    manufacturer: null,
    model: null,
    operator_name: null,
    operator_icao: null,
    aircraft_class: null,
    art_asset_id: null,
    art_scope: null,
    airframe_sightings: 1,
    type_sightings: null,
    ...over,
  };
}

class MemoryDisplayStore implements DisplayStore {
  passes: DisplayCandidate[] = [];
  commits: Array<{ selectedAt: Date; ids: string[]; reason: string }> = [];
  async devices() {
    return [DEVICE];
  }
  async candidates(_d: DisplayDevice, now: Date, windowHours: number) {
    const since = now.getTime() - windowHours * 3_600_000;
    return this.passes.filter((p) => {
      const t = Date.parse(p.closest_seen_at);
      return t > since && t <= now.getTime();
    });
  }
  async current(): Promise<CurrentSelection | null> {
    const last = this.commits.at(-1);
    return last ? { overflight_ids: last.ids, selected_at: last.selectedAt.toISOString() } : null;
  }
  async commit(_d: DisplayDevice, s: Parameters<DisplayStore['commit']>[1]) {
    this.commits.push({
      selectedAt: s.selectedAt,
      ids: s.items.map((i) => i.overflight_id),
      reason: s.reason,
    });
  }
}

describe('DisplayScheduler', () => {
  test('commits at most once per dwell period and never blanks the frame', async () => {
    let now = Date.parse('2026-09-23T12:00:00Z');
    const store = new MemoryDisplayStore();
    const scheduler = new DisplayScheduler({
      store,
      logger: silentLogger,
      intervalS: 60,
      clock: () => new Date(now),
    });
    const minutes = (m: number) => (now += m * 60_000);

    // Empty sky: nothing to commit.
    expect((await scheduler.runOnce()).committed).toBe(0);

    store.passes.push(pass('00000000-0000-4000-8000-000000000001', new Date(now - 60_000)));
    expect((await scheduler.runOnce()).committed).toBe(1);
    expect(store.commits[0]?.reason).toBe('initial');

    // A new plane 10 minutes later is held for the rest of the hour...
    minutes(10);
    store.passes.push(pass('00000000-0000-4000-8000-000000000002', new Date(now - 60_000)));
    expect((await scheduler.runOnce()).committed).toBe(0);
    minutes(45);
    expect((await scheduler.runOnce()).committed).toBe(0);

    // ...and committed once the dwell time has passed.
    minutes(6);
    expect((await scheduler.runOnce()).committed).toBe(1);
    expect(store.commits[1]?.reason).toBe('changed');
    expect(store.commits[1]?.ids).toHaveLength(2);

    // Everything ages out of the 6 h window: the last selection stays.
    minutes(8 * 60);
    expect((await scheduler.runOnce()).committed).toBe(0);
    expect(store.commits).toHaveLength(2);
  });

  test('one failing device does not stop the round', async () => {
    const store = new MemoryDisplayStore();
    store.candidates = async () => {
      throw new Error('boom');
    };
    const scheduler = new DisplayScheduler({ store, logger: silentLogger, intervalS: 60 });
    expect(await scheduler.runOnce()).toEqual({ devices: 1, committed: 0, errors: 1 });
  });
});
