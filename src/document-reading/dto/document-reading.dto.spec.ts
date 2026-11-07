import { BadRequestException } from '@nestjs/common';

import { crearValidationPipe } from '../../common/validation/validation-pipe';
import { CorrectDocumentReadingDto } from './document-reading.dto';

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
