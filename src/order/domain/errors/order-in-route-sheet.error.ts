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

/** `code` del 409 de salir hacia una parada de la hoja con otra ya en camino. */
export const DRIVER_ALREADY_ON_THE_WAY = 'DRIVER_ALREADY_ON_THE_WAY';

/**
 * Un chofer con hoja de ruta en curso va a una parada por vez: no sale hacia un
 * pedido de la hoja mientras tiene otro en camino. 409 con `code`
 * DRIVER_ALREADY_ON_THE_WAY (lo valida el caso de uso con el cerrojo del chofer).
 */
export const choferYaEnCamino = (): ConflictException =>
  conCodigo(
    ConflictException,
    409,
    'El chofer ya va en camino a otra parada: hay que entregarla o marcarla como no entregada antes de salir a otra',
    DRIVER_ALREADY_ON_THE_WAY,
  );
