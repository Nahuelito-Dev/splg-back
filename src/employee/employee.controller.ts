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
  Put,
  Query,
  Res,
  UploadedFile,
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
import type { Response } from 'express';
import { EmployeeService } from './employee.service';
import { TerminateEmployeeUseCase } from './application/terminate-employee.use-case';
import {
  EmployeeConPuesto,
  EmployeeMapper,
  ResumenDeDocumentacion,
} from './employee.mapper';
import { EmployeePhotoService } from './employee-photo.service';
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
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { DownloadQueryDto } from '../s3/dto/download-link.dto';
import {
  ApiSubirFoto,
  ApiVerFoto,
  responderFoto,
  SubirFotoInterceptor,
} from '../s3/photo-http';

const SIN_DOCUMENTACION: ResumenDeDocumentacion = {
  estado: null,
  proximoVencimiento: null,
};

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
    private readonly photo: EmployeePhotoService,
  ) {}

  /** El legajo con `photoUrl` como URL firmada vigente. */
  private async toDto(
    empleado: EmployeeConPuesto,
    deliveryId: string | null,
  ): Promise<EmployeeResponseDto> {
    await this.photo.firmar(empleado);
    return EmployeeMapper.toDto(empleado, deliveryId);
  }

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
    return this.toDto(await this.employees.create(dto, distributorId), null);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar empleados, sin datos personales sensibles (CU-180)',
  })
  @ApiOkResponse({ type: EmployeePageDto })
  @ApiBadRequestResponse({
    description:
      'Algún filtro inválido (por ejemplo, un `documentStatus` que no es uno de los cuatro estados)',
  })
  async findAll(
    @Query() query: QueryEmployeeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeePageDto> {
    const { data, total, documentacion } = await this.employees.findAll(
      query,
      distributorId,
    );
    await this.photo.firmar(data);
    return {
      data: data.map((e) =>
        EmployeeMapper.toListItem(
          e,
          documentacion.get(e.employeeId) ?? SIN_DOCUMENTACION,
        ),
      ),
      total,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver el legajo completo de un empleado (CU-179)' })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeeResponseDto> {
    const { empleado, deliveryId } = await this.employees.findOneDetallado(
      id,
      distributorId,
    );
    return this.toDto(empleado, deliveryId);
  }

  @Put(':id/photo')
  @ApiSubirFoto(
    'Subir o reemplazar la foto del legajo',
    EmployeeResponseDto,
    'Sólo para un legajo sin cuenta de acceso: con cuenta, la foto es la de ' +
      'perfil del usuario (409).',
  )
  @ApiConflictResponse({ description: 'El legajo tiene cuenta de acceso' })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @SubirFotoInterceptor()
  async uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeeResponseDto> {
    const empleado = await this.photo.subir(id, distributorId, file);
    return EmployeeMapper.toDto(
      empleado,
      await this.employees.deliveryIdDe(empleado),
    );
  }

  @Delete(':id/photo')
  @ApiOperation({
    summary: 'Sacar la foto del legajo',
    description:
      'Quita la referencia (el objeto se borra del bucket en segundo plano); ' +
      'no elimina el legajo. Con cuenta de acceso responde 409.',
  })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  @ApiConflictResponse({ description: 'El legajo tiene cuenta de acceso' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async removePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeeResponseDto> {
    const empleado = await this.photo.quitar(id, distributorId);
    return EmployeeMapper.toDto(
      empleado,
      await this.employees.deliveryIdDe(empleado),
    );
  }

  @Get(':id/photo')
  @ApiVerFoto('Ver la foto del legajo (la del usuario si tiene cuenta)')
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async getPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Res() res: Response,
  ): Promise<void> {
    responderFoto(res, query.modo, await this.photo.enlace(id, distributorId));
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
    return this.toDto(empleado, deliveryId);
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
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MessageResponseDto> {
    return this.employees.remove(id, distributorId);
  }

  @Post(':id/termination')
  @Idempotent()
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
    description:
      'Ya está egresado, o el chofer tiene pedidos en curso, una carga de camión abierta o una rendición pendiente',
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
    return this.toDto(empleado, deliveryId);
  }

  @Post(':id/reinstatement')
  @Idempotent()
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
    return this.toDto(empleado, deliveryId);
  }
}
