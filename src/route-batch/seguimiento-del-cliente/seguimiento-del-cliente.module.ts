import { Module } from '@nestjs/common';
import { SeguimientoDelPedido } from './seguimiento-del-pedido.service';

/**
 * Lo que el cliente puede saber del reparto de su pedido (hoja de ruta),
 * solo en su módulo: el asistente del chat lo importa sin depender de
 * `RouteBatchModule` (sólo usa la base y los parámetros, que son globales).
 */
@Module({
  providers: [SeguimientoDelPedido],
  exports: [SeguimientoDelPedido],
})
export class SeguimientoDelClienteModule {}
