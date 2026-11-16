import { BadRequestException } from '@nestjs/common';

import { crearValidationPipe } from '../../common/validation/validation-pipe';
import {
  CorrectDocumentReadingDto,
  RejectDocumentReadingDto,
} from './document-reading.dto';

describe('CorrectDocumentReadingDto', () => {
  const pipe = crearValidationPipe();
  const validar = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: CorrectDocumentReadingDto });

  it('una clave «constructor» en los campos no rompe la validación (no es 500)', async () => {
    const dto = (await validar({
      fields: JSON.parse('{"constructor": 1, "importe": "10.00"}') as object,
    })) as CorrectDocumentReadingDto;
    expect(Object.keys(dto.fields)).toEqual(['importe']);
  });

  it('conserva los campos comunes y exige un objeto', async () => {
    const dto = (await validar({
      fields: { importe: '10.00', patente: 'AB123CD' },
    })) as CorrectDocumentReadingDto;
    expect(dto.fields).toEqual({ importe: '10.00', patente: 'AB123CD' });
    await expect(validar({ fields: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('RejectDocumentReadingDto', () => {
  const pipe = crearValidationPipe();
  const motivo = async (body: unknown): Promise<string[]> => {
    try {
      await pipe.transform(body, {
        type: 'body',
        metatype: RejectDocumentReadingDto,
      });
      return [];
    } catch (e) {
      const r = (e as BadRequestException).getResponse() as {
        message: string | string[];
      };
      return ([] as string[]).concat(r.message);
    }
  };

  it('sin motivo, lo primero que dice es que es obligatorio', async () => {
    const mensajes = await motivo({});
    expect(mensajes[0]).toBe('Motivo: es obligatorio');
  });

  it('un motivo vacío no pasa', async () => {
    expect((await motivo({ reason: '' })).length).toBeGreaterThan(0);
    expect(await motivo({ reason: 'No corresponde' })).toEqual([]);
  });
});
