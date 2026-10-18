import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import {
  CashSystemCode,
  CATEGORIAS_DE_SISTEMA,
  CategoryDirection,
} from '../domain/cash.enums';
import { CategoriaNoEncontradaError } from '../domain/errors/cash.errors';
import {
  CreateCashCategoryDto,
  QueryCashCategoryDto,
  UpdateCashCategoryDto,
} from '../dto/cash-category.dto';
import { CashCategory } from '../entities/cash-category.entity';

/** Categorías de ingresos y gastos de la distribuidora (CU-230, CU-265). */
@Injectable()
export class CashCategoryService {
  private readonly logger = new Logger(CashCategoryService.name);

  constructor(
    @InjectRepository(CashCategory)
    private readonly categorias: Repository<CashCategory>,
  ) {}

  async findAll(
    distributorId: string,
    query: QueryCashCategoryDto,
  ): Promise<{ data: CashCategory[]; total: number }> {
    const limit = query.limit ?? 100;
    const qb = this.categorias
      .createQueryBuilder('c')
      .where('c.distributorId = :distributorId', { distributorId });
    if (!query.includeInactive) qb.andWhere('c.isActive = true');
    if (query.direction) {
      qb.andWhere('c.direction = :direction', { direction: query.direction });
    }
    const term = query.term?.trim();
    if (term) qb.andWhere('c.name ILIKE :term', { term: `%${term}%` });
    const [data, total] = await qb
      .orderBy('c.direction', 'ASC')
      .addOrderBy('c.name', 'ASC')
      .skip(((query.page ?? 1) - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total };
  }

  async findOne(id: string, distributorId: string): Promise<CashCategory> {
    const categoria = await this.categorias.findOne({
      where: { categoryId: id, distributorId },
    });
    if (!categoria) throw new CategoriaNoEncontradaError(id);
    return categoria;
  }

  async create(
    dto: CreateCashCategoryDto,
    distributorId: string,
  ): Promise<CashCategory> {
    await this.asegurarNombreLibre(
      dto.name,
      dto.direction,
      distributorId,
      null,
    );
    try {
      return await this.categorias.save(
        this.categorias.create({
          distributorId,
          name: dto.name,
          direction: dto.direction,
          systemCode: null,
        }),
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'categorías de caja');
    }
  }

  async update(
    id: string,
    dto: UpdateCashCategoryDto,
    distributorId: string,
  ): Promise<CashCategory> {
    const categoria = await this.findOne(id, distributorId);
    this.asegurarNoEsDeSistema(categoria);
    const nombre = dto.name ?? categoria.name;
    const activa = dto.isActive ?? categoria.isActive;
    if (activa && (dto.name !== undefined || !categoria.isActive)) {
      await this.asegurarNombreLibre(
        nombre,
        categoria.direction,
        distributorId,
        id,
      );
    }
    categoria.name = nombre;
    categoria.isActive = activa;
    try {
      return await this.categorias.save(categoria);
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'categorías de caja');
    }
  }

  /** `DELETE` es una desactivación (la categoría queda en los movimientos viejos). */
  async deactivate(id: string, distributorId: string): Promise<CashCategory> {
    const categoria = await this.findOne(id, distributorId);
    this.asegurarNoEsDeSistema(categoria);
    categoria.isActive = false;
    return this.categorias.save(categoria);
  }

  /**
   * La categoría de sistema de la distribuidora; si todavía no está sembrada
   * (distribuidora creada antes de la caja) se siembra en el acto.
   */
  async deSistema(
    manager: EntityManager,
    distributorId: string,
    code: CashSystemCode,
  ): Promise<CashCategory> {
    const buscar = () =>
      manager.findOne(CashCategory, {
        where: { distributorId, systemCode: code },
      });
    const existente = await buscar();
    if (existente) return existente;
    await this.sembrarDeSistema(manager, distributorId);
    const sembrada = await buscar();
    if (!sembrada) throw new CategoriaNoEncontradaError(code);
    return sembrada;
  }

  /** Siembra las categorías de sistema que falten (idempotente). */
  async sembrarDeSistema(
    manager: EntityManager,
    distributorId: string,
  ): Promise<void> {
    for (const c of CATEGORIAS_DE_SISTEMA) {
      await manager.query(
        `INSERT INTO "cash_category" ("distributor_id", "name", "direction", "system_code")
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (
           SELECT 1 FROM "cash_category" WHERE "distributor_id" = $1 AND "system_code" = $4
         )
         ON CONFLICT DO NOTHING`,
        [distributorId, c.name, c.direction, c.code],
      );
    }
  }

  private asegurarNoEsDeSistema(categoria: CashCategory): void {
    if (categoria.systemCode) {
      throw new ConflictException(
        `"${categoria.name}" es una categoría de sistema: no se edita ni se desactiva`,
      );
    }
  }

  private async asegurarNombreLibre(
    nombre: string,
    direction: CategoryDirection,
    distributorId: string,
    excluirId: string | null,
  ): Promise<void> {
    const existente = await this.categorias
      .createQueryBuilder('c')
      .where('c.distributorId = :distributorId', { distributorId })
      .andWhere('c.direction = :direction', { direction })
      .andWhere('c.isActive = true')
      .andWhere('LOWER(c.name) = LOWER(:nombre)', { nombre })
      .getOne();
    if (existente && existente.categoryId !== excluirId) {
      throw new ConflictException(
        `Ya hay una categoría activa "${existente.name}" de ${direction === CategoryDirection.INCOME ? 'ingresos' : 'gastos'}`,
      );
    }
  }
}
