import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AvisoContexto,
  enmascararCorreo,
  enmascararToken,
  NotificationChannel,
  NotificationStatus,
  normalizarTipo,
  recortarError,
  recortarTitulo,
} from './domain/aviso';
import { NotificationLog } from './entities/notification-log.entity';

export interface AvisoAEnviar {
  channel: NotificationChannel;
  /** Correo o token del dispositivo: se guarda enmascarado. */
  destino: string;
  titulo?: string | null;
  contexto?: AvisoContexto;
}

/**
 * Deja rastro de cada envío. Es best-effort: si el registro falla se anota en
 * el log y el envío sigue (nunca lanza).
 */
@Injectable()
export class NotificationLogRecorder {
  private readonly logger = new Logger(NotificationLogRecorder.name);

  constructor(
    @InjectRepository(NotificationLog)
    private readonly repo: Repository<NotificationLog>,
  ) {}

  /**
   * Corre el envío y registra su resultado: `sent`, `failed` con el error (que
   * se vuelve a lanzar tal cual) o `skipped` si el envío dice que no salió.
   */
  async conRegistro<T>(
    aviso: AvisoAEnviar,
    enviar: () => Promise<T>,
    /** `null` si el envío fue bien; el motivo si no salió pero tampoco lanzó. */
    sinEfecto: (resultado: T) => {
      status: NotificationStatus;
      error: string;
    } | null = () => null,
  ): Promise<T> {
    let resultado: T;
    try {
      resultado = await enviar();
    } catch (error) {
      this.enSegundoPlano(
        aviso,
        NotificationStatus.FAILED,
        recortarError(error),
      );
      throw error;
    }
    const anomalia = sinEfecto(resultado);
    this.enSegundoPlano(
      aviso,
      anomalia?.status ?? NotificationStatus.SENT,
      anomalia?.error ?? null,
    );
    return resultado;
  }

  /** El registro no demora el envío: sale solo y su fallo sólo se anota en el log. */
  private enSegundoPlano(
    aviso: AvisoAEnviar,
    status: NotificationStatus,
    error: string | null,
  ): void {
    this.registrar(aviso, status, error).catch((fallo: unknown) =>
      this.logger.error(
        `No se pudo registrar el aviso ${aviso.channel}: ${recortarError(fallo)}`,
      ),
    );
  }

  async registrar(
    aviso: AvisoAEnviar,
    status: NotificationStatus,
    error: string | null,
  ): Promise<void> {
    try {
      const contexto = aviso.contexto ?? {};
      const orderId = contexto.orderId ?? null;
      let distributorId = contexto.distributorId ?? null;
      if (!distributorId && orderId) {
        this.logger.warn(
          `Aviso ${aviso.channel}/${normalizarTipo(contexto.type)} sin distribuidora: se la busca por el pedido ${orderId}`,
        );
        distributorId = await this.distribuidoraDelPedido(orderId);
      }
      await this.repo.insert({
        distributorId,
        channel: aviso.channel,
        type: normalizarTipo(contexto.type),
        recipientUserId: contexto.recipientUserId ?? null,
        recipientMasked:
          aviso.channel === NotificationChannel.EMAIL
            ? enmascararCorreo(aviso.destino)
            : enmascararToken(aviso.destino),
        subject: recortarTitulo(aviso.titulo),
        status,
        error:
          status === NotificationStatus.SENT ? null : (error ?? 'Sin detalle'),
        relatedOrderId: orderId,
      });
    } catch (fallo) {
      this.logger.error(
        `No se pudo registrar el aviso ${aviso.channel}/${normalizarTipo(aviso.contexto?.type)}: ${recortarError(fallo)}`,
      );
    }
  }

  private async distribuidoraDelPedido(
    orderId: string,
  ): Promise<string | null> {
    try {
      const filas: Array<{ distributor_id: string | null }> =
        await this.repo.query(
          `SELECT "distributor_id" FROM "order" WHERE "order_id" = $1`,
          [orderId],
        );
      return filas[0]?.distributor_id ?? null;
    } catch (fallo) {
      this.logger.warn(
        `No se pudo ubicar la distribuidora del pedido ${orderId}: ${recortarError(fallo)}`,
      );
      return null;
    }
  }
}
