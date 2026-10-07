import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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
  ) {}

  /**
   * Resuelve un `distributor_id` a partir de un slug o uuid. Usado por los
   * endpoints públicos del catálogo, donde el tenant llega por query
   * `?distributor=` (el guard no corre en rutas @Public).
   *
   * Compatibilidad hacia atrás: si NO se pasa distribuidora, cae a la default
   * (Jeny Gas) en vez de mezclar catálogos de todos los tenants — así la app
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
      return await this.gasCylinderRepository.save(gasCylinder);
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

    const gasCylinder = await this.gasCylinderRepository.preload({
      gasCylinderId: id,
      ...updateGasCylinderDto,
    });

    if (!gasCylinder) {
      throw new NotFoundException(`Gas cylinder with ID: ${id} not found`);
    }

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

  async remove(id: string, distributorId: string): Promise<BajaDeProductoDto> {
    const gasCylinder = await this.findOne(id, distributorId);
    gasCylinder.isActive = false;

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
   * Devuelve el stock de los ítems de un pedido cancelado, en la transacción
   * de quien llama y con el mismo lock. Un producto que ya no existe se
   * ignora: el pedido se cancela igual.
   */
  async restituirStock(
    manager: EntityManager,
    items: MovimientoDeStock[],
  ): Promise<void> {
    for (const item of items) {
      const gasCylinder = await this.bloquear(manager, item.gasCylinderId);
      if (gasCylinder) {
        gasCylinder.stock += item.quantity;
        await manager.save(gasCylinder);
      }
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
