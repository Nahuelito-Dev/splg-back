import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
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
import { AttendanceService } from './attendance.service';
import { AttendanceMapper } from './attendance.mapper';
import {
  CorrectAttendanceDto,
  RegisterAttendanceDto,
} from './dto/register-attendance.dto';
import { QueryAttendanceDto } from './dto/query-attendance.dto';
import {
  AttendancePageDto,
  AttendanceResponseDto,
} from './dto/attendance-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';

/** Asistencia del personal: la grilla del panel y las marcas del chofer (`/attendance/mine/*`). */
@ApiTags('Personal · Asistencia')
@Controller()
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('employees/:id/attendance')
  @Idempotent()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Registrar la asistencia de un empleado desde el panel (CU-189)',
  })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiCreatedResponse({ type: AttendanceResponseDto })
  @ApiBadRequestResponse({
    description: 'El egreso no es posterior al ingreso',
  })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  @ApiConflictResponse({
    description: 'El empleado está egresado o ya tiene una jornada abierta',
  })
  async register(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegisterAttendanceDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<AttendanceResponseDto> {
    return AttendanceMapper.toDto(
      await this.attendance.register(id, dto, distributorId, actorUserId),
    );
  }

  @Get('attendance')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Consultar la asistencia de los empleados (CU-314)',
    description:
      'Por día (`date`, por omisión hoy si no hay ningún filtro), por período (`from`/`to`), por empleado o sólo las jornadas abiertas (`open`). Informa cuántos están presentes hoy y cuántas jornadas de días anteriores quedaron sin cerrar.',
  })
  @ApiOkResponse({ type: AttendancePageDto })
  @ApiBadRequestResponse({ description: 'Un filtro tiene un valor inválido' })
  async findAll(
    @Query() query: QueryAttendanceDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<AttendancePageDto> {
    const { data, total, presentToday, staleOpen } =
      await this.attendance.findAll(query, distributorId);
    return {
      data: data.map((j) => AttendanceMapper.toDto(j)),
      total,
      presentToday,
      staleOpen,
    };
  }

  @Patch('attendance/:id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Corregir el ingreso o el egreso de una jornada, con nota (CU-313)',
  })
  @ApiParam({ name: 'id', description: 'Jornada UUID' })
  @ApiOkResponse({ type: AttendanceResponseDto })
  @ApiBadRequestResponse({
    description: 'Falta la nota, o el egreso no es posterior al ingreso',
  })
  @ApiNotFoundResponse({ description: 'Jornada no encontrada' })
  async correct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorrectAttendanceDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<AttendanceResponseDto> {
    return AttendanceMapper.toDto(
      await this.attendance.correct(id, dto, distributorId),
    );
  }

  @Get('attendance/mine/current')
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'La jornada abierta del chofer (CU-190, CU-315)',
    description:
      'La app la consulta al abrir para saber si ya marcó el inicio. Si la abierta es de un día anterior, finalizarla desde la app responde 409: se corrige desde el panel.',
  })
  @ApiOkResponse({ type: AttendanceResponseDto })
  @ApiNoContentResponse({
    description:
      'No tiene una jornada abierta, o su cuenta no está vinculada a un legajo',
  })
  async current(
    @CurrentUser('user_id') userId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AttendanceResponseDto | undefined> {
    const jornada = await this.attendance.jornadaAbierta(userId);
    if (!jornada) {
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return AttendanceMapper.toDto(jornada);
  }

  @Post('attendance/mine/check-in')
  @Idempotent()
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'El chofer inicia su jornada desde la app (CU-190)',
    description:
      'Idempotente: si ya tiene una jornada abierta de hoy marcada desde la app, la devuelve (200) en vez de abrir otra.',
  })
  @ApiCreatedResponse({ type: AttendanceResponseDto })
  @ApiOkResponse({
    type: AttendanceResponseDto,
    description: 'Ya tenía una jornada abierta de hoy desde la app',
  })
  @ApiConflictResponse({
    description:
      'La cuenta no está vinculada a un legajo activo, o hay una jornada abierta de otro día o cargada desde el panel',
  })
  async checkIn(
    @CurrentUser('user_id') userId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AttendanceResponseDto> {
    const { jornada, created } = await this.attendance.checkIn(userId);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return AttendanceMapper.toDto(jornada);
  }

  @Post('attendance/mine/check-out')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'El chofer finaliza su jornada desde la app (CU-315)',
  })
  @ApiOkResponse({ type: AttendanceResponseDto })
  @ApiConflictResponse({
    description:
      'La cuenta no está vinculada a un legajo activo, no hay jornada abierta, o la abierta es de un día anterior (se corrige desde el panel)',
  })
  async checkOut(
    @CurrentUser('user_id') userId: string,
  ): Promise<AttendanceResponseDto> {
    return AttendanceMapper.toDto(await this.attendance.checkOut(userId));
  }
}
