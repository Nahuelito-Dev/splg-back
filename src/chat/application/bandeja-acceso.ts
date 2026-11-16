import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { StaffPermissionsService } from '../../admin/staff-permissions.service';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { Permiso } from '../../common/permisos/catalogo';
import {
  type CanalDeLaBandeja,
  canalesQueAtiende,
  permisoDelCanal,
} from '../domain/bandeja';
import { Channel, Party } from '../domain/chat.enums';
import { ConversacionNoEncontradaError } from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import type { Lector } from '../infrastructure/chat-read-model';
import { sinPermiso } from './bandeja.errors';

/**
 * Quién usa la bandeja en esta request: el personal (con los canales que
 * atiende según su rol), el cliente (C3) o el chofer (C2), siempre dentro de
 * UNA empresa (la del perfil o la del `X-Distributor` del cliente).
 */
export interface ActorDeLaBandeja {
  party: Party.COMPANY | Party.CUSTOMER | Party.DRIVER;
  userId: string;
  distributorId: string;
  canales: readonly CanalDeLaBandeja[];
  /** Los permisos efectivos del personal (vacío para el cliente y el chofer). */
  permisos: readonly Permiso[];
}

export const lectorDe = (actor: ActorDeLaBandeja): Lector => ({
  party: actor.party,
  userId: actor.userId,
});

export const esDelPersonal = (actor: ActorDeLaBandeja): boolean =>
  actor.party === Party.COMPANY;

/**
 * Resuelve el actor y busca las conversaciones con el aislamiento de la
 * bandeja: de otra empresa, de un canal que no atiende o (cliente y chofer) de
 * otra persona → 404, sin decir si existe.
 */
@Injectable()
export class BandejaAcceso {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly permisos: StaffPermissionsService,
  ) {}

  async delPersonal(
    user: AuthenticatedUser,
    distributorId: string,
  ): Promise<ActorDeLaBandeja> {
    const { permisos } = await this.permisos.deUsuario(
      user.user_id,
      RoleType.ADMIN,
      undefined,
      user.actuaComoEmpresaPropia === true,
    );
    return {
      party: Party.COMPANY,
      userId: user.user_id,
      distributorId,
      canales: canalesQueAtiende(permisos),
      permisos,
    };
  }

  /** El cliente habla con la empresa por C3; el chofer, por C2. */
  deLaPersona(
    user: AuthenticatedUser,
    distributorId: string,
  ): ActorDeLaBandeja {
    const chofer = user.role === RoleType.DELIVERY;
    return {
      party: chofer ? Party.DRIVER : Party.CUSTOMER,
      userId: user.user_id,
      distributorId,
      canales: [chofer ? Channel.STAFF_DRIVER : Channel.STAFF_CUSTOMER],
      permisos: [],
    };
  }

  /** 403 si el personal no atiende ese canal. */
  assertAtiende(actor: ActorDeLaBandeja, canal: CanalDeLaBandeja): void {
    if (!actor.canales.includes(canal))
      throw sinPermiso(permisoDelCanal(canal));
  }

  async buscar(
    actor: ActorDeLaBandeja,
    conversationId: string,
    manager: EntityManager = this.dataSource.manager,
    opciones: {
      bloquear?: boolean;
      canales?: readonly CanalDeLaBandeja[];
    } = {},
  ): Promise<Conversation> {
    const canales = (opciones.canales ?? actor.canales).filter((c) =>
      actor.canales.includes(c),
    );
    if (canales.length === 0) throw new ConversacionNoEncontradaError();
    const c = await manager.getRepository(Conversation).findOne({
      where: {
        conversationId,
        distributorId: actor.distributorId,
        channel: In([...canales]),
        ...(actor.party === Party.CUSTOMER
          ? { customerUserId: actor.userId }
          : actor.party === Party.DRIVER
            ? { driverUserId: actor.userId }
            : {}),
      },
      ...(opciones.bloquear ? { lock: { mode: 'pessimistic_write' } } : {}),
    });
    if (!c) throw new ConversacionNoEncontradaError();
    return c;
  }
}
