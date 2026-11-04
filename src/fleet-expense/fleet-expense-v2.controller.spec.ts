import {
  INestApplication,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { RoleType } from '../common/constants/role-type.enum';
import { RedisService } from '../redis/redis.service';
import { FleetExpensePaymentService } from './fleet-expense-payment.service';
import {
  FuelLoadV2Controller,
  TireV2Controller,
  VehicleAccidentV2Controller,
} from './fleet-expense-v2.controller';
import { FuelLoadService } from './fuel-load.service';
import { TireService } from './tire.service';
import { VehicleAccidentService } from './vehicle-accident.service';
import { crearValidationPipe } from '../common/validation/validation-pipe';

const ID = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f001';
const CAJA = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f003';

const neumatico = {
  tireId: ID,
  distributorId: 'd1',
  serialNumber: 'S',
  brand: 'B',
  size: '1',
  cost: 100,
  status: 'in_stock',
  carId: null,
  position: null,
  mountedOdometerKm: null,
  kmTraveled: 0,
  retreadCount: 0,
  createdAt: new Date(),
  cashMovementId: 'mov1',
  paidAt: new Date('2026-10-28T15:00:00.000Z'),
};

describe('Gastos de la flota v2 (HTTP)', () => {
  let app: INestApplication<Server>;
  let pagos: {
    pagarNeumatico: jest.Mock;
    pagarSiniestro: jest.Mock;
    registrarReintegro: jest.Mock;
  };
  let tires: { findOne: jest.Mock; historial: jest.Mock; findAll: jest.Mock };

  beforeEach(async () => {
    pagos = {
      pagarNeumatico: jest.fn().mockResolvedValue(undefined),
      pagarSiniestro: jest.fn().mockResolvedValue(undefined),
      registrarReintegro: jest.fn().mockResolvedValue(undefined),
    };
    tires = {
      findOne: jest.fn().mockResolvedValue(neumatico),
      historial: jest.fn().mockResolvedValue([]),
      findAll: jest.fn().mockResolvedValue({ data: [neumatico], total: 1 }),
    };
    const modulo = await Test.createTestingModule({
      controllers: [
        TireV2Controller,
        FuelLoadV2Controller,
        VehicleAccidentV2Controller,
      ],
      providers: [
        { provide: TireService, useValue: tires },
        { provide: FuelLoadService, useValue: {} },
        { provide: VehicleAccidentService, useValue: { findOne: jest.fn() } },
        { provide: FleetExpensePaymentService, useValue: pagos },
        { provide: RedisService, useValue: {} },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = 'd1';
      req.user = { user_id: 'u1', email: 'a@b.c', role: RoleType.ADMIN };
      next();
    });
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.useGlobalPipes(crearValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /v2/fleet/fuel-loads/quote calcula el importe: litros × precio a 2 decimales', async () => {
    const res = await request(app.getHttpServer())
      .get('/v2/fleet/fuel-loads/quote')
      .query({ liters: 40.5, unitPrice: 1050.5 })
      .expect(200);
    expect(res.body).toEqual({
      liters: 40.5,
      unitPrice: 1050.5,
      totalAmount: 42545.25,
    });
  });

  it('GET /v2/fleet/fuel-loads/quote rechaza litros o precio inválidos', async () => {
    await request(app.getHttpServer())
      .get('/v2/fleet/fuel-loads/quote')
      .query({ liters: 0, unitPrice: 1000 })
      .expect(400);
    await request(app.getHttpServer())
      .get('/v2/fleet/fuel-loads/quote')
      .query({ liters: 10 })
      .expect(400);
  });

  it('POST /v2/fleet/tires/:id/pay paga y responde el neumático con su estado de pago', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v2/fleet/tires/${ID}/pay`)
      .send({ cashBoxId: CAJA, paidAt: '2026-10-28T12:00:00-03:00' })
      .expect(201);
    expect(res.body).toMatchObject({ isPaid: true, cashMovementId: 'mov1' });
    expect(pagos.pagarNeumatico).toHaveBeenCalledWith(
      ID,
      { cashBoxId: CAJA, paidAt: '2026-10-28T12:00:00-03:00' },
      'd1',
      'u1',
    );
  });

  it('sin caja, con caja que no es UUID o con fecha inválida es 400', async () => {
    for (const body of [
      { paidAt: '2026-10-28' },
      { cashBoxId: 'x', paidAt: '2026-10-28' },
      { cashBoxId: CAJA, paidAt: 'ayer' },
    ]) {
      await request(app.getHttpServer())
        .post(`/v2/fleet/tires/${ID}/pay`)
        .send(body)
        .expect(400);
    }
    expect(pagos.pagarNeumatico).not.toHaveBeenCalled();
  });

  it('el pago del siniestro exige un importe positivo', async () => {
    await request(app.getHttpServer())
      .post(`/v2/fleet/accidents/${ID}/pay`)
      .send({ cashBoxId: CAJA, paidAt: '2026-10-28', amount: 0 })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/v2/fleet/accidents/${ID}/reimbursement`)
      .send({ cashBoxId: CAJA, receivedAt: '2026-10-28' })
      .expect(400);
    expect(pagos.pagarSiniestro).not.toHaveBeenCalled();
    expect(pagos.registrarReintegro).not.toHaveBeenCalled();
  });

  it('el listado v2 trae isPaid y en la v1 el pago no existe', async () => {
    const res = await request(app.getHttpServer())
      .get('/v2/fleet/tires')
      .expect(200);
    expect(
      (res.body as { data: Array<{ isPaid: boolean }> }).data[0].isPaid,
    ).toBe(true);
    await request(app.getHttpServer())
      .post(`/v1/fleet/tires/${ID}/pay`)
      .send({})
      .expect(404);
  });
});
