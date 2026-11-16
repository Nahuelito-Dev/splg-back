/** Escenario aislado de T4: tenants A/B con una zona y una franja por cada uno. */
import { DataSource } from 'typeorm';
import { CoverageZone } from '../../../src/coverage-zone/entities/coverage-zone.entity';
import { TimeSlot } from '../../../src/time-slot/entities/time-slot.entity';
import { TestApp } from '../setup/test-env';
import { Escenario, sembrarEscenario } from './matriz';

const poligono = (lng: number, lat: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lng, lat],
      [lng + 0.01, lat],
      [lng + 0.01, lat + 0.01],
      [lng, lat + 0.01],
      [lng, lat],
    ],
  ],
});

export interface EscenarioT4 extends Escenario {
  zonaA: string;
  zonaB: string;
  franjaA: string;
  franjaB: string;
}

export async function sembrarBaseT4(app: TestApp): Promise<EscenarioT4> {
  const e = await sembrarEscenario(app);
  const ds = app.get(DataSource);
  const zona = async (distributorId: string, name: string, lng: number) =>
    ds.getRepository(CoverageZone).save({
      distributorId,
      name,
      area: poligono(lng, -34.61),
      surchargeValue: 10,
      priority: 0,
      isActive: true,
    } as Partial<CoverageZone>);
  const franja = async (distributorId: string, name: string) =>
    ds.getRepository(TimeSlot).save({
      distributorId,
      name,
      startTime: '08:00',
      endTime: '10:00',
      capacity: 20,
      isActive: true,
    } as Partial<TimeSlot>);
  const [zonaA, zonaB, franjaA, franjaB] = await Promise.all([
    zona(e.distA.id, 'Zona T4 A', -58.4),
    zona(e.distB.id, 'Zona T4 B', -58.3),
    franja(e.distA.id, 'Franja T4 A'),
    franja(e.distB.id, 'Franja T4 B'),
  ]);
  return {
    ...e,
    zonaA: zonaA.coverageZoneId,
    zonaB: zonaB.coverageZoneId,
    franjaA: franjaA.timeSlotId,
    franjaB: franjaB.timeSlotId,
  };
}

export const zonaValida = (name: string) => ({
  name,
  polygon: [
    [-58.42, -34.62],
    [-58.41, -34.62],
    [-58.41, -34.61],
    [-58.42, -34.61],
  ],
  surchargeType: 'percentage',
  surchargeValue: 5,
  color: '#FF7A00',
});

export const franjaValida = (name: string) => ({
  name,
  startTime: '14:00',
  endTime: '16:00',
  capacity: 20,
});
