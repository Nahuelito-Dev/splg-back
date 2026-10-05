import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JobPositionService } from './job-position.service';
import { JobPositionMapper } from './employee.mapper';
import {
  CreateJobPositionDto,
  UpdateJobPositionDto,
} from './dto/create-job-position.dto';
import { JobPositionResponseDto } from './dto/job-position-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { MessageResponseDto } from '../common/dtos/message-response.dto';

/** Puestos de trabajo de la distribuidora (CU-176). */
@ApiTags('Personal · Puestos')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('job-positions')
export class JobPositionController {
  constructor(private readonly positions: JobPositionService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar los puestos con su cantidad de empleados activos',
  })
  @ApiOkResponse({ type: JobPositionResponseDto, isArray: true })
  async findAll(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<JobPositionResponseDto[]> {
    const puestos = await this.positions.findAll(distributorId);
    return puestos.map((p) =>
      JobPositionMapper.toDto(p.puesto, p.activeEmployees),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Crear un puesto de trabajo' })
  @ApiCreatedResponse({ type: JobPositionResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o falta la distribuidora',
  })
  @ApiConflictResponse({ description: 'Ya existe un puesto con ese nombre' })
  async create(
    @Body() dto: CreateJobPositionDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<JobPositionResponseDto> {
    const { puesto, activeEmployees } = await this.positions.create(
      dto,
      distributorId,
    );
    return JobPositionMapper.toDto(puesto, activeEmployees);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modificar un puesto (nombre, categoría o activo)' })
  @ApiParam({ name: 'id', description: 'Puesto UUID' })
  @ApiOkResponse({ type: JobPositionResponseDto })
  @ApiNotFoundResponse({ description: 'Puesto no encontrado' })
  @ApiConflictResponse({ description: 'Ya existe un puesto con ese nombre' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobPositionDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<JobPositionResponseDto> {
    const { puesto, activeEmployees } = await this.positions.update(
      id,
      dto,
      distributorId,
    );
    return JobPositionMapper.toDto(puesto, activeEmployees);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar un puesto (baja lógica)' })
  @ApiParam({ name: 'id', description: 'Puesto UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({ description: 'Puesto no encontrado' })
  @ApiConflictResponse({ description: 'Tiene empleados activos' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MessageResponseDto> {
    return this.positions.remove(id, distributorId);
  }
}
