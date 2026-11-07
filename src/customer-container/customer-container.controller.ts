import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Version,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CustomersService } from '../customer/customer.service';
import { CustomerContainerService } from './customer-container.service';
import { CreateContainerAdjustmentDto } from './dto/create-container-adjustment.dto';
import {
  CustomerContainerResponseDto,
  CustomerContainersResponseDto,
} from './dto/customer-container-response.dto';
import { CustomerContainerMovementsResponseDto } from './dto/customer-container-movements-response.dto';
import { QueryContainerMovementsDto } from './dto/query-container-movements.dto';
import { CustomerContainerMovementReason } from './entities/customer-container-movement.entity';

@ApiTags('Customer containers')
@ApiBearerAuth()
@Controller('customers')
export class CustomerContainerController {
  constructor(
    private readonly customerContainers: CustomerContainerService,
    private readonly customers: CustomersService,
    private readonly dataSource: DataSource,
  ) {}

  @Get(':id/containers')
  @Version('2')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Consultar envases propios y prestados de un cliente',
  })
  @ApiOkResponse({ type: CustomerContainersResponseDto })
  @ApiNotFoundResponse({
    description: 'Cliente no encontrado en la distribuidora',
  })
  async listar(
    @Param('id', ParseUUIDPipe) customerId: string,
    @CurrentDistributor({ required: 'staff' }) distributorId: string,
  ): Promise<CustomerContainersResponseDto> {
    const customer = await this.clienteDeLaDistribuidora(
      customerId,
      distributorId,
    );
    return {
      items: await this.customerContainers.listar(
        this.dataSource.manager,
        distributorId,
        customer.userId,
      ),
    };
  }

  @Get(':id/containers/movements')
  @Version('2')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Historial de movimientos de envases del cliente' })
  @ApiOkResponse({ type: CustomerContainerMovementsResponseDto })
  @ApiBadRequestResponse({ description: 'Paginación inválida' })
  @ApiNotFoundResponse({
    description: 'Cliente no encontrado en la distribuidora',
  })
  async movimientos(
    @Param('id', ParseUUIDPipe) customerId: string,
    @Query() query: QueryContainerMovementsDto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string,
  ): Promise<CustomerContainerMovementsResponseDto> {
    const customer = await this.clienteDeLaDistribuidora(
      customerId,
      distributorId,
    );
    return this.customerContainers.listarMovimientos(
      this.dataSource.manager,
      distributorId,
      customer.userId,
      query.limit ?? 10,
      query.offset ?? 0,
    );
  }

  @Post(':id/containers/adjustments')
  @Version('2')
  @Idempotent()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Registrar un ajuste manual en la cuenta de envases',
  })
  @ApiCreatedResponse({ type: CustomerContainerResponseDto })
  @ApiBadRequestResponse({
    description: 'Envases, Cantidad o Motivo inválidos',
  })
  @ApiNotFoundResponse({
    description: 'Cliente o tipo de envase no encontrado en la distribuidora',
  })
  @ApiConflictResponse({
    description: 'El cliente quedaría con envases negativos',
  })
  async ajustar(
    @Param('id', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateContainerAdjustmentDto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerContainerResponseDto> {
    const customer = await this.clienteDeLaDistribuidora(
      customerId,
      distributorId,
    );
    return this.dataSource.transaction((manager) =>
      this.customerContainers.ajuste(manager, {
        distributorId,
        customerUserId: customer.userId,
        gasCylinderId: dto.gasCylinderId,
        quantity: dto.quantity,
        reason: CustomerContainerMovementReason.MANUAL_ADJUSTMENT,
        note: dto.note,
        actorUserId: user.user_id,
      }),
    );
  }

  private async clienteDeLaDistribuidora(
    customerId: string,
    distributorId: string,
  ) {
    await this.customers.assertDeLaDistribuidora(
      { customer_id: customerId },
      distributorId,
    );
    return this.customers.findOne(customerId);
  }
}
