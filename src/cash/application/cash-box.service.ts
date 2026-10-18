import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import { dec } from '../../common/utils/dinero';
import {
  CashBoxKind,
  CashSessionStatus,
  NOMBRE_CAJA_CENTRAL,
} from '../domain/cash.enums';
import { requiereSesionPorOmision } from '../domain/cash-rules';
import { CajaNoEncontradaError } from '../domain/errors/cash.errors';
import {
  CreateCashBoxDto,
  QueryCashBoxDto,
  UpdateCashBoxDto,
} from '../dto/cash-box.dto';
import { CashBox } from '../entities/cash-box.entity';
import { CashSession } from '../entities/cash-session.entity';
import { CashCategoryService } from './cash-category.service';

export interface CajaConSesion {
  caja: CashBox;
  openSessionId: string | null;
}

/** ABM de cajas de la distribuidora (CU-225, CU-264). */
@Injectable()
export class CashBoxService {
  private readonly logger = new Logger(CashBoxService.name);

  constructor(
    @InjectRepository(CashBox) private readonly cajas: Repository<CashBox>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly categorias: CashCategoryService,
  ) {}

  async findAll(
    distributorId: string,
    query: QueryCashBoxDto,
  ): Promise<{ data: CajaConSesion[]; total: number }> {
    const limit = query.limit ?? 100;
    const qb = this.cajas
      .createQueryBuilder('c')
      .where('c.distributorId = :distributorId', { distributorId });
    if (!query.includeInactive) qb.andWhere('c.isActive = true');
    if (query.kind) qb.andWhere('c.kind = :kind', { kind: query.kind });
    const term = query.term?.trim();
    if (term) qb.andWhere('c.name ILIKE :term', { term: `%${term}%` });
    const [cajas, total] = await qb
      .orderBy('c.name', 'ASC')
      .skip(((query.page ?? 1) - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const sesiones = await this.sesionesAbiertas(cajas.map((c) => c.cashBoxId));
    return {
      data: cajas.map((caja) => ({
        caja,
        openSessionId: sesiones.get(caja.cashBoxId) ?? null,
      })),
      total,
    };
  }

  async findOne(id: string, distributorId: string): Promise<CajaConSesion> {
    const caja = await this.cajas.findOne({
      where: { cashBoxId: id, distributorId },
    });
    if (!caja) throw new CajaNoEncontradaError(id);
    const sesiones = await this.sesionesAbiertas([id]);
    return { caja, openSessionId: sesiones.get(id) ?? null };
  }

  async create(
    dto: CreateCashBoxDto,
    distributorId: string,
  ): Promise<CajaConSesion> {
    await this.asegurarNombreLibre(dto.name, distributorId, null);
    try {
      const caja = await this.cajas.save(
        this.cajas.create({
          distributorId,
          name: dto.name,
          kind: dto.kind,
          balance: 0,
          requiresSession:
            dto.requiresSession ?? requiereSesionPorOmision(dto.kind),
        }),
      );
      return { caja, openSessionId: null };
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'cajas');
    }
  }

  async update(
    id: string,
    dto: UpdateCashBoxDto,
    distributorId: string,
  ): Promise<CajaConSesion> {
    return this.dataSource.transaction(async (manager) => {
      const [fila]: Array<{ cash_box_id: string }> = await manager.query(
        `SELECT "cash_box_id" FROM "cash_box"
         WHERE "cash_box_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL
         FOR UPDATE`,
        [id, distributorId],
      );
      if (!fila) throw new CajaNoEncontradaError(id);
      const caja = await manager.findOneByOrFail(CashBox, { cashBoxId: id });
      const abierta = await manager.findOne(CashSession, {
        where: { cashBoxId: id, status: CashSessionStatus.OPEN },
      });
      if (abierta && dto.isActive === false) {
        throw new ConflictException(
          'La caja tiene una sesión abierta: cerrala con el arqueo antes de desactivarla',
        );
      }
      if (
        dto.isActive === false &&
        caja.isActive &&
        !dec(caja.balance).isZero()
      ) {
        throw new ConflictException(
          `La caja tiene un saldo de ${dec(caja.balance).toFixed(2)}: transferilo a otra caja o ajustalo a cero antes de desactivarla`,
        );
      }
      if (
        abierta &&
        dto.requiresSession !== undefined &&
        dto.requiresSession !== caja.requiresSession
      ) {
        throw new ConflictException(
          'La caja tiene una sesión abierta: cerrala antes de cambiar si exige sesión',
        );
      }
      if (dto.name !== undefined && dto.name !== caja.name) {
        await this.asegurarNombreLibre(dto.name, distributorId, id, manager);
        caja.name = dto.name;
      }
      if (dto.isActive !== undefined) caja.isActive = dto.isActive;
      if (dto.requiresSession !== undefined) {
        caja.requiresSession = dto.requiresSession;
      }
      try {
        const guardada = await manager.save(caja);
        return { caja: guardada, openSessionId: abierta?.sessionId ?? null };
      } catch (error) {
        return traducirErrorDeBase(error, this.logger, 'cajas');
      }
    });
  }

  /** "Caja central" de efectivo de la distribuidora si no tiene ninguna caja. */
  async asegurarCajaCentral(
    manager: EntityManager,
    distributorId: string,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "cash_box" ("distributor_id", "name", "kind", "requires_session")
       SELECT $1, $2, $3, true
       WHERE NOT EXISTS (
         SELECT 1 FROM "cash_box" WHERE "distributor_id" = $1 AND "deletedAt" IS NULL
       )`,
      [distributorId, NOMBRE_CAJA_CENTRAL, CashBoxKind.CASH],
    );
    await this.categorias.sembrarDeSistema(manager, distributorId);
  }

  /** Saldos y sesiones abiertas para el tablero financiero (CU-245). */
  async resumenParaTablero(distributorId: string): Promise<
    Array<{
      cashBoxId: string;
      name: string;
      kind: CashBoxKind;
      balance: number;
      hasOpenSession: boolean;
    }>
  > {
    // Una caja desactivada que todavía tiene saldo sigue siendo plata de la
    // distribuidora: entra en el total.
    const { data: todas } = await this.findAll(distributorId, {
      limit: 100,
      page: 1,
      includeInactive: true,
    });
    const data = todas.filter(
      ({ caja }) => caja.isActive || !dec(caja.balance).isZero(),
    );
    return data.map(({ caja, openSessionId }) => ({
      cashBoxId: caja.cashBoxId,
      name: caja.name,
      kind: caja.kind,
      balance: caja.balance,
      hasOpenSession: openSessionId !== null,
    }));
  }

  private async sesionesAbiertas(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const filas: Array<{ cash_box_id: string; session_id: string }> =
      await this.dataSource.query(
        `SELECT "cash_box_id", "session_id" FROM "cash_session"
         WHERE "cash_box_id" = ANY($1::uuid[]) AND "status" = 'open'`,
        [ids],
      );
    return new Map(filas.map((f) => [f.cash_box_id, f.session_id]));
  }

  private async asegurarNombreLibre(
    nombre: string,
    distributorId: string,
    excluirId: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(CashBox) : this.cajas;
    const existente = await repo
      .createQueryBuilder('c')
      .where('c.distributorId = :distributorId', { distributorId })
      .andWhere('LOWER(c.name) = LOWER(:nombre)', { nombre })
      .getOne();
    if (existente && existente.cashBoxId !== excluirId) {
      throw new ConflictException(
        `Ya hay una caja vigente con el nombre "${existente.name}"`,
      );
    }
  }
}
