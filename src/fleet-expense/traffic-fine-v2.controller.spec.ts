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
import { RoleType } from '../common/constants/role-type.enum';
import { RedisService } from '../redis/redis.service';
import { TrafficFine, TrafficFineStatus } from './entities/traffic-fine.entity';
import { TrafficFinePaymentService } from './traffic-fine-payment.service';
import { TrafficFineV2Controller } from './traffic-fine-v2.controller';
import { TrafficFineService } from './traffic-fine.service';

const MULTA = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f001';
const ADJUNTO = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f002';
const CAJA = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f003';
const AUTO = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f004';
const PNG = Buffer.from('89504e470d0a1a0a0000000d', 'hex');

const multaPaga = {
  fineId: MULTA,
  distributorId: 'd1',
  carId: AUTO,
  car: { carPatent: 'AB123CD' },
  employeeId: null,
  occurredAt: new Date('2026-09-01T15:00:00.000Z'),
  jurisdiction: 'Posadas',
  actNumber: 'A-1',
  infraction: 'Velocidad',
  amount: 85000,
  voluntaryPaymentAmount: 59500,
  dueDate: '2026-11-15',
  status: TrafficFineStatus.PAID,
  paidAt: new Date('2026-10-20T17:30:00.000Z'),
  paidAmount: 59500,
  cashMovementId: 'mov1',
  chargedToEmployee: false,
  voidReason: null,
  voidedAt: null,
  createdAt: new Date('2026-09-02T00:00:00.000Z'),
  paymentUrl: 'https://pagos.posadas.test/m1',
  paymentCode: '123',
  operationNumber: '88',
  receiptAttachmentId: ADJUNTO,
} as unknown as TrafficFine;

describe('TrafficFineV2Controller · multas en la API v2', () => {
  let app: INestApplication<Server>;
  let multas: {
    registrar: jest.Mock;
    modificar: jest.Mock;
    findOne: jest.Mock;
    findAll: jest.Mock;
  };
  let pagos: { subirComprobante: jest.Mock; pagar: jest.Mock };

  beforeEach(async () => {
    multas = {
      registrar: jest.fn().mockResolvedValue(multaPaga),
      modificar: jest.fn().mockResolvedValue(multaPaga),
      findOne: jest.fn().mockResolvedValue(multaPaga),
      findAll: jest.fn().mockResolvedValue({ data: [multaPaga], total: 1 }),
    };
    pagos = {
      subirComprobante: jest.fn().mockResolvedValue({
        attachmentId: ADJUNTO,
        scan: { available: false, data: null },
      }),
      pagar: jest.fn().mockResolvedValue(undefined),
    };
    const modulo = await Test.createTestingModule({
      controllers: [TrafficFineV2Controller],
      providers: [
        { provide: TrafficFineService, useValue: multas },
        { provide: TrafficFinePaymentService, useValue: pagos },
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
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /v2/traffic-fines/:id/receipt', () => {
    it('sube el comprobante y responde el adjunto con el escaneo', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v2/traffic-fines/${MULTA}/receipt`)
        .attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })
        .expect(201);
      expect(res.body).toEqual({
        attachmentId: ADJUNTO,
        scan: { available: false, data: null },
      });
      expect(pagos.subirComprobante).toHaveBeenCalledWith(
        MULTA,
        expect.objectContaining({ originalname: 'c.png' }),
        'd1',
        { userId: 'u1', role: RoleType.ADMIN },
      );
    });

    it('el id tiene que ser un UUID (400)', async () => {
      await request(app.getHttpServer())
        .post('/v2/traffic-fines/no-es-uuid/receipt')
        .attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })
        .expect(400);
      expect(pagos.subirComprobante).not.toHaveBeenCalled();
    });

    it('en la v1 no existe', async () => {
      await request(app.getHttpServer())
        .post(`/v1/traffic-fines/${MULTA}/receipt`)
        .expect(404);
    });
  });

  describe('POST /v2/traffic-fines/:id/pay', () => {
    const cuerpo = {
      attachmentId: ADJUNTO,
      paidAt: '2026-10-20T14:30:00-03:00',
      amount: 59500,
      operationNumber: '88',
      cashBoxId: CAJA,
    };

    it('paga con el usuario y la distribuidora de la sesión y responde la multa paga', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v2/traffic-fines/${MULTA}/pay`)
        .send(cuerpo)
        .expect(200);
      expect(pagos.pagar).toHaveBeenCalledWith(MULTA, cuerpo, 'd1', 'u1');
      expect(res.body).toMatchObject({
        fineId: MULTA,
        status: 'paid',
        cashMovementId: 'mov1',
        receiptAttachmentId: ADJUNTO,
        operationNumber: '88',
        paymentUrl: 'https://pagos.posadas.test/m1',
        paymentCode: '123',
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
        .post(`/v2/traffic-fines/${MULTA}/pay`)
        .send({ ...cuerpo, ...cambio })
        .expect(400);
      expect(pagos.pagar).not.toHaveBeenCalled();
    });

    it('en la v1 no existe', async () => {
      await request(app.getHttpServer())
        .post(`/v1/traffic-fines/${MULTA}/pay`)
        .send(cuerpo)
        .expect(404);
    });
  });

  describe('alta y edición con enlace y código de pago', () => {
    const alta = {
      carId: AUTO,
      occurredAt: '2026-09-01T15:00:00.000Z',
      jurisdiction: 'Posadas',
      actNumber: 'A-1',
      infraction: 'Velocidad',
      amount: 85000,
      paymentUrl: 'https://pagos.posadas.test/m1',
      paymentCode: '123',
    };

    it('POST registra la multa con paymentUrl y paymentCode', async () => {
      await request(app.getHttpServer())
        .post('/v2/traffic-fines')
        .send(alta)
        .expect(201);
      expect(multas.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentUrl: 'https://pagos.posadas.test/m1',
          paymentCode: '123',
        }),
        'd1',
      );
    });

    it.each(['http://inseguro.test', 'javascript:alert(1)', 'no es url'])(
      'rechaza un paymentUrl que no es https (%s)',
      async (paymentUrl) => {
        await request(app.getHttpServer())
          .post('/v2/traffic-fines')
          .send({ ...alta, paymentUrl })
          .expect(400);
        expect(multas.registrar).not.toHaveBeenCalled();
      },
    );

    it('PATCH corrige el enlace y con null lo borra', async () => {
      await request(app.getHttpServer())
        .patch(`/v2/traffic-fines/${MULTA}`)
        .send({ paymentUrl: null, paymentCode: '' })
        .expect(200);
      expect(multas.modificar).toHaveBeenCalledWith(
        MULTA,
        { paymentUrl: null, paymentCode: null },
        'd1',
      );
    });
  });

  it('GET lista con los campos nuevos y filtra por vehículo', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v2/traffic-fines?carId=${AUTO}&status=paid`)
      .expect(200);
    expect(res.body).toMatchObject({
      total: 1,
      data: [{ fineId: MULTA, receiptAttachmentId: ADJUNTO }],
    });
    expect(multas.findAll).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ carId: AUTO, status: 'paid' }),
    );
  });

  it('GET :id devuelve la multa con enlace y comprobante', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v2/traffic-fines/${MULTA}`)
      .expect(200);
    expect(res.body).toMatchObject({
      paymentUrl: 'https://pagos.posadas.test/m1',
      operationNumber: '88',
    });
    expect(multas.findOne).toHaveBeenCalledWith(MULTA, 'd1');
  });
});
