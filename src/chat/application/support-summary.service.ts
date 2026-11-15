import { Injectable } from '@nestjs/common';
import { ChatReadModel } from '../infrastructure/chat-read-model';

/**
 * Resúmenes para las insignias del menú (relevamiento de chats B3): lo que el
 * panel muestra sin pedir cada hilo. Los no leídos son de la persona que pide,
 * sin mensajes de sistema ni los propios.
 */
@Injectable()
export class SupportSummaryService {
  constructor(private readonly lectura: ChatReadModel) {}

  async deLaEmpresa(
    distributorId: string,
    userId: string,
  ): Promise<{ chatUnread: number; ticketsUnread: number; total: number }> {
    const r = await this.lectura.resumenDeLaEmpresa(distributorId, userId);
    return { ...r, total: r.chatUnread + r.ticketsUnread };
  }

  async deLaPlataforma(userId: string): Promise<{
    chatsUnread: number;
    chatsUnassigned: number;
    ticketsUnread: number;
    ticketsUnassigned: number;
    total: number;
  }> {
    const r = await this.lectura.resumenDeLaPlataforma(userId);
    return { ...r, total: r.chatsUnread + r.ticketsUnread };
  }
}
