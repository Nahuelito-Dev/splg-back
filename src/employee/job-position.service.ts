import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Not, Repository } from 'typeorm';
import {
  JobPosition,
  JobPositionCategory,
} from './entities/job-position.entity';
import { Employee, EmployeeStatus } from './entities/employee.entity';
import {
  CreateJobPositionDto,
  UpdateJobPositionDto,
} from './dto/create-job-position.dto';
import { BASE_POSITION_DEFINITIONS } from './domain/base-positions';
import { rolDeAcceso } from './domain/access-role';
import { UsersService } from '../users/users.service';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { MessageResponseDto } from '../common/dtos/message-response.dto';

/** Categorías de las que depende el alta de personal con cuenta: nunca se quedan sin un puesto activo. */
const CATEGORIAS_PROTEGIDAS = [
  JobPositionCategory.DRIVER,
  JobPositionCategory.ADMINISTRATION,
];

export interface PuestoConConteo {
  puesto: JobPosition;
  activeEmployees: number;
}

/** Puestos de trabajo (CU-176). Siempre dentro de una distribuidora: lo de otra es 404. */
@Injectable()
export class JobPositionService {
  private readonly logger = new Logger(JobPositionService.name);

  constructor(
    @InjectRepository(JobPosition)
    private readonly positions: Repository<JobPosition>,
    @InjectRepository(Employee)
    private readonly employees: Repository<Employee>,
    private readonly users: UsersService,
    private readonly dataSource: DataSource,
  ) {}

  /** consultarPuestosDeTrabajo: los vigentes con su cantidad de empleados activos. */
  async findAll(distributorId: string): Promise<PuestoConConteo[]> {
    const puestos = await this.positions.find({
      where: { distributorId },
      order: { name: 'ASC' },
    });
    const conteo = await this.contarActivosPorPuesto(distributorId);
    return puestos.map((puesto) => ({
      puesto,
      activeEmployees: conteo.get(puesto.positionId) ?? 0,
    }));
  }

  async create(
    dto: CreateJobPositionDto,
    distributorId: string,
  ): Promise<PuestoConConteo> {
    await this.assertNombreDisponible(distributorId, dto.name);
    const puesto = await this.guardar(
      this.positions.create({
        distributorId,
        name: dto.name,
        category: dto.category,
        isActive: dto.isActive ?? true,
      }),
    );
    return { puesto, activeEmployees: 0 };
  }

  async update(
    id: string,
    dto: UpdateJobPositionDto,
    distributorId: string,
  ): Promise<PuestoConConteo> {
    return this.enTransaccion(async (manager) => {
      await this.bloquearPuestos(manager, distributorId, id);
      const repo = manager.getRepository(JobPosition);
      const puesto = await this.vigente(manager, id, distributorId);
      if (dto.name !== undefined && dto.name !== puesto.name) {
        await this.assertNombreDisponible(distributorId, dto.name, id);
      }
      const categoria = dto.category ?? puesto.category;
      const activo = dto.isActive ?? puesto.isActive;
      if (categoria !== puesto.category) {
        await this.assertCategoriaCompatibleConLasCuentas(
          manager,
          puesto,
          categoria,
        );
      }
      if (
        puesto.isActive &&
        CATEGORIAS_PROTEGIDAS.includes(puesto.category) &&
        (!activo || categoria !== puesto.category)
      ) {
        await this.assertNoEsElUltimoActivo(manager, puesto);
      }
      if (dto.name !== undefined) puesto.name = dto.name;
      puesto.category = categoria;
      puesto.isActive = activo;
      await repo.save(puesto);
      return {
        puesto,
        activeEmployees: await manager.getRepository(Employee).count({
          where: { positionId: id, status: EmployeeStatus.ACTIVE },
        }),
      };
    });
  }

