import { EntityManager } from 'typeorm';
import { EmployeeRulesRegistry } from './employee-rules.registry';
import { Employee } from './entities/employee.entity';

describe('EmployeeRulesRegistry', () => {
  const manager = {} as EntityManager;
  const empleado = { employeeId: 'e1' } as Employee;

  it('sin reglas registradas no impide nada', async () => {
    const registry = new EmployeeRulesRegistry();
    await expect(
      registry.motivosQueImpidenElEgreso(manager, empleado),
    ).resolves.toEqual([]);
    await expect(
      registry.motivosQueImpidenLaBaja(manager, empleado),
    ).resolves.toEqual([]);
  });

  it('junta los motivos de todas las reglas, cada lista en su operación', async () => {
    const registry = new EmployeeRulesRegistry();
    registry.alEgresar(() => Promise.resolve(['carga de camión abierta']));
    registry.alEgresar(() => Promise.resolve(['rendición pendiente']));
    registry.alDarDeBaja(() => Promise.resolve(['tiene jornadas']));

    await expect(
      registry.motivosQueImpidenElEgreso(manager, empleado),
    ).resolves.toEqual(['carga de camión abierta', 'rendición pendiente']);
    await expect(
      registry.motivosQueImpidenLaBaja(manager, empleado),
    ).resolves.toEqual(['tiene jornadas']);
  });
});
