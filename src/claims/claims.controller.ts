import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { ResolveClaimDto } from './dto/resolve-claim.dto';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { ClaimMapper } from './claims.mapper';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

@ApiTags('Claims')
@ApiBearerAuth()
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @Post()
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Cliente crea un reclamo' })
  @ApiCreatedResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({ description: 'El pedido no existe' })
  @ApiBadRequestResponse({ description: 'El pedido no es del cliente' })
  async create(
    @Body() createClaimDto: CreateClaimDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ClaimResponseDto> {
    // Anti-impersonación: un cliente solo puede reclamar como SÍ MISMO (se
    // fuerza el customerId al del token, ignorando lo que venga en el body).
    // Un admin puede crear a nombre de un cliente (soporte). El distributor_id
    // NO sale del header: se deriva de la orden reclamada (claims.service).
    const isAdmin =
      user.role === RoleType.ADMIN || user.role === RoleType.SUPER_ADMIN;
    const dto = isAdmin
      ? createClaimDto
      : { ...createClaimDto, customerId: user.user_id };
    // Al admin lo acota su distribuidora; al cliente, que el pedido sea suyo.
    return ClaimMapper.toDto(
      await this.claimsService.create(dto, isAdmin ? distributorId : null),
    );
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin ve todos los reclamos' })
  @ApiOkResponse({ type: ClaimResponseDto, isArray: true })
  async findAll(
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ClaimResponseDto[]> {
    const claims = await this.claimsService.findAll(distributorId);
    return claims.map((c) => ClaimMapper.toDto(c));
  }

  @Patch(':id/resolve')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin resuelve un reclamo' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: resolution should not be empty; status debe ser uno de: pending, in_process, resolved, rejected)',
  })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveClaimDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ClaimResponseDto> {
    return ClaimMapper.toDto(
      await this.claimsService.resolve(
        id,
        body.resolution,
        body.status,
        distributorId,
      ),
    );
  }
}
