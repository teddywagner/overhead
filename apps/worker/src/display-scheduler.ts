import type { Logger } from '@overhead/core';
import type { Sql } from '@overhead/database';
import {
  decideCommit,
  selectForDisplay,
  toDisplayItems,
  type CommitReason,
  type CurrentSelection,
  type DisplayCandidate,
  type DisplayItem,
  type DisplaySettings,
} from '@overhead/display';
import {
  insertDisplaySelection,
  loadCurrentSelection,
  loadDisplayCandidates,
  loadDisplayDevices,
  type DisplayDevice,
} from '@overhead/display/sql';
import { safeMessage } from './poller';

export interface DisplayStore {
  devices(): Promise<DisplayDevice[]>;
  candidates(device: DisplayDevice, now: Date, windowHours: number): Promise<DisplayCandidate[]>;
  current(device: DisplayDevice): Promise<CurrentSelection | null>;
  commit(
    device: DisplayDevice,
    selection: {
      reason: CommitReason;
      selectedAt: Date;
      items: DisplayItem[];
      settings: DisplaySettings;
    },
  ): Promise<void>;
}

export class PostgresDisplayStore implements DisplayStore {
  constructor(private readonly sql: Sql) {}
  devices() {
    return loadDisplayDevices(this.sql, { activeLocationsOnly: true });
  }
  candidates(device: DisplayDevice, now: Date, windowHours: number) {
    return loadDisplayCandidates(this.sql, device, now, windowHours);
  }
  current(device: DisplayDevice) {
    return loadCurrentSelection(this.sql, device);
  }
  commit(device: DisplayDevice, selection: Parameters<DisplayStore['commit']>[1]) {
    return insertDisplaySelection(this.sql, device, selection);
  }
}

export interface DisplayRound {
  devices: number;
  committed: number;
  errors: number;
}

export interface DisplaySchedulerOptions {
  store: DisplayStore;
  logger: Logger;
  intervalS: number;
  clock?: () => Date;
}

/**
 * Decides, for every frame, which recent overflights it should show, and
 * commits a new selection when the pick changes and the current one has
 * been up for the frame's dwell time. Committed selections are the render
 * queue for the portrait renderer.
 */
export class DisplayScheduler {
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: DisplaySchedulerOptions) {}

  async runOnce(): Promise<DisplayRound> {
    const { store, logger } = this.options;
    const now = (this.options.clock ?? (() => new Date()))();
    const round: DisplayRound = { devices: 0, committed: 0, errors: 0 };
    let devices: DisplayDevice[];
    try {
      devices = await store.devices();
    } catch (err) {
      logger.error('display round failed', { error: safeMessage(err) });
      return { ...round, errors: 1 };
    }
    for (const device of devices) {
      if (this.stopped) break;
      round.devices++;
      try {
        const { settings } = device;
        const candidates = await store.candidates(device, now, settings.window_hours);
        const pick = selectForDisplay(candidates, settings, device.rules, now);
        const current = await store.current(device);
        const decision = decideCommit(
          current,
          pick.selected.map((s) => s.candidate.overflight_id),
          now,
          settings.min_dwell_minutes,
        );
        if (!decision.commit) continue;
        await store.commit(device, {
          reason: decision.reason,
          selectedAt: now,
          items: toDisplayItems(pick.selected),
          settings,
        });
        round.committed++;
        logger.info('display selection committed', {
          device_id: device.deviceId,
          reason: decision.reason,
          planes: pick.selected.length,
        });
      } catch (err) {
        round.errors++;
        logger.error('display selection failed', {
          device_id: device.deviceId,
          error: safeMessage(err),
        });
      }
    }
    return round;
  }

  async start(): Promise<void> {
    const intervalMs = this.options.intervalS * 1000;
    while (!this.stopped) {
      await this.runOnce();
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }
}
