import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EmployeeService } from './employee.service';
import {
  EVENTO_USUARIO_DADO_DE_BAJA,
  UsuarioDadoDeBajaEvent,
} from '../users/events/usuario-dado-de-baja.event';

/**
 * Cuando se da de baja un usuario con legajo (chofer o admin, `DELETE /users/:id`),
 * su legajo pasa a egresado y se suelta la cuenta en la MISMA transacción (CU-181). Escucha el evento
 * en vez de que `users` llame a `employee` (que ya depende de `users`):
 * sin ciclo de módulos. No suprime errores: si falla, la baja se revierte.
 */
@Injectable()
export class EmployeeUserRemovedListener {
  constructor(private readonly employees: EmployeeService) {}

  @OnEvent(EVENTO_USUARIO_DADO_DE_BAJA, { suppressErrors: false })
  async handle(evento: UsuarioDadoDeBajaEvent): Promise<void> {
    await this.employees.egresarPorBajaDeUsuario(evento.manager, evento.userId);
  }
}
