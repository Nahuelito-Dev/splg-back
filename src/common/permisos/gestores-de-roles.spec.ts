import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  assertQuedaQuienGestioneRoles,
  bloquearGestoresDeRoles,
  contarGestoresDeRoles,
  MENSAJE_ULTIMO_GESTOR_DE_ROLES,
} from './gestores-de-roles';

describe('gestores de roles (F37)', () => {
  const managerCon = (respuesta: unknown[] = []) => {
    const query = jest.fn().mockResolvedValue(respuesta);
    return { manager: { query } as unknown as EntityManager, query };
  };

  it('toma los locks en el orden único: bajas y después roles', async () => {
    const { manager, query } = managerCon();
    await bloquearGestoresDeRoles(manager, 'd1');
    expect(query.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      ['admin-baja:d1'],
      ['staff-role:d1'],
    ]);
  });

  it('si ya tiene el de bajas, sólo toma el de roles', async () => {
    const { manager, query } = managerCon();
    await bloquearGestoresDeRoles(manager, 'd1', { yaTieneElDeBajas: true });
    expect(query.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      ['staff-role:d1'],
    ]);
  });

  it('cuenta los activos con rol de sistema o roles.gestionar, excluyendo a uno si se pide', async () => {
    const { manager, query } = managerCon([{ n: 2 }]);
    await expect(contarGestoresDeRoles(manager, 'd1', 'u1')).resolves.toBe(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('u."blocked" = false');
    expect(sql).toContain('sr."is_system" OR $3 = ANY(sr."permissions")');
    expect(params).toEqual(['d1', 'admin', 'roles.gestionar', 'u1']);
    const vacio = managerCon([]);
    await expect(contarGestoresDeRoles(vacio.manager, 'd1')).resolves.toBe(0);
    expect((vacio.query.mock.calls[0] as unknown[][])[1][3]).toBeNull();
  });

  it('falla sólo si antes había alguien y después nadie', () => {
    expect(() => assertQuedaQuienGestioneRoles(1, 0)).toThrow(
      ConflictException,
    );
    expect(() => assertQuedaQuienGestioneRoles(1, 0)).toThrow(
      MENSAJE_ULTIMO_GESTOR_DE_ROLES,
    );
    expect(() => assertQuedaQuienGestioneRoles(0, 0)).not.toThrow();
    expect(() => assertQuedaQuienGestioneRoles(2, 1)).not.toThrow();
  });
});
