import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import {
  AttendanceSource,
  EmployeeAttendance,
} from './entities/employee-attendance.entity';
import { agregarNota, validarJornada } from './domain/attendance-rules';
import {
  CorrectAttendanceDto,
  RegisterAttendanceDto,
} from './dto/register-attendance.dto';
import { QueryAttendanceDto } from './dto/query-attendance.dto';
import { JornadaConLegajo } from './attendance.mapper';
import { EmployeeService } from '../employee/employee.service';
import { Employee, EmployeeStatus } from '../employee/entities/employee.entity';
import { diaArgentino } from '../common/utils/dias-argentina';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';

export interface PaginaDeJornadas {
  data: JornadaConLegajo[];
  total: number;
  presentToday: number;
  staleOpen: number;
}

const MENSAJE_EGRESO =
  'checkOutAt: el egreso tiene que ser posterior al ingreso';

/** Tolerancia con el reloj del cliente: una marca de hasta un minuto en el futuro se acepta. */
const TOLERANCIA_RELOJ_MS = 60_000;
const SIN_FIN = new Date('9999-12-31T00:00:00Z');

/** Una jornada no puede registrarse ni corregirse hacia el futuro. */
function assertNoFutura(instante: Date | null, campo: string): void {
  if (instante && instante.getTime() > Date.now() + TOLERANCIA_RELOJ_MS) {
    throw new BadRequestException(`${campo}: no puede ser una fecha futura`);
  }
}

/** Resultado de la marca de inicio: `created` es `false` si ya había una abierta de hoy (idempotente). */
export interface InicioDeJornada {
  jornada: JornadaConLegajo;
  created: boolean;
}

