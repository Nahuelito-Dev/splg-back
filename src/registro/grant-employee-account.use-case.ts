import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { RegistroService } from './registro.service';
import type { Solicitante } from './politica-de-registro';
import { EmployeeService } from '../employee/employee.service';
import { GrantEmployeeAccountDto } from '../employee/dto/grant-account.dto';
import { EmployeeConPuesto } from '../employee/employee.mapper';
import { EmployeeStatus } from '../employee/entities/employee.entity';
import {
  puedeOtorgarseCuenta,
  rolDeAcceso,
} from '../employee/domain/access-role';
import { valorLegible } from '../common/validation/etiquetas';

/**
 * Otorgar una cuenta de acceso a un empleado (CU-182): el rol sale de la
 * categoría de su puesto y el alta es la misma de CU-082 (`RegistroService`),
 * que crea el usuario y su perfil y vincula el legajo en una sola
 * transacción. Vive en `registro/` y no en `employee/` para que `employee` no
 * dependa del alta de usuarios (que ya depende de `employee`): sin ciclo.
 */
@Injectable()
export class GrantEmployeeAccountUseCase {
  constructor(
    private readonly employees: EmployeeService,
    private readonly registro: RegistroService,
  ) {}

  async execute(
    employeeId: string,
    dto: GrantEmployeeAccountDto,
    distributorId: string,
    solicitante: Solicitante,
  ): Promise<{ empleado: EmployeeConPuesto; deliveryId: string | null }> {
    const empleado = await this.employees.findOne(employeeId, distributorId);
    if (empleado.status !== EmployeeStatus.ACTIVE) {
      throw new ConflictException(
        'El empleado está egresado: reingresalo antes',
      );
    }
    if (empleado.userId) {
      throw new ConflictException('El empleado ya tiene una cuenta de acceso');
    }
    const rol = rolDeAcceso(empleado.position.category);
    if (!puedeOtorgarseCuenta(empleado.position.category) || !rol) {
      throw new BadRequestException(
        `Sólo los choferes tienen cuenta de acceso: el puesto "${empleado.position.name}" es de categoría ${valorLegible(empleado.position.category)}`,
      );
    }
    const telefono = dto.phoneNumber ?? empleado.phone;
    if (!telefono || !/^\+[1-9]\d{7,14}$/.test(telefono)) {
      throw new BadRequestException(
        'Falta un teléfono en formato E.164 (+549...): enviá el teléfono o cargalo en el legajo',
      );
    }

    await this.registro.registrar(
      {
        email: dto.email,
        password: dto.password,
        full_name: `${empleado.firstName} ${empleado.lastName}`,
        phone_number: telefono,
        rol,
        distributorId: empleado.distributorId,
        employeeId: empleado.employeeId,
      },
      solicitante,
    );
    return this.employees.findOneDetallado(employeeId, distributorId);
  }
}
