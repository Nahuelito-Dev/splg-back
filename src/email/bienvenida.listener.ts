import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EmailService } from './email.service';
import { RoleType } from '../common/constants/role-type.enum';
import {
  EVENTO_USUARIO_REGISTRADO,
  UsuarioRegistradoEvent,
} from '../registro/events/usuario-registrado.event';

/**
 * El correo de bienvenida a los clientes nuevos. Escucha el alta en lugar de
 * que el alta llame al correo: así `registro` no depende de `email`, y un
 * correo que no sale nunca deshace un alta confirmada.
 */
@Injectable()
export class BienvenidaListener {
  constructor(private readonly emailService: EmailService) {}

  @OnEvent(EVENTO_USUARIO_REGISTRADO)
  async handle(evento: UsuarioRegistradoEvent): Promise<void> {
    if (evento.rol !== RoleType.CUSTOMER) return;
    await this.emailService.sendWelcomeEmail(evento.email, evento.fullName);
  }
}