  /** eliminarPuestoDeTrabajo: baja lógica; 409 si todavía lo ocupa alguien. */
  async remove(id: string, distributorId: string): Promise<MessageResponseDto> {
    return this.enTransaccion(async (manager) => {
      await this.bloquearPuestos(manager, distributorId, id);
      const puesto = await this.vigente(manager, id, distributorId);
      const empleados = manager.getRepository(Employee);
      const activos = await empleados.count({
        where: { positionId: id, status: EmployeeStatus.ACTIVE },
      });
      if (activos > 0) {
        throw new ConflictException(
          `El puesto "${puesto.name}" lo ocupan ${activos} empleado(s) activo(s): reasignalos antes de eliminarlo`,
        );
      }
      // Un legajo egresado sigue apuntando a su puesto: borrarlo lo dejaría sin él.
      const legajos = await empleados.count({ where: { positionId: id } });
      if (legajos > 0) {
        throw new ConflictException(
          `El puesto "${puesto.name}" figura en ${legajos} legajo(s), también egresados: desactivalo (isActive=false) en vez de eliminarlo`,
        );
      }
      if (puesto.isActive && CATEGORIAS_PROTEGIDAS.includes(puesto.category)) {
        await this.assertNoEsElUltimoActivo(manager, puesto);
      }
      await manager.getRepository(JobPosition).softRemove(puesto);
      return MessageResponseDto.of('Puesto eliminado');
    });
  }

  /**
   * Orden de locks de los puestos: el puesto y los demás de categoría chofer
   * o administración de la distribuidora (los que cuentan para "el último
   * activo"), ordenados por id. Un alta de legajo toma el puesto con
   * `FOR SHARE`, así que un borrado concurrente espera y después ve al nuevo
   * ocupante.
   */
  private async bloquearPuestos(
    manager: EntityManager,
    distributorId: string,
    id: string,
  ): Promise<void> {
    await manager.query(
      `SELECT "position_id" FROM "job_position"
       WHERE "distributor_id" = $1 AND "deletedAt" IS NULL
         AND ("position_id" = $2 OR "category" = ANY($3::job_position_category_enum[]))
       ORDER BY "position_id"
       FOR UPDATE`,
      [distributorId, id, CATEGORIAS_PROTEGIDAS],
    );
  }

  private async enTransaccion<T>(
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await withTransactionRetry(() => this.dataSource.transaction(fn), {
        context: 'puesto de trabajo',
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'puesto de trabajo');
    }
  }

