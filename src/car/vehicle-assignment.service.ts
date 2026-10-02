import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  DataSource,
  EntityManager,
  In,
  IsNull,
  Repository,
} from 'typeorm';
import { VehicleAssignment } from './entities/vehicle-assignment.entity';
import { Car } from './entities/car.entity';
import { DeliveryService } from '../delivery/delivery.service';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import { OrderStatus } from '../order/entities/order.entity';
import { bloquearChoferes } from '../common/locks/chofer-lock';

/**
 * Estados de pedido con los que no se le puede tocar el vehículo al chofer:
 * está en medio de una entrega. Sólo se importa el ENUM de `order` (un tipo,
 * no un provider de Nest): no genera dependencia de módulo ni ciclo
 * (CONVENCIONES §4; `car` no puede depender del `OrderModule` en sí — ver
 * `assertSinViajeEnCurso`, que por eso lee la tabla con una subconsulta).
 */
const ESTADOS_DE_VIAJE_EN_CURSO = [
  OrderStatus.ACCEPTED,
  OrderStatus.ON_THE_WAY,
];

/**
 * Qué vehículo usa cada chofer, con historial (decisión de nahue del 30/09,
 * resuelve el punto 5 de la revisión de bloqueo de flota: hoy un chofer con
 * varios autos quedaba bloqueado por cualquiera de ellos).
 *
 * La flota es de la distribuidora: `car.user_id` queda como "chofer
 * habitual" (informativo, no se toca acá); el vehículo EN USO de verdad es
 * el de la asignación abierta (`released_at IS NULL`) de este service.
 *
 * A propósito NO valida acá si el vehículo está inhabilitado por
 * documentación vencida (CU-136/137): ese chequeo necesita `FleetTaskService`
 * (módulo `fleet`), que YA depende de `car` — si `car` dependiera de `fleet`
 * también, sería un ciclo (CONVENCIONES §4). Lo pregunta el caller
 * (`DeliveryVehicleController`, en `fleet`) antes de llamar a `ponerEnUso`.
 *
 * Usa el repositorio de `Car` directo, NO `CarService`: `CarService.remove`
 * necesita preguntarle a este service si el vehículo está en uso
 * (`assertVehiculoLibre`), y si este service a su vez dependiera de
 * `CarService` sería un ciclo entre los dos (mismo módulo, mismo problema).
 */
@Injectable()
export class VehicleAssignmentService {
  private readonly logger = new Logger(VehicleAssignmentService.name);

  constructor(
    @InjectRepository(VehicleAssignment)
    private readonly assignments: Repository<VehicleAssignment>,
    @InjectRepository(Car)
    private readonly cars: Repository<Car>,
    private readonly dataSource: DataSource,
    private readonly deliveryService: DeliveryService,
  ) {}

