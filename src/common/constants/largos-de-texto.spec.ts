import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { CreateClaimDto } from '../../claims/dto/create-claim.dto';
import { ReopenClaimDto } from '../../claims/dto/reopen-claim.dto';
import { ResolveClaimDto } from '../../claims/dto/resolve-claim.dto';
import { CreateIncidentDto } from '../../incident/dto/create-incident.dto';
import { ResolveIncidentDto } from '../../incident/dto/resolve-incident.dto';
import { ResolveUnpaidDto } from '../../order/dto/resolve-unpaid.dto';
import {
  LARGO_DESCRIPCION,
  LARGO_MINIMO_NOTA_DE_IMPAGO,
  LARGO_MOTIVO_DE_RECLAMO,
  LARGO_NOTA,
} from './largos-de-texto';

// El mismo pipe global de `main.ts`.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validar = (metatype: ArgumentMetadata['metatype'], body: object) =>
  pipe.transform(body, { type: 'body', metatype });

const UUID = '2c0f7a9e-6f4f-4f55-9d0e-0a5a4d1b7c11';
const largo = (n: number) => 'a'.repeat(n);

describe('Largo máximo de los textos (el mismo que el CHECK de la base)', () => {
  it.each([
    [
      'reclamo: motivo',
      CreateClaimDto,
      { orderId: UUID, customerId: UUID, description: 'x' },
      'reason',
      LARGO_MOTIVO_DE_RECLAMO,
    ],
    [
      'reclamo: descripción',
      CreateClaimDto,
      { orderId: UUID, customerId: UUID, reason: 'x' },
      'description',
      LARGO_DESCRIPCION,
    ],
    ['reclamo: reapertura', ReopenClaimDto, {}, 'reason', LARGO_DESCRIPCION],
    [
      'reclamo: resolución',
      ResolveClaimDto,
      { status: 'resolved' },
      'resolution',
      LARGO_DESCRIPCION,
    ],
    [
      'incidencia: descripción',
      CreateIncidentDto,
      { orderId: UUID, type: 'other' },
      'description',
      LARGO_DESCRIPCION,
    ],
    [
      'incidencia: resolución',
      ResolveIncidentDto,
      {},
      'resolutionNote',
      LARGO_DESCRIPCION,
    ],
    [
      'impago: nota',
      ResolveUnpaidDto,
      { resolution: 'paid' },
      'note',
      LARGO_NOTA,
    ],
  ])(
    '%s: acepta el máximo y rechaza uno más',
    async (_n, dto, resto, campo, max) => {
      await expect(
        validar(dto, { ...resto, [campo]: largo(max) }),
      ).resolves.toBeDefined();
      await expect(
        validar(dto, { ...resto, [campo]: largo(max + 1) }),
      ).rejects.toThrow();
    },
  );

  it('la nota de un impago exige el mínimo que ya pide el panel', async () => {
    const body = { resolution: 'written_off' };
    await expect(
      validar(ResolveUnpaidDto, {
        ...body,
        note: largo(LARGO_MINIMO_NOTA_DE_IMPAGO - 1),
      }),
    ).rejects.toThrow();
    await expect(
      validar(ResolveUnpaidDto, {
        ...body,
        note: largo(LARGO_MINIMO_NOTA_DE_IMPAGO),
      }),
    ).resolves.toBeDefined();
  });
});
