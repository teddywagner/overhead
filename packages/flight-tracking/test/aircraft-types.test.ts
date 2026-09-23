import { describe, expect, test } from 'bun:test';
import {
  decodeTar1090File,
  decodeTypeDescription,
  parseTar1090AircraftTypes,
  splitTypeName,
} from '../src';

describe('aircraft type names', () => {
  test.each([
    ['BELL 407', 'Bell', '407'],
    ['CESSNA 172 Skyhawk', 'Cessna', '172 Skyhawk'],
    ['BOEING 737 MAX 8', 'Boeing', '737 MAX 8'],
    ['ROBINSON R-44 Raven', 'Robinson', 'R-44 Raven'],
    ['AIRBUS HELICOPTERS EC-135/635', 'Airbus Helicopters', 'EC-135/635'],
    ['DE HAVILLAND CANADA DHC-6 Twin Otter', 'De Havilland Canada', 'DHC-6 Twin Otter'],
    ['MCDONNELL-DOUGLAS MD-11', 'McDonnell-Douglas', 'MD-11'],
    ['BRITISH AEROSPACE ATP', 'British Aerospace', 'ATP'],
    ['FLIGHT DESIGN CT', 'Flight Design', 'CT'],
    ['ATR ATR-72-600', 'ATR', 'ATR-72-600'],
  ])('%s -> %s / %s', (name, manufacturer, model) => {
    expect(splitTypeName(name)).toEqual({ manufacturer, model });
  });

  test('names that start with the model keep it whole', () => {
    expect(splitTypeName('ATR-72-600')).toEqual({ manufacturer: null, model: 'ATR-72-600' });
    expect(splitTypeName('AEROPUP')).toEqual({ manufacturer: null, model: 'AEROPUP' });
  });
});

describe('ICAO description codes', () => {
  test.each([
    ['H1T', 'helicopter', 1, 'turbine'],
    ['H1P', 'helicopter', 1, 'piston'],
    ['L2J', 'landplane', 2, 'jet'],
    ['A1P', 'amphibian', 1, 'piston'],
    ['G1P', 'gyrocopter', 1, 'piston'],
    ['L1E', 'landplane', 1, 'electric'],
  ])('%s', (desc, aircraftClass, engineCount, engineType) => {
    expect(decodeTypeDescription(desc)).toEqual({
      aircraftClass,
      engineCount,
      engineType,
    } as ReturnType<typeof decodeTypeDescription>);
  });

  test('unknown or partial codes decode to nulls', () => {
    expect(decodeTypeDescription('B0-')).toEqual({
      aircraftClass: 'balloon',
      engineCount: 0,
      engineType: null,
    });
    expect(decodeTypeDescription('')).toEqual({
      aircraftClass: null,
      engineCount: null,
      engineType: null,
    });
  });
});

describe('tar1090 file parsing', () => {
  const sample = {
    B407: ['BELL 407', 'H1T', 'L'],
    C172: ['CESSNA 172 Skyhawk', 'L1P', 'L'],
    bad: ['', 'L1P', 'L'],
    '!!': ['NONSENSE', 'L1P', 'L'],
  };

  test('parses entries and skips invalid ones', () => {
    const records = parseTar1090AircraftTypes(sample);
    expect(records).toEqual([
      {
        icaoTypeCode: 'B407',
        name: 'BELL 407',
        manufacturer: 'Bell',
        model: '407',
        aircraftClass: 'helicopter',
        engineCount: 1,
        engineType: 'turbine',
        wakeCategory: 'L',
      },
      {
        icaoTypeCode: 'C172',
        name: 'CESSNA 172 Skyhawk',
        manufacturer: 'Cessna',
        model: '172 Skyhawk',
        aircraftClass: 'landplane',
        engineCount: 1,
        engineType: 'piston',
        wakeCategory: 'L',
      },
    ]);
  });

  test('decodes gzip-compressed and plain JSON files', () => {
    const json = new TextEncoder().encode(JSON.stringify(sample));
    const gz = Bun.gzipSync(json);
    expect(decodeTar1090File(new Uint8Array(gz))).toEqual(sample);
    expect(decodeTar1090File(json)).toEqual(sample);
  });

  test('rejects an unexpected shape', () => {
    expect(() => parseTar1090AircraftTypes([1, 2, 3])).toThrow();
  });
});
