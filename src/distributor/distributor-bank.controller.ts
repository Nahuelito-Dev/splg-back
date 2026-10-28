import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { DistributorBankService } from './distributor-bank.service';
import { BankDetailsDto, BankDetailsResponseDto } from './dto/bank-details.dto';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")';

/** Datos bancarios de la distribuidora para cobrar por transferencia (API v2). */
@ApiTags('Distributors')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'distributor/bank-details', version: '2' })
export class DistributorBankController {
  constructor(private readonly bank: DistributorBankService) {}

  @Get()
  @ApiOperation({
    summary: 'Datos bancarios de la distribuidora',
    description:
      'CBU, alias y titular que ve el cliente cuando paga por transferencia. Cada dato es `null` si no se cargó.',
  })
  @ApiOkResponse({ type: BankDetailsResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  obtener(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<BankDetailsResponseDto> {
    return this.bank.obtener(distributorId);
  }

  @Put()
  @ApiOperation({
    summary: 'Cargar o cambiar los datos bancarios',
    description:
      'Reemplaza los tres datos: el que no se manda (o va `null` o vacío) queda sin cargar. El CBU se valida con sus dos dígitos verificadores; el alias lleva de 6 a 20 caracteres entre letras, números, punto y guion.',
  })
  @ApiOkResponse({ type: BankDetailsResponseDto })
  @ApiBadRequestResponse({
    description: `CBU, alias o titular inválidos, o ${FALTA_DISTRIBUIDORA}`,
  })
  guardar(
    @Body() dto: BankDetailsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<BankDetailsResponseDto> {
    return this.bank.guardar(distributorId, dto);
  }
}
