import {
  calcularEstadoDeVencimiento,
  ExpirationStatus,
} from './domain/expiration-status';
import { BoardColumn, columnaDe } from './domain/task-board';
import { MaintenanceDocumentKind } from './entities/maintenance-plan.entity';
import { MaintenanceTaskStatus } from './entities/maintenance-task.entity';
import {
  FleetTaskBoardCardDto,
  FleetTaskBoardColumnsDto,
  FleetTaskBoardDto,
} from './dto/task-board.dto';
import type { TableroLeido, TarjetaLeida } from './fleet-task-board.reader';
import type { Car } from '../car/entities/car.entity';

const CERRADAS = new Set<MaintenanceTaskStatus>([
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
]);

export class FleetTaskBoardMapper {
  static toCard(
    { task, attachmentsCount }: TarjetaLeida,
    ahora: Date = new Date(),
  ): FleetTaskBoardCardDto {
    const card = new FleetTaskBoardCardDto();
    card.id = task.taskId;
    card.title = task.plan.name;
    card.category = task.plan.documentKind ?? MaintenanceDocumentKind.GENERIC;
    card.status = task.status;
    card.column = columnaDe(task);
    const abierta = !CERRADAS.has(task.status);
    card.isOverdue =
      abierta &&
      (task.status === MaintenanceTaskStatus.OVERDUE ||
        calcularEstadoDeVencimiento(
          task.dueAt,
          task.plan.leadTimeDays,
          ahora,
        ) === ExpirationStatus.EXPIRED);
    card.dueAt = task.dueAt;
    card.dueKm = task.dueKm;
    card.scheduledAt = task.scheduledAt;
    card.car = task.car
      ? {
          id: task.car.carId,
          plate: task.car.carPatent,
          label: etiquetaDelVehiculo(task.car),
        }
      : null;
    card.assignee = task.assignee
      ? {
          employeeId: task.assignee.employeeId,
          name: `${task.assignee.lastName}, ${task.assignee.firstName}`,
        }
      : null;
    card.attachmentsCount = attachmentsCount;
    card.cost = task.cost;
    card.position = task.boardPosition;
    card.updatedAt = task.updatedAt;
    return card;
  }

  static toBoard(
    { columnas, canceladas }: TableroLeido,
    ahora: Date = new Date(),
  ): FleetTaskBoardDto {
    const aTarjetas = (lista: TarjetaLeida[]) =>
      lista.map((t) => FleetTaskBoardMapper.toCard(t, ahora));
    const columns = new FleetTaskBoardColumnsDto();
    columns.forecast = aTarjetas(columnas[BoardColumn.FORECAST]);
    columns.scheduled = aTarjetas(columnas[BoardColumn.SCHEDULED]);
    columns.in_progress = aTarjetas(columnas[BoardColumn.IN_PROGRESS]);
    columns.done = aTarjetas(columnas[BoardColumn.DONE]);
    const dto = new FleetTaskBoardDto();
    dto.columns = columns;
    dto.cancelledCount = canceladas;
    return dto;
  }
}

function etiquetaDelVehiculo(car: Car): string {
  const marcaYModelo = [car.carBrand, car.carModel]
    .filter((p): p is string => Boolean(p))
    .join(' ');
  return marcaYModelo || car.typeCar || car.carPatent || 'Vehículo';
}
