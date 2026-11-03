import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { EmployeeLeave, LeaveType } from './entities/employee-leave.entity';
import {
  ESTADOS_VIGENTES,
  LeaveStatus,
  RechazoDeLicencia,
  diasCorridos,
  validarCancelacion,
  validarModificacion,
  validarPeriodo,
  validarRechazo,
  validarResolucion,
} from './domain/leave-state';
import {
  diasDeVacacionesPorAntiguedad,
  diasDentroDelAnio,
} from './domain/vacaciones';
import { CreateLeaveDto, UpdateLeaveDto } from './dto/create-leave.dto';
import { QueryLeaveDto } from './dto/query-leave.dto';
import { VacationBalanceDto } from './dto/leave-response.dto';
import { LicenciaConLegajo } from './leave.mapper';
import { EmployeeService } from '../employee/employee.service';
import { Employee } from '../employee/entities/employee.entity';
import { diaArgentino } from '../common/utils/dias-argentina';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';

export interface PaginaDeLicencias {
  data: LicenciaConLegajo[];
  total: number;
}

const ETIQUETA_DEL_TIPO: Record<LeaveType, string> = {
  [LeaveType.VACATION]: 'vacaciones',
  [LeaveType.SICK]: 'enfermedad',
  [LeaveType.WORK_ACCIDENT]: 'accidente de trabajo',
  [LeaveType.STUDY]: 'estudio',
  [LeaveType.MARRIAGE]: 'matrimonio',
  [LeaveType.BIRTH]: 'nacimiento',
  [LeaveType.BEREAVEMENT]: 'duelo',
  [LeaveType.UNPAID]: 'sin goce de sueldo',
  [LeaveType.SUSPENSION]: 'suspensión',
  [LeaveType.UNJUSTIFIED_ABSENCE]: 'ausencia injustificada',
  [LeaveType.OTHER]: 'otra',
};

const ETIQUETA_DEL_ESTADO: Record<LeaveStatus, string> = {
  [LeaveStatus.REQUESTED]: 'solicitada',
  [LeaveStatus.APPROVED]: 'aprobada',
  [LeaveStatus.REJECTED]: 'rechazada',
  [LeaveStatus.CANCELLED]: 'cancelada',
};

/**
 * Licencias y ausencias del personal (CU-191, CU-192, CU-193, CU-316 a
 * CU-319). Toda escritura toma primero el lock del legajo (`FOR UPDATE`) y
 * recién después el de la licencia: dos administradores que cargan licencias
 * del mismo empleado a la vez se serializan, y el control de superposición ve
 * lo que dejó el otro.
 */
