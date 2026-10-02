import { Type } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { IncidentController } from './incident.controller';
import { ClaimsController } from '../claims/claims.controller';

/** Metadata que Nest guarda por cada parámetro con un decorador custom
 * (como `@CurrentDistributor()`): `data` son las opciones con las que se
 * usó (p. ej. `{ required: true }`), `undefined` si se usó sin opciones. */
interface ParametroCustom {
  index: number;
  data: unknown;
}

/** Opciones del parámetro custom en la posición `index` de `metodo`. */
function opcionesDelParametro(
  controller: Type<unknown>,
  metodo: string,
  index: number,
): unknown {
  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    controller,
    metodo,
  ) as Record<string, ParametroCustom>;
  const entrada = Object.values(args).find((a) => a.index === index);
  return entrada?.data;
}

/**
 * Reclamos e incidencias resuelven una entidad EXISTENTE con el mismo criterio:
 * la distribuidora en contexto es obligatoria (`{ required: true }`). Un super
 * admin sin `X-Distributor` no puede operar sobre las de cualquier
 * distribuidora. El comportamiento HTTP de reclamos está en
 * `claims.controller.spec.ts`; esto fija la misma opción para los dos.
 */
describe('Tenant: reclamos e incidencias exigen la distribuidora', () => {
  it.each([
    [ClaimsController, 'resolve', 2],
    [ClaimsController, 'take', 1],
    [ClaimsController, 'reopen', 2],
    [IncidentController, 'resolve', 2],
  ] as const)(
    '@CurrentDistributor() de %p.%s es obligatorio',
    (controller, metodo, index) => {
      expect(opcionesDelParametro(controller, metodo, index)).toEqual({
        required: true,
      });
    },
  );
});
