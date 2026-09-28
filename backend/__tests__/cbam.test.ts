
import { detectCBAMSector, CBAM_SECTORS } from '../src/services/cbamCalculator';

describe('CBAM Sector Detection', () => {
  test('HS72xx should detect steel', () => {
    const sector = detectCBAMSector('7208.39');
    expect(sector).not.toBeNull();
    expect(sector!.sector).toBe('steel');
  });

  test('HS76xx should detect aluminum', () => {
    const sector = detectCBAMSector('7601.10');
    expect(sector).not.toBeNull();
    expect(sector!.sector).toBe('aluminum');
  });

  test('HS2523 should detect cement', () => {
    const sector = detectCBAMSector('2523.10');
    expect(sector).not.toBeNull();
    expect(sector!.sector).toBe('cement');
  });

  test('Non-CBAM HS code should return null', () => {
    const sector = detectCBAMSector('8471.30');
    expect(sector).toBeNull();
  });

  test('All CBAM sectors have valid config', () => {
    expect(CBAM_SECTORS.length).toBe(6); // steel, aluminum, cement, fertilizer, electricity, hydrogen
    CBAM_SECTORS.forEach(s => {
      expect(s.hsPrefixes.length).toBeGreaterThan(0);
      expect(s.defaultUnit).toBeTruthy();
    });
  });
});
