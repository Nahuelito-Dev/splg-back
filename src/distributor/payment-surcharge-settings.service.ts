import { BadRequestException, Injectable } from '@nestjs/common';
import { ModuleConfigService } from './module-config.service';
import { ConfigurableProcess } from './entities/module-config.entity';
import { PaymentMethod } from '../order/entities/order.entity';
import {
  CLAVES_DE_RECARGO,
  esPorcentajeDeRecargo,
  PaymentSurchargeSettings,
  paymentSurchargeSettingsDesde,
  paymentSurchargeSettingsPorDefecto,
  porcentajeDelMedio,
  sonLosDeOmisionRecargo,
} from './payment-surcharge-settings';

/** Lo que devuelve la API: los recargos vigentes y quién los modificó. */
export interface PaymentSurchargeSettingsVigentes
  extends PaymentSurchargeSettings {
  isDefault: boolean;
  updatedAt: Date | null;
  updatedByUserId: string | null;
}

/**
 * Recargo por medio de pago de cada distribuidora. Sin copia en memoria: es
 * plata, y lo que se cotiza tiene que ser lo que rige en el momento en todas
 * las instancias del servidor.
 */
@Injectable()
export class PaymentSurchargeSettingsService {
  constructor(private readonly configs: ModuleConfigService) {}

  /** Los que rigen. Sin distribuidora o sin configuración, los de omisión. */
  async obtener(
    distributorId: string | null | undefined,
  ): Promise<PaymentSurchargeSettings> {
    if (!distributorId) return paymentSurchargeSettingsPorDefecto();
    const params = await this.configs.parametros(
      distributorId,
      ConfigurableProcess.PAYMENT_SURCHARGES,
    );
    return paymentSurchargeSettingsDesde(params);
  }

  /** El % vigente de un medio de pago para esa distribuidora. */
  async porcentaje(
    distributorId: string | null | undefined,
    method: PaymentMethod,
  ): Promise<number> {
    return porcentajeDelMedio(await this.obtener(distributorId), method);
  }

  /** Lo configurado en la base (lo que muestra el panel). */
  async vigentes(
    distributorId: string,
  ): Promise<PaymentSurchargeSettingsVigentes> {
    const fila = await this.configs.fila(
      distributorId,
      ConfigurableProcess.PAYMENT_SURCHARGES,
    );
    const settings = paymentSurchargeSettingsDesde(fila?.params ?? null);
    return {
      ...settings,
      isDefault: sonLosDeOmisionRecargo(settings),
      updatedAt: fila?.updatedAt ?? null,
      updatedByUserId: fila?.updatedByUserId ?? null,
    };
  }

  /**
   * Guarda los porcentajes de Mercado Pago y de efectivo (reemplaza la
   * configuración). Rige para los pedidos que se cotizan o crean desde ahí: los
   * existentes conservan el % con que se crearon. El de transferencia, si llega,
   * se ignora: queda el ya guardado.
   */
  async guardar(
    distributorId: string,
    settings: Pick<
      PaymentSurchargeSettings,
      'mercadoPagoPercentage' | 'cashPercentage'
    > &
      Partial<Pick<PaymentSurchargeSettings, 'transferPercentage'>>,
    actorUserId: string,
  ): Promise<PaymentSurchargeSettingsVigentes> {
    const guardados = await this.obtener(distributorId);
    const completos: PaymentSurchargeSettings = {
      transferPercentage: guardados.transferPercentage,
      mercadoPagoPercentage: settings.mercadoPagoPercentage,
      cashPercentage: settings.cashPercentage,
    };
    if (!CLAVES_DE_RECARGO.every((k) => esPorcentajeDeRecargo(completos[k]))) {
      throw new BadRequestException(
        'Los porcentajes de Mercado Pago y de efectivo son obligatorios: 0 a 30, hasta 2 decimales',
      );
    }
    await this.configs.guardar(
      distributorId,
      ConfigurableProcess.PAYMENT_SURCHARGES,
      { ...completos },
      actorUserId,
    );
    return this.vigentes(distributorId);
  }
}
