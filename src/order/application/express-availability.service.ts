import { Injectable } from '@nestjs/common';
import type { Point } from 'typeorm';

import { CoverageZoneService } from '../../coverage-zone/coverage-zone.service';
import { ExpressSettingsService } from '../../distributor/express-settings.service';
import {
  ExpressSettings,
  dentroDelHorarioExpress,
} from '../../distributor/express-settings';
import { coordenadasDePunto } from '../../common/geo/punto';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';

/** Por qué la modalidad express no se ofrece (CU-148, CU-147). */
export type MotivoExpressNoDisponible =
  | 'disabled'
  | 'no_location'
  | 'out_of_coverage'
  | 'out_of_hours'
  | 'no_motorcycle_driver';

const MENSAJES: Record<MotivoExpressNoDisponible, string> = {
  disabled: 'La distribuidora no ofrece la modalidad express',
  no_location:
    'La dirección no tiene ubicación: no se puede calcular el express',
  out_of_coverage: 'La dirección está fuera de la zona de cobertura',
  out_of_hours: 'Fuera del horario de servicio express',
  no_motorcycle_driver: 'No hay un chofer en moto disponible cerca',
};

export interface DisponibilidadExpress {
  available: boolean;
  reason: MotivoExpressNoDisponible | null;
  message: string | null;
  settings: ExpressSettings;
}

/**
 * Las tres condiciones de la modalidad express (CU-148): dirección dentro de la
 * cobertura, horario de servicio y un chofer en moto dentro del radio express.
 * Consultar no escribe nada: la vuelve a evaluar el alta del pedido, porque el
 * último chofer pudo ocuparse entre una cosa y la otra.
 */
@Injectable()
export class ExpressAvailabilityService {
  constructor(
    private readonly settings: ExpressSettingsService,
    private readonly coverage: CoverageZoneService,
    private readonly orchestrator: DispatchOrchestratorService,
  ) {}

  async evaluar(
    distributorId: string,
    address: { location?: Point | null },
    ahora: Date = new Date(),
  ): Promise<DisponibilidadExpress> {
    const settings = await this.settings.obtener(distributorId);
    const no = (reason: MotivoExpressNoDisponible): DisponibilidadExpress => ({
      available: false,
      reason,
      message: MENSAJES[reason],
      settings,
    });

    if (!settings.enabled) return no('disabled');
    const punto = coordenadasDePunto(address.location);
    if (!punto) return no('no_location');

    const cobertura = await this.coverage.checkCoverage(
      distributorId,
      punto.lat,
      punto.lng,
    );
    if (!cobertura.covered) return no('out_of_coverage');
    if (!dentroDelHorarioExpress(settings, ahora)) return no('out_of_hours');

    const motos = await this.orchestrator.choferesEnMotoCerca(
      punto.lat,
      punto.lng,
      distributorId,
      settings.maxRadiusKm,
    );
    if (motos.length === 0) return no('no_motorcycle_driver');

    return { available: true, reason: null, message: null, settings };
  }
}
