import {
  INestApplication,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { RoleType } from '../../common/constants/role-type.enum';
import { RedisService } from '../../redis/redis.service';
import { InsurancePolicyService } from '../application/insurance-policy.service';
import { InsuranceQueryService } from '../application/insurance-query.service';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { InsurancePolicyController } from './insurance-policy.controller';
import { crearValidationPipe } from '../../common/validation/validation-pipe';

const UUID = (n: number) => `0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f00${n}`;

const poliza = {
  policyId: UUID(1),
  carId: UUID(2),
  car: { carPatent: 'OVQ621' },
  insurerId: UUID(3),
  insurer: {
    insurerId: UUID(3),
    name: 'Seguros Rivadavia',
    paymentUrl: 'https://pagos.test',
  },
  policyNumber: '67/02/192143',
  coverage: 'Todo riesgo',
  validFrom: '2099-06-22',
  validTo: '2099-12-22',
  paymentCode: null,
  cancelledAt: null,
  cancelReason: null,
  installments: [],
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
} as unknown as InsurancePolicy;

describe('InsurancePolicyController · pólizas en la API v2', () => {
  let app: INestApplication<Server>;
  let polizas: { crear: jest.Mock; modificar: jest.Mock; cancelar: jest.Mock };
  let consultas: { findPolicy: jest.Mock; ofCar: jest.Mock };

  beforeEach(async () => {
    polizas = {
      crear: jest.fn().mockResolvedValue({
        policyId: UUID(1),
        fleet: { synced: false, taskId: null, reason: 'sin plan' },
      }),
      modificar: jest.fn().mockResolvedValue(undefined),
      cancelar: jest.fn().mockResolvedValue(undefined),
    };
    consultas = {
      findPolicy: jest.fn().mockResolvedValue(poliza),
      ofCar: jest.fn().mockResolvedValue({ current: poliza, history: [] }),
    };
    const modulo = await Test.createTestingModule({
      controllers: [InsurancePolicyController],
      providers: [
        { provide: InsurancePolicyService, useValue: polizas },
        { provide: InsuranceQueryService, useValue: consultas },
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
    await app.listen(0, '127.0.0.1'); // una sola vez y en loopback, adonde se conecta supertest: si no, falla al azar con carga
  });

  afterEach(async () => {
    await app.close();
  });

  const alta = {
    carId: UUID(2),
    insurerId: UUID(3),
    policyNumber: '67/02/192143',
    coverage: 'Todo riesgo',
    validFrom: '2099-06-22',
    validTo: '2099-12-22',
    installments: { count: 6, amount: 29958, firstDueDate: '2099-06-22' },
  };

  it('POST /v2/insurance-policies da de alta y responde la póliza con lo que pasó en la flota', async () => {
    const res = await request(app.getHttpServer())
      .post('/v2/insurance-policies')
      .send(alta)
      .expect(201);

    expect(polizas.crear).toHaveBeenCalledWith(alta, 'd1');
    expect(res.body).toMatchObject({
      policyId: UUID(1),
      status: 'upcoming',
      carPatent: 'OVQ621',
      insurer: { name: 'Seguros Rivadavia', paymentUrl: 'https://pagos.test' },
      fleet: { synced: false, taskId: null, reason: 'sin plan' },
    });
  });

  it.each([
    ['sin cuotas', { installments: undefined }],
    [
      'con 0 cuotas',
      { installments: { count: 0, amount: 10, firstDueDate: '2099-06-22' } },
    ],
    ['con una fecha inválida', { validFrom: '22/06/2099' }],
    ['sin número de póliza', { policyNumber: '   ' }],
    ['con un vehículo que no es UUID', { carId: 'x' }],
  ])('400 %s', async (_caso, cambio) => {
    await request(app.getHttpServer())
      .post('/v2/insurance-policies')
      .send({ ...alta, ...cambio })
      .expect(400);
    expect(polizas.crear).not.toHaveBeenCalled();
  });

  it('GET /v2/cars/:carId/insurance responde la vigente y el historial', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v2/cars/${UUID(2)}/insurance`)
      .expect(200);

    expect(consultas.ofCar).toHaveBeenCalledWith(UUID(2), 'd1');
    expect(res.body).toMatchObject({
      carId: UUID(2),
      current: { policyNumber: '67/02/192143' },
      history: [],
    });
  });

  it('POST /v2/insurance-policies/:id/cancel exige motivo y devuelve la póliza', async () => {
    await request(app.getHttpServer())
      .post(`/v2/insurance-policies/${UUID(1)}/cancel`)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post(`/v2/insurance-policies/${UUID(1)}/cancel`)
      .send({ reason: 'Se vendió el vehículo' })
      .expect(200);
    expect(polizas.cancelar).toHaveBeenCalledWith(
      UUID(1),
      { reason: 'Se vendió el vehículo' },
      'd1',
    );
  });

  it('PATCH no acepta cambiar la vigencia ni las cuotas', async () => {
    await request(app.getHttpServer())
      .patch(`/v2/insurance-policies/${UUID(1)}`)
      .send({ validTo: '2100-01-01' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/v2/insurance-policies/${UUID(1)}`)
      .send({ coverage: 'Terceros completo' })
      .expect(200);
    expect(polizas.modificar).toHaveBeenCalledTimes(1);
  });

  it('en la v1 no existe nada de esto', async () => {
    await request(app.getHttpServer())
      .get(`/v1/cars/${UUID(2)}/insurance`)
      .expect(404);
    await request(app.getHttpServer())
      .post('/v1/insurance-policies')
      .send(alta)
      .expect(404);
  });
});
