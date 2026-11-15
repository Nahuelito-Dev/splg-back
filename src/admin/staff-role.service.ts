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
  ordenarPermisos,
  permisosDesconocidos,
  type Permiso,
} from '../common/permisos/catalogo';
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
export class StaffRoleService {
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
      if (permisos) await this.assertTieneLoQueDa(manager, actor, permisos);
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
      await this.assertTieneLoQueDa(
        manager,
        actor,
        rol.isSystem ? 'todos' : rol.permissions.filter(esPermiso),
      );
      if (admin.staffRoleId !== rol.staffRoleId) {
        const antes = await contarGestoresDeRoles(manager, distributorId);
        await manager
          .getRepository(Admin)
          .update({ adminId }, { staffRoleId: rol.staffRoleId });
        assertQuedaQuienGestioneRoles(
          antes,
          await contarGestoresDeRoles(manager, distributorId),
        );
      }
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
