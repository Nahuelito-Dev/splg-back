import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PeoplePhotosController } from './people-photos.controller';
import type { PeoplePhotosService } from './people-photos.service';
import { PeoplePhotosRequestDto } from './dto/people-photos.dto';

const UUID = '0b6f5f0e-6a46-4f0e-9c0a-0b8f2b1a7d11';

describe('PeoplePhotosController', () => {
  it('pasa los ids y la distribuidora al servicio; sin legajos ni choferes van listas vacías', async () => {
    const firmar = jest.fn().mockResolvedValue({ users: {}, employees: {} });
    const controller = new PeoplePhotosController({
      firmar,
    } as unknown as PeoplePhotosService);
    await controller.firmar({ userIds: [UUID] }, 'd1', {
      user_id: 'yo',
    } as AuthenticatedUser);
    expect(firmar).toHaveBeenCalledWith([UUID], [], [], 'd1', 'yo');
  });

  describe('validación del cuerpo', () => {
    const errores = (cuerpo: object) =>
      validate(plainToInstance(PeoplePhotosRequestDto, cuerpo));

    it('acepta hasta 100 ids y rechaza 101', async () => {
      const cien = Array.from({ length: 100 }, () => UUID);
      expect(await errores({ userIds: cien })).toHaveLength(0);
      expect(await errores({ userIds: [...cien, UUID] })).not.toHaveLength(0);
      expect(
        await errores({ userIds: [], employeeIds: [...cien, UUID] }),
      ).not.toHaveLength(0);
    });

    it('rechaza ids que no son UUID y exige userIds', async () => {
      expect(await errores({ userIds: ['x'] })).not.toHaveLength(0);
      expect(await errores({})).not.toHaveLength(0);
    });
  });
});
