import { haversineMatrix } from './route-matrix';
import { distanciaEnMetros } from './routes.service';

const POSADAS = { lat: -27.3671, lng: -55.8961 };
const OBERA = { lat: -27.4871, lng: -55.1199 };
const GARUPA = { lat: -27.4817, lng: -55.8267 };

describe('haversineMatrix', () => {
  const m = haversineMatrix([POSADAS, OBERA, GARUPA]);

  it('es cuadrada, con diagonal en cero y simétrica', () => {
    expect(m.km).toHaveLength(3);
    expect(m.minutes).toHaveLength(3);
    for (let a = 0; a < 3; a++) {
      expect(m.km[a][a]).toBe(0);
      expect(m.minutes[a][a]).toBe(0);
      for (let b = 0; b < 3; b++) {
        expect(m.km[a][b]).toBe(m.km[b][a]);
        expect(m.minutes[a][b]).toBe(m.minutes[b][a]);
      }
    }
  });

  it('los kilómetros son la línea recta por 1,3 (las calles no son rectas)', () => {
    const recta = distanciaEnMetros(POSADAS, OBERA) / 1000;
    expect(recta).toBeGreaterThan(70);
    expect(m.km[0][1]).toBeCloseTo(recta * 1.3, 6);
  });

  it('los minutos salen de esos kilómetros a 30 km/h', () => {
    expect(m.minutes[0][1]).toBeCloseTo((m.km[0][1] / 30) * 60, 6);
    expect(m.minutes[0][2]).toBeCloseTo((m.km[0][2] / 30) * 60, 6);
  });

  it('dice de dónde salió', () => {
    expect(m.source).toBe('haversine');
  });

  it('un punto o ninguno dan matrices mínimas', () => {
    expect(haversineMatrix([POSADAS])).toEqual({
      km: [[0]],
      minutes: [[0]],
      source: 'haversine',
    });
    expect(haversineMatrix([])).toEqual({
      km: [],
      minutes: [],
      source: 'haversine',
    });
  });
});
