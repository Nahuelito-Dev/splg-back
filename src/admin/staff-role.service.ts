import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { StaffRole } from './entities/staff-role.entity';
import { Admin } from './entities/admin.entity';
import { CreateStaffRoleDto, UpdateStaffRoleDto } from './dto/staff-role.dto';
import { StaffPermissionsService } from './staff-permissions.service';
import { RoleType } from '../common/constants/role-type.enum';
import { CODIGOS_DE_ERROR, conCodigo } from '../common/errors/con-codigo';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import {
  EVENTO_PERMISOS_CAMBIADOS,
  PermisosCambiadosEvent,
} from '../common/events/permisos-cambiados.event';
import {
  esPermiso,
  etiquetaDelPermiso,
  ordenarPermisos,
  permisosDesconocidos,
  type Permiso,
} from '../common/permisos/catalogo';
import {
  AutoridadSobreCuentas,
  type CuentaDestino,
  type OpcionesSobreCuentas,
} from '../common/permisos/autoridad-sobre-cuentas';
import type { PermisosDelUsuario } from './staff-permissions.service';
import {
  assertQuedaQuienGestioneRoles,
  bloquearGestoresDeRoles,
  contarGestoresDeRoles,
} from '../common/permisos/gestores-de-roles';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/** Quién pide el cambio (sale de `@CurrentUser()`). */
export type Actor = Pick<
  AuthenticatedUser,
  'user_id' | 'role' | 'actuaComoEmpresaPropia'
>;

export interface RolConConteo {
  rol: StaffRole;
  adminCount: number;
}

export interface AsignacionDeRol {
  adminId: string;
  userId: string;
  rol: StaffRole;
}

export { assertQuedaQuienGestioneRoles };

/** Permisos fuera del catálogo: 400 con sus nombres. Devuelve la lista válida, ordenada. */
export function validarPermisos(valores: readonly string[]): Permiso[] {
  const desconocidos = permisosDesconocidos(valores);
  if (desconocidos.length > 0) {
    throw conCodigo(
      BadRequestException,
      400,
      `${desconocidos.length === 1 ? 'Permiso desconocido' : 'Permisos desconocidos'}: ${desconocidos
        .map((p) => `«${p}»`)
        .join(', ')}. Los válidos son los del catálogo de permisos`,
      CODIGOS_DE_ERROR.UNKNOWN_PERMISSION,
    );
  }
  return ordenarPermisos(valores as Permiso[]);
}

/**
 * Roles del personal del panel (F37 E1) y su asignación a los admins.
 * Siempre dentro de una distribuidora: lo de otra es 404. Las escrituras que
 * pueden dejar a la distribuidora sin nadie que gestione roles se serializan
 * por distribuidora (lock de la transacción) y verifican la regla después del
 * cambio, dentro de la misma transacción.
 */
@Injectable()
export class StaffRoleService implements AutoridadSobreCuentas {
  private readonly logger = new Logger(StaffRoleService.name);