@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    @InjectRepository(EmployeeLeave)
    private readonly leaves: Repository<EmployeeLeave>,
    private readonly dataSource: DataSource,
    private readonly employees: EmployeeService,
  ) {}

  /** registrarLicencia (CU-191): nace solicitada. */
  async create(
    employeeId: string,
    dto: CreateLeaveDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<LicenciaConLegajo> {
    this.assertPeriodo(dto.startDate, dto.endDate);
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const empleado = await this.employees.findActivo(
              employeeId,
              distributorId,
              manager,
            );
            await this.assertSinSuperposicion(
              manager,
              empleado.employeeId,
              dto.startDate,
              dto.endDate,
            );
            const repo = manager.getRepository(EmployeeLeave);
            const creada = await repo.save(
              repo.create({
                distributorId,
                employeeId: empleado.employeeId,
                type: dto.type,
                startDate: dto.startDate,
                endDate: dto.endDate,
                days: diasCorridos(dto.startDate, dto.endDate),
                status: LeaveStatus.REQUESTED,
                reason: dto.reason ?? null,
                rejectionReason: null,
                requestedByUserId: actorUserId,
                decidedByUserId: null,
                decidedAt: null,
              }),
            );
            return Object.assign(creada, { employee: empleado as Employee });
          }),
        { context: 'alta de licencia' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'licencias');
    }
  }

  /** modificarLicencia (CU-316): sólo mientras está solicitada. */
  async update(
    id: string,
    dto: UpdateLeaveDto,
    distributorId: string,
  ): Promise<LicenciaConLegajo> {
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const licencia = await this.tomar(manager, id, distributorId, true);
            this.assertTransicion(
              validarModificacion(licencia.status),
              licencia,
            );

            const inicio = dto.startDate ?? licencia.startDate;
            const fin = dto.endDate ?? licencia.endDate;
            this.assertPeriodo(inicio, fin);
            await this.assertSinSuperposicion(
              manager,
              licencia.employeeId,
              inicio,
              fin,
              licencia.leaveId,
            );

            Object.assign(
              licencia,
              sinIndefinidos({
                type: dto.type,
                reason: dto.reason,
                startDate: inicio,
                endDate: fin,
                days: diasCorridos(inicio, fin),
              }),
            );
            return manager.getRepository(EmployeeLeave).save(licencia);
          }),
        { context: 'modificación de licencia' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'licencias');
    }
  }

  /** aprobarLicencia (CU-192): asienta quién y cuándo. */
  async approve(
    id: string,
    distributorId: string,
    actorUserId: string,
  ): Promise<LicenciaConLegajo> {
    return this.resolver(id, distributorId, (licencia) => {
      this.assertTransicion(validarResolucion(licencia.status), licencia);
      licencia.status = LeaveStatus.APPROVED;
      licencia.decidedByUserId = actorUserId;
      licencia.decidedAt = new Date();
    });
  }

  /** rechazarLicencia (CU-318): el motivo es obligatorio. */
  async reject(
    id: string,
    reason: string,
    distributorId: string,
    actorUserId: string,
  ): Promise<LicenciaConLegajo> {
    return this.resolver(id, distributorId, (licencia) => {
      this.assertTransicion(validarRechazo(licencia.status, reason), licencia);
      licencia.status = LeaveStatus.REJECTED;
      licencia.rejectionReason = reason.trim();
      licencia.decidedByUserId = actorUserId;
      licencia.decidedAt = new Date();
    });
  }

  /** cancelarLicencia (CU-317): libera el período y deja de inhabilitar. */
  async cancel(
    id: string,
    distributorId: string,
    actorUserId: string,
  ): Promise<LicenciaConLegajo> {
    return this.resolver(id, distributorId, (licencia) => {
      this.assertTransicion(
        validarCancelacion(licencia, diaArgentino()),
        licencia,
      );
      licencia.status = LeaveStatus.CANCELLED;
      licencia.decidedByUserId = actorUserId;
      licencia.decidedAt = new Date();
    });
  }

  /** consultarLicencias (CU-319). */
  async findAll(
    query: QueryLeaveDto,
    distributorId: string,
  ): Promise<PaginaDeLicencias> {
    if (query.from && query.to && query.to < query.from) {
      throw new BadRequestException(
        'to: la fecha final no puede ser anterior a from',
      );
    }
    const limit = query.limit ?? 10;
    const page = query.page ?? 1;
    const consulta = this.leaves
      .createQueryBuilder('l')
      .innerJoinAndSelect('l.employee', 'e')
      .where('l.distributorId = :distributorId', { distributorId });

    if (query.status) {
      consulta.andWhere('l.status = :status', { status: query.status });
    }
    if (query.type) {
      consulta.andWhere('l.type = :type', { type: query.type });
    }
    if (query.employeeId) {
      consulta.andWhere('l.employeeId = :employeeId', {
        employeeId: query.employeeId,
      });
    }
    if (query.from) {
      consulta.andWhere('l.endDate >= :from', { from: query.from });
    }
    if (query.to) {
      consulta.andWhere('l.startDate <= :to', { to: query.to });
    }

    const [data, total] = await consulta
      .orderBy('l.startDate', 'ASC')
      .addOrderBy('l.leaveId', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data: data as LicenciaConLegajo[], total };
  }

  /** consultarSaldoDeVacaciones (CU-193): se calcula en cada consulta, no se guarda. */
  async vacationBalance(
    employeeId: string,
    distributorId: string,
    year?: number,
  ): Promise<VacationBalanceDto> {
    const empleado = await this.employees.findOne(employeeId, distributorId);
    const anio = year ?? Number(diaArgentino().slice(0, 4));

    const tomadas = await this.leaves
      .createQueryBuilder('l')
      .where('l.employeeId = :employeeId', { employeeId })
      .andWhere('l.type = :type', { type: LeaveType.VACATION })
      .andWhere('l.status = :status', { status: LeaveStatus.APPROVED })
      .andWhere('l.startDate <= :fin AND l.endDate >= :inicio', {
        inicio: `${anio}-01-01`,
        fin: `${anio}-12-31`,
      })
      .getMany();

    const dto = new VacationBalanceDto();
    dto.employeeId = empleado.employeeId;
    dto.year = anio;
    dto.entitledDays = diasDeVacacionesPorAntiguedad(empleado.hireDate, anio);
    dto.takenDays = tomadas.reduce(
      (suma, l) => suma + diasDentroDelAnio(l.startDate, l.endDate, anio),
      0,
    );
    dto.balanceDays = dto.entitledDays - dto.takenDays;
    return dto;
  }

  /**
   * De esos legajos, los que tienen una licencia aprobada que cubre `dia`
   * (CU-246: el chofer de licencia no recibe pedidos). Una sola consulta.
   */
  async empleadosDeLicenciaEn(
    employeeIds: string[],
    dia: string,
  ): Promise<Set<string>> {
    if (employeeIds.length === 0) return new Set();
    const cubiertos = await this.leaves
      .createQueryBuilder('l')
      .select('DISTINCT l.employeeId', 'employeeId')
      .where('l.employeeId IN (:...employeeIds)', { employeeIds })
      .andWhere('l.status = :status', { status: LeaveStatus.APPROVED })
      .andWhere('l.startDate <= :dia AND l.endDate >= :dia', { dia })
      .getRawMany<{ employeeId: string }>();
    return new Set(cubiertos.map((f) => f.employeeId));
  }

  /** Cuántos empleados de la distribuidora están de licencia aprobada ese día (CU-194). */
  async contarDeLicenciaEn(
    distributorId: string,
    dia: string,
  ): Promise<number> {
    const { n } = (await this.leaves
      .createQueryBuilder('l')
      .select('COUNT(DISTINCT l.employeeId)', 'n')
      .where('l.distributorId = :distributorId', { distributorId })
      .andWhere('l.status = :status', { status: LeaveStatus.APPROVED })
      .andWhere('l.startDate <= :dia AND l.endDate >= :dia', { dia })
      .getRawOne<{ n: string }>()) ?? { n: '0' };
    return Number(n);
  }

  /** ¿Tiene el legajo alguna licencia cargada? Para impedir la baja de un alta errónea. */
  async tieneLicencias(
    manager: EntityManager,
    employeeId: string,
  ): Promise<boolean> {
    return manager
      .getRepository(EmployeeLeave)
      .exists({ where: { employeeId } });
  }

  // ---------------------------------------------------------------------------

  /** Carga la licencia (404 si no es de la distribuidora); con `conLegajo` toma antes el lock del legajo. */
  private async tomar(
    manager: EntityManager,
    id: string,
    distributorId: string,
    conLegajo: boolean,
  ): Promise<LicenciaConLegajo> {
    const repo = manager.getRepository(EmployeeLeave);
    if (conLegajo) {
      const previa = await repo.findOne({
        where: { leaveId: id, distributorId },
      });
      if (!previa) throw this.noEncontrada();
      await this.employees.bloquear(manager, previa.employeeId, distributorId);
    }
    const bloqueada = await repo.findOne({
      where: { leaveId: id, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bloqueada) throw this.noEncontrada();
    const empleado = await manager
      .getRepository(Employee)
      .findOneByOrFail({ employeeId: bloqueada.employeeId });
    return Object.assign(bloqueada, { employee: empleado });
  }

  private async resolver(
    id: string,
    distributorId: string,
    aplicar: (licencia: LicenciaConLegajo) => void,
  ): Promise<LicenciaConLegajo> {
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const licencia = await this.tomar(manager, id, distributorId, true);
            aplicar(licencia);
            return manager.getRepository(EmployeeLeave).save(licencia);
          }),
        { context: 'resolución de licencia' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'licencias');
    }
  }

  private noEncontrada(): NotFoundException {
    return new NotFoundException('Licencia no encontrada');
  }

  private assertPeriodo(inicio: string, fin: string): void {
    if (validarPeriodo(inicio, fin)) {
      throw new BadRequestException(
        'endDate: la fecha de fin no puede ser anterior a la de inicio',
      );
    }
  }

  /** 409 con la licencia que pisa, sin contar la que se está modificando. */
  private async assertSinSuperposicion(
    manager: EntityManager,
    employeeId: string,
    inicio: string,
    fin: string,
    excepto?: string,
  ): Promise<void> {
    const consulta = manager
      .getRepository(EmployeeLeave)
      .createQueryBuilder('l')
      .where('l.employeeId = :employeeId', { employeeId })
      .andWhere('l.status IN (:...vigentes)', { vigentes: ESTADOS_VIGENTES })
      .andWhere('l.startDate <= :fin AND l.endDate >= :inicio', {
        inicio,
        fin,
      });
    if (excepto) consulta.andWhere('l.leaveId <> :excepto', { excepto });
    const pisada = await consulta.orderBy('l.startDate', 'ASC').getOne();
    if (pisada) {
      throw new ConflictException(
        `El período se superpone con otra licencia (${ETIQUETA_DEL_TIPO[pisada.type]}, ${ETIQUETA_DEL_ESTADO[pisada.status]}) del ${pisada.startDate} al ${pisada.endDate}`,
      );
    }
  }

  private assertTransicion(
    rechazo: RechazoDeLicencia | null,
    licencia: EmployeeLeave,
  ): void {
    switch (rechazo) {
      case null:
        return;
      case 'MOTIVO_OBLIGATORIO':
        throw new BadRequestException('reason: el motivo es obligatorio');
      case 'FIN_ANTERIOR_AL_INICIO':
        throw new BadRequestException(
          'endDate: la fecha de fin no puede ser anterior a la de inicio',
        );
      case 'NO_ESTA_SOLICITADA':
        throw new ConflictException(
          `La licencia está ${ETIQUETA_DEL_ESTADO[licencia.status]}: sólo una licencia solicitada admite esta operación`,
        );
      case 'YA_TERMINO':
        throw new ConflictException('La licencia ya terminó');
      case 'YA_RESUELTA':
        throw new ConflictException(
          `La licencia ya está ${ETIQUETA_DEL_ESTADO[licencia.status]}`,
        );
    }
  }
}
