import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTimeSlotDto } from './create-time-slot.dto';
import { UpdateTimeSlotDto } from './update-time-slot.dto';

const invalidas = async <T extends object>(
  clase: new () => T,
  cuerpo: object,
): Promise<string[]> =>
  (await validate(plainToInstance(clase, cuerpo))).map((e) => e.property);

const valida = { name: 'Mañana', startTime: '09:00', endTime: '13:00' };

describe('CreateTimeSlotDto', () => {
  it('una franja válida pasa, con o sin capacidad', async () => {
    expect(await invalidas(CreateTimeSlotDto, valida)).toEqual([]);
    expect(
      await invalidas(CreateTimeSlotDto, { ...valida, capacity: 50 }),
    ).toEqual([]);
  });

  it.each([0, -3, 10001, 2.5])('capacity %p es 400', async (capacity) => {
    expect(
      await invalidas(CreateTimeSlotDto, { ...valida, capacity }),
    ).toContain('capacity');
  });

  it.each([1, 10000])('capacity %p pasa', async (capacity) => {
    expect(await invalidas(CreateTimeSlotDto, { ...valida, capacity })).toEqual(
      [],
    );
  });

  it.each(['', '   '])('el nombre %j es 400', async (name) => {
    expect(await invalidas(CreateTimeSlotDto, { ...valida, name })).toContain(
      'name',
    );
  });

  it('el nombre no pasa de 50 caracteres y se recorta', async () => {
    expect(
      await invalidas(CreateTimeSlotDto, { ...valida, name: 'a'.repeat(51) }),
    ).toContain('name');
    expect(
      plainToInstance(CreateTimeSlotDto, { ...valida, name: ' Noche ' }).name,
    ).toBe('Noche');
  });

  it('al editar también rige el mínimo de capacidad', async () => {
    expect(await invalidas(UpdateTimeSlotDto, { capacity: 0 })).toContain(
      'capacity',
    );
  });
});
