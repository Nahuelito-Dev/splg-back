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
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

@ApiTags('Claims')
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @Post()
  @Roles(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Cliente crea un reclamo' })
  create(
    @Body() createClaimDto: CreateClaimDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Anti-impersonación: un cliente solo puede reclamar como SÍ MISMO (se
    // fuerza el customerId al del token, ignorando lo que venga en el body).
    // Un admin puede crear a nombre de un cliente (soporte). El distributor_id
    // NO sale del header: se deriva de la orden reclamada (claims.service).
    const isAdmin =
      user.role === RoleType.ADMIN || user.role === RoleType.SUPER_ADMIN;
    const dto = isAdmin
      ? createClaimDto
      : { ...createClaimDto, customerId: user.user_id };
    return this.claimsService.create(dto);
  }

  @Get()
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin ve todos los reclamos' })
  findAll(@CurrentDistributor() distributorId: string | null) {
    return this.claimsService.findAll(distributorId);
  }

  @Patch(':id/resolve')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin resuelve un reclamo' })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveClaimDto,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.claimsService.resolve(
      id,
      body.resolution,
      body.status,
      distributorId,
    );
  }
}
