import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Repository,
  MoreThan,
  FindOptionsWhere,
  EntityManager,
  ILike,
} from 'typeorm';
import { GasCylinder } from './entities/gascylinder.entity';
import { GasCylinderPromotion } from './entities/gascylinder-promotion.entity';
import { PromocionDto } from './dto/create-gascylinder.dto';
import { CreateGasCylinderDto } from './dto/create-gascylinder.dto';
import { UpdateGasCylinderDto } from './dto/update-gascylinder.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { DistributorService } from '../distributor/distributor.service';

import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { GasCylinderNotFoundError } from './domain/errors/gas-cylinder-not-found.error';
import { InsufficientStockError } from './domain/errors/insufficient-stock.error';
import {
  EVENTO_GARRAFA_CREADA,
  GarrafaCreadaEvent,
} from './events/garrafa-creada.event';
import { VendibleInsuficienteError } from './domain/errors/vendible-insuficiente.error';
import {
  BajaDeProductoDto,
  MedioDePagoDto,
} from './dto/gascylinder-response.dto';

/** Lo mínimo para mover stock: qué producto y cuántas unidades. */
export interface MovimientoDeStock {
  gasCylinderId: string;
  quantity: number;
}

/** Las lecturas del catálogo traen las promociones del producto. */
const CON_PROMOCIONES = ['promotions'];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Medios de pago del catálogo, con su recargo en porcentaje. */
const MEDIOS_DE_PAGO: MedioDePagoDto[] = [
  { name: 'Efectivo', key: 'CASH', surcharge: 0 },
  { name: 'MercadoPago / Transferencia', key: 'TRANSFER', surcharge: 10 },
];

@Injectable()
export class GasCylinderService {
  private readonly logger = new Logger(GasCylinderService.name);

  constructor(
    @InjectRepository(GasCylinder)
    private readonly gasCylinderRepository: Repository<GasCylinder>,
    private readonly distributorService: DistributorService,
    private readonly eventos: EventEmitter2,
  ) {}

  /**
   * Resuelve un `distributor_id` a partir de un slug o uuid. Usado por los
   * endpoints públicos del catálogo, donde el tenant llega por query
   * `?distributor=` (el guard no corre en rutas @Public).
   *
   * Compatibilidad hacia atrás: si NO se pasa distribuidora, cae a la default
   * (Distribuidora Demo) en vez de mezclar catálogos de todos los tenants — así la app
   * cliente previa al multi-tenant sigue viendo un catálogo coherente.
   */
  async resolveDistributor(slugOrId?: string): Promise<string | null> {
    if (!slugOrId) {
      const def = await this.distributorService.getDefault();
      return def?.distributorId ?? null;
    }
    const distributor = UUID_RE.test(slugOrId)
      ? await this.distributorService.assertActive(slugOrId)
      : await this.distributorService.findBySlug(slugOrId);
    return distributor.distributorId;
  }

  async create(
    createGasCylinderDto: CreateGasCylinderDto,
    distributorId: string,
  ): Promise<GasCylinder> {
    // Unicidad de `type` es POR distribuidora: dos tenants pueden tener ambos
    // una "Garrafa 10kg".
    const existing = await this.gasCylinderRepository.findOne({
      where: { type: createGasCylinderDto.type, distributorId },
    });

    if (existing) {
      throw new BadRequestException(
        'Ya existe una garrafa con este tipo en tu distribuidora',
      );
    }

    assertPromocionesSinRepetir(createGasCylinderDto.promotions);
    const gasCylinder = this.gasCylinderRepository.create({
      ...createGasCylinderDto,
      distributorId,
    });
    try {
      return await this.gasCylinderRepository.manager.transaction(
        async (manager) => {
          const guardado = await manager.save(gasCylinder);
          // El stock inicial es vendible: el módulo de stock lo registra como
          // físico del depósito predeterminado EN ESTA transacción (con el
          // `manager`), para que las dos cifras no se desalineen nunca. Si el
          // listener falla, el producto tampoco se crea.
          if (guardado.stock > 0) {
            await this.eventos.emitAsync(
              EVENTO_GARRAFA_CREADA,
              new GarrafaCreadaEvent(
                guardado.gasCylinderId,
                distributorId,
                guardado.stock,
                manager,
              ),
            );
          }
          return guardado;
        },
      );
    } catch (error) {
      return this.handleDBExceptions(error);
    }
  }

