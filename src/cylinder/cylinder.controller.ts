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
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CylinderService } from './cylinder.service';
import { CreateCylinderDto } from './dto/create-cylinder.dto';
import { TransitionCylinderDto } from './dto/transition-cylinder.dto';
import { CylinderState } from './entities/cylinder.entity';
import { Roles } from '../common/decorators/roles.decorator';
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
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Dar de alta un envase físico (IN_DEPOT)' })
  @ApiResponse({ status: 201, description: 'Envase creado' })
  @ApiResponse({ status: 409, description: 'El serial ya existe en tu distribuidora' })
  create(
    @Body() dto: CreateCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.cylinderService.create(dto, distributorId);
  }

  @Get()
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Listar envases (scopeado por distribuidora)' })
  @ApiQuery({ name: 'state', enum: CylinderState, required: false })
  findAll(
    @CurrentDistributor() distributorId: string | null,
    @Query('state') state?: CylinderState,
  ) {
    return this.cylinderService.findAll(distributorId, state);
  }

  @Get(':id')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({ summary: 'Ver un envase' })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiResponse({ status: 404, description: 'Envase no encontrado' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.cylinderService.findOne(id, distributorId);
  }

  @Get(':id/history')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Historial de movimientos/transiciones del envase' })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  getHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.cylinderService.getHistory(id, distributorId);
  }

  @Patch(':id/transition')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary:
      'Transicionar el estado del envase (admin llena/deposita, chofer despacha/entrega/recibe vacío)',
  })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiResponse({ status: 400, description: 'Transición inválida' })
  @ApiResponse({ status: 404, description: 'Envase no encontrado' })
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cylinderService.transition(
      id,
      dto,
      distributorId,
      user.user_id,
    );
  }
}