  /**
   * Pone en uso un vehículo para un chofer: cierra la asignación abierta
   * anterior del chofer (si tenía otro vehículo) y la del vehículo (si lo
   * tenía otro chofer), y abre la nueva. Si el chofer ya tiene en uso ese
   * mismo vehículo es un no-op: devuelve la asignación abierta, sin cerrar
   * ni abrir otra ni sumar al historial. Rechaza con 409 si al chofer que
   * recibe el vehículo, o al que se lo "roba", le tocaría quitárselo en
   * medio de una entrega (pedido ACCEPTED/ON_THE_WAY — decisión de la
   * revisión).
   *
   * Todo, validaciones incluidas, corre en UNA transacción: se bloquea la
   * fila del vehículo y las de los choferes involucrados (siempre en orden
   * de id, para que dos llamadas cruzadas no se deadlockeen) ANTES de mirar
   * si hay un viaje en curso, así el chequeo no se hace sobre un estado que
   * otra request de este mismo servicio está por cambiar. Reintento
   * automático si choca por concurrencia (`withTransactionRetry`): los dos
   * índices únicos parciales de la entidad son la última línea de defensa
   * (409 vía `traducirErrorDeBase`).
   */
  async ponerEnUso(
    deliveryId: string,
    carId: string,
    note: string | null,
    distributorId: string,
    actorUserId: string,
  ): Promise<VehicleAssignment> {
    await this.assertChoferDelTenant(deliveryId, distributorId);

    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const repo = manager.getRepository(VehicleAssignment);
            const car = await manager
              .getRepository(Car)
              .createQueryBuilder('car')
              .setLock('pessimistic_write')
              .where('car.carId = :carId', { carId })
              .andWhere('car.distributorId = :distributorId', { distributorId })
              .getOne();
            if (!car) {
              throw new NotFoundException(`Vehículo ${carId} no encontrado`);
            }

            const abiertaDelChofer = await repo.findOne({
              where: { deliveryId, releasedAt: IsNull() },
            });
            if (abiertaDelChofer?.carId === car.carId) {
              abiertaDelChofer.car = car;
              return abiertaDelChofer;
            }

            const tenedorActual = await repo.findOne({
              where: { carId: car.carId, releasedAt: IsNull() },
            });
            const choferes = [
              ...new Set([deliveryId, tenedorActual?.deliveryId ?? deliveryId]),
            ].sort();
            await this.bloquearYValidarChoferes(manager, choferes, deliveryId);

            // Al chofer que recibe el vehículo no se le puede cambiar en
            // medio de una entrega (si tiene un pedido en curso, YA tiene un
            // vehículo en uso con el que lo está cumpliendo), ni "robárselo"
            // a otro que está en una.
            for (const chofer of choferes) {
              await this.assertSinViajeEnCurso(chofer, manager);
            }

            const ahora = new Date();

            // Cierra en UNA sola sentencia la abierta anterior del chofer
            // (si tenía otro vehículo) Y la del vehículo (si lo tenía otro
            // chofer): dos `update()` separados bloqueaban sus filas en dos
            // fases independientes y podían tomar esos bloqueos en orden
            // cruzado (40P01). Una sola sentencia con las dos condiciones
            // hace que Postgres recorra las mismas filas en el mismo orden.
            await repo
              .createQueryBuilder()
              .update(VehicleAssignment)
              .set({ releasedAt: ahora, releasedByUserId: actorUserId })
              .where('released_at IS NULL')
              .andWhere(
                new Brackets((qb) => {
                  qb.where('delivery_id = :deliveryId', {
                    deliveryId,
                  }).orWhere('car_id = :carId', { carId: car.carId });
                }),
              )
              .execute();

            const nueva = repo.create({
              distributorId,
              carId: car.carId,
              deliveryId,
              assignedAt: ahora,
              releasedAt: null,
              assignedByUserId: actorUserId,
              releasedByUserId: null,
              note,
            });
            // Se lo adjuntamos para que el caller (`DeliveryVehicleController`)
            // arme la respuesta sin otra consulta.
            nueva.car = car;

            return repo.save(nueva);
          }),
        { context: 'poner vehículo en uso' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'asignación de vehículo');
    }
  }

  /** Libera el vehículo en uso del chofer. 404 si no tenía ninguno; 409 si tiene un pedido en curso. */
  async liberar(
    deliveryId: string,
    distributorId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.assertChoferDelTenant(deliveryId, distributorId);
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.bloquearYValidarChoferes(manager, [deliveryId], deliveryId);
        await this.assertSinViajeEnCurso(deliveryId, manager);
        const repo = manager.getRepository(VehicleAssignment);
        const abierta = await repo.findOne({
          where: { deliveryId, releasedAt: IsNull() },
        });
        if (!abierta) {
          throw new NotFoundException('El chofer no tiene un vehículo en uso');
        }
        abierta.releasedAt = new Date();
        abierta.releasedByUserId = actorUserId;
        await repo.save(abierta);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'asignación de vehículo');
    }
  }

  /**
   * Bloquea la fila de cada chofer (ver `bloquearChoferes`) y responde el
   * mismo 404 de siempre si `deliveryId` —el chofer sobre el que se opera—
   * no existe o ya fue dado de baja: una baja que ganó la carrera ya está
   * confirmada cuando el lock se libera. Los otros (a quien se le "roba" el
   * vehículo) sólo se bloquean: si lo dieron de baja, su vehículo ya quedó
   * libre.
   */
  private async bloquearYValidarChoferes(
    manager: EntityManager,
    deliveryIds: string[],
    deliveryId: string,
  ): Promise<void> {
    const vigentes = await bloquearChoferes(manager, deliveryIds);
    if (!vigentes.has(deliveryId)) {
      throw new NotFoundException(`Chofer ${deliveryId} no encontrado`);
    }
  }

  /**
   * 409 si el chofer tiene un pedido ACCEPTED u ON_THE_WAY: no se le puede
   * quitar ni "robar" el vehículo en uso en medio de una entrega (decisión
   * de la revisión de vehículo en uso). Lee la tabla `order` en una
   * subconsulta de sólo lectura — misma excepción documentada en
   * CONVENCIONES §4 que `common/tenancy/pertenencia.ts`: `car` no puede
   * depender de `OrderModule` (ciclo: order → fleet → car → order).
   */
  private async assertSinViajeEnCurso(
    deliveryId: string,
    manager: EntityManager,
  ): Promise<void> {
    const filas = await manager.query<{ existe: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM "order"
         WHERE delivery_id = $1 AND status = ANY($2)
       ) AS existe`,
      [deliveryId, ESTADOS_DE_VIAJE_EN_CURSO],
    );
    if (filas[0]?.existe) {
      throw new ConflictException(
        'No se puede modificar el vehículo de un chofer con un pedido en curso (aceptado o en camino)',
      );
    }
  }

  /**
   * Libera el vehículo en uso si tenía uno, sin tirar si no tenía (baja de
   * chofer). Con `manager` corre dentro de la transacción de la baja: si
   * esto falla, la baja se revierte.
   */
  async liberarSiTieneUno(
    deliveryId: string,
    manager: EntityManager,
  ): Promise<void> {
    const repo = manager.getRepository(VehicleAssignment);
    const abierta = await repo.findOne({
      where: { deliveryId, releasedAt: IsNull() },
    });
    if (!abierta) return;

    abierta.releasedAt = new Date();
    abierta.note = abierta.note
      ? `${abierta.note}\n\nLiberado automáticamente: el chofer fue dado de baja.`
      : 'Liberado automáticamente: el chofer fue dado de baja.';
    await repo.save(abierta);
    this.logger.log(
      `Vehículo ${abierta.carId} liberado por baja del chofer ${deliveryId}`,
    );
  }

  /** Vehículo en uso del chofer (con `car` cargado), o `null` si no tiene. */
  async vehiculoEnUso(
    deliveryId: string,
    distributorId: string,
  ): Promise<VehicleAssignment | null> {
    await this.assertChoferDelTenant(deliveryId, distributorId);
    return this.assignments.findOne({
      where: { deliveryId, releasedAt: IsNull() },
      relations: ['car'],
    });
  }

  /** Historial de vehículos de un chofer, paginado (más reciente primero). */
  async historialDelChofer(
    deliveryId: string,
    distributorId: string,
    pagination: PaginationDto,
  ): Promise<[VehicleAssignment[], number]> {
    await this.assertChoferDelTenant(deliveryId, distributorId);
    return this.assignments.findAndCount({
      where: { deliveryId },
      relations: ['car', 'delivery', 'delivery.user'],
      // Un vehículo dado de baja sigue figurando con patente, marca y modelo.
      withDeleted: true,
      order: { assignedAt: 'DESC' },
      take: pagination.limit ?? 10,
      skip: pagination.offset ?? 0,
    });
  }

  /**
   * 404 si el chofer no existe o no es de esta distribuidora. La usa cada
   * método de este service, Y `DeliveryVehicleController` ANTES de
   * `FleetTaskService.assertVehiculoHabilitado` en `PUT /delivery/:id/vehicle`
   * — si no, un vehículo inhabilitado revelaría por qué está inhabilitado
   * (400 con el detalle) ANTES de confirmar que el chofer es de este tenant:
   * la pertenencia tiene que cortar primero, con 404 (CONVENCIONES §4: "lo de
   * otra distribuidora responde 404, no se revela que existe").
   */
  async assertChoferDelTenant(
    deliveryId: string,
    distributorId: string,
  ): Promise<void> {
    const delivery = await this.deliveryService.findOne(deliveryId); // 404 si no existe
    if (delivery.distributorId !== distributorId) {
      throw new NotFoundException(`Chofer ${deliveryId} no encontrado`);
    }
  }

  /** Historial de choferes de un vehículo, paginado (más reciente primero). */
  async historialDelVehiculo(
    carId: string,
    distributorId: string,
    pagination: PaginationDto,
  ): Promise<[VehicleAssignment[], number]> {
    // `withDeleted`: un vehículo dado de baja conserva su historial (no se
    // puede dar de baja uno EN USO — `assertVehiculoLibre` —, pero uno viejo,
    // ya liberado, sí, y su historial sigue siendo consultable).
    const car = await this.cars.findOne({
      where: { carId, distributorId },
      withDeleted: true,
    });
    if (!car) {
      throw new NotFoundException(`Vehículo ${carId} no encontrado`);
    }
    return this.assignments.findAndCount({
      where: { carId },
      relations: ['car', 'delivery', 'delivery.user'],
      // Un chofer dado de baja sigue figurando con su nombre.
      withDeleted: true,
      order: { assignedAt: 'DESC' },
      take: pagination.limit ?? 10,
      skip: pagination.offset ?? 0,
    });
  }

  /**
   * 409 si el vehículo está en uso. Lo llama `CarService.remove` antes de dar
   * de baja el vehículo, con el `manager` de su transacción.
   */
  async assertVehiculoLibre(
    carId: string,
    manager: EntityManager,
  ): Promise<void> {
    const abierta = await manager.getRepository(VehicleAssignment).findOne({
      where: { carId, releasedAt: IsNull() },
    });
    if (abierta) {
      throw new ConflictException('El vehículo está en uso: liberalo primero');
    }
  }

  /**
   * El vehículo en uso de cada uno de esos choferes (`delivery_id`), en
   * lote, con marca/modelo/patente. Lo usa `FleetDispatchLockService` para
   * el gate de despacho (sólo necesita `carId`) y para el snapshot que se
   * guarda en el pedido al aceptarlo (necesita todo lo demás) — misma
   * consulta para los dos casos, sin un round-trip por candidato.
   */
  async findVehiculosEnUsoPorDeliveryIds(
    deliveryIds: string[],
    distributorId?: string | null,
  ): Promise<
    Array<{
      deliveryId: string;
      carId: string;
      patent: string | null;
      brand: string | null;
      model: string | null;
    }>
  > {
    if (deliveryIds.length === 0) return [];
    const filas = await this.assignments.find({
      where: {
        deliveryId: In(deliveryIds),
        releasedAt: IsNull(),
        ...(distributorId ? { distributorId } : {}),
      },
      relations: ['car'],
    });
    return filas.map((f) => ({
      deliveryId: f.deliveryId,
      carId: f.carId,
      patent: f.car?.carPatent ?? null,
      brand: f.car?.carBrand ?? null,
      model: f.car?.carModel ?? null,
    }));
  }
}
