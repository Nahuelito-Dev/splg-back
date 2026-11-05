import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RatingService } from './rating.service';
import { RatingMapper } from './rating.mapper';
import { RatingResponseDto, RatingSummaryDto } from './dto/rating-response.dto';
import { ModerateRatingDto } from './dto/moderate-rating.dto';
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
  @ApiBadRequestResponse({
    description:
      'Estrellas o comentario inválidos, o el pedido no está entregado o no tiene chofer',
  })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
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
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
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
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async findForUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RatingResponseDto[]> {
    const ratings = await this.ratingService.findForUser(userId, distributorId);
    return ratings.map((r) => RatingMapper.toDto(r));
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Ficha de una calificación (incluye las ocultas)' })
  @ApiParam({ name: 'id', description: 'Rating UUID' })
  @ApiOkResponse({ type: RatingResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({
    description: 'La calificación no existe o es de otra distribuidora',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RatingResponseDto> {
    return RatingMapper.toDto(
      await this.ratingService.findOne(id, distributorId),
    );
  }

  @Patch(':id/hide')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Ocultar una calificación (moderación), con motivo',
    description:
      'No se borra: deja de contar en promedios y resúmenes y no se muestra a ' +
      'clientes; el admin la sigue viendo marcada (`hidden: true`).',
  })
  @ApiParam({ name: 'id', description: 'Rating UUID' })
  @ApiOkResponse({ type: RatingResponseDto })
  @ApiBadRequestResponse({
    description: 'Falta el motivo, está en blanco o pasa de 500 caracteres',
  })
  @ApiNotFoundResponse({
    description: 'La calificación no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({ description: 'Ya está oculta' })
  async hide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateRatingDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RatingResponseDto> {
    return RatingMapper.toDto(
      await this.ratingService.hide(
        id,
        dto.reason,
        user.user_id,
        distributorId,
      ),
    );
  }

  @Patch(':id/unhide')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Volver a mostrar una calificación oculta, con motivo',
    description:
      'Vuelve a contar en los promedios. El motivo queda en el registro de ' +
      'auditoría (la calificación sólo conserva el de la última ocultación ' +
      'vigente).',
  })
  @ApiParam({ name: 'id', description: 'Rating UUID' })
  @ApiOkResponse({ type: RatingResponseDto })
  @ApiBadRequestResponse({
    description: 'Falta el motivo, está en blanco o pasa de 500 caracteres',
  })
  @ApiNotFoundResponse({
    description: 'La calificación no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({ description: 'No está oculta' })
  async unhide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateRatingDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RatingResponseDto> {
    return RatingMapper.toDto(
      await this.ratingService.unhide(id, dto.reason, distributorId),
    );
  }
}
