import { DECORATORS } from '@nestjs/swagger/dist/constants';

import { CreateGasCylinderDto } from './create-gascylinder.dto';
import { GasCylinderResponseDto } from './gascylinder-response.dto';

// Sin `type` explícito, Swagger publica `number | null` como objeto y el panel
// genera `Record<string, never>` en lugar de un número.
describe('Swagger: precio del envase', () => {
  it.each([
    ['alta y edición', CreateGasCylinderDto],
    ['respuesta', GasCylinderResponseDto],
  ])('en %s se publica como número que admite null', (_, dto: object) => {
    const meta = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      (dto as { prototype: object }).prototype,
      'container_price',
    ) as { type?: unknown; nullable?: boolean };
    expect(meta.type).toBe(Number);
    expect(meta.nullable).toBe(true);
  });
});
