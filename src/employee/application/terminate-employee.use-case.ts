import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Employee, EmployeeStatus } from '../entities/employee.entity';
import { TerminateEmployeeDto } from '../dto/terminate-employee.dto';
import { EmployeeService } from '../employee.service';
import { EmployeeRulesRegistry } from '../employee-rules.registry';
import { EmployeeConPuesto } from '../employee.mapper';
import { validarEgreso } from '../domain/employee-state';
import { DeliveryService } from '../../delivery/delivery.service';
import { UsersService } from '../../users/users.service';
import { VehicleAssignmentService } from '../../car/vehicle-assignment.service';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { bloquearChoferVigente } from '../../common/locks/chofer-lock';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';

/**
 * Registrar el egreso de un empleado (CU-181), todo en UNA transacción:
 * el legajo pasa a `terminated` y, si tiene cuenta, se bloquea al usuario y,
 * si es chofer, se lo deshabilita y se libera el vehículo que tenía en uso
 * (el mismo camino que la baja de un chofer).
 *
 * Orden de locks global: usuario/chofer (`bloquearChoferes`) ANTES que el
 * legajo. Es el de `UsersService.remove`, que bloquea al chofer y recién en su
 * evento toca el legajo; invertirlo daba deadlock (40P01).
 */
@Injectable()
export class TerminateEmployeeUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly employees: EmployeeService,
    private readonly users: UsersService,
    private readonly deliveries: DeliveryService,
    private readonly vehicleAssignments: VehicleAssignmentService,
    private readonly orders: OrderLookupService,
    private readonly rules: EmployeeRulesRegistry,
  ) {}

  async execute(
    id: string,
    dto: TerminateEmployeeDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<{ empleado: EmployeeConPuesto; deliveryId: string | null }> {
    const userIdDelChofer = await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          // Orden de locks (el mismo que `users.remove`): usuario/chofer
          // primero y el legajo después. Se lee el legajo sin lock sólo para
          // saber qué chofer bloquear.
          const previo = await this.employees.findOne(id, distributorId);
          const chofer = previo.userId
            ? await this.deliveries.findByUserIdEnTransaccion(
                manager,
                previo.userId,
              )
            : null;
          if (chofer) {
            await bloquearChoferVigente(manager, chofer.deliveryId);
          }
          const empleado = await this.employees.bloquear(
            manager,
            id,
            distributorId,
          );
          if (empleado.userId !== previo.userId) {
            throw new ConflictException(
              'La cuenta del empleado cambió mientras se registraba el egreso: reintentá',
            );
          }
          const rechazo = validarEgreso(empleado, dto.terminationDate);
          if (rechazo === 'YA_EGRESADO') {
            throw new ConflictException('El empleado ya está egresado');
          }
          if (rechazo === 'FECHA_ANTERIOR_AL_INGRESO') {
            throw new BadRequestException(
              'La fecha de egreso no puede ser anterior a la de ingreso',
            );
          }

          if (chofer) {
            const pedidos = await this.orders.countActiveByDelivery(
              chofer.deliveryId,
              manager,
            );
            if (pedidos > 0) {
              throw new ConflictException(
                `El chofer tiene ${pedidos} pedido(s) en curso: cancelalos o reasignalos antes del egreso`,
              );
            }
          }

          const motivos = await this.rules.motivosQueImpidenElEgreso(
            manager,
            empleado,
          );
          if (motivos.length > 0) {
            throw new ConflictException(
              `No se puede registrar el egreso: ${motivos.join('; ')}`,
            );
          }

          empleado.status = EmployeeStatus.TERMINATED;
          empleado.terminationDate = dto.terminationDate;
          empleado.terminationReason = dto.reason;
          await manager.getRepository(Employee).save(empleado);

          if (empleado.userId) {
            await this.users.bloquearEnTransaccion(manager, empleado.userId);
          }
          if (chofer) {
            await this.deliveries.deshabilitarEnTransaccion(
              manager,
              chofer.deliveryId,
            );
            await this.vehicleAssignments.liberarSiTieneUno(
              chofer.deliveryId,
              manager,
              {
                motivo:
                  'Liberado automáticamente: egreso del legajo del chofer.',
                actorUserId,
              },
            );
          }
          return chofer ? chofer.userId : null;
        }),
      { context: 'egreso de empleado' },
    );

    // Con el egreso confirmado sale del radar de despacho (Redis no es transaccional).
    if (userIdDelChofer) {
      await this.deliveries.quitarDelRadar(userIdDelChofer);
    }
    return this.employees.findOneDetallado(id, distributorId);
  }
}
