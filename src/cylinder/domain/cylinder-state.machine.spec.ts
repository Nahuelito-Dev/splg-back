import { BadRequestException } from '@nestjs/common';
import {
  canTransition,
  assertTransition,
  CYLINDER_TRANSITIONS,
} from './cylinder-state.machine';
import { CylinderState } from '../entities/cylinder.entity';

/**
 * Máquina de estados del ciclo físico del envase (dominio puro). Verificamos el
 * camino feliz completo (depósito → llenado → despacho → cliente → vacía →
 * depósito) y que los saltos ilegales se rechacen.
 */
describe('cylinder-state.machine', () => {
  it('permite el ciclo completo in_depot → filled → dispatched → with_customer → empty_returned → in_depot', () => {
    expect(
      canTransition(CylinderState.IN_DEPOT, CylinderState.FILLED),
    ).toBe(true);
    expect(
      canTransition(CylinderState.FILLED, CylinderState.DISPATCHED),
    ).toBe(true);
    expect(
      canTransition(CylinderState.DISPATCHED, CylinderState.WITH_CUSTOMER),
    ).toBe(true);
    expect(
      canTransition(
        CylinderState.WITH_CUSTOMER,
        CylinderState.EMPTY_RETURNED,
      ),
    ).toBe(true);
    expect(
      canTransition(CylinderState.EMPTY_RETURNED, CylinderState.IN_DEPOT),
    ).toBe(true);
  });

  it('permite revertir despacho/llenado (filled/dispatched → in_depot)', () => {
    expect(
      canTransition(CylinderState.FILLED, CylinderState.IN_DEPOT),
    ).toBe(true);
    expect(
      canTransition(CylinderState.DISPATCHED, CylinderState.IN_DEPOT),
    ).toBe(true);
  });

  it('rechaza saltos ilegales', () => {
    // No se puede entregar sin despachar.
    expect(
      canTransition(CylinderState.FILLED, CylinderState.WITH_CUSTOMER),
    ).toBe(false);
    // No se puede saltear el llenado.
    expect(
      canTransition(CylinderState.IN_DEPOT, CylinderState.DISPATCHED),
    ).toBe(false);
    // El vacío del cliente no vuelve a estar con el cliente.
    expect(
      canTransition(
        CylinderState.EMPTY_RETURNED,
        CylinderState.WITH_CUSTOMER,
      ),
    ).toBe(false);
  });

  it('rechaza quedarse en el mismo estado', () => {
    for (const state of Object.values(CylinderState)) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('assertTransition lanza 400 con mensaje claro en transición inválida', () => {
    expect(() =>
      assertTransition(CylinderState.IN_DEPOT, CylinderState.WITH_CUSTOMER),
    ).toThrow(BadRequestException);
    expect(() =>
      assertTransition(CylinderState.IN_DEPOT, CylinderState.WITH_CUSTOMER),
    ).toThrow(/Transición de envase inválida/);
  });

  it('assertTransition no lanza en transición válida', () => {
    expect(() =>
      assertTransition(CylinderState.IN_DEPOT, CylinderState.FILLED),
    ).not.toThrow();
  });

  it('todo estado del enum está declarado en la tabla de transiciones', () => {
    for (const state of Object.values(CylinderState)) {
      expect(CYLINDER_TRANSITIONS[state]).toBeDefined();
    }
  });
});
