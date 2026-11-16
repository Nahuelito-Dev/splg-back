import { Injectable, OnModuleInit } from '@nestjs/common';
import { DeliveryService } from '../../delivery/delivery.service';
import { EmployeeRulesRegistry } from '../../employee/employee-rules.registry';
import { RendicionConflictoError } from '../domain/errors/driver-settlement.errors';
import {
  mensajeDeRendicionPendiente,
  pendienteDeRendir,
} from './rendicion-pendiente';

/**
 * Egreso del empleado (CU-181) y baja de su usuario: un chofer con una
 * rendición pendiente no se puede egresar. Rechaza con 409 y el mensaje propio
 * (como la carga de camión abierta) en vez de sumar un motivo a la lista
 * genérica, y corre dentro de la transacción del egreso, que ya tiene
 * bloqueado al chofer. Busca al chofer igual que el caso de uso, pero con las
 * bajas: la baja del usuario lo borra lógicamente antes de egresar el legajo.
 */
@Injectable()
export class EgresoDelChoferRule implements OnModuleInit {
  constructor(
    private readonly rules: EmployeeRulesRegistry,
    private readonly deliveries: DeliveryService,
  ) {}

  onModuleInit(): void {
    this.rules.alEgresar(async (manager, empleado) => {
      if (!empleado.userId) return [];
      const chofer = await this.deliveries.findByUserIdEnTransaccion(
        manager,
        empleado.userId,
        { conBajas: true },
      );
      if (!chofer) return [];
      const pendiente = await pendienteDeRendir(
        manager,
        empleado.distributorId,
        chofer.deliveryId,
      );
      if (pendiente) {
        throw new RendicionConflictoError(
          mensajeDeRendicionPendiente(pendiente),
        );
      }
      return [];
    });
  }
}
