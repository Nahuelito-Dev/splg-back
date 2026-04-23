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
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ClaimStatus } from './entities/claim.entity';

@ApiTags('Claims')
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @Post()
  @ApiOperation({ summary: 'Cliente crea un reclamo' })
  create(@Body() createClaimDto: CreateClaimDto) {
    return this.claimsService.create(createClaimDto);
  }

  @Get()
  @ApiOperation({ summary: 'Admin ve todos los reclamos' })
  findAll() {
    return this.claimsService.findAll();
  }

  @Patch(':id/resolve')
  @ApiOperation({ summary: 'Admin resuelve un reclamo' })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { resolution: string; status: ClaimStatus },
  ) {
    return this.claimsService.resolve(id, body.resolution, body.status);
  }
}
