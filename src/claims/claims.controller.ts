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
import { ReopenClaimDto } from './dto/reopen-claim.dto';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
  @ApiOperation({
    summary: 'Admin resuelve un reclamo',
    description:
      'Deja el reclamo en RESOLVED o REJECTED, con nota obligatoria ' +
      '(CU-025). La transición se valida contra la máquina de estados: un ' +
      'reclamo RESOLVED o REJECTED no se vuelve a resolver sin reabrirlo antes ' +
      '(`PATCH /claims/:id/reopen`). Pasar a IN_PROCESS es `PATCH /claims/:id/take`.',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Falta la distribuidora (header X-Distributor, sólo super admin) o datos inválidos (p. ej.: resolution should not be empty; status debe ser uno de: resolved, rejected) ' +
      'o transición de reclamo inválida (p. ej.: resolved → rejected sin reabrir antes)',
  })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveClaimDto,
    @CurrentDistributor({ required: true }) distributorId: string,
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

  @Patch(':id/take')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin toma un reclamo pendiente para revisarlo',
    description:
      'PENDING → IN_PROCESS. Sin nota: sólo marca que un admin ya está mirando ' +
      'el reclamo (distinto de `resolve`, que exige nota de resolución).',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Falta la distribuidora (header X-Distributor, sólo super admin) o el reclamo no está pendiente (ya fue tomado, resuelto o rechazado)',
  })
  async take(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ClaimResponseDto> {
    return ClaimMapper.toDto(await this.claimsService.take(id, distributorId));
  }

  @Patch(':id/reopen')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin reabre un reclamo resuelto o rechazado',
    description:
      'RESOLVED/REJECTED → IN_PROCESS, con motivo obligatorio. Nunca vuelve a ' +
      'PENDING: alguien ya lo había tomado.',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Falta la distribuidora (header X-Distributor, sólo super admin), datos inválidos (reason should not be empty) o el reclamo no está resuelto ni rechazado',
  })
  async reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReopenClaimDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ClaimResponseDto> {
    return ClaimMapper.toDto(
      await this.claimsService.reopen(id, body.reason, distributorId),
    );
  }
}
