import { haversineDistanceMeters } from './geo.util';

describe('haversineDistanceMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineDistanceMeters(13.0827, 80.2707, 13.0827, 80.2707)).toBe(0);
  });

  it('computes ~111.2km for 1 degree of latitude apart', () => {
    const distance = haversineDistanceMeters(0, 0, 1, 0);
    expect(distance).toBeGreaterThan(110_000);
    expect(distance).toBeLessThan(112_000);
  });

  it('computes a small distance correctly (~1.1km for 0.01 degree latitude)', () => {
    const distance = haversineDistanceMeters(13.0827, 80.2707, 13.0927, 80.2707);
    expect(distance).toBeGreaterThan(1000);
    expect(distance).toBeLessThan(1200);
  });
});
