import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';

const ID = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';

/**
 * Qué pasa con la distribuidora en `take`, `reopen` y `resolve`: un super
 * admin sin `X-Distributor` no puede operar sobre reclamos de cualquier
 * distribuidora. El guard global no corre acá; un middleware deja en la
 * request lo que el guard dejaría.
 */
describe('ClaimsController · distribuidora obligatoria', () => {
  let app: INestApplication<Server>;
  let claims: { take: jest.Mock; reopen: jest.Mock; resolve: jest.Mock };
  let distributorId: string | null;

  beforeEach(async () => {
    distributorId = null;
    claims = {
      take: jest.fn().mockResolvedValue({}),
      reopen: jest.fn().mockResolvedValue({}),
      resolve: jest.fn().mockResolvedValue({}),
    };
    const modulo = await Test.createTestingModule({
      controllers: [ClaimsController],
      providers: [{ provide: ClaimsService, useValue: claims }],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = distributorId;
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const llamadas: Array<[string, string, object]> = [
    ['take', `/claims/${ID}/take`, {}],
    ['reopen', `/claims/${ID}/reopen`, { reason: 'motivo' }],
    [
      'resolve',
      `/claims/${ID}/resolve`,
      { resolution: 'listo', status: 'resolved' },
    ],
  ];

  it.each(llamadas)(
    '%s: 400 si no hay distribuidora en contexto, y no toca el reclamo',
    async (metodo, ruta, cuerpo) => {
      const res = await request(app.getHttpServer()).patch(ruta).send(cuerpo);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toMatch(
        /Falta la distribuidora/,
      );
      expect(claims[metodo as 'take']).not.toHaveBeenCalled();
    },
  );

  it.each(llamadas)(
    '%s: con distribuidora acota por ella',
    async (metodo, ruta, cuerpo) => {
      distributorId = 'd1';
      const res = await request(app.getHttpServer()).patch(ruta).send(cuerpo);
      expect(res.status).toBe(200);
      const argumentos = claims[metodo as 'take'].mock.calls[0] as unknown[];
      expect(argumentos.at(-1)).toBe('d1');
    },
  );

  it('resolve y reopen rechazan un texto de sólo espacios (400)', async () => {
    distributorId = 'd1';
    const a = await request(app.getHttpServer())
      .patch(`/claims/${ID}/resolve`)
      .send({ resolution: '   ', status: 'resolved' });
    const b = await request(app.getHttpServer())
      .patch(`/claims/${ID}/reopen`)
      .send({ reason: '  \t ' });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(claims.resolve).not.toHaveBeenCalled();
    expect(claims.reopen).not.toHaveBeenCalled();
  });

  it('resolve guarda el texto recortado', async () => {
    distributorId = 'd1';
    await request(app.getHttpServer())
      .patch(`/claims/${ID}/resolve`)
      .send({ resolution: '  se cambió  ', status: 'rejected' })
      .expect(200);
    expect(claims.resolve).toHaveBeenCalledWith(
      ID,
      'se cambió',
      'rejected',
      'd1',
    );
  });

  it('resolve no acepta in_process: tomar el reclamo es PATCH /take', async () => {
    distributorId = 'd1';
    await request(app.getHttpServer())
      .patch(`/claims/${ID}/resolve`)
      .send({ resolution: 'ok', status: 'in_process' })
      .expect(400);
  });
});
