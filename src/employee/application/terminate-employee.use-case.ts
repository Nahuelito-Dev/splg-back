import {
  ForbiddenException,
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
import { RoleType } from '../../common/constants/role-type.enum';
import { bloquearGestoresDeRoles } from '../../common/permisos/gestores-de-roles';
import {
  AutoridadSobreCuentas,
  type ActorSobreCuentas,
} from '../../common/permisos/autoridad-sobre-cuentas';

/**
 * Registrar el egreso de un empleado (CU-181), todo en UNA transacción:
 * el legajo pasa a `terminated` y, si tiene cuenta, se bloquea al usuario y,
 * si es chofer, se lo deshabilita y se libera el vehículo que tenía en uso
 * (el mismo camino que la baja de un chofer).
 *
 * Orden de locks global: usuario/chofer (`bloquearChoferes`) ANTES que el
 * legajo. Es el de `UsersService.remove`, que bloquea al chofer y recién en su
 * evento toca el legajo; invertirlo daba deadlock (40P01).
 *
 * Si la cuenta del legajo es de un administrador, el egreso es también su
 * bloqueo: pasa por la regla sobre cuentas de otros (`administradores.gestionar`
 * y cubrir los permisos de su rol) y por las del último administrador activo y
 * `LAST_ROLES_MANAGER` (`UsersService.bloquearEnTransaccion`). Los locks de la
 * empresa (bajas y roles) van antes que el legajo, el orden de `users.remove`.
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
    private readonly autoridad: AutoridadSobreCuentas,
  ) {}

  async execute(
    id: string,
    dto: TerminateEmployeeDto,
    distributorId: string,
    actor: ActorSobreCuentas,
  ): Promise<{ empleado: EmployeeConPuesto; deliveryId: string | null }> {
    let usuarioBloqueado: string | null = null;
    const userIdDelChofer = await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          // Orden de locks (el mismo que `users.remove`): usuario/chofer
          // primero y el legajo después. Se lee el legajo sin lock sólo para
          // saber qué chofer bloquear.
          const previo = await this.employees.findOne(id, distributorId);
          // Igual que `/users/:id/block`: nadie se bloquea a sí mismo por acá.
          if (
            previo.userId &&
            previo.userId.toLowerCase() === actor.user_id.toLowerCase()
          ) {
            throw new ForbiddenException(
              'No podés dar de egreso tu propio legajo: pedíselo a otro administrador',
            );
          }
          if (previo.userId) {
            const rol = (await this.users.findRoleTypes([previo.userId])).get(
              previo.userId,
            );
            if (rol === String(RoleType.ADMIN)) {
              await bloquearGestoresDeRoles(manager, distributorId);
              await this.autoridad.assertPuedeAdministrarA(
                actor,
                { userId: previo.userId, rol },
                distributorId,
                { manager },
              );
            }
          }
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
            usuarioBloqueado = empleado.userId;
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
                actorUserId: actor.user_id,
              },
            );
          }
          return chofer ? chofer.userId : null;
        }),
      { context: 'egreso de empleado' },
    );

    if (usuarioBloqueado) {
      this.users.avisarAccesoRevocado(usuarioBloqueado, 'bloqueo');
    }
    // Con el egreso confirmado sale del radar de despacho (Redis no es transaccional).
    if (userIdDelChofer) {
      await this.deliveries.quitarDelRadar(userIdDelChofer);
    }
    return this.employees.findOneDetallado(id, distributorId);
  }
}
