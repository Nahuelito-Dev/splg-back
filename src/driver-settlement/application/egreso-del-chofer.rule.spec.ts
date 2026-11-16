import type { EntityManager } from 'typeorm';
import { DeliveryService } from '../../delivery/delivery.service';
import { EmployeeRulesRegistry } from '../../employee/employee-rules.registry';
import { Employee } from '../../employee/entities/employee.entity';
import { RendicionConflictoError } from '../domain/errors/driver-settlement.errors';
import { EgresoDelChoferRule } from './egreso-del-chofer.rule';
import * as sinRendir from './settlement-orders';

describe('EgresoDelChoferRule (CU-181)', () => {
  const empleado = (userId: string | null) =>
    ({ employeeId: 'e1', distributorId: 'd1', userId }) as Employee;

  /** `chofer`: lo que devuelve la búsqueda; `sinCerrar`: la fila de la rendición sin cerrar, si hay. */
  const armar = (
    chofer: { deliveryId: string } | null,
    sinCerrar: unknown[] = [],
  ) => {
    const query = jest.fn().mockResolvedValue(sinCerrar);
    const buscar = jest.fn().mockResolvedValue(chofer);
    const registry = new EmployeeRulesRegistry();
    new EgresoDelChoferRule(registry, {
      findByUserIdEnTransaccion: buscar,
    } as unknown as DeliveryService).onModuleInit();
    const manager = { query } as unknown as EntityManager;
    return { registry, manager, query, buscar };
  };

  afterEach(() => jest.restoreAllMocks());

  it('un empleado sin cuenta no tiene rendiciones: no consulta nada', async () => {
    const { registry, manager, query, buscar } = armar(null);
    await expect(
      registry.motivosQueImpidenElEgreso(manager, empleado(null)),
    ).resolves.toEqual([]);
    expect(buscar).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('una cuenta sin perfil de reparto no se frena', async () => {
    const { registry, manager, query } = armar(null);
    await expect(
      registry.motivosQueImpidenElEgreso(manager, empleado('u1')),
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('busca al chofer con las bajas (la baja del usuario lo borra antes de egresar el legajo)', async () => {
    const { registry, manager, buscar } = armar({ deliveryId: 'c1' });
    jest.spyOn(sinRendir, 'pedidosSinRendir').mockResolvedValue([]);
    await registry.motivosQueImpidenElEgreso(manager, empleado('u1'));
    expect(buscar).toHaveBeenCalledWith(manager, 'u1', { conBajas: true });
  });

  it.each([
    ['open', 'abierta'],
    ['submitted', 'presentada'],
  ])(
    'rechaza con 409 si tiene una rendición %s, con su N°, estado y fecha',
    async (status, texto) => {
      const { registry, manager } = armar({ deliveryId: 'c1' }, [
        { number: 12, status, business_date: '2026-10-30' },
      ]);
      const intento = registry.motivosQueImpidenElEgreso(
        manager,
        empleado('u1'),
      );
      await expect(intento).rejects.toBeInstanceOf(RendicionConflictoError);
      await expect(intento).rejects.toThrow(
        `No se puede dar de baja al chofer mientras tenga una rendición pendiente (rendición N° 12, ${texto}, del 30/10/2026): cerrala antes`,
      );
    },
  );

  describe('efectivo entregado que ninguna rendición tomó', () => {
    const pedidos = () =>
      jest.spyOn(sinRendir, 'pedidosSinRendir').mockResolvedValue(
        [5000, 2500.5].map((monto, i) => ({
          orderId: `o${i}`,
          totalAmount: monto,
          amountToCollect: monto,
          paymentStatus: 'paid',
          deliveredAt: new Date(),
        })),
      );

    it('rechaza con el monto y pide generar y aprobar la rendición', async () => {
      pedidos();
      const { registry, manager } = armar({ deliveryId: 'c1' });
      await expect(
        registry.motivosQueImpidenElEgreso(manager, empleado('u1')),
      ).rejects.toThrow(
        'No se puede dar de baja al chofer mientras tenga efectivo sin rendir (2 pedido(s) en efectivo por $ 7.500,50): generá y aprobá su rendición antes',
      );
    });
  });

  it('con todo aprobado y nada sin rendir deja pasar el egreso', async () => {
    jest.spyOn(sinRendir, 'pedidosSinRendir').mockResolvedValue([]);
    const { registry, manager } = armar({ deliveryId: 'c1' });
    await expect(
      registry.motivosQueImpidenElEgreso(manager, empleado('u1')),
    ).resolves.toEqual([]);
  });

  it('no se aplica a la baja de un legajo erróneo', async () => {
    const { registry, manager, query } = armar({ deliveryId: 'c1' });
    await expect(
      registry.motivosQueImpidenLaBaja(manager, empleado('u1')),
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
