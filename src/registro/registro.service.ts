import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { RoleService } from '../role/role.service';
import { CustomersService } from '../customer/customer.service';
import { DeliveryService } from '../delivery/delivery.service';
import { AdminService } from '../admin/admin.service';
import { DistributorService } from '../distributor/distributor.service';
import { RoleType } from '../common/constants/role-type.enum';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { RegistrarUsuarioDto } from './dto/registrar-usuario.dto';
import {
  AltaAutorizada,
  Solicitante,
  autorizarAlta,
} from './politica-de-registro';
import {
  EVENTO_USUARIO_REGISTRADO,
  UsuarioRegistradoEvent,
} from './events/usuario-registrado.event';

/**
 * El alta de usuarios, una sola para todos los roles (CU-082, incluido por
 * CU-002, CU-003/031, CU-086 y CU-087).
 *
 * 1. `autorizarAlta` decide si el solicitante puede crear ese rol y en qué
 *    distribuidora.
 * 2. Se controla que el correo y el teléfono estén libres.
 * 3. Se crea la cuenta en Firebase.
 * 4. En UNA transacción: la fila del usuario y el perfil de su rol, cada uno
 *    por el servicio dueño de su tabla.
 * 5. Si el paso 4 falla, se borra la cuenta de Firebase del paso 3, por su
 *    uid: nunca una que no haya creado esta llamada (H-70).
 * 6. Confirmada el alta, se publica `usuario.registrado`.
 */
@Injectable()
export class RegistroService {
  private readonly logger = new Logger(RegistroService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly firebaseAuth: FirebaseAuthPort,
    private readonly users: UsersService,
    private readonly roles: RoleService,
    private readonly customers: CustomersService,
    private readonly deliveries: DeliveryService,
    private readonly admins: AdminService,
    private readonly distributors: DistributorService,
    private readonly eventos: EventEmitter2,
  ) {}

  async registrar(
    datos: RegistrarUsuarioDto,
    solicitante: Solicitante,
  ): Promise<User> {
    const alta = autorizarAlta(solicitante, datos.rol, datos.distributorId);
    if (alta.distributorId) {
      await this.distributors.assertActive(alta.distributorId);
    }

    const rol = await this.roles.findByType(alta.rol);
    if (!rol) {
      throw new InternalServerErrorException(
        `No existe el rol ${alta.rol}: falta correr el seed de roles`,
      );
    }

    await this.users.assertDisponible(datos.email, datos.phone_number);

    const cuenta = await this.firebaseAuth.createUserSafe({
      email: datos.email,
      password: datos.password,
      full_name: datos.full_name,
      phone_number: datos.phone_number,
    });

    let userId: string;
    try {
      userId = await this.dataSource.transaction(async (manager) => {
        const user = await this.users.crearEnTransaccion(manager, {
          email: datos.email,
          fullName: datos.full_name,
          phoneNumber: datos.phone_number,
          selfie: datos.selfie,
          firebaseUid: cuenta.uid,
          roleId: rol.roleId,
        });
        await this.crearPerfil(manager, user.userId, alta, datos);
        return user.userId;
      });
    } catch (error) {
      await this.firebaseAuth.deleteUserSafe(cuenta.uid, this.logger);
      traducirErrorDeBase(error, this.logger, 'usuarios');
    }

    this.eventos.emit(
      EVENTO_USUARIO_REGISTRADO,
      new UsuarioRegistradoEvent(
        userId,
        datos.email,
        datos.full_name,
        alta.rol,
      ),
    );
    return this.users.findOne(userId);
  }

  /** El perfil que corresponde al rol, por el servicio dueño de su tabla. */
  private async crearPerfil(
    manager: EntityManager,
    userId: string,
    alta: AltaAutorizada,
    datos: RegistrarUsuarioDto,
  ): Promise<void> {
    switch (alta.rol) {
      case RoleType.CUSTOMER:
        return this.customers.crearPerfil(manager, userId, {
          lat_lang: datos.lat_lang,
          notification_token: datos.notification_token,
          validated: datos.validated,
        });
      case RoleType.DELIVERY:
        return this.deliveries.crearPerfil(
          manager,
          userId,
          this.distribuidoraDe(alta),
          {
            latLng: datos.latLng,
            actual_location: datos.actual_location,
            validated: datos.validated,
            isActive: datos.isActive,
          },
        );
      case RoleType.ADMIN:
        return this.admins.crearPerfil(
          manager,
          userId,
          this.distribuidoraDe(alta),
        );
      case RoleType.SUPER_ADMIN:
        return this.admins.crearPerfil(manager, userId, null);
    }
  }

  /** La política ya garantiza la distribuidora de choferes y admins. */
  private distribuidoraDe(alta: AltaAutorizada): string {
    if (!alta.distributorId) {
      throw new InternalServerErrorException(
        `Alta de ${alta.rol} sin distribuidora`,
      );
    }
    return alta.distributorId;
  }
}