  constructor(
    @InjectRepository(StaffRole)
    private readonly roles: Repository<StaffRole>,
    private readonly dataSource: DataSource,
    private readonly permisos: StaffPermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  async findAll(distributorId: string): Promise<RolConConteo[]> {
    const roles = await this.roles.find({
      where: { distributorId },
      order: { isSystem: 'DESC', name: 'ASC' },
    });
    const conteo = await this.contarAdminsPorRol(this.dataSource.manager, [
      ...roles.map((r) => r.staffRoleId),
    ]);
    return roles.map((rol) => ({
      rol,
      adminCount: conteo.get(rol.staffRoleId) ?? 0,
    }));
  }

  async findOne(id: string, distributorId: string): Promise<RolConConteo> {
    const rol = await this.vigente(this.dataSource.manager, id, distributorId);
    const conteo = await this.contarAdminsPorRol(this.dataSource.manager, [id]);
    return { rol, adminCount: conteo.get(id) ?? 0 };
  }

  async create(
    dto: CreateStaffRoleDto,
    distributorId: string,
    actor: Actor,
  ): Promise<RolConConteo> {
    const permisos = validarPermisos(dto.permissions);
    return this.enTransaccion(async (manager) => {
      await this.assertTieneLoQueDa(manager, actor, permisos);
      await this.assertNombreDisponible(manager, distributorId, dto.name);
      const repo = manager.getRepository(StaffRole);
      const rol = await repo.save(
        repo.create({
          distributorId,
          name: dto.name,
          description: dto.description ?? null,
          permissions: permisos,
          isSystem: false,
        }),
      );
      return { rol, adminCount: 0 };
    });
  }

  async update(
    id: string,
    dto: UpdateStaffRoleDto,
    distributorId: string,
    actor: Actor,
  ): Promise<RolConConteo> {
    const permisos =
      dto.permissions !== undefined ? validarPermisos(dto.permissions) : null;
    const resultado = await this.enTransaccion(async (manager) => {
      await this.bloquear(manager, distributorId);
      const rol = await this.vigente(manager, id, distributorId);
      this.assertNoEsDeSistema(rol, 'editar');
      await this.assertNoEsSuPropioRol(manager, actor, rol);
      if (permisos) {
        await this.assertTieneLoQueDa(manager, actor, permisos);
        await this.assertPuedeQuitar(manager, actor, rol, permisos);
      }
      if (dto.name !== undefined && dto.name !== rol.name) {
        await this.assertNombreDisponible(manager, distributorId, dto.name, id);
        rol.name = dto.name;
      }
      if (dto.description !== undefined) {
        rol.description = dto.description;
      }
      const antes = await contarGestoresDeRoles(manager, distributorId);
      if (permisos) rol.permissions = permisos;
      await manager.getRepository(StaffRole).save(rol);
      assertQuedaQuienGestioneRoles(
        antes,
        await contarGestoresDeRoles(manager, distributorId),
      );
      const conteo = await this.contarAdminsPorRol(manager, [id]);
      const afectados = permisos
        ? (
            await manager
              .getRepository(Admin)
              .find({ select: { userId: true }, where: { staffRoleId: id } })
          ).map((a) => a.userId)
        : [];
      return { rol, adminCount: conteo.get(id) ?? 0, afectados };
    });
    this.avisarPermisosCambiados(resultado.afectados);
    return { rol: resultado.rol, adminCount: resultado.adminCount };
  }

  /** Baja lógica. El de sistema y uno con admins asignados no se dan de baja (409). */
  async remove(id: string, distributorId: string): Promise<MessageResponseDto> {
    await this.enTransaccion(async (manager) => {
      await this.bloquear(manager, distributorId);
      const rol = await this.vigente(manager, id, distributorId);
      this.assertNoEsDeSistema(rol, 'dar de baja');
      const asignados = (await this.contarAdminsPorRol(manager, [id])).get(id);
      if (asignados) {
        throw conCodigo(
          ConflictException,
          409,
          `El rol "${rol.name}" lo tienen ${asignados} administrador(es): asignales otro rol antes de darlo de baja`,
          CODIGOS_DE_ERROR.STAFF_ROLE_HAS_ADMINS,
        );
      }
      // Los admins dados de baja que lo tenían conservan la referencia.
      await manager.getRepository(StaffRole).softRemove(rol);
    });
    return MessageResponseDto.of('Rol dado de baja');
  }

  /**
   * Asigna un rol de la distribuidora a uno de sus admins. Un admin de otra
   * distribuidora, un super admin o uno dado de baja responden 404, igual que
   * un rol de otra distribuidora o dado de baja.
   */
  async asignar(
    adminId: string,
    staffRoleId: string,
    distributorId: string,
    actor: Actor,
  ): Promise<AsignacionDeRol> {
    const asignacion = await this.enTransaccion(async (manager) => {
      await this.bloquear(manager, distributorId);
      const admin = await manager
        .getRepository(Admin)
        .createQueryBuilder('a')
        .innerJoin('a.user', 'u')
        .innerJoin('u.role', 'r')
        .where('a.adminId = :adminId', { adminId })
        .andWhere('a.distributorId = :distributorId', { distributorId })
        .andWhere('u.deletedAt IS NULL')
        .andWhere('r.type = :tipo', { tipo: RoleType.ADMIN })
        .getOne();
      if (!admin) {
        throw new NotFoundException('Administrador no encontrado');
      }
      if (actor.role === RoleType.ADMIN && admin.userId === actor.user_id) {
        throw conCodigo(
          ForbiddenException,
          403,
          'No podés cambiar tu propio rol: pedíselo a otro administrador',
          CODIGOS_DE_ERROR.STAFF_ROLE_SELF_ASSIGN,
        );
      }
      const rol = await this.vigente(manager, staffRoleId, distributorId);
      // Sin cambio no se da ni se saca nada: no hay nada que controlar.
      if (admin.staffRoleId === rol.staffRoleId) {
        return { adminId: admin.adminId, userId: admin.userId, rol };
      }
      await this.assertTieneLoQueDa(
        manager,
        actor,
        rol.isSystem ? 'todos' : rol.permissions.filter(esPermiso),
      );
      // Tampoco se le cambia el rol a quien tiene permisos que el actor no tiene.
      await this.assertPuedeCambiarleElRol(
        manager,
        actor,
        admin.staffRoleId,
        distributorId,
      );
      const antes = await contarGestoresDeRoles(manager, distributorId);
      await manager
        .getRepository(Admin)
        .update({ adminId }, { staffRoleId: rol.staffRoleId });
      assertQuedaQuienGestioneRoles(
        antes,
        await contarGestoresDeRoles(manager, distributorId),
      );
      return { adminId: admin.adminId, userId: admin.userId, rol };
    });
    this.avisarPermisosCambiados([asignacion.userId]);
    return asignacion;
  }

  /** Después del commit: las conexiones en vivo de esas personas reevalúan sus salas. */
  private avisarPermisosCambiados(userIds: readonly string[]): void {
    if (userIds.length === 0) return;
    this.events.emit(
      EVENTO_PERMISOS_CAMBIADOS,
      new PermisosCambiadosEvent(userIds),
    );
  }

  /**
   * Nadie da lo que no tiene: los permisos de un rol que se crea, se edita o se
   * asigna tienen que estar entre los efectivos de quien lo hace (el super
   * admin y el rol de sistema tienen todos). Se leen en la misma transacción.
   */
  private async assertTieneLoQueDa(
    manager: EntityManager,
    actor: Actor,
    pedidos: readonly Permiso[] | 'todos',
  ): Promise<void> {
    const propios = await this.permisos.deUsuario(
      actor.user_id,
      actor.role,
      manager,
      actor.actuaComoEmpresaPropia === true,
    );
    if (propios.todos) return;
    const faltan =
      pedidos === 'todos'
        ? null
        : pedidos.filter((p) => !propios.permisos.includes(p));
    if (faltan && faltan.length === 0) return;
    throw conCodigo(
      ForbiddenException,
      403,
      faltan
        ? `No podés dar permisos que no tenés: ${faltan.map((p) => `«${p}»`).join(', ')}`
        : 'No podés dar el rol de sistema: tiene todos los permisos y vos no',
      CODIGOS_DE_ERROR.STAFF_ROLE_PERMISSION_NOT_HELD,
    );
  }

  /**
   * Editar los permisos de un rol que tienen administradores no puede
   * sacarles algo que el actor no tiene: sería bajar a quien tiene más por
   * otra puerta. Sobre un rol sin administradores no hay a quién bajar.
   */
  private async assertPuedeQuitar(
    manager: EntityManager,
    actor: Actor,
    rol: StaffRole,
    nuevos: readonly Permiso[],
  ): Promise<void> {
    const quitados = rol.permissions
      .filter(esPermiso)
      .filter((p) => !nuevos.includes(p));
    if (quitados.length === 0) return;
    const asignados =
      (await this.contarAdminsPorRol(manager, [rol.staffRoleId])).get(
        rol.staffRoleId,
      ) ?? 0;
    if (asignados === 0) return;
    const propios = await this.permisos.deUsuario(
      actor.user_id,
      actor.role,
      manager,
      actor.actuaComoEmpresaPropia === true,
    );
    if (propios.todos) return;
    const faltan = quitados.filter((p) => !propios.permisos.includes(p));
    if (faltan.length === 0) return;
    throw conCodigo(
      ForbiddenException,
      403,
      `No podés sacarle al rol permisos que vos no tenés (${faltan.map((p) => `«${p}»`).join(', ')}): lo tienen administradores asignados`,
      CODIGOS_DE_ERROR.STAFF_ROLE_TARGET_OUTRANKS,
    );
  }

  /**
   * Dar de alta un cliente pide `clientes.gestionar` y un chofer
   * `personal.gestionar` (el de un admin lo controla `rolParaElAlta`).
   */
  async assertPuedeDarDeAlta(
    actor: Actor,
    rol: RoleType.CUSTOMER | RoleType.DELIVERY,
  ): Promise<void> {
    const propios = await this.permisos.deUsuario(
      actor.user_id,
      actor.role,
      this.dataSource.manager,
      actor.actuaComoEmpresaPropia === true,
    );
    const pedido: Permiso =
      rol === RoleType.CUSTOMER ? 'clientes.gestionar' : 'personal.gestionar';
    if (propios.todos || propios.permisos.includes(pedido)) return;
    throw conCodigo(
      ForbiddenException,
      403,
      rol === RoleType.CUSTOMER
        ? 'No tenés permiso para dar de alta clientes'
        : 'No tenés permiso para dar de alta choferes',
      CODIGOS_DE_ERROR.PERMISSION_DENIED,
    );
  }

  /**
   * El rol del personal de un administrador que se da de alta. Hace falta
   * `administradores.gestionar`; con `staffRoleId`, el actor tiene que poder
   * dar ese rol; sin él, el admin nuevo queda con el rol de sistema (todos los
   * permisos), y eso sólo lo puede dar quien tiene todos. Devuelve el id a
   * guardar, o null para que la base ponga el de sistema.
   */
  async rolParaElAlta(
    actor: Actor,
    distributorId: string,
    staffRoleId: string | undefined,
  ): Promise<string | null> {
    return this.decidirRolDelAlta(
      this.dataSource.manager,
      actor,
      distributorId,
      staffRoleId,
    );
  }

  /**
   * La misma decisión de `rolParaElAlta`, de nuevo DENTRO de la transacción
   * del alta y con el cerrojo de los roles de la distribuidora (el que toman
   * la edición, la baja y la asignación de roles): si entre el primer control
   * y el insert le sacaron permisos al actor o cambiaron el rol elegido, el
   * alta se rechaza y la transacción se revierte. Va antes de cualquier
   * escritura del alta, para respetar el orden de los locks.
   */
  async confirmarRolDelAlta(
    manager: EntityManager,
    actor: Actor,
    distributorId: string,
    staffRoleId: string | null,
  ): Promise<void> {
    await this.bloquear(manager, distributorId);
    await this.decidirRolDelAlta(
      manager,
      actor,
      distributorId,
      staffRoleId ?? undefined,
    );
  }

  private async decidirRolDelAlta(
    manager: EntityManager,
    actor: Actor,
    distributorId: string,
    staffRoleId: string | undefined,
  ): Promise<string | null> {
    const propios = await this.permisos.deUsuario(
      actor.user_id,
      actor.role,
      manager,
      actor.actuaComoEmpresaPropia === true,
    );
    if (
      !propios.todos &&
      !propios.permisos.includes('administradores.gestionar')
    ) {
      throw conCodigo(
        ForbiddenException,
        403,
        'No tenés permiso para dar de alta administradores',
        CODIGOS_DE_ERROR.PERMISSION_DENIED,
      );
    }
    if (staffRoleId) {
      const rol = await this.vigente(manager, staffRoleId, distributorId);
      await this.assertTieneLoQueDa(
        manager,
        actor,
        rol.isSystem ? 'todos' : rol.permissions.filter(esPermiso),
      );
      return rol.staffRoleId;
    }
    if (propios.todos) return null;
    throw conCodigo(
      BadRequestException,
      400,
      'Elegí el rol del personal del administrador nuevo: el de sistema sólo lo da quien tiene todos los permisos',
      CODIGOS_DE_ERROR.STAFF_ROLE_REQUIRED,
    );
  }

  /**
   * Regla de producto (17/11): nadie sube ni baja a quien tiene más permisos.
   * Para modificar, bloquear o dar de baja la cuenta de OTRO usuario:
   * - cliente: `clientes.gestionar`; chofer: `personal.gestionar`;
   * - administrador de la empresa: `administradores.gestionar` y todos los
   *   permisos de su rol de personal (si es el de sistema, todos);
   * - la contraseña de otro administrador no se cambia desde la API: sólo el
   *   super admin (403 `ADMIN_PASSWORD_NOT_CHANGEABLE`).
   * El super admin y la empresa propia (y quien tiene el rol de sistema)
   * tienen todos los permisos y pasan. La cuenta propia no pasa por acá: sus
   * reglas son otras. Un super admin como destino, para quien no tiene todos,
   * es 404 (no es de ninguna distribuidora).
   */
  async assertPuedeAdministrarA(
    actor: Actor,
    destino: CuentaDestino,
    distributorId: string | null,
    opciones: OpcionesSobreCuentas = {},
  ): Promise<void> {
    if (destino.userId.toLowerCase() === actor.user_id.toLowerCase()) return;
    const esAdmin = destino.rol === String(RoleType.ADMIN);
    const esSuperAdmin =
      actor.role === RoleType.SUPER_ADMIN ||
      actor.actuaComoEmpresaPropia === true;
    if (opciones.cambiaContraseña && esAdmin && !esSuperAdmin) {
      throw conCodigo(
        ForbiddenException,
        403,
        'No podés cambiar la contraseña de otro administrador: la cambia él desde su cuenta, con el enlace para restablecerla',
        CODIGOS_DE_ERROR.ADMIN_PASSWORD_NOT_CHANGEABLE,
      );
    }
    if (esSuperAdmin) return;
    const manager = opciones.manager ?? this.dataSource.manager;
    // Sobre un administrador, dentro de la transacción que escribe: primero
    // el cerrojo de los roles de la empresa (el que toman la edición y la
    // asignación de roles) y recién después se leen los permisos de los dos.
    // El cerrojo va antes de leer el rol del destino: si no, un cambio de rol
    // confirmado mientras se espera el cerrojo quedaría sin ver.
    if (esAdmin && opciones.manager && distributorId) {
      await this.bloquear(manager, distributorId);
    }
    const perfil = esAdmin
      ? await manager
          .getRepository(Admin)
          .findOne({ where: { userId: destino.userId } })
      : null;
    const tenant = distributorId ?? perfil?.distributorId ?? null;
    if (esAdmin && opciones.manager && !distributorId && tenant) {
      await this.bloquear(manager, tenant);
    }
    const propios = await this.permisos.deUsuario(
      actor.user_id,
      actor.role,
      manager,
      false,
    );
    if (propios.todos) return;
    const pedido = permisoParaAdministrar(destino.rol);
    if (!pedido) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (!propios.permisos.includes(pedido)) {
      throw conCodigo(
        ForbiddenException,
        403,
        `No tenés permiso para ${etiquetaDelPermiso(pedido)}`,
        CODIGOS_DE_ERROR.PERMISSION_DENIED,
      );
    }
    if (!esAdmin || !perfil?.staffRoleId || !tenant) return;
    const falta = await this.faltaParaCubrir(
      manager,
      propios,
      perfil.staffRoleId,
      tenant,
    );
    if (!falta) return;
    throw conCodigo(
      ForbiddenException,
      403,
      falta === 'sistema'
        ? 'No podés modificar, bloquear ni dar de baja a este administrador: tiene el rol de sistema y vos no tenés todos los permisos'
        : `No podés modificar, bloquear ni dar de baja a este administrador: tiene permisos que vos no tenés (${falta.map((p) => `«${p}»`).join(', ')})`,
      CODIGOS_DE_ERROR.STAFF_ROLE_TARGET_OUTRANKS,
    );
  }

  /**
   * Qué le falta al actor para cubrir el rol de personal que tiene hoy otra
   * persona: `null` si lo cubre (o el rol no existe en la distribuidora o está
   * dado de baja: no hay nada que proteger), `'sistema'` si es el de sistema
   * y el actor no tiene todos, o la lista de permisos que le faltan.
   */
  private async faltaParaCubrir(
    manager: EntityManager,
    propios: PermisosDelUsuario,
    rolId: string,
    distributorId: string,
  ): Promise<Permiso[] | 'sistema' | null> {
    if (propios.todos) return null;
    const actual = await manager
      .getRepository(StaffRole)
      .findOne({ where: { staffRoleId: rolId, distributorId } });
    if (!actual) return null;
    if (actual.isSystem) return 'sistema';
    const faltan = actual.permissions
      .filter(esPermiso)
      .filter((p) => !propios.permisos.includes(p));
    return faltan.length > 0 ? faltan : null;
  }

  /**
   * Para cambiarle el rol a un administrador, el actor tiene que tener todos
   * los permisos del rol que esa persona tiene hoy (y, si es el de sistema,
   * todos los permisos). Sin rol actual no hay nada que proteger.
   */
  private async assertPuedeCambiarleElRol(
    manager: EntityManager,
    actor: Actor,
    rolActualId: string | null,
    distributorId: string,
  ): Promise<void> {
    if (!rolActualId) return;
    const propios = await this.permisos.deUsuario(
      actor.user_id,
      actor.role,
      manager,
      actor.actuaComoEmpresaPropia === true,
    );
    const falta = await this.faltaParaCubrir(
      manager,
      propios,
      rolActualId,
      distributorId,
    );
    if (!falta) return;
    throw conCodigo(
      ForbiddenException,
      403,
      falta === 'sistema'
        ? 'No podés cambiarle el rol: tiene el rol de sistema y vos no tenés todos los permisos'
        : `No podés cambiarle el rol: tiene permisos que vos no tenés (${falta.map((p) => `«${p}»`).join(', ')})`,
      CODIGOS_DE_ERROR.STAFF_ROLE_TARGET_OUTRANKS,
    );
  }

  /** Un admin no edita el rol que tiene asignado (se daría permisos a sí mismo). */
  private async assertNoEsSuPropioRol(
    manager: EntityManager,
    actor: Actor,
    rol: StaffRole,
  ): Promise<void> {
    if (actor.role !== RoleType.ADMIN) return;
    const propios = await this.permisos.deUsuario(
      actor.user_id,
      actor.role,
      manager,
      actor.actuaComoEmpresaPropia === true,
    );
    if (propios.rol?.staffRoleId === rol.staffRoleId) {
      throw conCodigo(
        ForbiddenException,
        403,
        `No podés editar "${rol.name}" porque es tu propio rol: pedíselo a otro administrador que gestione los roles`,
        CODIGOS_DE_ERROR.STAFF_ROLE_OWN_ROLE,
      );
    }
  }

  private assertNoEsDeSistema(rol: StaffRole, accion: string): void {
    if (rol.isSystem) {
      throw conCodigo(
        ConflictException,
        409,
        `"${rol.name}" es el rol de sistema: tiene todos los permisos y no se puede ${accion}`,
        CODIGOS_DE_ERROR.STAFF_ROLE_IS_SYSTEM,
      );
    }
  }

  private async vigente(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<StaffRole> {
    const rol = await manager
      .getRepository(StaffRole)
      .findOne({ where: { staffRoleId: id, distributorId } });
    if (!rol) {
      throw new NotFoundException('Rol no encontrado');
    }
    return rol;
  }

  /**
   * Serializa las escrituras de roles, asignaciones y bajas/bloqueos de admins
   * de una distribuidora: la regla de «alguien gestiona los roles» se cuenta y
   * se verifica sin que otra escritura cambie el resultado en el medio. Los
   * locks van en el mismo orden que en `UsersService`.
   */
  private async bloquear(
    manager: EntityManager,
    distributorId: string,
  ): Promise<void> {
    await bloquearGestoresDeRoles(manager, distributorId);
  }

  private async assertNombreDisponible(
    manager: EntityManager,
    distributorId: string,
    nombre: string,
    excluirId?: string,
  ): Promise<void> {
    const consulta = manager
      .getRepository(StaffRole)
      .createQueryBuilder('sr')
      .where('sr.distributorId = :distributorId', { distributorId })
      .andWhere('LOWER(sr.name) = LOWER(:nombre)', { nombre });
    if (excluirId) {
      consulta.andWhere('sr.staffRoleId <> :excluirId', { excluirId });
    }
    if (await consulta.getExists()) {
      throw conCodigo(
        ConflictException,
        409,
        `Ya existe un rol llamado "${nombre}"`,
        CODIGOS_DE_ERROR.STAFF_ROLE_NAME_TAKEN,
      );
    }
  }

  /** Admins no dados de baja por rol. */
  private async contarAdminsPorRol(
    manager: EntityManager,
    ids: string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const filas: { staff_role_id: string; n: number }[] = await manager.query(
      `SELECT a."staff_role_id", count(*)::int AS n FROM "admin" a
         JOIN "user" u ON u."user_id" = a."user_id" AND u."deletedAt" IS NULL
        WHERE a."staff_role_id" = ANY($1::uuid[])
        GROUP BY a."staff_role_id"`,
      [ids],
    );
    return new Map(filas.map((f) => [f.staff_role_id, Number(f.n)]));
  }

  private async enTransaccion<T>(
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await withTransactionRetry(() => this.dataSource.transaction(fn), {
        context: 'rol de personal',
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'rol de personal');
    }
  }
}

/** El permiso que pide administrar la cuenta de cada rol; `null` si no se administra (super admin). */
function permisoParaAdministrar(rol: string | undefined): Permiso | null {
  switch (rol) {
    case String(RoleType.CUSTOMER):
      return 'clientes.gestionar';
    case String(RoleType.DELIVERY):
      return 'personal.gestionar';
    case String(RoleType.ADMIN):
      return 'administradores.gestionar';
    default:
      return null;
  }
}
