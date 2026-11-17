import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { auditContext } from '../../audit/data/audit-context';
import { errorMessage } from '../../common/errors/error-message';
import {
  type Asignacion,
  lugarPorCanal,
  repartir,
} from '../domain/asignacion-automatica';
import { ConversationStatus } from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import { AgentesDeLaBandeja } from '../infrastructure/agentes-de-la-bandeja';
import { BandejaGestionService } from './bandeja-gestion.service';
import { ChatEvents, Efectos } from './chat.events';
import { CompanyChatSettingsService } from './company-chat-settings.service';
import {
  comoCandidato,
  EquipoDeLaBandejaService,
} from './equipo-de-la-bandeja.service';

/** Lo más que dura una vuelta del reparto antes de abandonarla. */
export const TOPE_DE_LA_VUELTA_MS = 30_000;
/** Vueltas por corrida (las que piden los disparos que llegan mientras corre). */
export const TOPE_DE_VUELTAS = 3;
/** `statement_timeout` y `lock_timeout` de la transacción del reparto. */
export const TIEMPO_DE_SENTENCIA_MS = 10_000;
export const TIEMPO_DE_CERROJO_MS = 5_000;

/** La promesa, o un error si no termina en `ms` (el temporizador se limpia). */
export async function conTope<T>(
  promesa: Promise<T>,
  ms: number,
  motivo: string,
): Promise<T> {
  let vencio: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promesa,
      new Promise<never>((_, rechazar) => {
        vencio = setTimeout(() => rechazar(new Error(motivo)), ms);
      }),
    ]);
  } finally {
    clearTimeout(vencio);
  }
}

/** La clave del cerrojo de transacción del reparto de una empresa. */
export const claveDelReparto = (distributorId: string) =>
  `chat:auto-assign:${distributorId}`;

/** Toma el cerrojo del reparto de la empresa (se suelta con la transacción). */
export async function bloquearElReparto(
  manager: EntityManager,
  distributorId: string,
): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    claveDelReparto(distributorId),
  ]);
}

/**
 * Intenta el cerrojo del reparto sin esperar: `false` si otra transacción
 * (otra instancia) ya está repartiendo esa empresa.
 */
export async function intentarElReparto(
  manager: EntityManager,
  distributorId: string,
): Promise<boolean> {
  const [fila]: Array<{ ok: boolean }> = await manager.query(
    'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "ok"',
    [claveDelReparto(distributorId)],
  );
  return fila?.ok === true;
}

/**
 * La asignación automática de la bandeja (8b): reparte las conversaciones
 * que esperan a una persona sin asignar (la más vieja primero) entre el
 * equipo disponible, a quien tenga más lugar. Corre cuando una queda
 * esperando, cuando alguien se pone en línea o libera lugar, cuando se
 * prende la función o se sube un tope, y cada minuto como red de seguridad.
 *
 * Un cerrojo de transacción por empresa: dos repartos de la misma empresa
 * van de a uno, así nadie recibe por encima de su tope ni una conversación
 * va a dos personas. Asigna por el mismo camino que la asignación a mano
 * (`BandejaGestionService.asignarDentro`: mismos avisos y auditoría) y como
 * «sistema» (sin el usuario del request que lo disparó). Apagada, o sin el
 * módulo `chat`, no hace nada.
 */
@Injectable()
export class AsignacionAutomaticaService {
  private readonly logger = new Logger(AsignacionAutomaticaService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ajustes: CompanyChatSettingsService,
    private readonly equipo: EquipoDeLaBandejaService,
    private readonly agentes: AgentesDeLaBandeja,
    private readonly gestion: BandejaGestionService,
    private readonly eventos: ChatEvents,
  ) {}

  /**
   * Un repartidor por empresa en esta instancia: si ya hay uno corriendo,
   * el nuevo disparo no abre otro (ni pide otra conexión): queda anotado y
   * el que corre da una vuelta más al terminar (hasta {@link TOPE_DE_VUELTAS}
   * por corrida; lo que quede, el próximo disparo o la tarea de cada minuto).
   * Una vuelta que no termina en {@link TOPE_DE_LA_VUELTA_MS} se abandona:
   * se registra y la empresa queda libre para el próximo disparo.
   */
  private readonly enCurso = new Map<
    string,
    { corrida: Promise<Asignacion[]>; otraVez: boolean }
  >();

