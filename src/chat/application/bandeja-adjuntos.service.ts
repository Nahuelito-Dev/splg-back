import { Injectable } from '@nestjs/common';
import type { DownloadLinkResponseDto } from '../../s3/dto/download-link.dto';
import { Party } from '../domain/chat.enums';
import type { SendAttachmentDto } from '../presentation/dto/chat-attachment.dto';
import { AdjuntoEscrito, AdjuntosDelChat } from './adjuntos-del-chat.service';
import { dejaDeEsperarPersona } from './asistente-del-chat';
import {
  type ActorDeLaBandeja,
  BandejaAcceso,
  esDelPersonal,
} from './bandeja-acceso';
import { chatDeClientesApagado } from './bandeja.errors';
import {
  esperarPersonaParaAsignar,
  primeraRespuestaDeLaEmpresa,
} from './bandeja.service';
import { CompanyChatSettingsService } from './company-chat-settings.service';
import { ConversacionVigente } from './conversacion-vigente';
import { MessageWriter } from './message-writer';

/**
 * Adjuntos en la bandeja de la empresa (C3 clientes, C2 choferes): las dos
 * puntas suben y bajan, con el mismo aislamiento que los mensajes (otra
 * empresa, otro canal o, para el cliente y el chofer, conversación ajena →
 * 404). El adjunto de la empresa cuenta como su respuesta; uno del cliente no
 * dispara respuestas automáticas (la conversación ya se abrió con un texto).
 */
@Injectable()
export class BandejaAdjuntos {
  constructor(
    private readonly acceso: BandejaAcceso,
    private readonly vigente: ConversacionVigente,
    private readonly ajustes: CompanyChatSettingsService,
    private readonly writer: MessageWriter,
    private readonly adjuntos: AdjuntosDelChat,
  ) {}

  async enviar(
    actor: ActorDeLaBandeja,
    conversationId: string,
    archivo: Express.Multer.File | undefined,
    dto: SendAttachmentDto,
  ): Promise<AdjuntoEscrito> {
    const c = await this.acceso.buscar(actor, conversationId);
    if (actor.party === Party.CUSTOMER) {
      const a = await this.ajustes.leer(actor.distributorId);
      if (!a.customerChatEnabled) throw chatDeClientesApagado();
    }
    await this.vigente.assertSePuedeEscribir(c);
    return this.adjuntos.subir(
      {
        conversation: c,
        party: actor.party,
        userId: actor.userId,
        archivo,
        dto,
        cupo: {
          ambito: actor.distributorId,
          conversacion: esDelPersonal(actor) ? undefined : c.conversationId,
        },
      },
      async (manager, nuevo, efectos) => {
        const r = await this.writer.escribir(manager, nuevo);
        if (!r.created) return r;
        efectos.mensaje(r.conversation, r.message);
        if (actor.party === Party.COMPANY) {
          await primeraRespuestaDeLaEmpresa(manager, r.conversation);
          await dejaDeEsperarPersona(manager, r.conversation);
        } else {
          // El adjunto no lo atiende el asistente: con la asignación
          // automática prendida, queda esperando a una persona (8b).
          await esperarPersonaParaAsignar(
            manager,
            r.conversation,
            efectos,
            new Date(),
          );
        }
        return r;
      },
    );
  }

  async enlace(
    actor: ActorDeLaBandeja,
    conversationId: string,
    messageId: string,
  ): Promise<DownloadLinkResponseDto> {
    const c = await this.acceso.buscar(actor, conversationId);
    return this.adjuntos.enlace(c, messageId, {
      party: actor.party,
    });
  }
}
