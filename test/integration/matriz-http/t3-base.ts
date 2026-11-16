/** Escenario de la T3: cuentas, direcciones e invitaciones en A y B. */
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomerAccount } from '../../../src/customer-account/entities/customer-account.entity';
import {
  CustomerAccountStatus,
  TaxCondition,
} from '../../../src/customer-account/domain/customer-account.enums';
import { Customer } from '../../../src/customer/entities/customer.entity';
import { CoverageZone } from '../../../src/coverage-zone/entities/coverage-zone.entity';
import { GasCylinder } from '../../../src/gascylinder/entities/gascylinder.entity';
import {
  DistribuidoraCreadaEvent,
  EVENTO_DISTRIBUIDORA_CREADA,
} from '../../../src/distributor/events/distribuidora-creada.event';
import { PaymentMethod } from '../../../src/order/entities/order.entity';
import {
  RepurchaseEstimateSource,
  RepurchaseInvitation,
  RepurchaseInvitationStatus,
} from '../../../src/repurchase-forecast/entities/repurchase-invitation.entity';
import { UserAddress } from '../../../src/user-address/entities/user-address.entity';
import { TestApp } from '../setup/test-env';
import {
  cabecerasDe_,
  Escenario,
  Persona,
  sembrarEscenario,
  sembrarPersona,
} from './matriz';

export interface EscenarioT3 extends Escenario {
  clienteA2: Persona;
  customerA: string;
  customerB: string;
  addressA: string;
  addressAAlternativa: string;
  addressAFuera: string;
  addressB: string;
  accountA: string;
  accountB: string;
  invitationA: string;
  invitationB: string;
  gasCylinderA: string;
  gasCylinderB: string;
}

const cuadrado = (lng: number, lat: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lng - 0.003, lat - 0.003],
      [lng + 0.003, lat - 0.003],
      [lng + 0.003, lat + 0.003],
      [lng - 0.003, lat + 0.003],
      [lng - 0.003, lat - 0.003],
    ],
  ],
});

