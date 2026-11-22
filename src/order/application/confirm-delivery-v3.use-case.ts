import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import { conCodigo } from '../../common/errors/con-codigo';
import { errorMessage } from '../../common/errors/error-message';
import { DeliveryService } from '../../delivery/delivery.service';
import { DispatchSettingsService } from '../../distributor/dispatch-settings.service';
import { RedisService } from '../../redis/redis.service';
import { coordenadasDePunto } from '../../common/geo/punto';
import {
  compareDeliveryCode,
  DeliveryCodeError,
  esCodigoDeSeisDigitos,
  MAX_INTENTOS_CODIGO_ENTREGA,
} from '../domain/delivery-code.util';
import {
  ConfirmacionDeEntrega,
  confirmacionDelAdmin,
  medirConfirmacion,
} from '../domain/delivery-confirmation';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import {
  RechazoAsentado,
  UpdateOrderStatusUseCase,
  VerificarEntrega,
} from './update-order-status.use-case';

/** Quién confirma y con qué (el chofer: código y ubicación; el admin: motivo). */
export interface ConfirmarEntregaV3 {
  orderId: string;
  userId: string;
  role: RoleType;
  code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  reason?: string | null;
  /** `Idempotency-Key` del request, si vino: el reintento de un error no suma otro intento. */
  idempotencyKey?: string | null;
}

/** Lo que se guarda de un intento fallido para responder igual a su reintento. */
interface IntentoFallidoGuardado {
  code: string;
  status: number;
  body: Record<string, unknown>;
}

/** Vigencia de la constancia de un intento fallido (la misma que la idempotencia). */
const INTENTO_FALLIDO_TTL_SEC = 60 * 60 * 24;

const intentoFallidoKey = (orderId: string, idempotencyKey: string) =>
  `c1:intento-fallido:${orderId}:${idempotencyKey}`;

/**
 * Confirmación de la entrega con el código AL REVÉS (v3): el cliente ve el
 * código en su app y se lo dice al chofer; el chofer lo escribe y manda su
 * ubicación. Acá vive la regla (rol, asignación, estado, intentos, distancia);
 * el cambio a `delivered` y sus efectos los hace `UpdateOrderStatusUseCase`,
 * el mismo que usa el resto de las entregas.
 *
 * El código, los intentos, la asignación y el estado se comparan CON el pedido
 * bloqueado, en la misma transacción que lo entrega (`VerificarEntrega`): dos
 * pedidos paralelos no pasan el tope de intentos, un código regenerado o un
 * chofer reasignado en el medio no se cuelan. Lo que se valida antes del lock
 * (formato, ubicación, rol) sólo corta rápido sin escribir.
 *
 * El chofer que se equivoca suma un intento (a los 5 el código se bloquea y el
 * cliente genera otro); a quien le toca el error es al cliente, por socket. Estar
 * fuera del radio de llegada no frena la entrega: se marca y queda auditado.
 */
@Injectable()
export class ConfirmDeliveryV3UseCase {
  private readonly logger = new Logger(ConfirmDeliveryV3UseCase.name);

  constructor(
    private readonly orders: OrderRepositoryPort,
    private readonly updateOrderStatusUseCase: UpdateOrderStatusUseCase,
    private readonly realtime: RealtimeDispatchPort,
    private readonly deliveries: DeliveryService,
    private readonly dispatchSettings: DispatchSettingsService,
    private readonly redis: RedisService,
  ) {}

  async execute(input: ConfirmarEntregaV3): Promise<Order> {
    const { orderId, userId, role } = input;
    const esChofer = role === RoleType.DELIVERY;
    const esAdmin = role === RoleType.ADMIN || role === RoleType.SUPER_ADMIN;
    if (!esChofer && !esAdmin) {
      throw new ForbiddenException(
        'Sólo el chofer asignado o un administrador confirman la entrega',
      );
    }

    const order = await this.orders.findByIdFull(orderId);
    if (!order) throw new NotFoundException('Pedido no encontrado');

    const deliveryId = esChofer
      ? await this.deliveryIdDelChofer(order, userId)
      : null;

    // Idempotencia: un reintento (red, doble toque) no vuelve a pedir el código.
    if (order.status === OrderStatus.DELIVERED) return order;
    if (order.status !== OrderStatus.ON_THE_WAY) throw this.noEnCamino();

    return deliveryId
      ? this.confirmarElChofer(order, deliveryId, input)
      : this.confirmarElAdmin(order, input, role as AdminRole);
  }