/**
 * Asistencia del personal (CU-189, CU-190, CU-313, CU-314, CU-315). Una sola
 * jornada abierta por empleado: lo garantiza el índice único parcial y, antes
 * de él, el lock del legajo que toma cada escritura.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    @InjectRepository(EmployeeAttendance)
    private readonly attendance: Repository<EmployeeAttendance>,
    private readonly dataSource: DataSource,
    private readonly employees: EmployeeService,
  ) {}

  /** registrarAsistencia (CU-189): carga manual desde el panel. */
  async register(
    employeeId: string,
    dto: RegisterAttendanceDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<JornadaConLegajo> {
    const ingreso = new Date(dto.checkInAt);
    const egreso = dto.checkOutAt ? new Date(dto.checkOutAt) : null;
    if (validarJornada(ingreso, egreso)) {
      throw new BadRequestException(MENSAJE_EGRESO);
    }
    assertNoFutura(ingreso, 'checkInAt');
    assertNoFutura(egreso, 'checkOutAt');
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const empleado = await this.employees.findActivo(
              employeeId,
              distributorId,
              manager,
            );
            return this.abrir(manager, empleado, {
              ingreso,
              egreso,
              source: AttendanceSource.PANEL,
              actorUserId,
            });
          }),
        { context: 'alta de asistencia' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'asistencia');
    }
  }

  /** corregirAsistencia (CU-313): exige la nota que explica el cambio. */
  async correct(
    id: string,
    dto: CorrectAttendanceDto,
    distributorId: string,
  ): Promise<JornadaConLegajo> {
    if (dto.checkInAt === undefined && dto.checkOutAt === undefined) {
      throw new BadRequestException(
        'Indicá el ingreso o el egreso que se corrige',
      );
    }
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const repo = manager.getRepository(EmployeeAttendance);
            const previa = await repo.findOne({
              where: { attendanceId: id, distributorId },
            });
            if (!previa) throw this.noEncontrada(id);
            // Mismo orden de locks que el resto: primero el legajo.
            const empleado = await this.employees.bloquear(
              manager,
              previa.employeeId,
              distributorId,
            );
            const jornada = await repo.findOneOrFail({
              where: { attendanceId: id },
              lock: { mode: 'pessimistic_write' },
            });

            const ingreso = dto.checkInAt
              ? new Date(dto.checkInAt)
              : jornada.checkInAt;
            const egreso = dto.checkOutAt
              ? new Date(dto.checkOutAt)
              : jornada.checkOutAt;
            if (validarJornada(ingreso, egreso)) {
              throw new BadRequestException(MENSAJE_EGRESO);
            }
            assertNoFutura(ingreso, 'checkInAt');
            assertNoFutura(egreso, 'checkOutAt');
            await this.assertSinSuperposicion(
              manager,
              jornada.employeeId,
              ingreso,
              egreso,
              jornada.attendanceId,
            );

            jornada.checkInAt = ingreso;
            jornada.checkOutAt = egreso;
            jornada.workDate = diaArgentino(ingreso);
            jornada.notes = agregarNota(jornada.notes, dto.notes);
            const guardada = await repo.save(jornada);
            return Object.assign(guardada, { employee: empleado });
          }),
        { context: 'corrección de asistencia' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'asistencia');
    }
  }

  /** consultarAsistencia (CU-314). Sin ningún filtro, trae el día de hoy. */
  async findAll(
    query: QueryAttendanceDto,
    distributorId: string,
  ): Promise<PaginaDeJornadas> {
    if (query.from && query.to && query.to < query.from) {
      throw new BadRequestException(
        'to: la fecha final no puede ser anterior a from',
      );
    }
    const limit = query.limit ?? 10;
    const page = query.page ?? 1;
    const sinFiltros =
      !query.date &&
      !query.from &&
      !query.to &&
      !query.employeeId &&
      query.open === undefined;

    const consulta = this.attendance
      .createQueryBuilder('a')
      .innerJoinAndSelect('a.employee', 'e')
      .where('a.distributorId = :distributorId', { distributorId });

    if (query.date || sinFiltros) {
      consulta.andWhere('a.workDate = :dia', {
        dia: query.date ?? diaArgentino(),
      });
    }
    if (query.from) {
      consulta.andWhere('a.workDate >= :from', { from: query.from });
    }
    if (query.to) {
      consulta.andWhere('a.workDate <= :to', { to: query.to });
    }
    if (query.employeeId) {
      consulta.andWhere('a.employeeId = :employeeId', {
        employeeId: query.employeeId,
      });
    }
    if (query.open !== undefined) {
      consulta.andWhere(
        query.open ? 'a.checkOutAt IS NULL' : 'a.checkOutAt IS NOT NULL',
      );
    }

    const [data, total] = await consulta
      .orderBy('a.workDate', 'DESC')
      .addOrderBy('a.checkInAt', 'DESC')
      .addOrderBy('a.attendanceId', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const hoy = diaArgentino();
    const abiertas = await this.attendance
      .createQueryBuilder('a')
      .select(`to_char(a.work_date, 'YYYY-MM-DD')`, 'workDate')
      .addSelect('COUNT(*)', 'n')
      .where('a.distributorId = :distributorId', { distributorId })
      .andWhere('a.checkOutAt IS NULL')
      .groupBy('a.work_date')
      .getRawMany<{ workDate: string; n: string }>();
    const presentToday = abiertas
      .filter((f) => f.workDate >= hoy)
      .reduce((suma, f) => suma + Number(f.n), 0);
    const staleOpen = abiertas
      .filter((f) => f.workDate < hoy)
      .reduce((suma, f) => suma + Number(f.n), 0);

    return {
      data: data as JornadaConLegajo[],
      total,
      presentToday,
      staleOpen,
    };
  }

  /**
   * registrarInicioDeJornada (CU-190): el chofer marca desde su app. Idempotente:
   * si ya tiene una jornada abierta de hoy marcada desde la app, la devuelve.
   * Una abierta de otro día o cargada desde el panel es un conflicto.
   */
  async checkIn(userId: string): Promise<InicioDeJornada> {
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const empleado = await this.legajoDeLaCuenta(manager, userId);
            const abierta = await manager
              .getRepository(EmployeeAttendance)
              .findOne({
                where: {
                  employeeId: empleado.employeeId,
                  checkOutAt: IsNull(),
                },
              });
            if (
              abierta &&
              abierta.source === AttendanceSource.DRIVER_APP &&
              abierta.workDate === diaArgentino()
            ) {
              return {
                jornada: Object.assign(abierta, { employee: empleado }),
                created: false,
              };
            }
            const jornada = await this.abrir(manager, empleado, {
              ingreso: new Date(),
              egreso: null,
              source: AttendanceSource.DRIVER_APP,
              actorUserId: userId,
            });
            return { jornada, created: true };
          }),
        { context: 'inicio de jornada' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'asistencia');
    }
  }

  /** registrarFinDeJornada (CU-315): cierra la jornada abierta del legajo del chofer. */
  async checkOut(userId: string): Promise<JornadaConLegajo> {
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const empleado = await this.legajoDeLaCuenta(manager, userId);
            const repo = manager.getRepository(EmployeeAttendance);
            const abierta = await repo.findOne({
              where: { employeeId: empleado.employeeId, checkOutAt: IsNull() },
            });
            if (!abierta) {
              throw new ConflictException('No tenés una jornada abierta');
            }
            if (abierta.workDate < diaArgentino()) {
              throw new ConflictException(
                `Tu jornada del ${abierta.workDate} quedó sin cerrar: corregila desde el panel`,
              );
            }
            const ahora = new Date();
            abierta.checkOutAt =
              ahora.getTime() > abierta.checkInAt.getTime()
                ? ahora
                : new Date(abierta.checkInAt.getTime() + 1000);
            const guardada = await repo.save(abierta);
            return Object.assign(guardada, { employee: empleado });
          }),
        { context: 'fin de jornada' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'asistencia');
    }
  }

  /** Las jornadas de días anteriores a `dia` que siguen abiertas (aviso de las 7). */
  async abiertasAnteriores(dia: string): Promise<EmployeeAttendance[]> {
    return this.attendance
      .createQueryBuilder('a')
      .innerJoinAndSelect('a.employee', 'e')
      .where('a.workDate < :dia', { dia })
      .andWhere('a.checkOutAt IS NULL')
      .orderBy('a.distributorId', 'ASC')
      .addOrderBy('e.lastName', 'ASC')
      .getMany();
  }

  /**
   * Empleados presentes hoy (CU-194): jornada abierta del día argentino de hoy.
   * Es la misma cifra que `presentToday` de la grilla; las abiertas de días
   * anteriores no cuentan (están sin cerrar, no presentes).
   */
  async contarPresentes(distributorId: string): Promise<number> {
    return this.attendance.count({
      where: { distributorId, checkOutAt: IsNull(), workDate: diaArgentino() },
    });
  }

  /** ¿Tiene el legajo alguna jornada cargada? Para impedir la baja de un alta errónea. */
  async tieneJornadas(
    manager: EntityManager,
    employeeId: string,
  ): Promise<boolean> {
    return manager
      .getRepository(EmployeeAttendance)
      .exists({ where: { employeeId } });
  }

  // ---------------------------------------------------------------------------

  /** Crea la jornada bajo el lock del legajo: una sola abierta a la vez. */
  private async abrir(
    manager: EntityManager,
    empleado: Employee,
    datos: {
      ingreso: Date;
      egreso: Date | null;
      source: AttendanceSource;
      actorUserId: string;
    },
  ): Promise<JornadaConLegajo> {
    const repo = manager.getRepository(EmployeeAttendance);
    // Sin egreso queda abierta: hay una sola abierta por empleado.
    if (
      !datos.egreso &&
      (await repo.exists({
        where: { employeeId: empleado.employeeId, checkOutAt: IsNull() },
      }))
    ) {
      throw new ConflictException(
        'El empleado ya tiene una jornada abierta: cerrala antes de abrir otra',
      );
    }
    await this.assertSinSuperposicion(
      manager,
      empleado.employeeId,
      datos.ingreso,
      datos.egreso,
    );
    const creada = await repo.save(
      repo.create({
        distributorId: empleado.distributorId,
        employeeId: empleado.employeeId,
        workDate: diaArgentino(datos.ingreso),
        checkInAt: datos.ingreso,
        checkOutAt: datos.egreso,
        source: datos.source,
        recordedByUserId: datos.actorUserId,
        notes: null,
      }),
    );
    return Object.assign(creada, { employee: empleado });
  }

  /** 409 si la jornada se pisa con otra del mismo empleado (una abierta se extiende hasta ahora y después). */
  private async assertSinSuperposicion(
    manager: EntityManager,
    employeeId: string,
    ingreso: Date,
    egreso: Date | null,
    excepto?: string,
  ): Promise<void> {
    const consulta = manager
      .getRepository(EmployeeAttendance)
      .createQueryBuilder('a')
      .where('a.employeeId = :employeeId', { employeeId })
      .andWhere('a.checkInAt < :hasta', { hasta: egreso ?? SIN_FIN })
      .andWhere('(a.checkOutAt IS NULL OR a.checkOutAt > :desde)', {
        desde: ingreso,
      });
    if (excepto) consulta.andWhere('a.attendanceId <> :excepto', { excepto });
    const pisada = await consulta.getOne();
    if (pisada) {
      throw new ConflictException(
        `La jornada se superpone con otra del empleado (${pisada.workDate}, jornada ${pisada.attendanceId})`,
      );
    }
  }

  /** El legajo activo de la cuenta del chofer, bajo lock; 409 si no tiene o está egresado. */
  private async legajoDeLaCuenta(
    manager: EntityManager,
    userId: string,
  ): Promise<Employee> {
    const vinculado = await this.employees.findByUserId(userId);
    if (!vinculado) {
      throw new ConflictException('Tu cuenta no está vinculada a un legajo');
    }
    const bloqueado = await this.employees.bloquear(
      manager,
      vinculado.employeeId,
      vinculado.distributorId,
    );
    if (bloqueado.status !== EmployeeStatus.ACTIVE) {
      throw new ConflictException('Tu legajo está egresado');
    }
    return bloqueado;
  }

  private noEncontrada(id: string): NotFoundException {
    return new NotFoundException(`Jornada ${id} no encontrada`);
  }
}
