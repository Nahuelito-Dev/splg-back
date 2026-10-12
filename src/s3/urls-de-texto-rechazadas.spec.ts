import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { RegistrarUsuarioDto } from '../registro/dto/registrar-usuario.dto';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { CreateDistributorDto } from '../distributor/dto/create-distributor.dto';
import { UpdateDistributorDto } from '../distributor/dto/update-distributor.dto';

// El mismo pipe global de `main.ts`.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
});
const URL_EXTERNA = 'https://externa.example/foto.jpg';

describe('las fotos no entran como URL de texto', () => {
  it.each([
    ['PATCH usuario', UpdateUserDto, { full_name: 'Ana' }, 'selfie'],
    [
      'alta de usuario',
      RegistrarUsuarioDto,
      {
        email: 'a@b.com',
        password: 'Test1234!',
        full_name: 'Ana',
        phone_number: '+5493764000000',
        role: 'admin',
      },
      'selfie',
    ],
    [
      'alta de distribuidora',
      CreateDistributorDto,
      { name: 'X', slug: 'x' },
      'logo_url',
    ],
    ['PATCH distribuidora', UpdateDistributorDto, { name: 'X' }, 'logo_url'],
  ])('%s rechaza %s', async (_n, dto, base, campo) => {
    await expect(
      pipe.transform({ ...base, [campo]: URL_EXTERNA }, meta(dto)),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        message: expect.arrayContaining([
          `property ${campo} should not exist`,
        ]) as string[],
      },
    });
  });
});
