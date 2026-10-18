import {
  Body,
  Controller,
  Get,
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
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CashBoxService } from '../application/cash-box.service';
import { CashSessionService } from '../application/cash-session.service';
import {
  CashBoxPageDto,
  CashBoxResponseDto,
  CreateCashBoxDto,
  QueryCashBoxDto,
  UpdateCashBoxDto,
} from '../dto/cash-box.dto';
import {
  CashSessionPageDto,
  CashSessionResponseDto,
  OpenCashSessionDto,
  QueryCashSessionDto,
} from '../dto/cash-session.dto';
import { CashMapper } from '../cash.mapper';

/** Cajas de la distribuidora y apertura de sus sesiones (CU-225, 226, 264). */
@ApiTags('Finanzas · Cajas')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('cash-boxes')
export class CashBoxController {
  constructor(
    private readonly cajas: CashBoxService,
    private readonly sesiones: CashSessionService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar las cajas con su saldo',
    description:
      'Saldo según el libro de movimientos y la sesión abierta de cada caja, si tiene.',
  })
  @ApiOkResponse({ type: CashBoxPageDto })
  async findAll(
    @Query() query: QueryCashBoxDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashBoxPageDto> {
    const { data, total } = await this.cajas.findAll(distributorId, query);
    return {
      data: data.map((c) => CashMapper.caja(c.caja, c.openSessionId)),
      total,
    };
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Crear una caja' })
  @ApiCreatedResponse({ type: CashBoxResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o tipo desconocido' })
  @ApiConflictResponse({
    description: 'Ya hay una caja vigente con ese nombre',
  })
  async create(
    @Body() dto: CreateCashBoxDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashBoxResponseDto> {
    const c = await this.cajas.create(dto, distributorId);
    return CashMapper.caja(c.caja, c.openSessionId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver una caja' })
  @ApiParam({ name: 'id', description: 'Caja UUID' })
  @ApiOkResponse({ type: CashBoxResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashBoxResponseDto> {
    const c = await this.cajas.findOne(id, distributorId);
    return CashMapper.caja(c.caja, c.openSessionId);
  }

  @Patch(':id')
  @Idempotent()
  @ApiOperation({
    summary: 'Modificar una caja',
    description: 'Nombre, activa o inactiva, y si exige sesión.',
  })
  @ApiParam({ name: 'id', description: 'Caja UUID' })
  @ApiOkResponse({ type: CashBoxResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'Nombre repetido, o se desactiva (o se cambia si exige sesión) con una sesión abierta',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCashBoxDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashBoxResponseDto> {
    const c = await this.cajas.update(id, dto, distributorId);
    return CashMapper.caja(c.caja, c.openSessionId);
  }

  @Post(':id/sessions')
  @Idempotent()
  @ApiOperation({
    summary: 'Abrir la caja (iniciar una sesión)',
    description:
      'Si el monto inicial no coincide con el saldo del libro, asienta un ajuste de apertura para que el saldo sea el monto inicial.',
  })
  @ApiParam({ name: 'id', description: 'Caja UUID' })
  @ApiCreatedResponse({ type: CashSessionResponseDto })
  @ApiBadRequestResponse({
    description: 'Monto negativo, o la caja no exige sesión',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La caja ya tiene una sesión abierta' })
  async open(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpenCashSessionDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CashSessionResponseDto> {
    const s = await this.sesiones.abrir(id, dto, distributorId, userId);
    return CashMapper.sesion(s.sesion, s.cashBoxName);
  }

  @Get(':id/sessions')
  @ApiOperation({
    summary: 'Sesiones de una caja, de la más nueva a la más vieja',
  })
  @ApiParam({ name: 'id', description: 'Caja UUID' })
  @ApiOkResponse({ type: CashSessionPageDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async sessions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryCashSessionDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashSessionPageDto> {
    const { data, total } = await this.sesiones.findByBox(
      id,
      distributorId,
      query,
    );
    return {
      data: data.map((s) => CashMapper.sesion(s.sesion, s.cashBoxName)),
      total,
    };
  }
}
