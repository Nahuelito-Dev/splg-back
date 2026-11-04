import { ArgumentMetadata } from '@nestjs/common';
import { CreateIncidentDto } from './create-incident.dto';
import { IncidentType } from '../entities/incident.entity';
import { crearValidationPipe } from '../../common/validation/validation-pipe';

const base = {
  orderId: '2c0f7a9e-6f4f-4f55-9d0e-0a5a4d1b7c11',
  type: Object.values(IncidentType)[0],
  description: 'El cliente no estaba',
};

// El mismo pipe global de `main.ts`.
const pipe = crearValidationPipe();
const meta: ArgumentMetadata = { type: 'body', metatype: CreateIncidentDto };

describe('CreateIncidentDto: la foto no viaja como texto', () => {
  it('acepta el alta sin foto', async () => {
    await expect(pipe.transform(base, meta)).resolves.toMatchObject(base);
  });

  it.each(['photoUrl', 'photo_url'])('rechaza %s con 400', async (campo) => {
    await expect(
      pipe.transform(
        { ...base, [campo]: 'https://externa.example/f.jpg' },
        meta,
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { message: ['Se envió un dato que no corresponde: Foto'] },
    });
  });
});
