import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { CustomerAccountService } from '../../customer-account/application/customer-account.service';
import { CustomerAccountPort } from '../domain/ports/customer-account.port';

/** Adaptador: el control de crédito lo hace el módulo de cuentas corrientes. */
@Injectable()
export class CustomerAccountAdapter extends CustomerAccountPort {
  constructor(private readonly cuentas: CustomerAccountService) {
    super();
  }

  assertCredito(
    manager: EntityManager,
    distributorId: string,
    customerId: string,
    total: Decimal.Value,
  ): Promise<void> {
    return this.cuentas.assertCredito(
      manager,
      distributorId,
      customerId,
      total,
    );
  }
}
