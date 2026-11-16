import {
  BadRequestDomainError,
  NotFoundDomainError,
} from '../../../common/errors/domain.error';
import { PurchaseOrderStatus } from '../purchase.enums';

const ESTADO_EN_TEXTO: Record<PurchaseOrderStatus, string> = {
  [PurchaseOrderStatus.DRAFT]: 'en borrador',
  [PurchaseOrderStatus.SENT]: 'enviada',
  [PurchaseOrderStatus.PARTIALLY_RECEIVED]: 'parcialmente recibida',
  [PurchaseOrderStatus.RECEIVED]: 'recibida',
  [PurchaseOrderStatus.CLOSED_SHORT]: 'cerrada con faltante',
  [PurchaseOrderStatus.CANCELLED]: 'cancelada',
};

export const estadoEnTexto = (estado: PurchaseOrderStatus): string =>
  ESTADO_EN_TEXTO[estado];

export class TransicionDeOrdenInvalidaError extends BadRequestDomainError {
  constructor(desde: PurchaseOrderStatus, hacia: PurchaseOrderStatus) {
    super(
      `La orden de compra está ${estadoEnTexto(desde)}: no puede pasar a ${estadoEnTexto(hacia)}`,
    );
  }
}

export class OrdenNoEditableError extends BadRequestDomainError {
  constructor(estado: PurchaseOrderStatus) {
    super(
      `Sólo se edita una orden en borrador; esta está ${estadoEnTexto(estado)}`,
    );
  }
}

export class OrdenNoRecibibleError extends BadRequestDomainError {
  constructor(numero: number, estado: PurchaseOrderStatus) {
    super(
      `La orden de compra N° ${numero} está ${estadoEnTexto(estado)}: sólo se recibe una orden enviada o parcialmente recibida`,
    );
  }
}

export class CompraInvalidaError extends BadRequestDomainError {
  constructor(motivo: string) {
    super(motivo);
  }
}

export class ProveedorNoEncontradoError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Proveedor no encontrado', `id=${id}`);
  }
}

export class OrdenNoEncontradaError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Orden de compra no encontrada', `id=${id}`);
  }
}

export class RecepcionNoEncontradaError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Recepción no encontrada', `id=${id}`);
  }
}