  private async vigente(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<JobPosition> {
    const puesto = await manager
      .getRepository(JobPosition)
      .findOne({ where: { positionId: id, distributorId } });
    if (!puesto) {
      throw new NotFoundException(`Puesto ${id} no encontrado`);
    }
    return puesto;
  }

  async findOne(id: string, distributorId: string): Promise<JobPosition> {
    const puesto = await this.positions.findOne({
      where: { positionId: id, distributorId },
    });
    if (!puesto) {
      throw new NotFoundException(`Puesto ${id} no encontrado`);
    }
    return puesto;
  }

  /** El puesto para asignarlo a un empleado: existe, es de la distribuidora y está activo. */
  async findAsignable(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<JobPosition> {
    const puesto = await manager.getRepository(JobPosition).findOne({
      where: { positionId: id, distributorId },
      // Lock compartido: un borrado o desactivación concurrente espera a
      // que este legajo termine y entonces ve a su ocupante.
      lock: { mode: 'pessimistic_read' },
    });
    if (!puesto) {
      throw new NotFoundException(`Puesto ${id} no encontrado`);
    }
    if (!puesto.isActive) {
      throw new ConflictException(
        `El puesto "${puesto.name}" está inactivo: activalo o elegí otro`,
      );
    }
    return puesto;
  }

  /**
   * El puesto activo más antiguo de la categoría, para los legajos que se
   * crean solos (alta de chofer). Si la distribuidora no tiene ningún puesto
   * (una creada sin pasar por el evento de alta) siembra los base.
   */
  async puestoPorDefecto(
    manager: EntityManager,
    distributorId: string,
    categorias: JobPositionCategory[],
  ): Promise<JobPosition> {
    const repo = manager.getRepository(JobPosition);
    const buscar = async (): Promise<JobPosition | null> => {
      for (const category of categorias) {
        const puesto = await repo.findOne({
          where: { distributorId, category, isActive: true },
          order: { createdAt: 'ASC', positionId: 'ASC' },
          // Compartido: el puesto no se borra mientras se da el alta.
          lock: { mode: 'pessimistic_read' },
        });
        if (puesto) return puesto;
      }
      return null;
    };

    const existente = await buscar();
    if (existente) return existente;

    if ((await repo.count({ where: { distributorId } })) === 0) {
      await this.sembrarBase(distributorId, manager);
      const sembrado = await buscar();
      if (sembrado) return sembrado;
    }
    throw new ConflictException(
      `La distribuidora no tiene un puesto activo de categoría "${categorias.join('" ni "')}": creá uno o indicá positionId`,
    );
  }

  /**
   * Siembra los puestos base si la distribuidora no tiene ninguno. Devuelve
   * cuántos creó. `ON CONFLICT DO NOTHING`: dos altas simultáneas sobre una
   * distribuidora sin puestos no chocan con el índice único del nombre.
   */
  async sembrarBase(
    distributorId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const em = manager ?? this.positions.manager;
    if (
      (await em
        .getRepository(JobPosition)
        .count({ where: { distributorId } })) > 0
    ) {
      return 0;
    }
    let creados = 0;
    for (const definicion of BASE_POSITION_DEFINITIONS) {
      const filas: unknown[] = await em.query(
        `INSERT INTO "job_position" ("distributor_id", "name", "category")
         VALUES ($1, $2, $3::job_position_category_enum)
         ON CONFLICT DO NOTHING
         RETURNING "position_id"`,
        [distributorId, definicion.name, definicion.category],
      );
      creados += filas.length;
    }
    return creados;
  }

  private async guardar(puesto: JobPosition): Promise<JobPosition> {
    try {
      return await this.positions.save(puesto);
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'puesto de trabajo');
    }
  }

  /** Sin otro puesto activo de la misma categoría, el alta de choferes (o de administrativos) no tendría dónde ubicarlos. */
  private async assertNoEsElUltimoActivo(
    manager: EntityManager,
    puesto: JobPosition,
  ): Promise<void> {
    const otros = await manager.getRepository(JobPosition).count({
      where: {
        distributorId: puesto.distributorId,
        category: puesto.category,
        isActive: true,
        positionId: Not(puesto.positionId),
      },
    });
    if (otros === 0) {
      throw new ConflictException(
        `"${puesto.name}" es el último puesto activo de categoría ${puesto.category}: creá otro antes de desactivarlo, recategorizarlo o eliminarlo`,
      );
    }
  }

  /** Cada ocupante con cuenta tiene que seguir en una categoría que corresponda al rol de su usuario. */
  private async assertCategoriaCompatibleConLasCuentas(
    manager: EntityManager,
    puesto: JobPosition,
    categoria: JobPositionCategory,
  ): Promise<void> {
    const conCuenta = await manager.getRepository(Employee).find({
      where: { positionId: puesto.positionId, userId: Not(IsNull()) },
      select: { employeeId: true, userId: true },
    });
    if (conCuenta.length === 0) return;
    const roles = await this.users.findRoleTypes(
      conCuenta.flatMap((e) => (e.userId ? [e.userId] : [])),
    );
    const esperado: string | null = rolDeAcceso(categoria);
    const incompatibles = [...roles.values()].filter((rol) => rol !== esperado);
    if (incompatibles.length > 0) {
      throw new ConflictException(
        `${incompatibles.length} empleado(s) del puesto "${puesto.name}" tienen una cuenta cuyo rol no corresponde a la categoría ${categoria}`,
      );
    }
  }

  private async assertNombreDisponible(
    distributorId: string,
    nombre: string,
    excluirId?: string,
  ): Promise<void> {
    const consulta = this.positions
      .createQueryBuilder('p')
      .where('p.distributorId = :distributorId', { distributorId })
      .andWhere('LOWER(p.name) = LOWER(:nombre)', { nombre });
    if (excluirId) {
      consulta.andWhere('p.positionId <> :excluirId', { excluirId });
    }
    if (await consulta.getExists()) {
      throw new ConflictException(`Ya existe un puesto llamado "${nombre}"`);
    }
  }

  private contarActivos(positionId: string): Promise<number> {
    return this.employees.count({
      where: { positionId, status: EmployeeStatus.ACTIVE },
    });
  }

  private async contarActivosPorPuesto(
    distributorId: string,
  ): Promise<Map<string, number>> {
    const filas = await this.employees
      .createQueryBuilder('e')
      .select('e.positionId', 'positionId')
      .addSelect('COUNT(*)', 'total')
      .where('e.distributorId = :distributorId', { distributorId })
      .andWhere('e.status = :status', { status: EmployeeStatus.ACTIVE })
      .groupBy('e.positionId')
      .getRawMany<{ positionId: string; total: string }>();
    return new Map(filas.map((f) => [f.positionId, Number(f.total)]));
  }
}
