import type { EntityManager } from 'typeorm';
import { idCortoDePedido } from '../../common/events/aviso-al-admin';
import type { VariableDePlantilla } from '../domain/bandeja';
import {
  proximaAtencion,
  textoDeLaProximaAtencion,
} from '../domain/horario-de-la-empresa';
import type { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import type { Conversation } from '../entities/conversation.entity';
import { nombreVisibleDeLaEmpresa } from '../infrastructure/nombre-visible-de-la-empresa';
import { horarioDe } from './company-chat-settings.service';

const UUID_NULO = '00000000-0000-0000-0000-000000000000';

/**
 * Los valores de las variables de una respuesta guardada en esa conversación
 * (§6.8): el nombre de pila de la persona, el número corto del pedido, el
 * nombre con que la conocen sus clientes (el de su marca, si lo tiene) y
 * cuándo vuelve a atender.
 */
export async function valoresDePlantilla(
  manager: EntityManager,
  c: Conversation,
  ajustes: ChatCompanySettings,
  ahora: Date,
): Promise<Partial<Record<VariableDePlantilla, string>>> {
  const persona = c.customerUserId ?? c.driverUserId;
  const [fila]: Array<{ persona: string | null; empresa: string | null }> =
    await manager.query(
      `SELECT (SELECT "full_name" FROM "user" WHERE "user_id" = $1) AS persona,
              (SELECT ${nombreVisibleDeLaEmpresa('d')} FROM "distributor" d
                WHERE d."distributor_id" = $2) AS empresa`,
      [persona ?? UUID_NULO, c.distributorId],
    );
  const h = horarioDe(ajustes);
  const abre = proximaAtencion(h, ahora);
  return {
    'cliente.nombre': (fila?.persona ?? '').trim().split(/\s+/)[0] ?? '',
    'pedido.numero': c.orderId ? idCortoDePedido(c.orderId) : '',
    'empresa.nombre': fila?.empresa ?? '',
    'horario.proximo': abre
      ? textoDeLaProximaAtencion(abre, h.zona, ahora)
      : 'ahora',
  };
}
