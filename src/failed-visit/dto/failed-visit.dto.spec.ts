import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FailedDeliveryDto } from './failed-delivery.dto';
import { QueryFailedVisitsDto } from './query-failed-visits.dto';

const errores = async (clase: new () => object, plano: object) =>
  (await validate(plainToInstance(clase, plano))).map((e) => e.property);

describe('DTO de la entrega fallida (C5)', () => {
  it('«No pude entregar»: el acuerdo se valida anidado (día ISO y franja UUID)', async () => {
    expect(
      await errores(FailedDeliveryDto, {
        reason: 'customer_absent',
        agreed: {
          scheduledDate: '2026-11-26',
          timeSlotId: '6f1c1a0e-2b7a-4c55-9a43-3b1a8e7f0c11',
        },
      }),
    ).toEqual([]);
    expect(
      await errores(FailedDeliveryDto, {
        reason: 'otra cosa',
        agreed: { scheduledDate: '26/11', timeSlotId: 'x' },
      }),
    ).toEqual(['reason', 'agreed']);
  });

  it('listado: la paginación llega como texto de la query y se convierte; fuera de rango, 400', async () => {
    const q = plainToInstance(QueryFailedVisitsDto, {
      limit: '50',
      offset: '10',
    });
    expect(q).toMatchObject({ status: 'open', limit: 50, offset: 10 });
    expect(await validate(q)).toEqual([]);
    expect(
      await errores(QueryFailedVisitsDto, {
        limit: '500',
        offset: '-1',
        status: 'cualquiera',
      }),
    ).toEqual(['status', 'limit', 'offset']);
  });
});
