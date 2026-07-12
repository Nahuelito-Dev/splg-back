import { Body, Controller, Get, Param, Post, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RatingService } from './rating.service';
import { CreateRatingDto } from './dto/create-rating.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Ratings')
@ApiBearerAuth()
@Controller('ratings')
export class RatingController {
  constructor(private readonly ratingService: RatingService) {}

  @Post()
  @Roles(RoleType.CUSTOMER, RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Calificar el pedido (cliente→chofer o chofer→cliente)',
    description:
      'Solo pedidos DELIVERED. El emisor sale del token; a quién califica se ' +
      'deriva del pedido. Una calificación por pedido y por lado.',
  })
  @ApiResponse({ status: 201, description: 'Calificación registrada' })
  @ApiResponse({ status: 400, description: 'Pedido no entregado / sin chofer' })
  @ApiResponse({ status: 403, description: 'Pedido de otro / no entregado por vos' })
  @ApiResponse({ status: 409, description: 'Ya calificaste este pedido' })
  create(
    @Body() dto: CreateRatingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ratingService.create(dto, user.user_id, user.role);
  }

  @Get('user/:userId/summary')
  @Roles(
    RoleType.CUSTOMER,
    RoleType.DELIVERY,
    RoleType.ADMIN,
    RoleType.SUPER_ADMIN,
  )
  @ApiOperation({
    summary: 'Promedio y cantidad de calificaciones de un usuario (como chofer)',
  })
  @ApiParam({ name: 'userId', description: 'User UUID del calificado' })
  getSummary(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.ratingService.getSummaryForUser(userId, distributorId);
  }

  @Get('user/:userId')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Historial de calificaciones recibidas por un usuario' })
  @ApiParam({ name: 'userId', description: 'User UUID del calificado' })
  findForUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.ratingService.findForUser(userId, distributorId);
  }
}
