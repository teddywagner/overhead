import { describe, expect, test } from 'bun:test';
import { PlanespottersClient, ProviderError, parsePlanespottersPhotos } from '../src';
import photosFixture from './fixtures/planespotters-photos.json';

describe('planespotters parsing', () => {
  test('maps the first photo', () => {
    expect(parsePlanespottersPhotos(photosFixture)).toEqual({
      thumbnailUrl: 'https://t.plnspttrs.net/14749/1877174_61804ab00b_t.jpg',
      largeUrl: 'https://t.plnspttrs.net/14749/1877174_61804ab00b_280.jpg',
      pageUrl:
        'https://www.planespotters.net/photo/1877174/n349tv-american-airlines-boeing-737-8-max?utm_source=api',
      photographer: 'Gerrit Griem',
    });
  });

  test('no photos is null; malformed or non-https links are errors', () => {
    expect(parsePlanespottersPhotos({ photos: [] })).toBeNull();
    expect(() => parsePlanespottersPhotos({ error: 'nope' })).toThrow(ProviderError);
    expect(() =>
      parsePlanespottersPhotos({
        photos: [{ thumbnail: { src: 'javascript:alert(1)' }, link: 'https://x.test' }],
      }),
    ).toThrow(ProviderError);
  });
});

describe('planespotters client', () => {
  const make = (fetchImpl: typeof fetch) =>
    new PlanespottersClient({
      baseUrl: 'https://api.planespotters.test',
      userAgent: 'overhead-tests/0.1 (+https://example.test)',
      fetch: fetchImpl,
      sleep: async () => {},
      minRequestIntervalMs: 0,
    });

  test('looks up by hex, then by registration, with the User-Agent', async () => {
    const seen: Array<{ url: string; ua: string | null }> = [];
    const client = make((async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), ua: new Headers(init.headers).get('user-agent') });
      return Response.json(String(url).includes('/reg/') ? photosFixture : { photos: [] });
    }) as unknown as typeof fetch);
    expect((await client.photo('a3e07a', 'n349tv'))?.photographer).toBe('Gerrit Griem');
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.planespotters.test/pub/photos/hex/A3E07A',
      'https://api.planespotters.test/pub/photos/reg/N349TV',
    ]);
    expect(seen.every((s) => s.ua === 'overhead-tests/0.1 (+https://example.test)')).toBe(true);
  });

  test('anonymised addresses without a registration are never sent', async () => {
    let calls = 0;
    const client = make((async () => {
      calls++;
      return Response.json(photosFixture);
    }) as unknown as typeof fetch);
    expect(await client.photo('~2afe91', null)).toBeNull();
    expect(await client.photo('~2afe91', '../etc')).toBeNull();
    expect(calls).toBe(0);
  });

  test('rate limits and server errors surface as provider errors', async () => {
    const limited = make(
      (async () =>
        new Response('', {
          status: 429,
          headers: { 'retry-after': '30' },
        })) as unknown as typeof fetch,
    );
    await expect(limited.photo('a3e07a')).rejects.toMatchObject({ code: 'rate_limited' });
    const forbidden = make((async () =>
      Response.json({ error: 'User-Agent' }, { status: 403 })) as unknown as typeof fetch);
    await expect(forbidden.photo('a3e07a')).rejects.toMatchObject({ code: 'http_error' });
  });
});
