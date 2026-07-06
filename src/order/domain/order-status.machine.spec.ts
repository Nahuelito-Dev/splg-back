import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '../entities/order.entity';
import {
  canTransition,
  assertTransition,
  isTerminal,
} from './order-status.machine';

/**
 * Máquina de estados del pedido (dominio puro). Reglas del SRS:
 *  PENDING    → ACCEPTED | CANCELLED
 *  ACCEPTED   → ON_THE_WAY | PENDING (re-dispatch) | CANCELLED
 *  ON_THE_WAY → DELIVERED | CANCELLED
 *  DELIVERED / CANCELLED = terminales.
 */
describe('order-status.machine', () => {
  describe('canTransition — transiciones válidas', () => {
    it.each([
      [OrderStatus.PENDING, OrderStatus.ACCEPTED],
      [OrderStatus.PENDING, OrderStatus.CANCELLED],
      [OrderStatus.ACCEPTED, OrderStatus.ON_THE_WAY],
      [OrderStatus.ACCEPTED, OrderStatus.PENDING], // chofer cancela → re-dispatch
      [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
      [OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED],
      [OrderStatus.ON_THE_WAY, OrderStatus.CANCELLED],
    ])('permite %s → %s', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    });
  });

  describe('canTransition — transiciones inválidas', () => {
    it.each([
      [OrderStatus.PENDING, OrderStatus.ON_THE_WAY], // salto de estado
      [OrderStatus.PENDING, OrderStatus.DELIVERED], // salto grande
      [OrderStatus.ACCEPTED, OrderStatus.DELIVERED], // salto (falta ON_THE_WAY)
      [OrderStatus.ON_THE_WAY, OrderStatus.ACCEPTED], // retroceso ilegal
      [OrderStatus.ON_THE_WAY, OrderStatus.PENDING], // retroceso ilegal
    ])('rechaza %s → %s', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });

    it('no permite salir de un estado terminal (DELIVERED)', () => {
      expect(canTransition(OrderStatus.DELIVERED, OrderStatus.PENDING)).toBe(
        false,
      );
      expect(canTransition(OrderStatus.DELIVERED, OrderStatus.CANCELLED)).toBe(
        false,
      );
    });

    it('no permite salir de un estado terminal (CANCELLED)', () => {
      expect(canTransition(OrderStatus.CANCELLED, OrderStatus.PENDING)).toBe(
        false,
      );
    });
  });

  describe('idempotencia', () => {
    it('re-aplicar el mismo estado es un no-op válido (from === to)', () => {
      for (const s of Object.values(OrderStatus)) {
        expect(canTransition(s, s)).toBe(true);
      }
    });
  });

  describe('isTerminal', () => {
    it('DELIVERED y CANCELLED son terminales', () => {
      expect(isTerminal(OrderStatus.DELIVERED)).toBe(true);
      expect(isTerminal(OrderStatus.CANCELLED)).toBe(true);
    });

    it('PENDING, ACCEPTED, ON_THE_WAY no son terminales', () => {
      expect(isTerminal(OrderStatus.PENDING)).toBe(false);
      expect(isTerminal(OrderStatus.ACCEPTED)).toBe(false);
      expect(isTerminal(OrderStatus.ON_THE_WAY)).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('no lanza en una transición válida', () => {
      expect(() =>
        assertTransition(OrderStatus.PENDING, OrderStatus.ACCEPTED),
      ).not.toThrow();
    });

    it('lanza BadRequestException con mensaje claro en una inválida', () => {
      expect(() =>
        assertTransition(OrderStatus.PENDING, OrderStatus.DELIVERED),
      ).toThrow(BadRequestException);
      expect(() =>
        assertTransition(OrderStatus.PENDING, OrderStatus.DELIVERED),
      ).toThrow(/inválida: pending → delivered/);
    });
  });
});
