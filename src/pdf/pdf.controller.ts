import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { contentDisposition } from '../s3/content-disposition';
import { DownloadDisposition } from '../s3/dto/download-link.dto';
import { PdfQueryDto, ReporteDeVentasPdfQueryDto } from './dto/pdf-query.dto';
import { DocumentoPdf, PdfDocumentsService } from './pdf-documents.service';

const TIPO_PDF = 'application/pdf';

const RESPUESTA_PDF = {
  description: 'El PDF (A4)',
  content: { [TIPO_PDF]: { schema: { type: 'string', format: 'binary' } } },
} as const;

function enviar(
  documento: DocumentoPdf,
  disposicion: DownloadDisposition = DownloadDisposition.ATTACHMENT,
): StreamableFile {
  return new StreamableFile(documento.contenido, {
    type: TIPO_PDF,
    disposition: contentDisposition(documento.nombre, disposicion),
    length: documento.contenido.length,
  });
}

/**
 * Documentos PDF generados por el back (API v2): remito, recibo, rendición,
 * liquidación, cierre de caja y reporte de ventas. Cada ruta cuelga del recurso
 * que documenta y respeta su regla de acceso.
 */
@ApiTags('Documentos PDF')
@Controller({ version: '2' })
export class PdfController {
  constructor(private readonly documentos: PdfDocumentsService) {}

  @Get('orders/:id/remito.pdf')
  @Permiso('pedidos.ver')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Remito del pedido en PDF',
    description:
      'Ítems, cantidades, precios, recargos, total, cliente, dirección, chofer, vehículo y estado del pago. El código de entrega sólo sale para admin y super admin. El cliente baja sólo los suyos; el personal, los de su distribuidora (el super admin con `X-Distributor`). Lo ajeno responde 404.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiProduces(TIPO_PDF)
  @ApiOkResponse(RESPUESTA_PDF)
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiBadRequestResponse({
    description: 'El super admin no mandó `X-Distributor`',
  })
  async remito(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PdfQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<StreamableFile> {
    return enviar(
      await this.documentos.remito(id, {
        distributorId,
        customerUserId:
          user.role === RoleType.CUSTOMER ? user.user_id : undefined,
      }),
      query.disposicion,
    );
  }

  @Get('orders/:id/recibo.pdf')
  @Permiso('pedidos.ver')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Recibo de pago del pedido en PDF',
    description:
      'Sólo si el pedido está pagado (`paymentStatus: paid`) y no está cancelado (un cancelado pagado se reintegra). Mismas reglas de acceso que el remito.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiProduces(TIPO_PDF)
  @ApiOkResponse(RESPUESTA_PDF)
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiConflictResponse({
    description: 'El pedido todavía no está pagado, o está cancelado',
  })
  async recibo(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PdfQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<StreamableFile> {
    return enviar(
      await this.documentos.recibo(id, {
        distributorId,
        customerUserId:
          user.role === RoleType.CUSTOMER ? user.user_id : undefined,
      }),
      query.disposicion,
    );
  }

  @Get('driver-settlements/:id/pdf')
  @Permiso('finanzas.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Rendición del chofer en PDF',
    description:
      'Pedidos en efectivo, cobros, gastos, esperado, declarado y diferencia. El chofer sólo baja las suyas.',
  })
  @ApiParam({ name: 'id', description: 'Rendición UUID' })
  @ApiProduces(TIPO_PDF)
  @ApiOkResponse(RESPUESTA_PDF)
  @ApiNotFoundResponse({
    description:
      'No existe, es de otra distribuidora o (chofer) de otro chofer',
  })
  async rendicion(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PdfQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StreamableFile> {
    return enviar(
      await this.documentos.rendicion(
        id,
        distributorId,
        user.role === RoleType.DELIVERY ? user.user_id : undefined,
      ),
      query.disposicion,
    );
  }

  @Get('driver-liquidations/:id/pdf')
  @Permiso('finanzas.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Liquidación de comisiones en PDF',
    description: 'Asientos del período, bruto, deducciones y neto.',
  })
  @ApiParam({ name: 'id', description: 'Liquidación UUID' })
  @ApiProduces(TIPO_PDF)
  @ApiOkResponse(RESPUESTA_PDF)
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async liquidacion(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PdfQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StreamableFile> {
    return enviar(
      await this.documentos.liquidacion(id, distributorId),
      query.disposicion,
    );
  }

  @Get('cash-sessions/:id/pdf')
  @Permiso('finanzas.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Cierre de caja (sesión) en PDF',
    description:
      'Apertura, movimientos de la sesión, esperado, contado y diferencia. Si la sesión sigue abierta sale como arqueo, con el saldo actual.',
  })
  @ApiParam({ name: 'id', description: 'Sesión de caja UUID' })
  @ApiProduces(TIPO_PDF)
  @ApiOkResponse(RESPUESTA_PDF)
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async cierreDeCaja(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PdfQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StreamableFile> {
    return enviar(
      await this.documentos.cierreDeCaja(id, distributorId),
      query.disposicion,
    );
  }

  @Get('reports/sales.pdf')
  @Permiso('reportes.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Reporte de ventas del período en PDF',
    description:
      'Mismas cifras que los reportes del panel (pedidos entregados y cobrados, por fecha de entrega, en hora argentina; `hasta` inclusive). Sin fechas, hoy; con una sola, ese día.',
  })
  @ApiProduces(TIPO_PDF)
  @ApiOkResponse(RESPUESTA_PDF)
  @ApiBadRequestResponse({
    description:
      'Fecha inválida, `desde` posterior a `hasta` o falta `X-Distributor`',
  })
  async ventas(
    @Query() query: ReporteDeVentasPdfQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StreamableFile> {
    return enviar(
      await this.documentos.reporteDeVentas(
        distributorId,
        query.desde,
        query.hasta,
      ),
      query.disposicion,
    );
  }
}
