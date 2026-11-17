import type Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, IsNull } from 'typeorm';
import {
  atiendeLaEmpresa,
  proximaAtencion,
  textoDeLaProximaAtencion,
} from '../chat/domain/horario-de-la-empresa';
import type { ChatCompanySettings } from '../chat/entities/chat-company-settings.entity';
import { horarioDe } from '../chat/application/company-chat-settings.service';
import { idCortoDePedido } from '../common/events/aviso-al-admin';
import {
  CoverageZone,
  CoverageZoneSurchargeType,
} from '../coverage-zone/entities/coverage-zone.entity';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { GasCylinderMapper } from '../gascylinder/gascylinder.mapper';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { TimeSlot } from '../time-slot/entities/time-slot.entity';
import { CAUSAS_DE_DERIVACION } from './asistente-ia.dominio';
import type { CanalDelAsistente } from './prompt';

/** Nombres de las herramientas (§4.2). Todas de sólo lectura salvo `pasar_a_persona`, que sólo avisa. */
export const ESTADO_DE_MI_PEDIDO = 'estado_de_mi_pedido';
export const HORARIOS_Y_ZONAS = 'horarios_y_zonas';
export const PRECIOS_VIGENTES = 'precios_vigentes';
export const MEDIOS_DE_PAGO = 'medios_de_pago';
export const PASAR_A_PERSONA = 'pasar_a_persona';

const SIN_PARAMETROS: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const PASAR: Anthropic.Tool = {
  name: PASAR_A_PERSONA,
  description:
    'Pasa la conversación a una persona del equipo. Usala cuando no tengas la información en la base de conocimiento o en las otras herramientas, cuando no estés seguro de la respuesta, cuando te pidan hablar con alguien, haya un reclamo o haya que hacer algo (cancelar, cambiar, cobrar, devolver). Es la única forma de que alguien del equipo se entere.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      causa: {
        type: 'string',
        enum: CAUSAS_DE_DERIVACION,
        description:
          'no_info: la base y las herramientas no tienen la información; low_confidence: no estás seguro de la respuesta; customer_asked: la persona pidió hablar con alguien; complaint: es un reclamo o hay que hacer algo; other: otra cosa',
      },
      motivo: {
        type: 'string',
        description: 'Por qué la pasás, en pocas palabras',
      },
      resumen: {
        type: 'string',
        description:
          'Para el equipo (la persona no lo ve), en 2 o 3 líneas: qué pide, qué ya le contestaste y qué falta. Sin teléfonos, documentos ni direcciones.',
      },
    },
    required: ['causa', 'motivo', 'resumen'],
    additionalProperties: false,
  },
};

const DE_LOS_CLIENTES: Anthropic.Tool[] = [
  {
    name: ESTADO_DE_MI_PEDIDO,
    description:
      'Estado de los pedidos de quien escribe (sólo los suyos): estado, franja de entrega, chofer asignado (nombre de pila) y total. Sin número de pedido, devuelve los últimos.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        pedido: {
          type: 'string',
          description:
            'Número corto del pedido (6 caracteres, como figura en la app). Mandalo sólo si la persona lo dijo.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: HORARIOS_Y_ZONAS,
    description:
      'Horario de atención del chat (si atiende ahora y cuándo vuelve), franjas de entrega y zonas de cobertura con su recargo.',
    strict: true,
    input_schema: SIN_PARAMETROS,
  },
  {
    name: PRECIOS_VIGENTES,
    description:
      'Precios de lista vigentes de cada producto y sus promociones por cantidad, tal como los calcula el sistema.',
    strict: true,
    input_schema: SIN_PARAMETROS,
  },
  {
    name: MEDIOS_DE_PAGO,
    description:
      'Medios de pago que acepta la distribuidora y el recargo de cada uno.',
    strict: true,
    input_schema: SIN_PARAMETROS,
  },
  PASAR,
];

/** Las herramientas de cada canal, siempre en el mismo orden (son parte del prefijo cacheado). */
export function herramientasDelCanal(
  canal: CanalDelAsistente,
): Anthropic.Tool[] {
  return canal === 'clientes' ? DE_LOS_CLIENTES : [PASAR];
}

/** A quién atiende el asistente: lo que filtra cada herramienta. */
export interface ContextoDeLasHerramientas {
  distributorId: string;
  /** El cliente de la conversación (C3); nulo en C1. */
  customerUserId: string | null;
  /** El pedido de la conversación, si es una por pedido. */
  orderId: string | null;
  ajustes: ChatCompanySettings;
  ahora: Date;
}

