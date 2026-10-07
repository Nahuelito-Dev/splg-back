import { VALOR_OCULTO } from './audit-exclusions';
import { cambioDeCampo, textoDe } from './audit-value';

describe('audit-value', () => {
  describe('textoDe', () => {
    it('normaliza cada tipo a texto', () => {
      expect(textoDe(null)).toBeNull();
      expect(textoDe(undefined)).toBeNull();
      expect(textoDe(new Date('2026-10-04T12:00:00Z'))).toBe(
        '2026-10-04T12:00:00.000Z',
      );
      expect(textoDe(true)).toBe('true');
      expect(textoDe(false)).toBe('false');
      expect(textoDe(12.5)).toBe('12.5');
      expect(textoDe('1000.00')).toBe('1000.00');
      expect(textoDe({ a: 1 })).toBe('{"a":1}');
    });
  });

  describe('cambioDeCampo', () => {
    it('un valor igual no es un cambio, aunque cambie la forma del número', () => {
      expect(cambioDeCampo('price', '1000.00', 1000, true)).toBeNull();
      expect(
        cambioDeCampo('phone', '03764123456', '3764123456'),
      ).not.toBeNull();
      expect(cambioDeCampo('x', null, undefined)).toBeNull();
      expect(cambioDeCampo('d', new Date(5), new Date(5))).toBeNull();
    });

    it('devuelve anterior y nuevo en texto', () => {
      expect(cambioDeCampo('stock', 5, 3)).toEqual({
        field: 'stock',
        oldValue: '5',
        newValue: '3',
      });
    });

    it('oculta los secretos sin dejar rastro del valor', () => {
      expect(cambioDeCampo('notificationToken', 'a', 'b')).toEqual({
        field: 'notificationToken',
        oldValue: VALOR_OCULTO,
        newValue: VALOR_OCULTO,
      });
      expect(cambioDeCampo('deliveryCode', null, '1234')).toEqual({
        field: 'deliveryCode',
        oldValue: null,
        newValue: VALOR_OCULTO,
      });
      expect(cambioDeCampo('passwordHash', 'x', 'x')).toBeNull();
    });

    it('trunca los textos muy largos', () => {
      const largo = 'a'.repeat(5000);
      const cambio = cambioDeCampo('note', null, largo);
      expect(cambio?.newValue).toHaveLength(2001);
    });
  });
});