  private async deliveryIdDelChofer(
    order: Order,
    userId: string,
  ): Promise<string> {
    const delivery = await this.deliveries.buscarPorIdOUsuario(userId);
    if (!delivery || order.deliveryId !== delivery.deliveryId) {
      throw this.noAsignado();
    }
    return delivery.deliveryId;
  }

  private async confirmarElChofer(
    order: Order,
    deliveryId: string,
    input: ConfirmarEntregaV3,
  ): Promise<Order> {
    const { code, latitude, longitude, accuracyMeters, userId } = input;
    // `== null`: el DTO deja pasar `null` en los campos opcionales.
    if (code == null || latitude == null || longitude == null) {
      throw this.validacion(
        'Para confirmar la entrega mandá el código que te dice el cliente y tu ubicación',
      );
    }
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      throw this.validacion(
        'Ubicación: la latitud va entre -90 y 90 y la longitud entre -180 y 180',
      );
    }
    if (
      accuracyMeters != null &&
      (!Number.isFinite(accuracyMeters) ||
        accuracyMeters < 0 ||
        accuracyMeters > 10_000)
    ) {
      throw this.validacion('Precisión: entre 0 y 10000 metros');
    }
    // Un código mal tipeado no es un intento: no tiene forma de ser el del pedido.
    if (typeof code !== 'string' || !esCodigoDeSeisDigitos(code)) {
      throw conCodigo(
        BadRequestException,
        400,
        'El código tiene 6 dígitos: revisá lo que escribiste',
        DeliveryCodeError.FORMATO,
      );
    }

    // El reintento con la misma `Idempotency-Key` de un intento que ya falló
    // responde lo mismo, sin sumar otro intento ni volver a avisar.
    const repetido = await this.intentoYaContado(
      order.orderId,
      input.idempotencyKey,
      code,
    );
    if (repetido) throw new HttpException(repetido.body, repetido.status);

    // Lo que no depende del lock se lee antes, para no tenerlo tomado de más.
    const { arrivalRadiusMeters } = await this.dispatchSettings.obtener(
      order.distributorId,
    );
    const domicilio = coordenadasDePunto(order.address?.location ?? null);

    const verificar: VerificarEntrega = async (pedido, manager) => {
      if (pedido.status !== OrderStatus.ON_THE_WAY) throw this.noEnCamino();
      // Una reasignación en el medio deja afuera al chofer anterior.
      if (pedido.deliveryId !== deliveryId) throw this.noAsignado();
      if (pedido.deliveryCodeAttempts >= MAX_INTENTOS_CODIGO_ENTREGA) {
        throw this.codigoBloqueado();
      }
      if (!compareDeliveryCode(pedido.deliveryCode, code)) {
        throw await this.intentoFallido(pedido, manager, code, input);
      }
      const destino =
        coordenadasDePunto(pedido.deliveryPoint ?? null) ?? domicilio;
      const medida = medirConfirmacion(
        { lat: latitude, lng: longitude },
        destino,
        arrivalRadiusMeters,
      );
      const confirmacion: ConfirmacionDeEntrega = {
        point: { type: 'Point', coordinates: [longitude, latitude] },
        accuracyM: accuracyMeters ?? null,
        distanceM: medida.distanceM,
        outOfRange: medida.outOfRange,
        byUserId: userId,
        byRole: RoleType.DELIVERY,
      };
      return confirmacion;
    };

