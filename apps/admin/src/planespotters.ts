import { api, unwrap, type Schemas } from './api';

/**
 * Aircraft photos from Planespotters.net, looked up through the API (it
 * needs a server User-Agent with contact details). The images themselves are
 * hotlinked from Planespotters, as their terms require, with the
 * photographer credited and a link to the photo page.
 */
export type PlanePhoto = NonNullable<Schemas['AircraftPhoto']['photo']>;

const MAX_CONCURRENT = 3;
const cache = new Map<string, Promise<PlanePhoto | null>>();
let active = 0;
const waiting: Array<() => void> = [];

async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((go) => waiting.push(go));
  active++;
  try {
    return await run();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Best photo for an airframe; null when Planespotters has none. */
export function planePhoto(
  icao24: string,
  registration: string | null,
): Promise<PlanePhoto | null> {
  const key = `${icao24}|${registration ?? ''}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = limited(() =>
      unwrap(
        api.GET('/admin/v1/aircraft-photos/{icao24}', {
          params: {
            path: { icao24 },
            query: registration ? { registration } : {},
          },
        }),
      ).then((d) => d.photo),
    );
    // Forget failures so a later render can retry.
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}
