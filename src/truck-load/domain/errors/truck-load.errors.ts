import {
  BadRequestDomainError,
  NotFoundDomainError,
} from '../../../common/errors/domain.error';
import { TruckLoadStatus } from '../truck-load.enums';

const ESTADO_EN_TEXTO: Record<TruckLoadStatus, string> = {
  [TruckLoadStatus.LOADING]: 'en carga',
  [TruckLoadStatus.ON_ROUTE]: 'en ruta',
  [TruckLoadStatus.RETURNED]: 'devuelta, pendiente de rendición',
  [TruckLoadStatus.CLOSED]: 'cerrada',
  [TruckLoadStatus.CLOSED_WITH_DIFFERENCE]: 'cerrada con diferencia',
  [TruckLoadStatus.CANCELLED]: 'cancelada',
};

export const estadoDeCargaEnTexto = (estado: TruckLoadStatus): string =>
  ESTADO_EN_TEXTO[estado];

export class CargaNoEncontradaError extends NotFoundDomainError {
  constructor(id: string) {
    super(`Carga de camión no encontrada: ${id}`);
  }
}

export class TransicionDeCargaInvalidaError extends BadRequestDomainError {
  constructor(numero: number, desde: TruckLoadStatus, accion: string) {
    super(
      `La carga N° ${numero} está ${estadoDeCargaEnTexto(desde)}: no se puede ${accion}`,
    );
  }
}

export class CargaInvalidaError extends BadRequestDomainError {
  constructor(motivo: string) {
    super(motivo);
  }
}
