import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  assertVariablesConocidas,
  assertNombreDelAsistente,
  DERIVACION_POR_DEFECTO,
  FUERA_DE_HORARIO_POR_DEFECTO,
  RECIBIDO_POR_DEFECTO,
} from '../domain/bandeja';
import { franjasValidas } from '../domain/horario';
import {
  feriadosValidos,
  type HorarioDeLaEmpresa,
} from '../domain/horario-de-la-empresa';
import { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import { nombreVisibleDeLaEmpresa } from '../infrastructure/nombre-visible-de-la-empresa';
import type {
  UpdateChatBusinessHoursDto,
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
    handoffMessage: null,
    outOfHoursEnabled: true,
    outOfHoursMessage: null,
    ackEnabled: false,
    ackMessage: null,
    firstResponseTargetMinutes: 30,
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

/** Lo que dice el asistente al pasar la conversación a una persona: el de la empresa o el de omisión. */
export function textoDeDerivacion(a: ChatCompanySettings): string {
  return a.handoffMessage ?? DERIVACION_POR_DEFECTO;
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
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
  ): Promise<ChatCompanySettings> {
    for (const texto of [
      dto.outOfHoursMessage,
      dto.ackMessage,
      dto.handoffMessage,
    ]) {
      if (typeof texto === 'string') assertVariablesConocidas(texto);
    }
    if (typeof dto.assistantName === 'string') {
      assertNombreDelAsistente(dto.assistantName);
    }
    return this.guardar(distributorId, userId, dto);
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

  private guardar(
    distributorId: string,
    userId: string,
    cambios: Partial<ChatCompanySettings>,
  ): Promise<ChatCompanySettings> {
    return this.dataSource.transaction(async (manager) => {
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
      return repo.save(
        Object.assign(actual, cambios, { updatedByUserId: userId }),
      );
    });
  }
}
