import { AHORA, enDias, unEnvase } from '../application/dobles-de-puertos';
import { CylinderState } from './cylinder-state';
import {
  asegurarDespachables,
  etiquetaDeEstadoDePedido,
  pedidoAdmiteCarga,
} from './despacho';
import { EnvasesVencidosError } from './errors/cylinder-rule.errors';
import { InvalidCylinderTransitionError } from './errors/invalid-cylinder-transition.error';

describe('reglas de despacho', () => {
  const lleno = (serial: string, expiresAt: Date | null = null) =>
    unEnvase({
      cylinderId: serial,
      serial,
      state: CylinderState.FILLED,
      expiresAt,
    });

  it.each([
    ['pending', true],
    ['accepted', true],
    ['on_the_way', true],
    ['reserved', false],
    ['delivered', false],
    ['cancelled', false],
  ] as const)('un pedido %s admite carga: %s', (estado, admite) => {
    expect(pedidoAdmiteCarga(estado)).toBe(admite);
  });

  it('nombra el estado del pedido en castellano', () => {
    expect(etiquetaDeEstadoDePedido('on_the_way')).toBe('en camino');
    expect(etiquetaDeEstadoDePedido('reserved')).toBe('reservado a futuro');
  });

  it('una carga de envases llenos, vigentes o sin fecha, pasa', () => {
    expect(() =>
      asegurarDespachables([lleno('A', enDias(10)), lleno('B')], AHORA),
    ).not.toThrow();
  });

  it('informa TODOS los seriales vencidos de la carga, no sólo el primero', () => {
    let error: unknown;
    try {
      asegurarDespachables(
        [
          lleno('A', enDias(-1)),
          lleno('B', enDias(10)),
          lleno('C', enDias(-3)),
        ],
        AHORA,
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvasesVencidosError);
    expect((error as EnvasesVencidosError).serials).toEqual(['A', 'C']);
  });

  it('un envase que no está lleno es una transición inválida, aunque otro esté vencido', () => {
    expect(() =>
      asegurarDespachables(
        [lleno('A', enDias(-1)), unEnvase({ state: CylinderState.IN_DEPOT })],
        AHORA,
      ),
    ).toThrow(InvalidCylinderTransitionError);
  });
});
