import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import { ProveedorNoEncontradoError } from '../domain/errors/purchase.errors';
import { PurchaseOrderStatus } from '../domain/purchase.enums';
import {
  CreateSupplierDto,
  QuerySupplierDto,
  UpdateSupplierDto,
} from '../dto/supplier.dto';
import { Supplier } from '../entities/supplier.entity';

const ESTADOS_ABIERTOS = [
  PurchaseOrderStatus.DRAFT,
  PurchaseOrderStatus.SENT,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
];

/** ABM de proveedores de la distribuidora, con baja lógica. */
@Injectable()
export class SupplierService {
  private readonly logger = new Logger(SupplierService.name);

  constructor(
    @InjectRepository(Supplier)
    private readonly suppliers: Repository<Supplier>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async create(
    dto: CreateSupplierDto,
    distributorId: string,
  ): Promise<Supplier> {
    await this.asegurarCuitLibre(dto.cuit, distributorId, null);
    try {
      return await this.suppliers.save(
        this.suppliers.create({
          distributorId,
          businessName: dto.businessName,
          cuit: dto.cuit,
          kind: dto.kind,
          contactName: dto.contactName ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          address: dto.address ?? null,
          paymentTermsDays: dto.paymentTermsDays ?? null,
        }),
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'proveedores');
    }
  }

  async findAll(
    distributorId: string,
    query: QuerySupplierDto,
  ): Promise<{ data: Supplier[]; total: number }> {
    const limit = query.limit ?? 10;
    const qb = this.suppliers
      .createQueryBuilder('s')
      .where('s.distributorId = :distributorId', { distributorId });
    if (!query.includeInactive) qb.andWhere('s.isActive = true');
    if (query.kind) qb.andWhere('s.kind = :kind', { kind: query.kind });
    const term = query.term?.trim();
    if (term) {
      qb.andWhere(
        new Brackets((w) =>
          w
            .where('s.businessName ILIKE :term', { term: `%${term}%` })
            .orWhere('s.cuit LIKE :cuit', {
              cuit: `%${term.replace(/-/g, '')}%`,
            }),
        ),
      );
    }
    const [data, total] = await qb
      .orderBy('s.businessName', 'ASC')
      .addOrderBy('s.supplierId', 'ASC')
      .skip(((query.page ?? 1) - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total };
  }

  /** `conBajas`: también los dados de baja (para ver su historial). */
  async findOne(
    id: string,
    distributorId: string,
    conBajas = false,
  ): Promise<Supplier> {
    const proveedor = await this.suppliers.findOne({
      where: { supplierId: id, distributorId },
      withDeleted: conBajas,
    });
    if (!proveedor) throw new ProveedorNoEncontradoError(id);
    return proveedor;
  }

  async update(
    id: string,
    dto: UpdateSupplierDto,
    distributorId: string,
  ): Promise<Supplier> {
    const proveedor = await this.findOne(id, distributorId);
    if (dto.cuit !== undefined && dto.cuit !== proveedor.cuit) {
      await this.asegurarCuitLibre(dto.cuit, distributorId, id);
    }
    const { cuit, businessName, kind, isActive } = dto;
    if (cuit !== undefined) proveedor.cuit = cuit;
    if (businessName !== undefined) proveedor.businessName = businessName;
    if (kind !== undefined) proveedor.kind = kind;
    if (isActive !== undefined) proveedor.isActive = isActive;
    if (dto.contactName !== undefined) proveedor.contactName = dto.contactName;
    if (dto.phone !== undefined) proveedor.phone = dto.phone;
    if (dto.email !== undefined) proveedor.email = dto.email;
    if (dto.address !== undefined) proveedor.address = dto.address;
    if (dto.paymentTermsDays !== undefined) {
      proveedor.paymentTermsDays = dto.paymentTermsDays;
    }
    try {
      return await this.suppliers.save(proveedor);
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'proveedores');
    }
  }

  /**
   * Baja lógica. Bajo lock del proveedor: una orden que se está armando en este
   * momento lo tiene bloqueado `FOR SHARE` y la baja espera su commit, así que
   * la cuenta de órdenes abiertas ya la incluye.
   */
  async remove(id: string, distributorId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const [fila]: Array<{ supplier_id: string }> = await manager.query(
        `SELECT "supplier_id" FROM "supplier"
         WHERE "supplier_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL
         FOR UPDATE`,
        [id, distributorId],
      );
      if (!fila) throw new ProveedorNoEncontradoError(id);
      const [{ abiertas }]: Array<{ abiertas: number }> = await manager.query(
        `SELECT COUNT(*)::int AS abiertas FROM "purchase_order"
         WHERE "supplier_id" = $1 AND "status"::text = ANY($2::text[])`,
        [id, ESTADOS_ABIERTOS],
      );
      if (abiertas > 0) {
        throw new ConflictException(
          `El proveedor tiene ${abiertas} orden(es) de compra abierta(s): cancelalas o recibilas antes de darlo de baja`,
        );
      }
      const proveedor = await manager.getRepository(Supplier).findOneByOrFail({
        supplierId: id,
      });
      await manager.getRepository(Supplier).softRemove(proveedor);
    });
  }

  /**
   * Proveedor vigente y activo para armar una orden o recibir. El lock
   * `FOR SHARE` frena su baja mientras se usa. 404 si no existe o es de otra
   * distribuidora; 400 si está inactivo.
   */
  async bloquearUsable(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<void> {
    const [fila]: Array<{ is_active: boolean }> = await manager.query(
      `SELECT "is_active" FROM "supplier"
       WHERE "supplier_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL
       FOR SHARE`,
      [id, distributorId],
    );
    if (!fila) throw new ProveedorNoEncontradoError(id);
    if (!fila.is_active) {
      throw new BadRequestException(
        'El proveedor está inactivo: activalo para comprarle',
      );
    }
  }

  private async asegurarCuitLibre(
    cuit: string,
    distributorId: string,
    excluirId: string | null,
  ): Promise<void> {
    const existente = await this.suppliers.findOne({
      where: { distributorId, cuit },
    });
    if (existente && existente.supplierId !== excluirId) {
      throw new ConflictException(
        `Ya hay un proveedor vigente con el CUIT ${cuit}: ${existente.businessName}`,
      );
    }
  }
}
