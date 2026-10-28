import {
  Controller,
  Get,
  Logger,
  Param,
  Query,
  Res,
  Version,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { SinTimeout } from '../common/decorators/sin-timeout.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CABECERA_TOTAL } from '../common/http/total';
import { ExportFormat } from './export.types';
import { ExportsService } from './exports.service';

/** Exportes completos (todas las filas que cumplen los filtros) en CSV y Excel. */
@ApiTags('Exportes')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'exports', version: '2' })
export class ExportsController {
  private readonly logger = new Logger(ExportsController.name);

  constructor(private readonly exportsService: ExportsService) {}

  @Get(':recurso')
  @Version('2')
  @SinTimeout()
  @ApiOperation({
    summary: 'Descargar todas las filas de un listado en CSV o Excel',
    description:
      'Acepta los mismos filtros que el listado de cada recurso y devuelve todas ' +
      'las filas que los cumplen, no sólo una página. Recursos: pedidos, clientes, ' +
      'choferes, vehiculos, garrafas, envases, stock-resumen, stock-movimientos, ' +
      'cajas, movimientos-caja, cuentas-corrientes, rendiciones, liquidaciones, ' +
      'combustible, multas, siniestros, neumaticos, costos-flota, reclamos, ' +
      'incidencias, ordenes-compra, recepciones, proveedores, legajos, auditoria ' +
      'y auditoria-datos. El CSV usa `;` y coma decimal, con BOM UTF-8. Un super ' +
      'admin necesita `X-Distributor`. `limit`, `offset` y `page` se ignoran.',
  })
  @ApiParam({ name: 'recurso', example: 'pedidos' })
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ExportFormat,
    description: 'Por defecto `csv`',
  })
  @ApiProduces(
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @ApiOkResponse({
    description:
      'El archivo, con `Content-Disposition: attachment; filename="<recurso>-<AAAA-MM-DD>.<ext>"`. ' +
      'El total de filas va en `X-Total-Count`.',
  })
  @ApiBadRequestResponse({
    description:
      'Formato o filtros inválidos, falta la distribuidora, o hay más filas que el tope (`EXPORT_MAX_ROWS`)',
  })
  @ApiNotFoundResponse({ description: 'El recurso no existe' })
  async exportar(
    @Param('recurso') recurso: string,
    @Query() parametros: Record<string, unknown>,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Res() res: Response,
  ): Promise<void> {
    const corte = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) corte.abort();
    });
    const exporte = await this.exportsService.preparar(
      recurso,
      parametros,
      distributorId,
      corte.signal,
    );
    res.status(200);
    res.setHeader('Content-Type', exporte.tipoDeContenido);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exporte.nombreDeArchivo}"`,
    );
    res.setHeader(CABECERA_TOTAL, String(exporte.total));
    res.setHeader('Cache-Control', 'no-store');
    try {
      await pipeline(exporte.cuerpo, res);
    } catch (error) {
      // Ya se enviaron los encabezados: no se puede responder un error. El
      // pipeline cortó la conexión, así el archivo truncado no pasa por completo.
      this.logger.error(
        `El exporte de ${recurso} se cortó: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Se cierra el socket: el cliente ve una descarga fallida, no un 200 completo.
      res.destroy(error instanceof Error ? error : undefined);
      res.req.socket?.destroy();
    }
  }
}
