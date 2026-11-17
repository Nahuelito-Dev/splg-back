import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  assertVariablesConocidas,
  assertNombreDelAsistente,
  DERIVACION_POR_DEFECTO,
  FUERA_DE_HORARIO_POR_DEFECTO,
  RECIBIDO_POR_DEFECTO,
} from '../domain/bandeja';
import { ACCIONES_POR_DEFECTO } from '../domain/acciones-del-cliente';
import { TOPE_POR_OMISION } from '../domain/asignacion-automatica';
import {
  type AjustesDeAsignacionCambiados,
  type ConversacionCambiada,
  EVENTO_AJUSTES_DE_ASIGNACION,
  EVENTO_CONVERSACION_CAMBIO,
} from './chat.events';
import { Conversation } from '../entities/conversation.entity';
import { ENCUESTA_POR_DEFECTO } from '../domain/encuesta';
import { franjasValidas } from '../domain/horario';
import { plazosValidos } from '../domain/inactividad';
import {
  feriadosValidos,
  type HorarioDeLaEmpresa,
} from '../domain/horario-de-la-empresa';
import { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import { nombreVisibleDeLaEmpresa } from '../infrastructure/nombre-visible-de-la-empresa';
import { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { moduloDeshabilitado } from '../../platform/access/errores';
import {
  type UpdateChatBusinessHoursDto,
  UpdateChatSettingsDto,
} from '../presentation/dto/bandeja-input.dto';

/** Los valores por defecto (los de la migración), para una empresa sin fila. */
export function ajustesDeLaBandejaPorDefecto(
  distributorId: string,
): ChatCompanySettings {
  return Object.assign(new ChatCompanySettings(), {
    distributorId,
    timezone: 'America/Argentina/Buenos_Aires',
    businessHours: [],
    holidays: [],
    customerChatEnabled: true,
    assistantName: null,
    assistantAiEnabled: false,
    handoffMessage: null,
    outOfHoursEnabled: true,
    outOfHoursMessage: null,
    ackEnabled: false,
    ackMessage: null,
    firstResponseTargetMinutes: 30,
    expectedReplyEnabled: true,
    inactivityCloseMinutes: null,
    inactivityWarningMinutes: null,
    inactivityEnabledAt: null,
    csatEnabled: true,
    csatMessage: null,
    customerActions: [...ACCIONES_POR_DEFECTO],
    autoAssignEnabled: false,
    autoAssignMaxOpen: TOPE_POR_OMISION,
    updatedByUserId: null,
  });
}

export function horarioDe(a: ChatCompanySettings): HorarioDeLaEmpresa {
  return { franjas: a.businessHours, feriados: a.holidays, zona: a.timezone };
}

/** El texto de la respuesta fuera de horario: el de la empresa o el de omisión. */
export function textoFueraDeHorario(a: ChatCompanySettings): string {
  return a.outOfHoursMessage ?? FUERA_DE_HORARIO_POR_DEFECTO;
}

export function textoDeRecibido(a: ChatCompanySettings): string {
  return a.ackMessage ?? RECIBIDO_POR_DEFECTO;
}

/** El pedido de calificación al cerrar (4b): el de la empresa o el de omisión. */
export function textoDeLaEncuesta(a: ChatCompanySettings): string {
  return a.csatMessage ?? ENCUESTA_POR_DEFECTO;
}

/** Lo que dice el asistente al pasar la conversación a una persona: el de la empresa o el de omisión. */
export function textoDeDerivacion(a: ChatCompanySettings): string {
  return a.handoffMessage ?? DERIVACION_POR_DEFECTO;
}

/**
 * Los plazos de inactividad que quedan con este cambio: lo que no viene queda
 * como estaba, y apagar el cierre apaga también el aviso. 400 si el aviso no
 * es anterior al cierre o se pide sin cierre.
 */
export function plazosDeInactividad(
  actual: Pick<
    ChatCompanySettings,
    | 'inactivityCloseMinutes'
    | 'inactivityWarningMinutes'
    | 'inactivityEnabledAt'
  >,
  dto: Pick<
    UpdateChatSettingsDto,
    'inactivityCloseMinutes' | 'inactivityWarningMinutes'
  >,
  ahora: Date,
): Pick<
  ChatCompanySettings,
  'inactivityCloseMinutes' | 'inactivityWarningMinutes' | 'inactivityEnabledAt'
> {
  const cierre =
    dto.inactivityCloseMinutes !== undefined
      ? dto.inactivityCloseMinutes
      : actual.inactivityCloseMinutes;
  const aviso =
    dto.inactivityWarningMinutes !== undefined
      ? dto.inactivityWarningMinutes
      : cierre === null
        ? null
        : actual.inactivityWarningMinutes;
  if (cierre === null && aviso !== null) {
    throw new BadRequestException(
      'Para avisar antes de cerrar, primero elegí en cuántos minutos se cierra la conversación',
    );
  }
  if (!plazosValidos({ cerrarMinutos: cierre, avisarMinutos: aviso })) {
    throw new BadRequestException(
      'El aviso tiene que salir antes del cierre: menos minutos que el cierre por inactividad',
    );
  }
  // Rigen desde ahora si se prende o cambian; si quedan igual, desde antes.
  const cambio =
    cierre !== actual.inactivityCloseMinutes ||
    aviso !== actual.inactivityWarningMinutes;
  return {
    inactivityCloseMinutes: cierre,
    inactivityWarningMinutes: aviso,
    inactivityEnabledAt:
      cierre === null
        ? null
        : cambio || actual.inactivityEnabledAt === null
          ? ahora
          : actual.inactivityEnabledAt,
  };
}

export function zonaValida(zona: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zona });
    return true;
  } catch {
    return false;
  }
}

