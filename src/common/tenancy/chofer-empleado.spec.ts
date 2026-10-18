import { EntityManager } from 'typeorm';
import {
  choferDelEmpleado,
  empleadoDelChofer,
  empleadoDelUsuario,
} from './chofer-empleado';

describe('chofer-empleado: el legajo y el chofer son de la misma distribuidora', () => {
  let sqls: string[];
  let manager: EntityManager;

  beforeEach(() => {
    sqls = [];
    manager = {
      query: jest.fn((sql: string) => {
        sqls.push(sql.replace(/\s+/g, ' '));
        return Promise.resolve([]);
      }),
    } as unknown as EntityManager;
  });

  it.each([
    ['empleadoDelChofer', (m: EntityManager) => empleadoDelChofer(m, 'd-1')],
    [
      'empleadoDelUsuario',
      (m: EntityManager) => empleadoDelUsuario(m, 'u-1', 'dist-1'),
    ],
    [
      'choferDelEmpleado',
      (m: EntityManager) => choferDelEmpleado(m, 'e-1', 'dist-1'),
    ],
  ])('%s une por usuario Y por distribuidora', async (_nombre, llamar) => {
    await llamar(manager);
    expect(sqls[0]).toMatch(
      /e\."distributor_id" = d\."distributor_id"|d\."distributor_id" = e\."distributor_id"/,
    );
  });
});