/** Lo que vuelve al modelo como `tool_result`. */
export interface ResultadoDeHerramienta {
  datos: unknown;
  error: boolean;
  /** Los pedidos que devolvió (número corto), para citarlos como fuente (4d). No va al modelo. */
  pedidos?: string[];
}

const ESTADOS: Readonly<Record<OrderStatus, string>> = {
  [OrderStatus.RESERVED]: 'Reservado (se activa el día agendado)',
  [OrderStatus.PENDING]: 'Recibido, buscando chofer',
  [OrderStatus.ACCEPTED]: 'Aceptado por un chofer',
  [OrderStatus.ON_THE_WAY]: 'En camino',
  [OrderStatus.DELIVERED]: 'Entregado',
  [OrderStatus.CANCELLED]: 'Cancelado',
};

const DIAS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

/** Un importe como lo ve la persona: «$ 12.345,50». Calculado con decimal, nunca con `number`. */
export function pesos(valor: number | string): string {
  const [entero, decimales] = new Decimal(valor).toFixed(2).split('.');
  const negativo = entero.startsWith('-');
  const digitos = negativo ? entero.slice(1) : entero;
  const miles = digitos.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativo ? '-' : ''}$ ${miles},${decimales}`;
}

/** Un porcentaje como lo ve la persona: «10 %», «2,5 %». */
export function porcentaje(valor: number | string): string {
  return `${new Decimal(valor).toString().replace('.', ',')} %`;
}

const hora = (h: string): string => h.slice(0, 5);

/** El número corto (6) o el id completo de un pedido, normalizado; `null` si no parece ninguno. */
export function pedidoBuscado(texto: string): string | null {
  const limpio = texto.trim().replace(/^#/, '');
  if (/^[0-9a-f-]{36}$/i.test(limpio)) return limpio.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(limpio)) return limpio.toUpperCase();
  return null;
}

/**
 * Las herramientas del asistente (§4.2): sólo lectura, siempre de la empresa
 * de la conversación y, los pedidos, sólo del cliente que escribe (mismas
 * reglas que la API: `distributorId` + `customerId`). Lo que devuelven es lo
 * mínimo que hace falta: nada de documentos, teléfonos ni direcciones (§5).
 */
@Injectable()
export class HerramientasDelAsistente {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly garrafas: GasCylinderService,
  ) {}

  async ejecutar(
    ctx: ContextoDeLasHerramientas,
    nombre: string,
    input: unknown,
  ): Promise<ResultadoDeHerramienta> {
    switch (nombre) {
      case ESTADO_DE_MI_PEDIDO:
        return this.pedidos(ctx, input);
      case HORARIOS_Y_ZONAS:
        return { datos: await this.horariosYZonas(ctx), error: false };
      case PRECIOS_VIGENTES:
        return { datos: await this.precios(ctx), error: false };
      case MEDIOS_DE_PAGO:
        return { datos: await this.mediosDePago(ctx), error: false };
      default:
        return {
          datos: { error: `La herramienta ${nombre} no existe` },
          error: true,
        };
    }
  }

  private async pedidos(
    ctx: ContextoDeLasHerramientas,
    input: unknown,
  ): Promise<ResultadoDeHerramienta> {
    if (!ctx.customerUserId) {
      return {
        datos: { error: 'Esta conversación no es con un cliente' },
        error: true,
      };
    }
    const pedido =
      typeof input === 'object' &&
      input !== null &&
      typeof (input as Record<string, unknown>).pedido === 'string'
        ? ((input as Record<string, unknown>).pedido as string)
        : null;
    const buscado = pedido === null ? null : pedidoBuscado(pedido);
    if (pedido !== null && buscado === null) {
      return {
        datos: {
          error:
            'Ese número de pedido no es válido: son 6 caracteres, como figura en la app',
        },
        error: true,
      };
    }
    const qb = this.dataSource
      .getRepository(Order)
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.timeSlot', 'franja')
      .leftJoinAndSelect('o.delivery', 'entrega')
      .leftJoinAndSelect('entrega.user', 'chofer')
      // Las mismas reglas que la API: de esta empresa y de este cliente.
      .where('o.distributorId = :empresa', { empresa: ctx.distributorId })
      .andWhere('o.customerId = :cliente', { cliente: ctx.customerUserId });
    if (buscado !== null) {
      if (buscado.length === 36) {
        qb.andWhere('o.orderId = :id', { id: buscado });
      } else {
        qb.andWhere('upper(right(o.order_id::text, 6)) = :corto', {
          corto: buscado,
        });
      }
    } else if (ctx.orderId) {
      qb.andWhere('o.orderId = :id', { id: ctx.orderId });
    }
    const filas = await qb
      .orderBy('o.createdAt', 'DESC')
      .addOrderBy('o.orderId', 'ASC')
      .take(3)
      .getMany();
    if (filas.length === 0) {
      return {
        datos: {
          error:
            buscado !== null
              ? 'No hay un pedido con ese número entre los de esta persona'
              : 'Esta persona no tiene pedidos',
        },
        error: buscado !== null,
      };
    }
    return {
      datos: filas.map((o) => ({
        pedido: idCortoDePedido(o.orderId),
        estado: ESTADOS[o.status] ?? o.status,
        fechaDeEntrega: o.scheduledDate ?? null,
        franja: o.timeSlot
          ? `${o.timeSlot.name} (${hora(o.timeSlot.startTime)} a ${hora(o.timeSlot.endTime)})`
          : null,
        chofer:
          o.status === OrderStatus.ACCEPTED ||
          o.status === OrderStatus.ON_THE_WAY
            ? ((o.delivery?.user?.fullName ?? '').trim().split(/\s+/)[0] ??
                null) ||
              null
            : null,
        total: pesos(o.totalAmount),
      })),
      error: false,
      pedidos: filas.map((o) => idCortoDePedido(o.orderId)),
    };
  }

  private async horariosYZonas(ctx: ContextoDeLasHerramientas) {
    const h = horarioDe(ctx.ajustes);
    const abre = proximaAtencion(h, ctx.ahora);
    const [franjas, zonas] = await Promise.all([
      this.dataSource.getRepository(TimeSlot).find({
        where: { distributorId: ctx.distributorId, isActive: true },
        order: { startTime: 'ASC', name: 'ASC' },
      }),
      this.dataSource.getRepository(CoverageZone).find({
        where: {
          distributorId: ctx.distributorId,
          isActive: true,
          deletedAt: IsNull(),
        },
        order: { name: 'ASC' },
      }),
    ]);
    const hoy = ctx.ahora.getTime();
    return {
      atiendeAhora: atiendeLaEmpresa(h, ctx.ahora),
      proximaAtencion: abre
        ? textoDeLaProximaAtencion(abre, h.zona, ctx.ahora)
        : null,
      horarioDeAtencion:
        h.franjas.length === 0
          ? 'Todos los días, todo el día'
          : [...h.franjas]
              .sort(
                (a, b) =>
                  a.weekday - b.weekday || a.opensAt.localeCompare(b.opensAt),
              )
              .map(
                (f) =>
                  `${DIAS[f.weekday]} de ${hora(f.opensAt)} a ${hora(f.closesAt)}`,
              ),
      franjasDeEntrega: franjas.map(
        (f) => `${f.name}: ${hora(f.startTime)} a ${hora(f.endTime)}`,
      ),
      zonasDeCobertura: zonas
        .filter(
          (z) =>
            (!z.validFrom || z.validFrom.getTime() <= hoy) &&
            (!z.validUntil || z.validUntil.getTime() >= hoy),
        )
        .map((z) => ({
          zona: z.name,
          recargo:
            Number(z.surchargeValue) === 0
              ? 'sin recargo'
              : z.surchargeType === CoverageZoneSurchargeType.PERCENTAGE
                ? porcentaje(z.surchargeValue)
                : pesos(z.surchargeValue),
        })),
    };
  }

  private async precios(ctx: ContextoDeLasHerramientas) {
    const productos = await this.dataSource.getRepository(GasCylinder).find({
      where: { distributorId: ctx.distributorId, isActive: true },
      relations: ['promotions'],
      order: { type: 'ASC', gasCylinderId: 'ASC' },
    });
    // El mismo cálculo que el catálogo de la app (promociones con su precio unitario).
    return productos.map((g) => {
      const p = GasCylinderMapper.toPublicDto(g);
      return {
        producto: p.type,
        precio: pesos(p.price),
        promociones: p.promotions.map(
          (pr) =>
            `desde ${pr.quantity} unidades: ${pesos(pr.unitPrice)} cada una`,
        ),
        hayStock: p.inStock,
      };
    });
  }

  private async mediosDePago(ctx: ContextoDeLasHerramientas) {
    const medios = await this.garrafas.mediosDePago(ctx.distributorId);
    return medios.map((m) => ({
      medio: m.name,
      recargo:
        Number(m.surcharge) === 0 ? 'sin recargo' : porcentaje(m.surcharge),
    }));
  }
}