  /** Reparte la cola de la empresa. Devuelve lo que asignó. */
  repartir(
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<Asignacion[]> {
    const actual = this.enCurso.get(distributorId);
    if (actual) {
      actual.otraVez = true;
      return actual.corrida;
    }
    const estado = {
      otraVez: false,
      corrida: Promise.resolve<Asignacion[]>([]),
    };
    estado.corrida = (async () => {
      const hechas: Asignacion[] = [];
      try {
        let cuando = ahora;
        let vueltas = 0;
        do {
          estado.otraVez = false;
          vueltas += 1;
          // Lo asienta la auditoría como del sistema, no de quien lo disparó.
          hechas.push(
            ...(await conTope(
              auditContext.exit(() => this.unaVuelta(distributorId, cuando)),
              TOPE_DE_LA_VUELTA_MS,
              `la vuelta de ${distributorId} no terminó en ${TOPE_DE_LA_VUELTA_MS} ms`,
            )),
          );
          cuando = new Date();
        } while (estado.otraVez && vueltas < TOPE_DE_VUELTAS);
      } finally {
        this.enCurso.delete(distributorId);
      }
      return hechas;
    })();
    this.enCurso.set(distributorId, estado);
    return estado.corrida;
  }

  /**
   * Para los disparos de una request (ponerse en línea, cambiar un tope):
   * dispara el reparto y no lo espera; un error queda en el log.
   */
  disparar(distributorId: string): void {
    void this.repartirSinFallar(distributorId);
  }

  /** Como {@link repartir}, pero un error queda en el log y no sube (para los disparadores). */
  async repartirSinFallar(
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<Asignacion[]> {
    try {
      return await this.repartir(distributorId, ahora);
    } catch (error) {
      this.logger.warn(
        `Asignación automática: no se pudo repartir la cola de ${distributorId}: ${errorMessage(error)}`,
      );
      return [];
    }
  }

  /**
   * Una vuelta: la presencia se lee ANTES de abrir la transacción (Redis no
   * se espera con el cerrojo tomado); adentro, todo por el `manager`. Entre
   * instancias, el cerrojo se intenta (`pg_try_advisory_xact_lock`): si otra
   * instancia está repartiendo esta empresa, no se espera (lo que quede lo
   * toma esa vuelta o la tarea de cada minuto).
   */
  private async unaVuelta(
    distributorId: string,
    ahora: Date,
  ): Promise<Asignacion[]> {
    // Apagada (lo común): ni transacción ni cerrojo. Se vuelve a mirar adentro.
    if (!(await this.ajustes.leer(distributorId)).autoAssignEnabled) return [];
    if (!(await this.ajustes.chatDisponible(distributorId))) return [];
    const conexiones = await this.equipo.conexionesDe(distributorId, ahora);
    const efectos = new Efectos();
    const hechas = await this.dataSource.transaction(async (manager) => {
      // Ninguna sentencia ni espera de cerrojo de fila se cuelga con la
      // conexión tomada (se cortan y la transacción vuelve atrás).
      await manager.query(
        `SET LOCAL statement_timeout = '${TIEMPO_DE_SENTENCIA_MS}ms'`,
      );
      await manager.query(
        `SET LOCAL lock_timeout = '${TIEMPO_DE_CERROJO_MS}ms'`,
      );
      if (!(await intentarElReparto(manager, distributorId))) return [];
      const ajustes = await this.ajustes.leer(distributorId, manager);
      if (!ajustes.autoAssignEnabled) return [];
      const equipo = (
        await this.equipo.delaEmpresa(distributorId, ahora, {
          manager,
          ajustes,
          conexiones,
        })
      ).map(comoCandidato);
      const porCanal = lugarPorCanal(equipo);
      if (![...porCanal.values()].some((n) => n > 0)) return [];
      const cola = await this.agentes.cola(manager, distributorId, porCanal);
      if (cola.length === 0) return [];
      const asignaciones = repartir(cola, equipo, ahora.getTime());
      const repo = manager.getRepository(Conversation);
      const asignadas: Asignacion[] = [];
      for (const a of asignaciones) {
        const c = await repo.findOneByOrFail({
          conversationId: a.conversationId,
        });
        if (c.status !== ConversationStatus.OPEN || c.assignedToUserId) {
          continue;
        }
        await this.gestion.asignarDentro(manager, c, a.userId, efectos, true);
        await this.agentes.marcarAsignacion(
          manager,
          distributorId,
          a.userId,
          ahora,
        );
        asignadas.push(a);
      }
      return asignadas;
    });
    this.eventos.publicar(efectos);
    if (hechas.length > 0) {
      await this.equipo.avisar(distributorId, [
        ...new Set(hechas.map((a) => a.userId)),
      ]);
    }
    return hechas;
  }
}
