import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  ParseEnumPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CylinderService } from './cylinder.service';
import { CylinderMapper } from './cylinder.mapper';
import {
  CylinderMovementResponseDto,
  CylinderResponseDto,
} from './dto/cylinder-response.dto';
import { CreateCylinderDto } from './dto/create-cylinder.dto';
import { TransitionCylinderDto } from './dto/transition-cylinder.dto';
import { AssignCylindersDto } from './dto/assign-cylinders.dto';
import { CylinderState } from './entities/cylinder.entity';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Cylinders')
@ApiBearerAuth()
@Controller('cylinders')
export class CylinderController {
  constructor(private readonly cylinderService: CylinderService) {}

  @Post()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Dar de alta un envase físico (IN_DEPOT)' })
  @ApiCreatedResponse({ type: CylinderResponseDto })
  @ApiConflictResponse({
    description: 'El serial ya existe en tu distribuidora',
  })
  async create(
    @Body() dto: CreateCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CylinderResponseDto> {
    return CylinderMapper.toDto(
      await this.cylinderService.create(dto, distributorId),
    );
  }

  @Post('assign')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary:
      'Asignar envases (por serial) a un pedido y despacharlos (FILLED→DISPATCHED)',
  })
  @ApiCreatedResponse({ type: CylinderResponseDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Algún envase no está FILLED (no se puede despachar)',
  })
  @ApiNotFoundResponse({ description: 'Pedido o envase no encontrado' })
  async assign(
    @Body() dto: AssignCylindersDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CylinderResponseDto[]> {
    const cylinders = await this.cylinderService.assignToOrder(
      dto.orderId,
      dto.serials,
      distributorId,
      user.user_id,
    );
    return cylinders.map((c) => CylinderMapper.toDto(c));
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Listar envases (scopeado por distribuidora)' })
  @ApiQuery({ name: 'state', enum: CylinderState, required: false })
  @ApiOkResponse({ type: CylinderResponseDto, isArray: true })
  async findAll(
    @CurrentDistributor() distributorId: string | null,
    // El tipo CylinderState no existe en tiempo de ejecucion: sin el pipe, un
    // estado inventado llegaba a la consulta y Postgres respondia con un 500.
    @Query('state', new ParseEnumPipe(CylinderState, { optional: true }))
    state?: CylinderState,
  ): Promise<CylinderResponseDto[]> {
    const cylinders = await this.cylinderService.findAll(distributorId, state);
    return cylinders.map((c) => CylinderMapper.toDto(c));
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({ summary: 'Ver un envase' })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiOkResponse({ type: CylinderResponseDto })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CylinderResponseDto> {
    return CylinderMapper.toDto(
      await this.cylinderService.findOne(id, distributorId),
    );
  }

  @Get(':id/history')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Historial de movimientos/transiciones del envase' })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiOkResponse({ type: CylinderMovementResponseDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  async getHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CylinderMovementResponseDto[]> {
    const movimientos = await this.cylinderService.getHistory(
      id,
      distributorId,
    );
    return movimientos.map((m) => CylinderMapper.movimientoToDto(m));
  }

  @Patch(':id/transition')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary:
      'Transicionar el estado del envase (admin llena/deposita, chofer despacha/entrega/recibe vacío)',
  })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiOkResponse({ type: CylinderResponseDto })
  @ApiBadRequestResponse({ description: 'Transición inválida' })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CylinderResponseDto> {
    return CylinderMapper.toDto(
      await this.cylinderService.transition(
        id,
        dto,
        distributorId,
        user.user_id,
      ),
    );
  }
}
