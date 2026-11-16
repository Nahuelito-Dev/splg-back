import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssignCylindersDto } from './assign-cylinders.dto';
import { CreateCylinderDto } from './create-cylinder.dto';
import { UpdateCylinderDto } from './update-cylinder.dto';
import { normalizarSerial } from './serial-de-envase';

const invalidas = async <T extends object>(
  clase: new () => T,
  cuerpo: object,
): Promise<string[]> =>
  (await validate(plainToInstance(clase, cuerpo))).map((e) => e.property);

describe('serial del envase', () => {
  it('normalizarSerial recorta y pasa a mayúsculas', () => {
    expect(normalizarSerial('  ab-1 ')).toBe('AB-1');
    expect(normalizarSerial('Sn 12')).toBe('SN 12');
  });

  describe('alta', () => {
    it('se guarda recortado y en mayúsculas', () => {
      expect(
        plainToInstance(CreateCylinderDto, { serial: ' sn-000123 ' }).serial,
      ).toBe('SN-000123');
    });

    it.each(['', '   ', '\t\n'])('%j es 400 (en blanco)', async (serial) => {
      expect(await invalidas(CreateCylinderDto, { serial })).toContain(
        'serial',
      );
    });

    it('no pasa de 100 caracteres', async () => {
      expect(
        await invalidas(CreateCylinderDto, { serial: 'A'.repeat(101) }),
      ).toContain('serial');
      expect(
        await invalidas(CreateCylinderDto, { serial: 'A'.repeat(100) }),
      ).toEqual([]);
    });

    it('un número no es un serial', async () => {
      expect(await invalidas(CreateCylinderDto, { serial: 123 })).toContain(
        'serial',
      );
    });
  });

  describe('edición', () => {
    it('sin serial es válido; con serial se normaliza; en blanco es 400', async () => {
      expect(await invalidas(UpdateCylinderDto, {})).toEqual([]);
      expect(
        plainToInstance(UpdateCylinderDto, { serial: ' x1 ' }).serial,
      ).toBe('X1');
      expect(await invalidas(UpdateCylinderDto, { serial: '  ' })).toContain(
        'serial',
      );
    });
  });

  describe('asignación por seriales', () => {
    const orderId = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';

    it('cada serial se normaliza', () => {
      const dto = plainToInstance(AssignCylindersDto, {
        orderId,
        serials: [' sn-1', 'Sn-2 '],
      });
      expect(dto.serials).toEqual(['SN-1', 'SN-2']);
    });

    it('un serial en blanco en la lista es 400', async () => {
      expect(
        await invalidas(AssignCylindersDto, {
          orderId,
          serials: ['SN-1', ' '],
        }),
      ).toContain('serials');
    });
  });
});

describe('normalizarSerial', () => {
  it('recorta sólo espacios y pasa a mayúsculas, igual que upper(btrim()) de la base', () => {
    expect(normalizarSerial('  sn-1 ')).toBe('SN-1');
    expect(normalizarSerial('\tsn-1\t')).toBe('\tSN-1\t');
  });
});
