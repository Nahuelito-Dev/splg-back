import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateCoverageZoneDto } from '../dto/update-coverage-zone.dto';

const errores = async (cuerpo: Record<string, unknown>) =>
  (await validate(plainToInstance(UpdateCoverageZoneDto, cuerpo))).map(
    (e) => e.property,
  );

describe('EsPosteriorA (vigencia de zonas)', () => {
  it('días: desde y hasta el mismo día es válido (el hasta incluye el día entero)', async () => {
    expect(
      await errores({ validFrom: '2026-11-02', validUntil: '2026-11-02' }),
    ).toEqual([]);
  });

  it('días: un hasta posterior es válido', async () => {
    expect(
      await errores({ validFrom: '2026-11-02', validUntil: '2026-11-10' }),
    ).toEqual([]);
  });

  it('días: un hasta anterior al desde es inválido', async () => {
    expect(
      await errores({ validFrom: '2026-11-03', validUntil: '2026-11-02' }),
    ).toEqual(['validUntil']);
  });

  it('instantes: un fin igual al inicio es inválido', async () => {
    expect(
      await errores({
        validFrom: '2026-11-02T12:00:00Z',
        validUntil: '2026-11-02T12:00:00Z',
      }),
    ).toEqual(['validUntil']);
  });

  it('instantes: un fin posterior es válido y uno anterior no', async () => {
    expect(
      await errores({
        validFrom: '2026-11-02T12:00:00Z',
        validUntil: '2026-11-02T13:00:00Z',
      }),
    ).toEqual([]);
    expect(
      await errores({
        validFrom: '2026-11-02T12:00:00Z',
        validUntil: '2026-11-02T11:00:00Z',
      }),
    ).toEqual(['validUntil']);
  });

  it('un día inexistente es inválido', async () => {
    expect(
      await errores({ validFrom: '2026-11-01', validUntil: '2026-02-30' }),
    ).toContain('validUntil');
  });

  it('null o ausente en cualquiera de las dos no se compara', async () => {
    expect(
      await errores({ validFrom: null, validUntil: '2026-11-02' }),
    ).toEqual([]);
    expect(
      await errores({ validFrom: '2026-11-02', validUntil: null }),
    ).toEqual([]);
  });
});