    return this.updateOrderStatusUseCase.execute(
      order.orderId,
      OrderStatus.DELIVERED,
      undefined,
      undefined,
      undefined,
      undefined,
      verificar,
    );
  }

  /**
   * Suma el intento con el pedido bloqueado (el contador es el fresco: dos
   * errores paralelos no se pisan ni pasan el tope) y arma el rechazo que se
   * commitea; el aviso al cliente y la constancia del reintento van después,
   * con el lock liberado.
   */
  private async intentoFallido(
    pedido: Order,
    manager: EntityManager,
    code: string,
    input: ConfirmarEntregaV3,
  ): Promise<RechazoAsentado> {
    const intentos = pedido.deliveryCodeAttempts + 1;
    await manager
      .createQueryBuilder()
      .update(Order)
      .set({ deliveryCodeAttempts: intentos })
      .where('order_id = :orderId', { orderId: pedido.orderId })
      .execute();
    const error =
      intentos >= MAX_INTENTOS_CODIGO_ENTREGA
        ? this.codigoBloqueado()
        : this.codigoIncorrecto(intentos);
    return new RechazoAsentado(error, async () => {
      this.avisarAlCliente(pedido, intentos);
      await this.recordarIntento(
        pedido.orderId,
        input.idempotencyKey,
        code,
        error,
      );
    });
  }

  /**
   * El admin entrega con motivo (el cliente no tiene celular, soporte…), sin
   * ubicación. El `code` que mande es sólo informativo: no se compara ni
   * frena la entrega. El motivo lo exige `UpdateOrderStatusUseCase`.
   */
  private async confirmarElAdmin(
    order: Order,
    input: ConfirmarEntregaV3,
    role: AdminRole,
  ): Promise<Order> {
    const { userId, reason } = input;
    const verificar: VerificarEntrega = (pedido) => {
      if (pedido.status !== OrderStatus.ON_THE_WAY) throw this.noEnCamino();
      return Promise.resolve(confirmacionDelAdmin(userId, role));
    };
    return this.updateOrderStatusUseCase.execute(
      order.orderId,
      OrderStatus.DELIVERED,
      undefined,
      role,
      userId,
      reason ?? undefined,
      verificar,
    );
  }

  private async intentoYaContado(
    orderId: string,
    idempotencyKey: string | null | undefined,
    code: string,
  ): Promise<IntentoFallidoGuardado | null> {
    if (!idempotencyKey) return null;
    try {
      const guardado = await this.redis.get(
        intentoFallidoKey(orderId, idempotencyKey),
      );
      if (!guardado) return null;
      const intento = JSON.parse(guardado) as IntentoFallidoGuardado;
      // Otro código con la misma clave es otro intento: se cuenta.
      return intento.code === code ? intento : null;
    } catch (error) {
      this.logger.warn(
        `Pedido ${orderId}: no se pudo leer el intento anterior: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async recordarIntento(
    orderId: string,
    idempotencyKey: string | null | undefined,
    code: string,
    error: HttpException,
  ): Promise<void> {
    if (!idempotencyKey) return;
    const intento: IntentoFallidoGuardado = {
      code,
      status: error.getStatus(),
      body: error.getResponse() as Record<string, unknown>,
    };
    await this.redis.setex(
      intentoFallidoKey(orderId, idempotencyKey),
      INTENTO_FALLIDO_TTL_SEC,
      JSON.stringify(intento),
    );
  }

  /**
   * Avisa al cliente, por su socket, que el chofer erró el código
   * (`order:delivery-code-failed`) y, al agotar los intentos, que quedó
   * bloqueado (`order:delivery-code-blocked`). Best-effort: el aviso nunca
   * cambia la respuesta al chofer.
   */
  private avisarAlCliente(order: Order, intentos: number): void {
    try {
      this.realtime.notifyCustomer(
        order.customerId,
        'order:delivery-code-failed',
        {
          orderId: order.orderId,
          attempts: intentos,
          remaining: Math.max(0, MAX_INTENTOS_CODIGO_ENTREGA - intentos),
        },
      );
      if (intentos === MAX_INTENTOS_CODIGO_ENTREGA) {
        this.realtime.notifyCustomer(
          order.customerId,
          'order:delivery-code-blocked',
          { orderId: order.orderId },
        );
      }
    } catch (error) {
      this.logger.warn(
        `Pedido ${order.orderId}: no se pudo avisar al cliente del código errado: ${errorMessage(error)}`,
      );
    }
  }

  private codigoIncorrecto(intentos: number): BadRequestException {
    const remaining = Math.max(0, MAX_INTENTOS_CODIGO_ENTREGA - intentos);
    return new BadRequestException({
      statusCode: 400,
      message: `El código no es correcto. ${
        remaining === 1
          ? 'Te queda 1 intento'
          : `Te quedan ${remaining} intentos`
      }`,
      error: 'Bad Request',
      code: DeliveryCodeError.INCORRECTO,
      attempts: intentos,
      remaining,
    });
  }

  private codigoBloqueado(): ConflictException {
    return conCodigo(
      ConflictException,
      409,
      'Demasiados intentos: pedile al cliente que genere un código nuevo en su app o comunicate con la distribuidora',
      DeliveryCodeError.BLOQUEADO,
    );
  }

  private noEnCamino(): ConflictException {
    return conCodigo(
      ConflictException,
      409,
      'El pedido no está en camino: no se puede confirmar la entrega',
      DeliveryCodeError.NO_EN_CAMINO,
    );
  }

  private noAsignado(): ForbiddenException {
    return new ForbiddenException('Este pedido no está asignado a tu usuario');
  }

  private validacion(message: string): BadRequestException {
    return conCodigo(BadRequestException, 400, message, 'VALIDATION');
  }
}

type AdminRole = RoleType.ADMIN | RoleType.SUPER_ADMIN;
