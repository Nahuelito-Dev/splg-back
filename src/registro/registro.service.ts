import {
  BadRequestException,
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
import { StaffRoleService } from '../admin/staff-role.service';
import { EmployeeService } from '../employee/employee.service';
import { ConsumptionService } from '../repurchase/consumption.service';
import type { ConsumoDeclarado } from '../customer/customer.service';
import { DistributorService } from '../distributor/distributor.service';
import { RoleType } from '../common/constants/role-type.enum';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { CODIGOS_DE_ERROR, conCodigo } from '../common/errors/con-codigo';
import { normalizarEmail } from '../common/utils/email.util';
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
 *    por el servicio dueño de su tabla. Un chofer es un empleado (CU-177):
 *    su legajo se crea en la misma transacción, o se vincula el existente si
 *    el pedido trae `employeeId`. Lo mismo vale para un admin de distribuidora.
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
    private readonly staffRoles: StaffRoleService,
    private readonly distributors: DistributorService,
    private readonly employees: EmployeeService,
    private readonly eventos: EventEmitter2,
    private readonly consumption: ConsumptionService,
  ) {}

  async registrar(
    datos: RegistrarUsuarioDto,
    solicitante: Solicitante,
    distribuidoraEnContexto: string | null = null,
  ): Promise<User> {
    const alta = autorizarAlta(solicitante, datos.rol, datos.distributorId);
    if (alta.distributorId) {
      await this.distributors.assertActive(alta.distributorId);
    }
    const vinculo = this.distribuidoraDelCliente(
      alta,
      solicitante,
      datos,
      distribuidoraEnContexto,
    );
    if (vinculo && vinculo !== alta.distributorId) {
      await this.distributors.assertActive(vinculo);
    }

    const rol = await this.roles.findByType(alta.rol);
    if (!rol) {
      throw new InternalServerErrorException(
        `No existe el rol ${alta.rol}: falta correr el seed de roles`,
      );
    }

    if (
      (datos.employeeId || datos.legajo) &&
      alta.rol !== RoleType.DELIVERY &&
      alta.rol !== RoleType.ADMIN
    ) {
      throw new BadRequestException(
        'Vincular un legajo existente o crear uno sólo vale para choferes y administradores',
      );
    }
    if (datos.employeeId && datos.legajo) {
      throw new BadRequestException(
        'Indicá un legajo existente para vincular o los datos de un legajo nuevo para crear, no los dos',
      );
    }

    // El rol del personal de un admin se decide antes de crear la cuenta:
    // dar de alta un admin no puede servir para darle más de lo que uno tiene.
    if (datos.staffRoleId && alta.rol !== RoleType.ADMIN) {
      throw conCodigo(
        BadRequestException,
        400,
        'El rol del personal sólo vale para administradores de distribuidora',
        CODIGOS_DE_ERROR.STAFF_ROLE_ONLY_FOR_ADMINS,
      );
    }
    if (
      solicitante.tipo === 'usuario' &&
      (alta.rol === RoleType.CUSTOMER || alta.rol === RoleType.DELIVERY)
    ) {
      await this.staffRoles.assertPuedeDarDeAlta(solicitante.usuario, alta.rol);
    }
    const rolDelPersonal =
      alta.rol === RoleType.ADMIN && solicitante.tipo === 'usuario'
        ? await this.staffRoles.rolParaElAlta(
            solicitante.usuario,
            this.distribuidoraDe(alta),
            datos.staffRoleId,
          )
        : (datos.staffRoleId ?? null);

    // CU-143: se valida antes de crear la cuenta en Firebase, para no
    // crearla y borrarla si el consumo declarado es inválido.
    const consumo =
      alta.rol === RoleType.CUSTOMER && datos.consumption
        ? await this.consumption.calcularDeclaracion(datos.consumption)
        : undefined;

    const email = normalizarEmail(datos.email);
    await this.users.assertDisponible(email, datos.phone_number);

    const cuenta = await this.firebaseAuth.createUserSafe({
      email,
      password: datos.password,
      full_name: datos.full_name,
      phone_number: datos.phone_number,
    });

    let userId: string;
    try {
      userId = await this.dataSource.transaction(async (manager) => {
        // El rol del personal se volvió a decidir con el cerrojo de los roles
        // tomado: lo controlado arriba pudo cambiar mientras se creaba la
        // cuenta de Firebase (permisos del actor, rol dado de baja o editado).
        if (alta.rol === RoleType.ADMIN && solicitante.tipo === 'usuario') {
          await this.staffRoles.confirmarRolDelAlta(
            manager,
            solicitante.usuario,
            this.distribuidoraDe(alta),
            rolDelPersonal,
          );
        }
        const user = await this.users.crearEnTransaccion(manager, {
          email,
          fullName: datos.full_name,
          phoneNumber: datos.phone_number,
          firebaseUid: cuenta.uid,
          roleId: rol.roleId,
        });
        await this.crearPerfil(
          manager,
          user.userId,
          alta,
          datos,
          consumo,
          rolDelPersonal,
        );
        if (vinculo && solicitante.tipo === 'usuario') {
          await this.customers.vincularConDistribuidora(
            manager,
            user.userId,
            vinculo,
            solicitante.usuario.user_id,
          );
        }
        return user.userId;
      });
    } catch (error) {
      await this.firebaseAuth.deleteUserSafe(cuenta.uid, this.logger);
      traducirErrorDeBase(error, this.logger, 'usuarios');
    }

    this.eventos.emit(
      EVENTO_USUARIO_REGISTRADO,
      new UsuarioRegistradoEvent(userId, email, datos.full_name, alta.rol),
    );
    return this.users.findOne(userId);
  }

  /**
   * La distribuidora que queda dueña de un cliente dado de alta desde el
   * panel: la del admin que lo crea; para un super admin, la que indique
   * (cuerpo) o la del contexto (`X-Distributor`). Sin ninguna, el cliente
   * queda sólo en la plataforma. Un alta pública o del sistema no vincula.
   */
  private distribuidoraDelCliente(
    alta: AltaAutorizada,
    solicitante: Solicitante,
    datos: RegistrarUsuarioDto,
    contexto: string | null,
  ): string | null {
    if (alta.rol !== RoleType.CUSTOMER || solicitante.tipo !== 'usuario') {
      return null;
    }
    const { usuario } = solicitante;
    if (usuario.role === RoleType.ADMIN) return usuario.distributor_id ?? null;
    return datos.distributorId ?? contexto ?? usuario.distributor_id ?? null;
  }

  /** El perfil que corresponde al rol, por el servicio dueño de su tabla. */
  private async crearPerfil(
    manager: EntityManager,
    userId: string,
    alta: AltaAutorizada,
    datos: RegistrarUsuarioDto,
    consumo?: ConsumoDeclarado,
    rolDelPersonal: string | null = null,
  ): Promise<void> {
    switch (alta.rol) {
      case RoleType.CUSTOMER:
        return this.customers.crearPerfil(manager, userId, {
          lat_lang: datos.lat_lang,
          notification_token: datos.notification_token,
          consumo,
        });
      case RoleType.DELIVERY: {
        const distributorId = this.distribuidoraDe(alta);
        await this.deliveries.crearPerfil(manager, userId, distributorId, {
          latLng: datos.latLng,
          actual_location: datos.actual_location,
          validated: datos.validated,
          // El campo del alta se sigue llamando `isActive` (contrato
          // externo, lo usan el panel y el seed): internamente ahora es la
          // habilitación administrativa (`delivery.isEnabled`).
          isEnabled: datos.isActive,
        });
        await this.legajoDelUsuario(
          manager,
          userId,
          distributorId,
          alta,
          datos,
        );
        return;
      }
      case RoleType.ADMIN: {
        const distributorId = this.distribuidoraDe(alta);
        await this.admins.crearPerfil(
          manager,
          userId,
          distributorId,
          rolDelPersonal,
        );
        await this.legajoDelUsuario(
          manager,
          userId,
          distributorId,
          alta,
          datos,
        );
        return;
      }
      case RoleType.SUPER_ADMIN:
        return this.admins.crearPerfil(manager, userId, null);
    }
  }

  /**
   * El legajo del chofer o del admin de distribuidora: se crea, o se vincula
   * el que trae `employeeId`.
   */
  private async legajoDelUsuario(
    manager: EntityManager,
    userId: string,
    distributorId: string,
    alta: AltaAutorizada,
    datos: RegistrarUsuarioDto,
  ): Promise<void> {
    if (datos.employeeId) {
      await this.employees.vincularUsuario(manager, {
        employeeId: datos.employeeId,
        userId,
        distributorId,
        rol: alta.rol,
      });
      return;
    }
    if (alta.rol === RoleType.DELIVERY || alta.rol === RoleType.ADMIN) {
      await this.employees.crearParaUsuario(manager, {
        rol: alta.rol,
        distributorId,
        userId,
        fullName: datos.full_name,
        phoneNumber: datos.phone_number,
        legajo: datos.legajo,
      });
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