/**
 * Configuración de la bandeja de cada empresa (§6.9): horario de atención,
 * días sin atención, si atiende a los clientes por chat, el asistente (nombre
 * y mensaje de derivación, D-B8) y las respuestas automáticas. Lo que no viene
 * queda como estaba.
 */
@Injectable()
export class CompanyChatSettingsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly acceso: AccesoDeLaEmpresa,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /** La plataforma le habilitó a la empresa el asistente con IA (módulo `assistant`). */
  asistenteConIaDisponible(distributorId: string): Promise<boolean> {
    return this.acceso.habilitado(distributorId, 'assistant');
  }

  async leer(
    distributorId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<ChatCompanySettings> {
    return (
      (await manager
        .getRepository(ChatCompanySettings)
        .findOne({ where: { distributorId } })) ??
      ajustesDeLaBandejaPorDefecto(distributorId)
    );
  }

  async actualizar(
    distributorId: string,
    userId: string,
    dto: UpdateChatSettingsDto,
    ahora: Date = new Date(),
  ): Promise<ChatCompanySettings> {
    for (const texto of [
      dto.outOfHoursMessage,
      dto.ackMessage,
      dto.handoffMessage,
      dto.csatMessage,
    ]) {
      if (typeof texto === 'string') assertVariablesConocidas(texto);
    }
    if (typeof dto.assistantName === 'string') {
      assertNombreDelAsistente(dto.assistantName);
    }
    // Prenderlo sin la función habilitada: 403, sin hablar de módulos ni
    // planes. Si ya estaba prendido, no es un cambio: se ignora el campo y el
    // resto del PUT sigue. Apagarlo siempre se puede.
    let cambios: UpdateChatSettingsDto = dto;
    if (
      dto.assistantAiEnabled === true &&
      !(await this.asistenteConIaDisponible(distributorId))
    ) {
      if (!(await this.leer(distributorId)).assistantAiEnabled) {
        throw moduloDeshabilitado();
      }
      cambios = Object.assign(new UpdateChatSettingsDto(), dto, {
        assistantAiEnabled: undefined,
      });
    }
    const tocaInactividad =
      dto.inactivityCloseMinutes !== undefined ||
      dto.inactivityWarningMinutes !== undefined;
    const guardados = await this.guardar(
      distributorId,
      userId,
      cambios,
      tocaInactividad
        ? (actual) => plazosDeInactividad(actual, dto, ahora)
        : undefined,
    );
    // Prender la asignación automática o cambiar su tope reparte la cola (8b).
    if (
      guardados.autoAssignEnabled &&
      (dto.autoAssignEnabled !== undefined ||
        dto.autoAssignMaxOpen !== undefined)
    ) {
      const evento: AjustesDeAsignacionCambiados = { distributorId };
      this.events?.emit(EVENTO_AJUSTES_DE_ASIGNACION, evento);
    }
    return guardados;
  }

  /** La empresa tiene habilitados los mensajes (módulo `chat`). */
  chatDisponible(distributorId: string): Promise<boolean> {
    return this.acceso.habilitado(distributorId, 'chat');
  }

  /** El nombre con que la conocen sus clientes (el de su marca, si lo tiene), para firmar con el nombre del asistente. */
  async nombreDeLaEmpresa(
    distributorId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<string> {
    const [fila]: Array<{ name: string | null }> = await manager.query(
      `SELECT ${nombreVisibleDeLaEmpresa('d')} AS "name"
         FROM "distributor" d WHERE d."distributor_id" = $1`,
      [distributorId],
    );
    return fila?.name ?? '';
  }

  async actualizarHorario(
    distributorId: string,
    userId: string,
    dto: UpdateChatBusinessHoursDto,
  ): Promise<ChatCompanySettings> {
    if (dto.timezone !== undefined && !zonaValida(dto.timezone)) {
      throw new BadRequestException('La zona horaria no es válida');
    }
    if (dto.days !== undefined && !franjasValidas(dto.days)) {
      throw new BadRequestException(
        'El horario tiene franjas que se solapan o que cierran antes de abrir',
      );
    }
    if (dto.holidays !== undefined && !feriadosValidos(dto.holidays)) {
      throw new BadRequestException(
        'Los días sin atención tienen una fecha inválida o repetida, o un motivo vacío',
      );
    }
    return this.guardar(distributorId, userId, {
      ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
      ...(dto.days !== undefined ? { businessHours: dto.days } : {}),
      ...(dto.holidays !== undefined
        ? {
            holidays: dto.holidays.map((h) => ({
              date: h.date,
              reason: h.reason.trim(),
            })),
          }
        : {}),
    });
  }

  private async guardar(
    distributorId: string,
    userId: string,
    cambios: Partial<ChatCompanySettings>,
    ajustar?: (actual: ChatCompanySettings) => Partial<ChatCompanySettings>,
  ): Promise<ChatCompanySettings> {
    const { guardado, sinEspera } = await this.dataSource.transaction(
      async (manager) => {
        const repo = manager.getRepository(ChatCompanySettings);
        // La primera vez, la fila con los valores por defecto: dos primeros
        // guardados simultáneos no chocan por la clave (el segundo espera el lock).
        await manager.query(
          `INSERT INTO "chat_company_settings" ("distributor_id") VALUES ($1) ON CONFLICT DO NOTHING`,
          [distributorId],
        );
        const actual = await repo.findOneOrFail({
          where: { distributorId },
          lock: { mode: 'pessimistic_write' },
        });
        const estabaPrendida = actual.autoAssignEnabled;
        // Sólo lo que vino: el DTO trae como `undefined` los campos que no se
        // mandaron (campos de clase de ES2022) y la respuesta saldría sin ellos.
        const vinieron = Object.fromEntries(
          Object.entries(cambios).filter(([, valor]) => valor !== undefined),
        );
        // Lo que depende de lo guardado (los plazos de inactividad se validan
        // juntos), con la fila bloqueada.
        const ajustados = ajustar ? ajustar(actual) : {};
        const guardado = await repo.save(
          Object.assign(actual, vinieron, ajustados, {
            updatedByUserId: userId,
          }),
        );
        const sinEspera =
          estabaPrendida && !guardado.autoAssignEnabled
            ? await limpiarEsperasDeLaAsignacion(manager, distributorId)
            : [];
        return { guardado, sinEspera };
      },
    );
    // Después del commit: la bandeja se entera de que ya no esperan.
    for (const conversation of sinEspera) {
      const cambio: ConversacionCambiada = { conversation, change: 'status' };
      this.events?.emit(EVENTO_CONVERSACION_CAMBIO, cambio);
    }
    return guardado;
  }
}

/**
 * Se apagó la asignación automática (decisión de nahue, 17/11): las
 * conversaciones de la empresa que esperaban a una persona porque las marcó
 * ella (`awaiting_human_reason = 'auto_assign'`) y siguen sin asignar dejan
 * de esperar. Las que derivó el asistente o pidió el cliente quedan. En la
 * transacción de quien llama; devuelve las que cambiaron.
 */
export async function limpiarEsperasDeLaAsignacion(
  manager: EntityManager,
  distributorId: string,
): Promise<Conversation[]> {
  const filas: Array<{ conversation_id: string }> = await manager.query(
    `UPDATE "conversation" SET "awaiting_human_since" = NULL, "awaiting_human_reason" = NULL, "updated_at" = now()
      WHERE "distributor_id" = $1 AND "awaiting_human_reason" = 'auto_assign'
        AND "assigned_to_user_id" IS NULL AND "status" = 'open'
      RETURNING "conversation_id"`,
    [distributorId],
  );
  const ids = (Array.isArray(filas[0]) ? (filas[0] as typeof filas) : filas)
    .map((f) => f.conversation_id)
    .filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return [];
  return manager
    .getRepository(Conversation)
    .find({ where: { conversationId: In(ids) } });
}
