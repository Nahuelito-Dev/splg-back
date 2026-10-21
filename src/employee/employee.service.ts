import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  Employee,
  EmployeeDocumentType,
  EmployeeStatus,
  EmployeeTerminationReason,
  EmploymentType,
} from './entities/employee.entity';
import {
  JobPosition,
  JobPositionCategory,
} from './entities/job-position.entity';
import {
  CreateEmployeeDto,
  UpdateEmployeeDto,
} from './dto/create-employee.dto';
import { QueryEmployeeDto } from './dto/query-employee.dto';
import { ReinstateEmployeeDto } from './dto/terminate-employee.dto';
import { JobPositionService } from './job-position.service';
import { EmployeeRulesRegistry } from './employee-rules.registry';
import { EmployeeConPuesto } from './employee.mapper';
import { partirNombreCompleto } from './domain/nombre';
import {
  nacimientoAnteriorAlIngreso,
  validarReingreso,
} from './domain/employee-state';
import { rolDeAcceso } from './domain/access-role';
import {
  DocType,
  DocumentSequenceService,
} from '../document-sequence/document-sequence.service';
import { S3CleanupService } from '../s3/s3-cleanup.service';
import { User } from '../users/entities/user.entity';
import { DeliveryService } from '../delivery/delivery.service';
import { UsersService } from '../users/users.service';
import { RoleType } from '../common/constants/role-type.enum';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { diaArgentino } from '../common/utils/dias-argentina';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';

const LARGO_DEL_LEGAJO = 4;
const PREFIJO_DOCUMENTO_PENDIENTE = 'PENDIENTE-';
const NOTA_LEGAJO_AUTOMATICO =
  'Legajo creado con el alta de la cuenta: completar DNI y CUIL.';

/** Lo que `POST /users` puede traer para el legajo de un chofer nuevo (todo opcional). */
export interface DatosDeLegajoDeChofer {
  positionId?: string;
  documentType?: EmployeeDocumentType;
  documentNumber?: string;
  cuil?: string;
  hireDate?: string;
  employmentType?: EmploymentType;
}

export interface EmpleadoParaUsuarioNuevo {
  /** El rol de la cuenta nueva: decide la categoría del puesto por defecto. */
  rol: RoleType.DELIVERY | RoleType.ADMIN;
  distributorId: string;
  userId: string;
  fullName: string;
  phoneNumber: string;
  legajo?: DatosDeLegajoDeChofer;
}

export interface Pagina<T> {
  data: T[];
  total: number;
}

/** Campos obligatorios del legajo: el PATCH no los puede dejar en `null`. */
const CAMPOS_OBLIGATORIOS = [
  'positionId',
  'fileNumber',
  'firstName',
  'lastName',
  'documentType',
  'documentNumber',
  'hireDate',
  'employmentType',
] as const;

/** La persona nació antes de ingresar a la empresa (400). */
function asegurarNacimientoAnteriorAlIngreso(
  nacimiento: string | null | undefined,
  ingreso: string,
): void {
  if (!nacimientoAnteriorAlIngreso(nacimiento, ingreso)) {
    throw new BadRequestException(
      'La fecha de nacimiento tiene que ser anterior a la de ingreso',
    );
  }
}

@Injectable()
export class EmployeeService {
  private readonly logger = new Logger(EmployeeService.name);

  constructor(
    @InjectRepository(Employee)
    private readonly employees: Repository<Employee>,
    private readonly dataSource: DataSource,
    private readonly positions: JobPositionService,
    private readonly sequences: DocumentSequenceService,
    private readonly deliveries: DeliveryService,
    private readonly users: UsersService,
    private readonly rules: EmployeeRulesRegistry,
    private readonly cleanup: S3CleanupService,
  ) {}