  async findAll(
    paginationDto: PaginationDto,
    distributor?: string,
  ): Promise<{
    gasCylinders: GasCylinder[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const { limit = 10, offset = 0 } = paginationDto;
    const distributorId = await this.resolveDistributor(distributor);

    const base: FindOptionsWhere<GasCylinder> = { isActive: true };
    if (distributorId) base.distributorId = distributorId;
    // `term` busca por tipo o descripción; las dos condiciones llevan el mismo
    // filtro de distribuidora, así el OR no abre el catálogo de otra.
    const term = paginationDto.term?.trim();
    const where = term
      ? [
          { ...base, type: ILike(`%${term}%`) },
          { ...base, description: ILike(`%${term}%`) },
        ]
      : base;

    const [gasCylinders, total] = await this.gasCylinderRepository.findAndCount(
      {
        where,
        relations: CON_PROMOCIONES,
        take: limit,
        skip: offset,
        order: { type: 'ASC' },
      },
    );

    return { gasCylinders, total, limit, offset };
  }

  /**
   * `distributorId` opcional: si viene, la garrafa debe pertenecer a ese tenant
   * (evita que un admin lea/edite productos de otra distribuidora). En rutas
   * públicas de lectura se pasa null y no se restringe por tenant.
   */
  async findOne(
    id: string,
    distributorId?: string | null,
  ): Promise<GasCylinder> {
    const where: FindOptionsWhere<GasCylinder> = { gasCylinderId: id };
    if (distributorId) where.distributorId = distributorId;

    const gasCylinder = await this.gasCylinderRepository.findOne({
      where,
      relations: CON_PROMOCIONES,
    });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder with ID: ${id} not found`);
    }

    return gasCylinder;
  }

  async findByType(type: string, distributor?: string): Promise<GasCylinder> {
    const distributorId = await this.resolveDistributor(distributor);
    const where: FindOptionsWhere<GasCylinder> = { type, isActive: true };
    if (distributorId) where.distributorId = distributorId;

    const gasCylinder = await this.gasCylinderRepository.findOne({
      where,
      relations: CON_PROMOCIONES,
    });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder type ${type} not found`);
    }