export async function sembrarBaseT3(app: TestApp): Promise<EscenarioT3> {
  const e = await sembrarEscenario(app);
  const eventos = app.get(EventEmitter2);
  await eventos.emitAsync(
    EVENTO_DISTRIBUIDORA_CREADA,
    new DistribuidoraCreadaEvent(e.distA.id),
  );
  await eventos.emitAsync(
    EVENTO_DISTRIBUIDORA_CREADA,
    new DistribuidoraCreadaEvent(e.distB.id),
  );
  const clienteA2 = await sembrarPersona(
    app,
    'customer',
    'cliente-a2-t3',
    e.distA.id,
  );
  e.actores.clienteA2 = cabecerasDe_(
    clienteA2.email,
    'customer-app',
    e.distA.slug,
  );
  const ds = app.get(DataSource);
  const zonas = ds.getRepository(CoverageZone);
  await zonas.save({
    distributorId: e.distA.id,
    name: 'Centro T3',
    area: cuadrado(-64.19, -31.41),
    surchargeType: 'percentage',
    surchargeValue: 10,
  } as Partial<CoverageZone>);
  await zonas.save({
    distributorId: e.distA.id,
    name: 'Alternativa T3',
    area: cuadrado(-64.18, -31.4),
    surchargeType: 'percentage',
    surchargeValue: 25,
  } as Partial<CoverageZone>);
  const customers = ds.getRepository(Customer);
  const customerA = await customers.findOneByOrFail({
    userId: e.clienteA.userId,
  });
  const customerB = await customers.findOneByOrFail({
    userId: e.clienteB.userId,
  });
  const addresses = ds.getRepository(UserAddress);
  const addressA = await addresses.save({
    userId: e.clienteA.userId,
    street: 'Calle A 100',
    city: 'Córdoba',
    isDefault: true,
    location: { type: 'Point', coordinates: [-64.19, -31.41] },
  } as Partial<UserAddress>);
  const addressB = await addresses.save({
    userId: e.clienteB.userId,
    street: 'Calle B 100',
    city: 'Córdoba',
    isDefault: true,
    location: { type: 'Point', coordinates: [-64.2, -31.42] },
  } as Partial<UserAddress>);
  const addressAAlternativa = await addresses.save({
    userId: e.clienteA.userId,
    street: 'Calle A 200',
    city: 'Córdoba',
    isDefault: false,
    location: { type: 'Point', coordinates: [-64.18, -31.4] },
  } as Partial<UserAddress>);
  const addressAFuera = await addresses.save({
    userId: e.clienteA.userId,
    street: 'Calle A fuera 300',
    city: 'Córdoba',
    isDefault: false,
    location: { type: 'Point', coordinates: [-64.1, -31.3] },
  } as Partial<UserAddress>);
  const accounts = ds.getRepository(CustomerAccount);
  const gasCylinders = ds.getRepository(GasCylinder);
  const gasCylinderA = await gasCylinders.save({
    distributorId: e.distA.id,
    type: '10kg T3',
    weight: 10,
    price: 1000,
    stock: 100,
    isActive: true,
  } as Partial<GasCylinder>);
  const gasCylinderB = await gasCylinders.save({
    distributorId: e.distB.id,
    type: '10kg T3 B',
    weight: 10,
    price: 1000,
    stock: 100,
    isActive: true,
  } as Partial<GasCylinder>);
  const accountA = await accounts.save({
    distributorId: e.distA.id,
    customerUserId: e.clienteA.userId,
    businessName: 'Cuenta T3 A',
    taxCondition: TaxCondition.FINAL_CONSUMER,
    creditLimit: 10000,
    paymentTermsDays: 30,
    status: CustomerAccountStatus.ACTIVE,
  } as Partial<CustomerAccount>);
  const accountB = await accounts.save({
    distributorId: e.distB.id,
    customerUserId: e.clienteB.userId,
    businessName: 'Cuenta T3 B',
    taxCondition: TaxCondition.FINAL_CONSUMER,
    creditLimit: 10000,
    paymentTermsDays: 30,
    status: CustomerAccountStatus.ACTIVE,
  } as Partial<CustomerAccount>);
  const now = new Date();
  const invitation = (
    distributorId: string,
    userId: string,
    addressId: string,
    gasCylinderId: string,
  ) => ({
    distributorId,
    userId,
    addressId,
    paymentMethod: PaymentMethod.CASH,
    projectedDepletionAt: now,
    estimateSource: RepurchaseEstimateSource.HISTORY,
    suggestedItems: [{ gasCylinderId, quantity: 1 }],
    status: RepurchaseInvitationStatus.PENDING,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    respondedAt: null,
    orderId: null,
  });
  const invitations = ds.getRepository(RepurchaseInvitation);
  const invitationA = await invitations.save(
    invitation(
      e.distA.id,
      e.clienteA.userId,
      addressA.addressId,
      gasCylinderA.gasCylinderId,
    ) as Partial<RepurchaseInvitation>,
  );
  const invitationB = await invitations.save(
    invitation(
      e.distB.id,
      e.clienteB.userId,
      addressB.addressId,
      gasCylinderB.gasCylinderId,
    ) as Partial<RepurchaseInvitation>,
  );
  return {
    ...e,
    clienteA2,
    customerA: customerA.customerId,
    customerB: customerB.customerId,
    addressA: addressA.addressId,
    addressAAlternativa: addressAAlternativa.addressId,
    addressAFuera: addressAFuera.addressId,
    addressB: addressB.addressId,
    accountA: accountA.accountId,
    accountB: accountB.accountId,
    invitationA: invitationA.invitationId,
    invitationB: invitationB.invitationId,
    gasCylinderA: gasCylinderA.gasCylinderId,
    gasCylinderB: gasCylinderB.gasCylinderId,
  };
}
