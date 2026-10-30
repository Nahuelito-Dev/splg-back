import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PatchPlannerSettingsDto } from './planner-request.dto';

const errores = async (cuerpo: Record<string, unknown>) =>
  (
    await validate(plainToInstance(PatchPlannerSettingsDto, cuerpo), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe('PatchPlannerSettingsDto', () => {
  it('acepta los días de taller, la vigencia del uso, la anticipación en km y el correo al chofer', async () => {
    expect(
      await errores({
        workshopDays: 126,
        usageStaleDays: 30,
        anticipationKm: 1500,
        driverEmail: 1,
      }),
    ).toEqual([]);
  });

  it.each([
    ['workshopDays', 0],
    ['workshopDays', 128],
    ['usageStaleDays', 91],
    ['anticipationKm', -1],
    ['driverEmail', 2],
    ['usageStaleDays', 7.5],
  ])('rechaza %s = %p', async (campo, valor) => {
    expect(await errores({ [campo]: valor })).toEqual([campo]);
  });
});
