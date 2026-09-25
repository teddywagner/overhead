import { describe, expect, test } from 'bun:test';
import type { AircraftPhoto } from '@overhead/flight-tracking';
import { CachedAircraftPhotos } from '../src/lib/aircraft-photos';

const PHOTO: AircraftPhoto = {
  thumbnailUrl: 'https://t.test/1_t.jpg',
  largeUrl: 'https://t.test/1_280.jpg',
  pageUrl: 'https://p.test/photo/1',
  photographer: 'Someone',
};
const HOUR = 60 * 60 * 1000;

describe('cached aircraft photos', () => {
  test('shares concurrent lookups and reuses results until they expire', async () => {
    let now = 0;
    let calls = 0;
    const cache = new CachedAircraftPhotos(
      {
        planespotters: {
          photo: async (hex) => {
            calls++;
            return hex === 'a3e07a' ? PHOTO : null;
          },
        },
      },
      () => now,
    );
    await Promise.all([cache.photo('a3e07a', 'N1'), cache.photo('A3E07A', 'n1')]);
    expect(calls).toBe(1);

    now = 11 * HOUR;
    expect(await cache.photo('a3e07a', 'N1')).toEqual(PHOTO);
    expect(calls).toBe(1);
    now = 13 * HOUR; // hits live 12 h
    await cache.photo('a3e07a', 'N1');
    expect(calls).toBe(2);

    expect(await cache.photo('000001', null)).toBeNull();
    now += HOUR / 2;
    await cache.photo('000001', null);
    expect(calls).toBe(3);
    now += HOUR; // misses live 1 h
    await cache.photo('000001', null);
    expect(calls).toBe(4);
  });

  test('candidates merge every source and survive one failing', async () => {
    let commonsCalls = 0;
    const commonsPhoto = {
      provider: 'wikimedia_commons' as const,
      thumbnailUrl: 'https://c.test/t.jpg',
      imageUrl: 'https://c.test/f.jpg',
      pageUrl: 'https://c.test/File',
      creator: null,
      licenseName: 'CC0',
      licenseUrl: null,
    };
    const cache = new CachedAircraftPhotos({
      planespotters: { photo: async () => PHOTO },
      adsbdb: {
        photo: async () => {
          throw new Error('down');
        },
      },
      commons: {
        photos: async (reg) => {
          commonsCalls++;
          expect(reg).toBe('N1');
          return [commonsPhoto, { ...commonsPhoto }]; // duplicate dropped
        },
      },
    });
    const got = await cache.candidates('a3e07a', 'n1');
    expect(got.failed).toEqual(['adsbdb']);
    expect(got.items.map((c) => c.provider)).toEqual(['planespotters', 'wikimedia_commons']);
    expect(got.items[0]).toMatchObject({ imageUrl: PHOTO.largeUrl, creator: 'Someone' });
    await cache.candidates('a3e07a', 'N1');
    expect(commonsCalls).toBe(1);
    // No registration: Commons is not asked.
    await cache.candidates('a3e07a', null);
    expect(commonsCalls).toBe(1);
  });

  test('does not cache failures', async () => {
    let calls = 0;
    const cache = new CachedAircraftPhotos({
      planespotters: {
        photo: async () => {
          calls++;
          if (calls === 1) throw new Error('down');
          return PHOTO;
        },
      },
    });
    await expect(cache.photo('a3e07a', null)).rejects.toThrow('down');
    expect(await cache.photo('a3e07a', null)).toEqual(PHOTO);
    expect(calls).toBe(2);
  });
});