  /** registrarEmpleado (CU-177). */
  async create(
    dto: CreateEmployeeDto,
    distributorId: string,
  ): Promise<EmployeeConPuesto> {
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const puesto = await this.positions.findAsignable(
              manager,
              dto.positionId,
              distributorId,
            );
            asegurarNacimientoAnteriorAlIngreso(dto.birthDate, dto.hireDate);
            await this.assertUnicos(manager, distributorId, dto);
            const fileNumber =
              dto.fileNumber ??
              (await this.siguienteLegajo(manager, distributorId));
            const repo = manager.getRepository(Employee);
            const creado = await repo.save(
              repo.create({
                ...this.valoresVacios(),
                ...sinIndefinidos(dto),
                fileNumber,
                distributorId,
                status: EmployeeStatus.ACTIVE,
              }),
            );
            return Object.assign(creado, { position: puesto });
          }),
        { context: 'alta de empleado' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'legajo');
    }
  }

  /**
   * El legajo de un chofer o admin que se da de alta por `POST /users`, en la
   * misma transacción que su usuario (CU-003 incluye CU-177). Sin datos de
   * legajo queda con el puesto por defecto de su rol (chofer o administración), ingreso hoy y documento
   * `PENDIENTE-<legajo>` para que el administrador lo complete.
   */
  async crearParaUsuario(
    manager: EntityManager,
    datos: EmpleadoParaUsuarioNuevo,
  ): Promise<Employee> {
    const { distributorId, legajo } = datos;
    const puesto = legajo?.positionId
      ? await this.positions.findAsignable(
          manager,
          legajo.positionId,
          distributorId,
        )
      : await this.positions.puestoPorDefecto(
          manager,
          distributorId,
          datos.rol === RoleType.DELIVERY
            ? [JobPositionCategory.DRIVER]
            : [
                JobPositionCategory.ADMINISTRATION,
                JobPositionCategory.MANAGEMENT,
              ],
        );
    if (rolDeAcceso(puesto.category) !== datos.rol) {
      throw new BadRequestException(
        `El puesto "${puesto.name}" (categoría ${puesto.category}) no corresponde a una cuenta con rol ${datos.rol}`,
      );
    }

    const fileNumber = await this.siguienteLegajo(manager, distributorId);
    const documento = legajo?.documentNumber;
    const { firstName, lastName } = partirNombreCompleto(datos.fullName);
    const nuevo = {
      ...this.valoresVacios(),
      distributorId,
      userId: datos.userId,
      positionId: puesto.positionId,
      fileNumber,
      firstName,
      lastName,
      documentType: legajo?.documentType ?? EmployeeDocumentType.DNI,
      documentNumber:
        documento ?? `${PREFIJO_DOCUMENTO_PENDIENTE}${fileNumber}`,
      cuil: legajo?.cuil ?? null,
      phone: datos.phoneNumber,
      hireDate: legajo?.hireDate ?? diaArgentino(),
      employmentType: legajo?.employmentType ?? EmploymentType.PERMANENT,
      notes: documento ? null : NOTA_LEGAJO_AUTOMATICO,
      status: EmployeeStatus.ACTIVE,
    };
    await this.assertUnicos(manager, distributorId, nuevo);
    const repo = manager.getRepository(Employee);
    return repo.save(repo.create(nuevo));
  }

  /**
   * Vincula una cuenta recién creada a un legajo existente. Bloquea el legajo:
   * dos altas simultáneas sobre el mismo no pueden quedarse las dos con él.
   */
  async vincularUsuario(
    manager: EntityManager,
    datos: {
      employeeId: string;
      userId: string;
      distributorId: string;
      rol: RoleType;
    },
  ): Promise<Employee> {
    const empleado = await this.bloquear(
      manager,
      datos.employeeId,
      datos.distributorId,
    );
    if (empleado.status !== EmployeeStatus.ACTIVE) {
      throw new ConflictException(
        'El empleado está egresado: reingresalo antes',
      );
    }
    if (empleado.userId) {
      throw new ConflictException('El empleado ya tiene una cuenta de acceso');
    }
    const puesto = await this.positions.findOne(
      empleado.positionId,
      datos.distributorId,
    );
    if (rolDeAcceso(puesto.category) !== datos.rol) {
      throw new BadRequestException(
        `El puesto "${puesto.name}" (categoría ${puesto.category}) no admite una cuenta con rol ${datos.rol}`,
      );
    }
    await this.pasarFotoAlUsuario(manager, empleado, datos.userId);
    empleado.userId = datos.userId;
    return manager.getRepository(Employee).save(empleado);
  }

  /**
   * Con cuenta, la foto es la del usuario (una sola fuente de verdad). La del
   * legajo pasa al usuario si no tiene una; si ya tiene, va a limpieza. Todo
   * en la transacción del alta, así la key nunca queda sin dueño.
   */
  private async pasarFotoAlUsuario(
    manager: EntityManager,
    empleado: Employee,
    userId: string,
  ): Promise<void> {
    const key = empleado.photoKey;
    if (!key) return;
    const usuarios = manager.getRepository(User);
    const usuario = await usuarios.findOne({
      where: { userId },
      select: { userId: true, photoKey: true },
    });
    if (usuario && !usuario.photoKey) {
      await usuarios.update({ userId }, { photoKey: key });
    } else {
      await this.cleanup.scheduleRemoval(manager, key);
    }
    empleado.photoKey = null;
  }

  /** consultarEmpleados (CU-180): sin datos personales sensibles. */
  async findAll(
    query: QueryEmployeeDto,
    distributorId: string,
  ): Promise<Pagina<EmployeeConPuesto>> {
    const limit = query.limit ?? 10;
    const page = query.page ?? 1;
    const consulta = this.employees
      .createQueryBuilder('e')
      .innerJoinAndSelect('e.position', 'p')
      .where('e.distributorId = :distributorId', { distributorId });

    if (query.q) {
      const texto = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      consulta.andWhere(
        `(e.firstName || ' ' || e.lastName ILIKE :texto
          OR e.lastName || ' ' || e.firstName ILIKE :texto
          OR e.fileNumber ILIKE :texto)`,
        { texto },
      );
    }
    if (query.positionId) {
      consulta.andWhere('e.positionId = :positionId', {
        positionId: query.positionId,
      });
    }
    if (query.category) {
      consulta.andWhere('p.category = :category', { category: query.category });
    }
    if (query.status) {
      consulta.andWhere('e.status = :status', { status: query.status });
    }
    if (query.hasAccount !== undefined) {
      consulta.andWhere(
        query.hasAccount ? 'e.userId IS NOT NULL' : 'e.userId IS NULL',
      );
    }

    const [data, total] = await consulta
      .orderBy('e.lastName', 'ASC')
      .addOrderBy('e.firstName', 'ASC')
      .addOrderBy('e.employeeId', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data: data.map(conPuesto), total };
  }

  /** consultarEmpleado (CU-179): el legajo completo y, si es chofer, su perfil de reparto. */
  async findOneDetallado(
    id: string,
    distributorId: string,
  ): Promise<{ empleado: EmployeeConPuesto; deliveryId: string | null }> {
    const empleado = await this.findOne(id, distributorId);
    return { empleado, deliveryId: await this.deliveryIdDe(empleado) };
  }

  /** modificarEmpleado (CU-178). El estado y el egreso no se editan por acá. */
  async update(
    id: string,
    dto: UpdateEmployeeDto,
    distributorId: string,
  ): Promise<{ empleado: EmployeeConPuesto; deliveryId: string | null }> {
    for (const campo of CAMPOS_OBLIGATORIOS) {
      if (dto[campo] === null) {
        throw new BadRequestException(`${campo} no puede quedar vacío`);
      }
    }
    try {
      await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const empleado = await this.bloquear(manager, id, distributorId);
            if (
              dto.positionId !== undefined &&
              dto.positionId !== empleado.positionId
            ) {
              await this.assertPuestoCompatibleConLaCuenta(
                manager,
                empleado,
                dto.positionId,
                distributorId,
              );
            }
            if (
              (dto.hireDate ?? empleado.hireDate) >
              (empleado.terminationDate ?? '9999-12-31')
            ) {
              throw new BadRequestException(
                'La fecha de ingreso no puede ser posterior a la de egreso',
              );
            }
            asegurarNacimientoAnteriorAlIngreso(
              dto.birthDate === undefined ? empleado.birthDate : dto.birthDate,
              dto.hireDate ?? empleado.hireDate,
            );
            await this.assertUnicos(manager, distributorId, dto, id);
            Object.assign(empleado, sinIndefinidos(dto));
            await manager.getRepository(Employee).save(empleado);
          }),
        { context: 'modificación de empleado' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'legajo');
    }
    return this.findOneDetallado(id, distributorId);
  }

  /** eliminarEmpleado (CU-178): sólo altas erróneas. */
  async remove(id: string, distributorId: string): Promise<MessageResponseDto> {
    await this.dataSource.transaction(async (manager) => {
      const empleado = await this.bloquear(manager, id, distributorId);
      const motivos = [
        ...(empleado.userId
          ? ['tiene una cuenta de acceso: registrá el egreso']
          : []),
        ...(await this.rules.motivosQueImpidenLaBaja(manager, empleado)),
      ];
      if (motivos.length > 0) {
        throw new ConflictException(
          `El legajo no es una alta errónea: ${motivos.join('; ')}`,
        );
      }
      await manager.getRepository(Employee).softRemove(empleado);
    });
    return MessageResponseDto.of('Legajo eliminado');
  }

  /** reingresarEmpleado (CU-181). No desbloquea la cuenta: es otra decisión del administrador. */
  async reinstate(
    id: string,
    dto: ReinstateEmployeeDto,
    distributorId: string,
  ): Promise<{ empleado: EmployeeConPuesto; deliveryId: string | null }> {
    await this.dataSource.transaction(async (manager) => {
      const empleado = await this.bloquear(manager, id, distributorId);
      const fecha = dto.hireDate ?? diaArgentino();
      const rechazo = validarReingreso(empleado, fecha);
      if (rechazo === 'NO_EGRESADO') {
        throw new ConflictException('El empleado no está egresado');
      }
      if (rechazo === 'FECHA_ANTERIOR_AL_EGRESO') {
        throw new BadRequestException(
          'La fecha de ingreso no puede ser anterior a la del egreso',
        );
      }
      empleado.status = EmployeeStatus.ACTIVE;
      empleado.hireDate = fecha;
      empleado.terminationDate = null;
      empleado.terminationReason = null;
      await manager.getRepository(Employee).save(empleado);
    });
    return this.findOneDetallado(id, distributorId);
  }

  /**
   * La baja de un usuario (`DELETE /users/:id`, chofer o admin) egresa su
   * legajo en la MISMA transacción y suelta la cuenta (`userId = null`): la
   * cuenta ya no existe, el vínculo queda en la auditoría y el legajo puede
   * recibir una cuenta nueva si se reingresa. Respeta las precondiciones del
   * egreso: si hay motivos, la baja falla con 409 y se revierte todo.
   *
   * Orden de locks: el usuario/chofer ya quedó bloqueado por `users.remove`;
   * el legajo se toma después.
   */
  async egresarPorBajaDeUsuario(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const repo = manager.getRepository(Employee);
    const empleado = await repo.findOne({
      where: { userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!empleado) return;

    if (empleado.status === EmployeeStatus.ACTIVE) {
      const motivos = await this.rules.motivosQueImpidenElEgreso(
        manager,
        empleado,
      );
      if (motivos.length > 0) {
        throw new ConflictException(
          `No se puede dar de baja al usuario: ${motivos.join('; ')}`,
        );
      }
      const hoy = diaArgentino();
      empleado.status = EmployeeStatus.TERMINATED;
      empleado.terminationDate =
        hoy < empleado.hireDate ? empleado.hireDate : hoy;
      empleado.terminationReason = EmployeeTerminationReason.OTHER;
      empleado.notes = empleado.notes
        ? `${empleado.notes}\nBaja del usuario`
        : 'Baja del usuario';
    }
    empleado.userId = null;
    await repo.save(empleado);
  }

  /** El legajo con su puesto, o 404 si no existe o es de otra distribuidora. */
  async findOne(id: string, distributorId: string): Promise<EmployeeConPuesto> {
    const empleado = await this.employees.findOne({
      where: { employeeId: id, distributorId },
      relations: { position: true },
    });
    if (!empleado) {
      throw new NotFoundException(`Empleado ${id} no encontrado`);
    }
    return conPuesto(empleado);
  }

  /**
   * El legajo activo, para operaciones que lo exigen (documentación, jornadas,
   * licencias): 404 si no existe o es de otra distribuidora, 409 si está
   * egresado. Con `manager` toma además el lock de la fila, así dos operaciones
   * sobre el mismo legajo se serializan.
   */
  async findActivo(
    id: string,
    distributorId: string,
    manager?: EntityManager,
  ): Promise<EmployeeConPuesto> {
    const empleado = manager
      ? conPuesto(await this.bloquearConPuesto(manager, id, distributorId))
      : await this.findOne(id, distributorId);
    if (empleado.status !== EmployeeStatus.ACTIVE) {
      throw new ConflictException(
        `El empleado ${empleado.firstName} ${empleado.lastName} está egresado`,
      );
    }
    return empleado;
  }

  /** Los legajos vigentes de esas cuentas, con su puesto (el gate del despacho los lee en lote). */
  async findByUserIds(
    userIds: string[],
    distributorId?: string | null,
  ): Promise<EmployeeConPuesto[]> {
    if (userIds.length === 0) return [];
    const legajos = await this.employees.find({
      where: {
        userId: In(userIds),
        ...(distributorId ? { distributorId } : {}),
      },
      relations: { position: true },
    });
    return legajos.map(conPuesto);
  }

  /** El legajo vigente de una cuenta, o `null` si no está vinculada a ninguno. */
  async findByUserId(userId: string): Promise<EmployeeConPuesto | null> {
    const [legajo] = await this.findByUserIds([userId]);
    return legajo ?? null;
  }

  /** Los legajos activos de una distribuidora, opcionalmente de una categoría de puesto. */
  async findActivos(
    distributorId: string,
    category?: JobPositionCategory,
  ): Promise<EmployeeConPuesto[]> {
    const legajos = await this.employees.find({
      where: {
        distributorId,
        status: EmployeeStatus.ACTIVE,
        ...(category ? { position: { category } } : {}),
      },
      relations: { position: true },
      order: { lastName: 'ASC', firstName: 'ASC', employeeId: 'ASC' },
    });
    return legajos.map(conPuesto);
  }

  /** Cuántos empleados activos hay por puesto (CU-194). Sólo los puestos con gente. */
  async contarActivosPorPuesto(distributorId: string): Promise<
    Array<{
      positionId: string;
      name: string;
      category: JobPositionCategory;
      count: number;
    }>
  > {
    const filas = await this.employees
      .createQueryBuilder('e')
      .innerJoin('e.position', 'p')
      .select('p.positionId', 'positionId')
      .addSelect('p.name', 'name')
      .addSelect('p.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('e.distributorId = :distributorId', { distributorId })
      .andWhere('e.status = :status', { status: EmployeeStatus.ACTIVE })
      .groupBy('p.positionId')
      .addGroupBy('p.name')
      .addGroupBy('p.category')
      .orderBy('p.name', 'ASC')
      .getRawMany<{
        positionId: string;
        name: string;
        category: JobPositionCategory;
        count: string;
      }>();
    return filas.map((f) => ({ ...f, count: Number(f.count) }));
  }

  /** Las distribuidoras que tienen al menos un chofer activo (aviso diario de documentación, CU-188). */
  async distribuidorasConChoferesActivos(): Promise<string[]> {
    const filas = await this.employees
      .createQueryBuilder('e')
      .innerJoin('e.position', 'p')
      .select('DISTINCT e.distributorId', 'distributorId')
      .where('e.status = :status', { status: EmployeeStatus.ACTIVE })
      .andWhere('p.category = :category', {
        category: JobPositionCategory.DRIVER,
      })
      .getRawMany<{ distributorId: string }>();
    return filas.map((f) => f.distributorId);
  }

  /** Lo mínimo de varios legajos (nombre y puesto) por id, para armar listados de otros módulos. */
  async findByIds(
    ids: string[],
    distributorId: string,
  ): Promise<EmployeeConPuesto[]> {
    if (ids.length === 0) return [];
    const legajos = await this.employees.find({
      where: { employeeId: In(ids), distributorId },
      relations: { position: true },
    });
    return legajos.map(conPuesto);
  }

  private async bloquearConPuesto(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<Employee & { position: JobPosition }> {
    const bloqueado = await this.bloquear(manager, id, distributorId);
    const completo = await manager.getRepository(Employee).findOneOrFail({
      where: { employeeId: bloqueado.employeeId },
      relations: { position: true },
    });
    return completo as Employee & { position: JobPosition };
  }

  /** Toma el lock de la fila del legajo (404 si no es de la distribuidora). */
  async bloquear(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<Employee> {
    const empleado = await manager.getRepository(Employee).findOne({
      where: { employeeId: id, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!empleado) {
      throw new NotFoundException(`Empleado ${id} no encontrado`);
    }
    return empleado;
  }

  /** El legajo vigente de esa cuenta en la distribuidora, o `null` si no tiene. */
  async findByUserIdEnDistribuidora(
    userId: string,
    distributorId: string,
  ): Promise<Employee | null> {
    return this.employees.findOne({ where: { userId, distributorId } });
  }

  async deliveryIdDe(empleado: Employee): Promise<string | null> {
    if (!empleado.userId) return null;
    const [perfil] = await this.deliveries.findDeliveryIdsByUserIds(
      [empleado.userId],
      empleado.distributorId,
    );
    return perfil?.deliveryId ?? null;
  }

  /**
   * Siguiente número de legajo libre: salta los que alguien cargó a mano (o el
   * documento `PENDIENTE-<n>` equivalente), igual que el backfill. Corre bajo
   * el lock de la fila de la secuencia, así que dos altas no se pisan.
   */
  private async siguienteLegajo(
    manager: EntityManager,
    distributorId: string,
  ): Promise<string> {
    const repo = manager.getRepository(Employee);
    for (;;) {
      const numero = await this.sequences.siguienteNumero(
        manager,
        distributorId,
        DocType.EMPLOYEE_FILE,
      );
      const legajo = String(numero).padStart(LARGO_DEL_LEGAJO, '0');
      const ocupado = await repo
        .createQueryBuilder('e')
        .where('e.distributorId = :distributorId', { distributorId })
        .andWhere('(e.fileNumber = :legajo OR e.documentNumber = :pendiente)', {
          legajo,
          pendiente: `${PREFIJO_DOCUMENTO_PENDIENTE}${legajo}`,
        })
        .getExists();
      if (!ocupado) return legajo;
    }
  }

  /** El documento, el CUIL y el legajo no pueden ser de otro empleado vigente (409). */
  private async assertUnicos(
    manager: EntityManager,
    distributorId: string,
    datos: {
      documentNumber?: string;
      cuil?: string | null;
      fileNumber?: string;
    },
    excluirId?: string,
  ): Promise<void> {
    const repo = manager.getRepository(Employee);
    const existe = async (
      campo: 'documentNumber' | 'cuil' | 'fileNumber',
      valor: string | null | undefined,
    ): Promise<boolean> => {
      if (!valor) return false;
      const consulta = repo
        .createQueryBuilder('e')
        .where('e.distributorId = :distributorId', { distributorId })
        .andWhere(`e.${campo} = :valor`, { valor });
      if (excluirId)
        consulta.andWhere('e.employeeId <> :excluirId', { excluirId });
      return consulta.getExists();
    };

    if (await existe('documentNumber', datos.documentNumber)) {
      throw new ConflictException(
        'Ya hay un empleado vigente con ese documento',
      );
    }
    if (await existe('cuil', datos.cuil)) {
      throw new ConflictException('Ya hay un empleado vigente con ese CUIL');
    }
    if (await existe('fileNumber', datos.fileNumber)) {
      throw new ConflictException(
        'Ya hay un empleado vigente con ese número de legajo',
      );
    }
  }

  /** Con cuenta, el puesto nuevo no puede pedir un rol distinto del que ya tiene el usuario. */
  private async assertPuestoCompatibleConLaCuenta(
    manager: EntityManager,
    empleado: Employee,
    positionId: string,
    distributorId: string,
  ): Promise<void> {
    const puesto = await this.positions.findAsignable(
      manager,
      positionId,
      distributorId,
    );
    if (!empleado.userId) return;
    const usuario = await this.users.findOne(empleado.userId);
    if (usuario.role?.type !== rolDeAcceso(puesto.category)) {
      throw new ConflictException(
        `El puesto "${puesto.name}" no es compatible con la cuenta del empleado (rol ${usuario.role?.type ?? 'sin rol'})`,
      );
    }
  }

  /** Columnas opcionales del legajo en `null`, para los alta que no las traen. */
  private valoresVacios(): Partial<Employee> {
    return {
      cuil: null,
      birthDate: null,
      addressLine: null,
      city: null,
      province: null,
      postalCode: null,
      phone: null,
      personalEmail: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      emergencyContactRelationship: null,
      terminationDate: null,
      terminationReason: null,
      bankCbu: null,
      notes: null,
      userId: null,
    };
  }
}

/** Toda consulta que llega acá hace `innerJoin` con el puesto: `position` siempre viene cargado. */
function conPuesto(empleado: Employee): EmployeeConPuesto {
  return empleado as EmployeeConPuesto;
}
