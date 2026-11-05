import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { DocumentReadingMapper } from './document-reading.mapper';
import { DocumentReadingService } from './document-reading.service';
import {
  DocumentReadingDto,
  DocumentReadingListDto,
  DocumentReadingSpendDto,
  DocumentReadingRunDto,
  QueryDocumentReadingsDto,
  RunDocumentReadingsDto,
} from './dto/document-reading.dto';
import { DocumentReadingRunnerService } from './document-reading-runner.service';

const FALTA_DISTRIBUIDORA = 'Falta la distribuidora (`X-Distributor`)';

@ApiTags('Lecturas de documentos (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'document-readings', version: '2' })
export class DocumentReadingController {
  constructor(
    private readonly lecturas: DocumentReadingService,
    private readonly runner: DocumentReadingRunnerService,
  ) {}

  @Post('run')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({
    summary: 'Correr la lectura automática ahora',
    description:
      'Lee los adjuntos pendientes de esta distribuidora dentro del tope mensual. Con dryRun sólo informa cuántos se leerían.',
  })
  @ApiOkResponse({ type: DocumentReadingRunDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiConflictResponse({
    description: 'La lectura de documentos está apagada; dryRun funciona igual',
  })
  async correr(
    @Body() dto: RunDocumentReadingsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DocumentReadingRunDto> {
    return this.runner.run(distributorId, { dryRun: dto.dryRun });
  }

  @Get()
  @ApiOperation({
    summary: 'Lecturas de documentos (módulo M6)',
    description:
      'Lo que el sistema leyó de cada documento subido: tipo, datos con su confianza, avisos, estado y costo. La más nueva primero.',
  })
  @ApiOkResponse({ type: DocumentReadingListDto })
  @ApiBadRequestResponse({
    description: `Filtro o paginación inválidos, o ${FALTA_DISTRIBUIDORA.toLowerCase()}`,
  })
  async listar(
    @Query() query: QueryDocumentReadingsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DocumentReadingListDto> {
    const { data, total } = await this.lecturas.listar(distributorId, query);
    return { data: data.map((r) => DocumentReadingMapper.toDto(r)), total };
  }

  @Get('spend')
  @ApiOperation({
    summary: 'Gasto del mes en lecturas',
    description:
      'Cuántos documentos se leyeron en el mes en curso (hora de Argentina) y cuánto costó, en dólares estimados.',
  })
  @ApiOkResponse({ type: DocumentReadingSpendDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async gasto(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DocumentReadingSpendDto> {
    const { lecturas, costoUsd } =
      await this.lecturas.gastoDelMes(distributorId);
    return {
      readings: lecturas,
      costUsd: costoUsd,
      available: this.lecturas.disponible,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ficha de una lectura, con su adjunto' })
  @ApiParam({ name: 'id', description: 'Reading UUID' })
  @ApiOkResponse({ type: DocumentReadingDto })
  @ApiBadRequestResponse({
    description: `El id no es un UUID, o ${FALTA_DISTRIBUIDORA.toLowerCase()}`,
  })
  @ApiNotFoundResponse({
    description: 'La lectura no existe o es de otra distribuidora',
  })
  async obtener(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DocumentReadingDto> {
    return DocumentReadingMapper.toDto(
      await this.lecturas.obtener(id, distributorId),
    );
  }
}
