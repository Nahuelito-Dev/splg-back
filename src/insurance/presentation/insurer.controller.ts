import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { InsurerService } from '../application/insurer.service';
import {
  CreateInsurerDto,
  InsurerPageDto,
  InsurerResponseDto,
  QueryInsurerDto,
  UpdateInsurerDto,
} from '../dto/insurer.dto';
import { InsuranceMapper } from './insurance.mapper';
import { Permiso } from '../../common/decorators/permiso.decorator';

/** Aseguradoras de la distribuidora, con el enlace de pago de sus cuotas (API v2). */
@ApiTags('Seguros · Aseguradoras')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'insurers', version: '2' })
export class InsurerController {
  constructor(private readonly insurers: InsurerService) {}

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({
    summary: 'Listar las aseguradoras',
    description: 'Con `term` filtra por nombre. Orden alfabético.',
  })
  @ApiOkResponse({ type: InsurerPageDto })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  async findAll(
    @Query() query: QueryInsurerDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsurerPageDto> {
    const { data, total } = await this.insurers.findAll(distributorId, query);
    return { data: data.map((i) => InsuranceMapper.insurer(i)), total };
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver una aseguradora' })
  @ApiParam({ name: 'id', description: 'Aseguradora UUID' })
  @ApiOkResponse({ type: InsurerResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsurerResponseDto> {
    return InsuranceMapper.insurer(
      await this.insurers.findOne(id, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Dar de alta una aseguradora',
    description:
      '`paymentUrl` es la página de pago (https) que el aviso de cada cuota le muestra al admin. El nombre es único entre las aseguradoras vigentes de la distribuidora.',
  })
  @ApiCreatedResponse({ type: InsurerResponseDto })
  @ApiBadRequestResponse({
    description: 'CUIT, correo, teléfono o enlaces inválidos',
  })
  @ApiConflictResponse({ description: 'Ya hay una aseguradora con ese nombre' })
  async create(
    @Body() dto: CreateInsurerDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsurerResponseDto> {
    return InsuranceMapper.insurer(
      await this.insurers.create(dto, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Patch(':id')
  @ApiOperation({ summary: 'Modificar una aseguradora' })
  @ApiParam({ name: 'id', description: 'Aseguradora UUID' })
  @ApiOkResponse({ type: InsurerResponseDto })
  @ApiBadRequestResponse({ description: 'Dato inválido' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'Ya hay una aseguradora con ese nombre' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInsurerDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsurerResponseDto> {
    return InsuranceMapper.insurer(
      await this.insurers.update(id, dto, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Dar de baja una aseguradora',
    description:
      'Baja lógica: la aseguradora y sus pólizas vencidas o canceladas se conservan en el historial.',
  })
  @ApiParam({ name: 'id', description: 'Aseguradora UUID' })
  @ApiNoContentResponse({ description: 'Dada de baja' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description: 'Tiene pólizas vigentes o futuras: se cancelan antes',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<void> {
    await this.insurers.remove(id, distributorId);
  }
}
