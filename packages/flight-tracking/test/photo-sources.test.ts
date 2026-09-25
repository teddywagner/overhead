import { describe, expect, test } from 'bun:test';
import {
  AdsbdbClient,
  ProviderError,
  WikimediaCommonsClient,
  parseAdsbdbPhoto,
  parseCommonsPhotos,
  plainText,
} from '../src';
import aircraftFixture from './fixtures/adsbdb-aircraft.json';

const commonsBody = {
  query: {
    pages: [
      {
        title: 'File:Delta 737 at ATL.jpg', // not this airframe: dropped
        index: 1,
        imageinfo: [
          {
            url: 'https://upload.test/other.jpg',
            descriptionurl: 'https://commons.test/File:other',
            mime: 'image/jpeg',
          },
        ],
      },
      {
        title: 'File:N398DN - Airbus A321-211 - Delta Air Lines (51985339754).jpg',
        index: 2,
        imageinfo: [
          {
            url: 'https://upload.test/n398dn.jpg',
            thumburl: 'https://upload.test/500px-n398dn.jpg',
            descriptionurl: 'https://commons.test/File:N398DN.jpg',
            mime: 'image/jpeg',
            extmetadata: {
              Artist: {
                value:
                  '<a rel="nofollow" class="external text" href="https://www.flickr.com/people/x">Colin Brown</a> from St Ann, &amp; Jamaica',
              },
              LicenseShortName: { value: 'CC BY 2.0' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by/2.0' },
            },
          },
        ],
      },
      {
        title: 'File:N398DN diagram.svg', // not a photo
        index: 3,
        imageinfo: [
          {
            url: 'https://upload.test/d.svg',
            descriptionurl: 'https://commons.test/File:d',
            mime: 'image/svg+xml',
          },
        ],
      },
    ],
  },
};

describe('photo sources', () => {
  test('commons keeps photos named after the airframe, with plain-text credits', () => {
    expect(parseCommonsPhotos(commonsBody, 'n398dn')).toEqual([
      {
        provider: 'wikimedia_commons',
        thumbnailUrl: 'https://upload.test/500px-n398dn.jpg',
        imageUrl: 'https://upload.test/n398dn.jpg',
        pageUrl: 'https://commons.test/File:N398DN.jpg',
        creator: 'Colin Brown from St Ann, & Jamaica',
        licenseName: 'CC BY 2.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/2.0',
      },
    ]);
    expect(parseCommonsPhotos({ batchcomplete: true }, 'N1')).toEqual([]);
    expect(() => parseCommonsPhotos('nope', 'N1')).toThrow(ProviderError);
    expect(plainText('  ')).toBeNull();
  });

  test('commons searches by quoted registration and maps 429', async () => {
    let asked = '';
    const ok = new WikimediaCommonsClient({
      baseUrl: 'https://commons.test',
      userAgent: 'overhead-tests/0.1 (+https://example.test)',
      fetch: (async (url: URL) => {
        asked = url.searchParams.get('gsrsearch') ?? '';
        return Response.json(commonsBody);
      }) as unknown as typeof fetch,
    });
    expect(await ok.photos('n398dn')).toHaveLength(1);
    expect(asked).toBe('"N398DN"');
    expect(await ok.photos(null)).toEqual([]);
    expect(await ok.photos('"; drop')).toEqual([]);

    const limited = new WikimediaCommonsClient({
      baseUrl: 'https://commons.test',
      userAgent: 'overhead-tests/0.1',
      fetch: (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch,
    });
    await expect(limited.photos('N398DN')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  test('adsbdb photo uses its image as the link and has no credit', async () => {
    const withPhoto = structuredClone(aircraftFixture) as {
      response: { aircraft: Record<string, unknown> };
    };
    withPhoto.response.aircraft.url_photo = 'https://image.test/1.jpg';
    withPhoto.response.aircraft.url_photo_thumbnail = 'https://image.test/t/1.jpg';
    expect(parseAdsbdbPhoto(withPhoto)).toEqual({
      provider: 'adsbdb',
      thumbnailUrl: 'https://image.test/t/1.jpg',
      imageUrl: 'https://image.test/1.jpg',
      pageUrl: 'https://image.test/1.jpg',
      creator: null,
      licenseName: null,
      licenseUrl: null,
    });
    expect(parseAdsbdbPhoto(aircraftFixture)).toBeNull(); // url_photo is null there
    expect(parseAdsbdbPhoto({ response: 'unknown aircraft' })).toBeNull();

    const client = new AdsbdbClient({
      baseUrl: 'https://api.adsbdb.test',
      userAgent: 'overhead-tests/0.1',
      fetch: (async () => Response.json(withPhoto)) as unknown as typeof fetch,
      sleep: async () => {},
      minRequestIntervalMs: 0,
    });
    expect((await client.photo('a3e07a'))?.imageUrl).toBe('https://image.test/1.jpg');
    expect(await client.photo('~2afe91')).toBeNull();
  });
});
