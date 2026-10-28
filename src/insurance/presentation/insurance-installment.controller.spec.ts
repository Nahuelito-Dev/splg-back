import {
  INestApplication,
  ValidationPipe,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { RoleType } from '../../common/constants/role-type.enum';
import { RedisService } from '../../redis/redis.service';
import { InsuranceInstallmentService } from '../application/insurance-installment.service';
import { InsuranceQueryService } from '../application/insurance-query.service';
import { InstallmentStatus } from '../domain/insurance.enums';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsuranceInstallmentController } from './insurance-installment.controller';

const CUOTA = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f001';
const ADJUNTO = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f002';
const CAJA = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f003';
const PNG = Buffer.from('89504e470d0a1a0a0000000d', 'hex');

const cuotaPaga = {
  installmentId: CUOTA,
  policyId: 'p1',
  number: 5,
  total: 6,
  dueDate: '2026-11-22',
  graceUntil: '2026-11-27',
  amount: 29958,
  status: InstallmentStatus.PAID,
  paidAt: new Date('2026-10-20T17:30:00.000Z'),
  paidAmount: 29958,
  operationNumber: '88',
  paidByUserId: 'u1',
  cashMovementId: 'mov1',
  receiptAttachmentId: ADJUNTO,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  policy: {
    carId: 'c1',
    car: { carPatent: 'OVQ621' },
    policyNumber: 'N1',
    insurerId: 'i1',
    insurer: { name: 'Seguros Rivadavia', paymentUrl: null },
  },
} as unknown as InsuranceInstallment;

describe('InsuranceInstallmentController · cuotas del seguro en la API v2', () => {
  let app: INestApplication<Server>;
  let cuotas: {
    findOne: jest.Mock;
    modificar: jest.Mock;
    subirComprobante: jest.Mock;
    pagar: jest.Mock;
  };
  let consultas: { findInstallments: jest.Mock };

  beforeEach(async () => {
    cuotas = {
      findOne: jest.fn().mockResolvedValue(cuotaPaga),
      modificar: jest.fn().mockResolvedValue(undefined),
      subirComprobante: jest.fn().mockResolvedValue({
        attachmentId: ADJUNTO,
        scan: { available: false, data: null },
      }),
      pagar: jest.fn().mockResolvedValue(undefined),
    };
    consultas = {
      findInstallments: jest
        .fn()
        .mockResolvedValue({ data: [cuotaPaga], total: 1 }),
    };
    const modulo = await Test.createTestingModule({
      controllers: [InsuranceInstallmentController],
      providers: [
        { provide: InsuranceInstallmentService, useValue: cuotas },
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
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1'); // una sola vez y en loopback, adonde se conecta supertest: si no, falla al azar con carga
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /v2/insurance-installments/:id/receipt', () => {
    it('sube el comprobante y responde el adjunto con el resultado del escaneo', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v2/insurance-installments/${CUOTA}/receipt`)
        .attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })
        .expect(201);

      expect(res.body).toEqual({
        attachmentId: ADJUNTO,
        scan: { available: false, data: null },
      });
      expect(cuotas.subirComprobante).toHaveBeenCalledWith(
        CUOTA,
        expect.objectContaining({
          originalname: 'c.png',
          mimetype: 'image/png',
        }),
        'd1',
        { userId: 'u1', role: RoleType.ADMIN },
      );
    });

    it('con lector, devuelve lo leído para precargar el formulario', async () => {
      const data = {
        amount: '29958.00',
        paidAt: '2026-10-20T14:30:00-03:00',
        operationNumber: '88',
        payee: 'Seguros Rivadavia',
        payeeTaxId: null,
        period: '2026-11',
        confidence: 'high',
        warnings: [],
      };
      cuotas.subirComprobante.mockResolvedValue({
        attachmentId: ADJUNTO,
        scan: { available: true, data },
      });
      const res = await request(app.getHttpServer())
        .post(`/v2/insurance-installments/${CUOTA}/receipt`)
        .attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })
        .expect(201);
      expect(res.body).toEqual({
        attachmentId: ADJUNTO,
        scan: { available: true, data },
      });
    });

    it('el id tiene que ser un UUID (400)', async () => {
      await request(app.getHttpServer())
        .post('/v2/insurance-installments/no-es-uuid/receipt')
        .attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })
        .expect(400);
      expect(cuotas.subirComprobante).not.toHaveBeenCalled();
    });

    it('en la v1 no existe', async () => {
      await request(app.getHttpServer())
        .post(`/v1/insurance-installments/${CUOTA}/receipt`)
        .expect(404);
    });
  });

  describe('POST /v2/insurance-installments/:id/pay', () => {
    const cuerpo = {
      attachmentId: ADJUNTO,
      paidAt: '2026-10-20T14:30:00-03:00',
      amount: 29958,
      operationNumber: '88',
      cashBoxId: CAJA,
    };

    it('paga la cuota con el usuario y la distribuidora de la sesión y responde la cuota paga', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v2/insurance-installments/${CUOTA}/pay`)
        .send(cuerpo)
        .expect(200);

      expect(cuotas.pagar).toHaveBeenCalledWith(CUOTA, cuerpo, 'd1', 'u1');
      expect(res.body).toMatchObject({
        installmentId: CUOTA,
        label: '5/6',
        status: 'paid',
        cashMovementId: 'mov1',
        receiptAttachmentId: ADJUNTO,
        carPatent: 'OVQ621',
        insurerName: 'Seguros Rivadavia',
      });
    });

    it.each([
      ['sin caja', { cashBoxId: undefined }],
      ['sin comprobante', { attachmentId: undefined }],
      ['con un importe en cero', { amount: 0 }],
      ['con una fecha mal escrita', { paidAt: 'ayer' }],
      ['con un campo que no existe', { otro: 'x' }],
    ])('400 %s', async (_caso, cambio) => {
      await request(app.getHttpServer())
        .post(`/v2/insurance-installments/${CUOTA}/pay`)
        .send({ ...cuerpo, ...cambio })
        .expect(400);
      expect(cuotas.pagar).not.toHaveBeenCalled();
    });

    it('en la v1 no existe', async () => {
      await request(app.getHttpServer())
        .post(`/v1/insurance-installments/${CUOTA}/pay`)
        .send(cuerpo)
        .expect(404);
    });
  });

  it('GET /v2/insurance-installments filtra por estado y vencimiento', async () => {
    const res = await request(app.getHttpServer())
      .get(
        '/v2/insurance-installments?status=pending&dueFrom=2026-11-01&dueTo=2026-11-30',
      )
      .expect(200);

    expect(res.body).toMatchObject({ total: 1, data: [{ label: '5/6' }] });
    expect(consultas.findInstallments).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({
        status: 'pending',
        dueFrom: '2026-11-01',
        dueTo: '2026-11-30',
      }),
    );
  });

  it('GET /v2/insurance-installments rechaza un estado que no existe', async () => {
    await request(app.getHttpServer())
      .get('/v2/insurance-installments?status=foo')
      .expect(400);
  });

  it('PATCH corrige la cuota y la devuelve', async () => {
    await request(app.getHttpServer())
      .patch(`/v2/insurance-installments/${CUOTA}`)
      .send({ amount: 31000, dueDate: '2026-11-25' })
      .expect(200);
    expect(cuotas.modificar).toHaveBeenCalledWith(
      CUOTA,
      { amount: 31000, dueDate: '2026-11-25' },
      'd1',
    );
  });
});
