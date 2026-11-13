import { ConflictException } from '@nestjs/common';
import { conCodigo } from '../../../common/errors/con-codigo';

/** `code` del 409 de tomar o asignar suelto un pedido que está en una hoja de ruta (F34). */
export const ORDER_IN_ROUTE_SHEET = 'ORDER_IN_ROUTE_SHEET';

export const MENSAJE_PEDIDO_EN_HOJA_DE_RUTA =
  'El pedido está en una hoja de ruta: lo lleva el chofer de esa hoja. Para asignarlo aparte, primero sacalo de la hoja';

/**
 * Un pedido que es parada activa de una hoja de ruta en borrador o confirmada
 * no se acepta ni se asigna por fuera de la hoja (ni el chofer desde el pool,
 * ni el admin a mano): 409 con `code` ORDER_IN_ROUTE_SHEET.
 */
export const pedidoEnHojaDeRuta = (): ConflictException =>
  conCodigo(
    ConflictException,
    409,
    MENSAJE_PEDIDO_EN_HOJA_DE_RUTA,
    ORDER_IN_ROUTE_SHEET,
  );