    return gasCylinder;
  }

  async update(
    id: string,
    updateGasCylinderDto: UpdateGasCylinderDto,
    distributorId: string,
  ): Promise<GasCylinder> {
    // Verifica pertenencia al tenant antes de editar.
    await this.findOne(id, distributorId);
    assertPromocionesSinRepetir(updateGasCylinderDto.promotions);

    // El stock no se edita acá: cambia con un ajuste, que deja el rastro en el
    // libro y mantiene el vendible igual al físico. Ignorarlo en silencio
    // dejaba al panel creyendo que lo había guardado.
    if (updateGasCylinderDto.stock !== undefined) {
      throw new BadRequestException(
        'El stock se cambia con un ajuste de stock (PATCH /gascylinder/{id}/stock o POST /stock/adjustments), no al editar el producto',
      );
    }
    const cambios = updateGasCylinderDto;
    const gasCylinder = await this.gasCylinderRepository.preload({
      gasCylinderId: id,
      ...cambios,
    });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder with ID: ${id} not found`);
    }
    this.sinEscribirElVendible(gasCylinder);

    // Si vinieron promociones, reemplazan a las anteriores (las que no están
    // en la lista se dan de baja: orphanedRowAction). Cambiarle el tipo al de otro
    // producto de la distribuidora choca con la unicidad: 409 (H-88).
    try {
      await this.gasCylinderRepository.save(gasCylinder);
    } catch (error) {
      return this.handleDBExceptions(error);
    }
    return this.findOne(id, distributorId);
  }

  /**
   * @deprecated Ninguna ruta lo usa: el ajuste manual del catálogo pasa por el
   * módulo de stock (`PATCH /gascylinder/:id/stock`), que mantiene el físico.
   * Cambiar el vendible por acá lo desalinea del físico.
   */
  async updateStock(
    id: string,
    quantity: number,
    distributorId: string,
  ): Promise<GasCylinder> {
    // Con el mismo lock que `reservarStock`: leer, sumar y guardar sin él
    // pisaba una reserva que se confirmara en el medio.
    await this.gasCylinderRepository.manager.transaction(async (manager) => {
      const gasCylinder = await manager
        .createQueryBuilder(GasCylinder, 'gc')
        .setLock('pessimistic_write')
        .where('gc.gasCylinderId = :id', { id })
        .andWhere('gc.distributorId = :distributorId', { distributorId })
        .getOne();
      if (!gasCylinder) {
        throw new NotFoundException(`Gas cylinder with ID: ${id} not found`);
      }
      if (gasCylinder.stock + quantity < 0) {
        throw new BadRequestException('Stock cannot be negative');
      }
      gasCylinder.stock += quantity;
      await manager.save(gasCylinder);
    });
    return this.findOne(id, distributorId);
  }

  /**
   * El ABM del catálogo nunca escribe `stock` ni `reservation_deficit`: los
   * mueven los pedidos y el módulo de stock bajo el lock de la fila. `save` de
   * una entidad leída antes volvería a escribir esos valores viejos y pisaría una
   * reserva o un recorte confirmados en el medio; con `undefined` TypeORM no los
   * incluye en el UPDATE.
   */
  private sinEscribirElVendible(gasCylinder: GasCylinder): void {
    Object.assign(gasCylinder, {
      stock: undefined,
      reservationDeficit: undefined,
    });
  }

  async remove(id: string, distributorId: string): Promise<BajaDeProductoDto> {
    const gasCylinder = await this.findOne(id, distributorId);
    gasCylinder.isActive = false;
    this.sinEscribirElVendible(gasCylinder);

    await this.gasCylinderRepository.save(gasCylinder);

    return {
      message: 'Gas cylinder deactivated successfully',
      gasCylinderId: id,
    };
  }

  async getAvailableCylinders(
    distributor?: string,
  ): Promise<{ products: GasCylinder[]; paymentMethods: MedioDePagoDto[] }> {
    const distributorId = await this.resolveDistributor(distributor);
    const where: FindOptionsWhere<GasCylinder> = {
      isActive: true,
      stock: MoreThan(0),
    };
    if (distributorId) where.distributorId = distributorId;

    const products = await this.gasCylinderRepository.find({
      where,
      relations: CON_PROMOCIONES,
      order: { type: 'ASC' },
    });

    return { products, paymentMethods: MEDIOS_DE_PAGO };
  }

  /**
   * Descuenta `quantity` de un producto dentro de la transacción de quien
   * llama: reservar el stock y guardar el pedido tienen que ser atómicos, por
   * eso recibe el `EntityManager` en lugar de abrir su propia transacción.
   * Toma un lock pesimista (SELECT ... FOR UPDATE) que serializa la lectura
   * con cualquier otra transacción sobre el mismo producto: evita vender más
   * de lo que hay. Devuelve el producto bloqueado, para que el pedido lea
   * precio y promociones.
   *
   * @throws GasCylinderNotFoundError si el producto no existe (404).
   * @throws InsufficientStockError si no alcanza el stock (400).
   */
  async reservarStock(
    manager: EntityManager,
    gasCylinderId: string,
    quantity: number,
  ): Promise<GasCylinder> {
    const gasCylinder = await this.bloquear(manager, gasCylinderId);
    if (!gasCylinder) {
      throw new GasCylinderNotFoundError(gasCylinderId);
    }
    if (gasCylinder.stock < quantity) {
      throw new InsufficientStockError(gasCylinder.type);
    }
    gasCylinder.stock -= quantity;
    await manager.save(gasCylinder);
    // Postgres no admite FOR UPDATE con un join externo: las promociones,
    // que el pedido necesita para el precio, se leen después del lock.
    gasCylinder.promotions = await manager.find(GasCylinderPromotion, {
      where: { gasCylinderId },
    });
    return gasCylinder;
  }

  /**
   * El producto bloqueado (`FOR UPDATE`) con sus promociones, SIN tocar el
   * stock: para repreciar los renglones de un pedido cuya reserva ya se ajustó
   * con `reajustarReserva`.
   *
   * @throws GasCylinderNotFoundError si el producto no existe (404).
   */
  async leerBloqueada(
    manager: EntityManager,
    gasCylinderId: string,
  ): Promise<GasCylinder> {
    const gasCylinder = await this.bloquear(manager, gasCylinderId);
    if (!gasCylinder) throw new GasCylinderNotFoundError(gasCylinderId);
    gasCylinder.promotions = await manager.find(GasCylinderPromotion, {
      where: { gasCylinderId },
    });
    return gasCylinder;
  }

  /**
   * Edición de un pedido: ajusta la reserva por la DIFERENCIA NETA de cada
   * garrafa entre los renglones que tenía y los nuevos, bajo el lock de cada una
   * (por id ascendente). Pedir más reserva sólo el aumento (400 si no alcanza el
   * vendible); pedir menos devuelve sólo lo que sobra, cubriendo primero el
   * déficit de reservas; igual no toca nada. Devolver todo y volver a reservar
   * fallaba cuando la garrafa tenía déficit: lo devuelto cubría el déficit y no
   * volvía a ser vendible, y la nueva reserva ya no encontraba stock.
   *
   * @throws InsufficientStockError si el aumento no alcanza (400).
   * @throws GasCylinderNotFoundError si un renglón nuevo es de un producto que no existe (404).
   */
  async reajustarReserva(
    manager: EntityManager,
    anteriores: ReadonlyArray<MovimientoDeStock>,
    nuevos: ReadonlyArray<MovimientoDeStock>,
  ): Promise<void> {
    const neto = new Map<string, number>();
    for (const i of nuevos)
      neto.set(i.gasCylinderId, (neto.get(i.gasCylinderId) ?? 0) + i.quantity);
    for (const i of anteriores)
      neto.set(i.gasCylinderId, (neto.get(i.gasCylinderId) ?? 0) - i.quantity);
    const ids = [...neto.keys()].sort((a, b) => a.localeCompare(b));
    for (const id of ids) {
      const delta = neto.get(id)!;
      if (delta === 0) continue;
      const gasCylinder = await this.bloquear(manager, id);
      if (!gasCylinder) {
        // Un producto que ya no existe se ignora al devolver (como `restituirStock`).
        if (delta > 0) throw new GasCylinderNotFoundError(id);
        continue;
      }
      if (delta > 0) {
        if (gasCylinder.stock < delta) {
          throw new InsufficientStockError(gasCylinder.type);
        }
        gasCylinder.stock -= delta;
      } else {
        const cubierto = Math.min(gasCylinder.reservationDeficit, -delta);
        gasCylinder.reservationDeficit -= cubierto;
        gasCylinder.stock += -delta - cubierto;
      }
      await manager.save(gasCylinder);
    }
  }

  /**
   * Devuelve el stock de los ítems de un pedido cancelado, en la transacción
   * de quien llama y con el mismo lock. Un producto que ya no existe se
   * ignora: el pedido se cancela igual.
   */
  async restituirStock(
    manager: EntityManager,
    items: MovimientoDeStock[],
  ): Promise<void> {
    // Siempre en el mismo orden (por id) para no cruzar locks con otra
    // transacción que reserva las mismas garrafas.
    const ordenados = [...items].sort((a, b) =>
      a.gasCylinderId.localeCompare(b.gasCylinderId),
    );
    for (const item of ordenados) {
      const gasCylinder = await this.bloquear(manager, item.gasCylinderId);
      if (gasCylinder) {
        // Lo que se libera cubre primero las reservas que el físico no cubría:
        // sólo el resto vuelve a ser vendible.
        const cubierto = Math.min(
          gasCylinder.reservationDeficit,
          item.quantity,
        );
        gasCylinder.reservationDeficit -= cubierto;
        gasCylinder.stock += item.quantity - cubierto;
        await manager.save(gasCylinder);
      }
    }
  }

  /**
   * Suma o resta unidades al stock VENDIBLE (`gas_cylinder.stock`) dentro de la
   * transacción de quien llama. Lo usa el módulo de stock para que el vendible
   * siga al físico (recepción, ajuste, merma, conteo): el vendible es lo que el
   * pedido reserva, así que es la misma fila y el mismo lock pesimista que
   * `reservarStock`. Los ids se bloquean siempre en orden ascendente.
   *
   * Con `recortarEnCero` (modo "el físico manda") el vendible nunca queda negativo
   * pero tampoco frena la operación. Una baja que lo llevaría por debajo de cero
   * lo deja en cero y suma lo que faltó a `reservationDeficit` (reservas que el
   * físico no cubre). Un alta (hallazgo, recepción, cancelación) cubre primero
   * ese déficit y sólo el resto sube el vendible. Así el vendible siempre es
   * `max(0, llenas − reservadas)`, sin sobreventa al cancelar después de un
   * recorte. Sin la opción el cambio es exacto y estricto.
   *
   * @throws GasCylinderNotFoundError si el producto no existe o es de otra
   *   distribuidora (404).
   * @throws VendibleInsuficienteError (400) si el vendible quedaría negativo y no
   *   se pidió `recortarEnCero`: lo que falta está reservado por pedidos abiertos.
   * @returns las garrafas cuyo vendible se recortó, con lo que faltó.
   */
  async ajustarVendible(
    manager: EntityManager,
    distributorId: string,
    cambios: ReadonlyArray<{ gasCylinderId: string; delta: number }>,
    opciones: { recortarEnCero?: boolean } = {},
  ): Promise<Array<{ gasCylinderId: string; type: string; faltante: number }>> {
    const recortes: Array<{
      gasCylinderId: string;
      type: string;
      faltante: number;
    }> = [];
    const ordenados = [...cambios].sort((a, b) =>
      a.gasCylinderId.localeCompare(b.gasCylinderId),
    );
    for (const { gasCylinderId, delta } of ordenados) {
      const gasCylinder = await this.bloquear(manager, gasCylinderId);
      if (!gasCylinder || gasCylinder.distributorId !== distributorId) {
        throw new GasCylinderNotFoundError(gasCylinderId);
      }
      let resultado = gasCylinder.stock + delta;
      if (opciones.recortarEnCero && delta > 0) {
        const cubierto = Math.min(gasCylinder.reservationDeficit, delta);
        gasCylinder.reservationDeficit -= cubierto;
        resultado -= cubierto;
      }
      if (resultado < 0) {
        if (!opciones.recortarEnCero) {
          throw new VendibleInsuficienteError(
            gasCylinder.type,
            gasCylinder.stock,
          );
        }
        recortes.push({
          gasCylinderId,
          type: gasCylinder.type,
          faltante: -resultado,
        });
        gasCylinder.reservationDeficit += -resultado;
        gasCylinder.stock = 0;
      } else {
        gasCylinder.stock = resultado;
      }
      await manager.save(gasCylinder);
    }
    return recortes;
  }

  /** Costo promedio ponderado vigente del producto (`null` si nunca se compró). */
  async costoPromedio(
    manager: EntityManager,
    distributorId: string,
    gasCylinderId: string,
  ): Promise<number | null> {
    const filas: Array<{ average_unit_cost: string | null }> =
      await manager.query(
        `SELECT "average_unit_cost" FROM "gas_cylinder"
         WHERE "gas_cylinder_id" = $1 AND "distributor_id" = $2`,
        [gasCylinderId, distributorId],
      );
    if (filas.length === 0) throw new GasCylinderNotFoundError(gasCylinderId);
    const costo = filas[0].average_unit_cost;
    return costo === null ? null : Number(costo);
  }

  /**
   * Fija el costo promedio ponderado. Lo llama la recepción de compras en la
   * transacción donde ya tiene el lock de `gas_cylinder` (lo toma el ledger al
   * subir las llenas).
   */
  async fijarCostoPromedio(
    manager: EntityManager,
    distributorId: string,
    gasCylinderId: string,
    costo: number | null,
  ): Promise<void> {
    const filas: unknown[] = await manager.query(
      `UPDATE "gas_cylinder" SET "average_unit_cost" = $3
       WHERE "gas_cylinder_id" = $1 AND "distributor_id" = $2
       RETURNING 1`,
      [gasCylinderId, distributorId, costo],
    );
    if (filas.length === 0) throw new GasCylinderNotFoundError(gasCylinderId);
  }

  /**
   * Toma el lock de varios productos de una sola vez, siempre por id
   * ascendente. Una operación que primero devuelve y después reserva (la
   * edición de un pedido) la llama con la unión de ids viejos y nuevos antes
   * de tocar nada: así ningún orden parcial se cruza con otra transacción.
   * Los ids que no existen se ignoran (los resuelve quien reserva).
   */
  async bloquearEnOrden(
    manager: EntityManager,
    gasCylinderIds: string[],
  ): Promise<void> {
    const ids = [...new Set(gasCylinderIds)].sort((a, b) => a.localeCompare(b));
    for (const id of ids) {
      await this.bloquear(manager, id);
    }
  }

  private bloquear(
    manager: EntityManager,
    gasCylinderId: string,
  ): Promise<GasCylinder | null> {
    return manager
      .createQueryBuilder(GasCylinder, 'gc')
      .setLock('pessimistic_write')
      .where('gc.gasCylinderId = :id', { id: gasCylinderId })
      .getOne();
  }

  /**
   * Delega en el traductor compartido. Antes cada servicio tenia su propia
   * copia: contemplaban uno o dos codigos de Postgres y convertian todo lo
   * demas en un 500 sin registrar la causa, asi que el mensaje mandaba a
   * mirar unos logs donde el error no estaba.
   */
  private handleDBExceptions(error: unknown): never {
    return traducirErrorDeBase(error, this.logger, 'productos');
  }
}

/** Dos promociones para la misma cantidad serían ambiguas: 400. */
function assertPromocionesSinRepetir(promociones?: PromocionDto[]): void {
  if (!promociones) return;
  const cantidades = promociones.map((p) => p.quantity);
  if (new Set(cantidades).size !== cantidades.length) {
    throw new BadRequestException(
      'Hay dos promociones para la misma cantidad de unidades',
    );
  }
}
