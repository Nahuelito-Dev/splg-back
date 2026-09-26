import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RatingService } from './rating.service';
import { RatingMapper } from './rating.mapper';
import { RatingResponseDto, RatingSummaryDto } from './dto/rating-response.dto';
import { CreateRatingDto } from './dto/create-rating.dto';
import { Auth } from '../common/decorators/auth.decorator';
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
  @Auth(RoleType.CUSTOMER, RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Calificar el pedido (cliente→chofer o chofer→cliente)',
    description:
      'Solo pedidos DELIVERED. El emisor sale del token; a quién califica se ' +
      'deriva del pedido. Una calificación por pedido y por lado.',
  })
  @ApiCreatedResponse({ type: RatingResponseDto })
  @ApiBadRequestResponse({ description: 'Pedido no entregado / sin chofer' })
  @ApiForbiddenResponse({
    description: 'Pedido de otro / no entregado por vos',
  })
  @ApiConflictResponse({ description: 'Ya calificaste este pedido' })
  async create(
    @Body() dto: CreateRatingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RatingResponseDto> {
    return RatingMapper.toDto(
      await this.ratingService.create(dto, user.user_id, user.role),
    );
  }

  @Get('user/:userId/summary')
  @Auth(
    RoleType.CUSTOMER,
    RoleType.DELIVERY,
    RoleType.ADMIN,
    RoleType.SUPER_ADMIN,
  )
  @ApiOperation({
    summary:
      'Promedio y cantidad de calificaciones de un usuario (como chofer)',
  })
  @ApiParam({ name: 'userId', description: 'User UUID del calificado' })
  @ApiOkResponse({ type: RatingSummaryDto })
  getSummary(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RatingSummaryDto> {
    return this.ratingService.getSummaryForUser(userId, distributorId);
  }

  @Get('user/:userId')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Historial de calificaciones recibidas por un usuario',
  })
  @ApiParam({ name: 'userId', description: 'User UUID del calificado' })
  @ApiOkResponse({ type: RatingResponseDto, isArray: true })
  async findForUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RatingResponseDto[]> {
    const ratings = await this.ratingService.findForUser(userId, distributorId);
    return ratings.map((r) => RatingMapper.toDto(r));
  }
}
