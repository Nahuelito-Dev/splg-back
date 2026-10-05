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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { EmployeeService } from './employee.service';
import { TerminateEmployeeUseCase } from './application/terminate-employee.use-case';
import { EmployeeMapper } from './employee.mapper';
import {
  CreateEmployeeDto,
  UpdateEmployeeDto,
} from './dto/create-employee.dto';
import { QueryEmployeeDto } from './dto/query-employee.dto';
import {
  ReinstateEmployeeDto,
  TerminateEmployeeDto,
} from './dto/terminate-employee.dto';
import {
  EmployeePageDto,
  EmployeeResponseDto,
} from './dto/employee-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MessageResponseDto } from '../common/dtos/message-response.dto';

/**
 * Legajos del personal (CU-177 a CU-181). Los datos personales (documento,
 * CUIL, domicilio, contacto de emergencia) sólo salen en `GET :id` y en las
 * escrituras que devuelven el legajo; el listado no los trae (Ley 25.326).
 * `POST :id/account` vive en `registro/` porque depende del alta de usuarios.
 */
@ApiTags('Personal · Empleados')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('employees')
export class EmployeeController {
  constructor(
    private readonly employees: EmployeeService,
    private readonly terminate: TerminateEmployeeUseCase,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Registrar el legajo de un empleado (CU-177)' })
  @ApiCreatedResponse({ type: EmployeeResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o CUIL con dígito verificador incorrecto',
  })
  @ApiNotFoundResponse({
    description: 'El puesto no existe en la distribuidora',
  })
  @ApiConflictResponse({
    description: 'Documento, CUIL o legajo ya usados, o puesto inactivo',
  })
  async create(
    @Body() dto: CreateEmployeeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeeResponseDto> {
    return EmployeeMapper.toDto(
      await this.employees.create(dto, distributorId),
      null,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Listar empleados, sin datos personales sensibles (CU-180)',
  })
  @ApiOkResponse({ type: EmployeePageDto })
  async findAll(
    @Query() query: QueryEmployeeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeePageDto> {
    const { data, total } = await this.employees.findAll(query, distributorId);
    return { data: data.map((e) => EmployeeMapper.toListItem(e)), total };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver el legajo completo de un empleado (CU-179)' })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeeResponseDto> {
    const { empleado, deliveryId } = await this.employees.findOneDetallado(
      id,
      distributorId,
    );
    return EmployeeMapper.toDto(empleado, deliveryId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modificar el legajo de un empleado (CU-178)' })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({ description: 'Empleado o puesto no encontrado' })
  @ApiConflictResponse({ description: 'Documento, CUIL o legajo ya usados' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeeResponseDto> {
    const { empleado, deliveryId } = await this.employees.update(
      id,
      dto,
      distributorId,
    );
    return EmployeeMapper.toDto(empleado, deliveryId);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Eliminar un legajo dado de alta por error (CU-178)',
  })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  @ApiConflictResponse({
    description: 'No es una alta errónea: corresponde el egreso',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MessageResponseDto> {
    return this.employees.remove(id, distributorId);
  }

  @Post(':id/termination')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Registrar el egreso: bloquea la cuenta, deshabilita al chofer y libera su vehículo (CU-181)',
  })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiBadRequestResponse({
    description: 'La fecha de egreso es anterior a la de ingreso',
  })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  @ApiConflictResponse({
    description: 'Ya está egresado, o el chofer tiene pedidos en curso',
  })
  async terminateEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TerminateEmployeeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<EmployeeResponseDto> {
    const { empleado, deliveryId } = await this.terminate.execute(
      id,
      dto,
      distributorId,
      actorUserId,
    );
    return EmployeeMapper.toDto(empleado, deliveryId);
  }

  @Post(':id/reinstatement')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reingresar a un empleado egresado. No desbloquea su cuenta (CU-181)',
  })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiBadRequestResponse({
    description: 'La fecha de ingreso es anterior al egreso',
  })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  @ApiConflictResponse({ description: 'El empleado no está egresado' })
  async reinstate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReinstateEmployeeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeeResponseDto> {
    const { empleado, deliveryId } = await this.employees.reinstate(
      id,
      dto,
      distributorId,
    );
    return EmployeeMapper.toDto(empleado, deliveryId);
  }
}
