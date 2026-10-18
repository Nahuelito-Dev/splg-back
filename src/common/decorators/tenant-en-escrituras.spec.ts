import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CarController } from '../../car/car.controller';
import { ClaimsController } from '../../claims/claims.controller';
import { CustomersController } from '../../customer/customer.controller';
import { DeliveryController } from '../../delivery/delivery.controller';
import { IncidentController } from '../../incident/incident.controller';
import { UnpaidCashController } from '../../incident/unpaid-cash.controller';
import { OrderController } from '../../order/order.controller';

interface ArgCustom {
  index: number;
  data?: { required?: boolean | 'staff' };
}

type Clase = { name: string };

/**
 * Toda escritura lleva distribuidora: el super admin sin `X-Distributor` no
 * puede operar por UUID sobre datos de cualquier distribuidora. Esta es la
 * lista de las escrituras con `@CurrentDistributor({ required })`.
 */
const ESCRITURAS: Array<[Clase, string[]]> = [
  [
    DeliveryController,
    [
      'update',
      'validateDelivery',
      'invalidateDelivery',
      'updateLocation',
      'updateBalance',
      'toggleStatus',
      'remove',
      'toggleAvailability',
    ],
  ],
  [CustomersController, ['update', 'updateLocation', 'remove']],
  [CarController, ['uploadPhoto', 'removePhoto']],
  [
    OrderController,
    [
      'create',
      'updateStatus',
      'rejectOffer',
      'confirmDelivery',
      'confirmCashReceived',
      'resolveUnpaid',
      'registerCash',
      'confirmTransfer',
      'assignDelivery',
      'updateLocation',
      'update',
      'cancelOrder',
      'cancel',
      'notifyArrival',
      'confirmDeposit',
      'changeAddress',
      'setReceiver',
    ],
  ],
  [
    IncidentController,
    ['create', 'update', 'resolve', 'uploadPhoto', 'removePhoto'],
  ],
  [UnpaidCashController, ['report', 'registerUnpaid']],
  [
    ClaimsController,
    [
      'create',
      'update',
      'resolve',
      'take',
      'reopen',
      'uploadPhoto',
      'removePhoto',
    ],
  ],
];

describe('distribuidora obligatoria en las escrituras', () => {
  it.each(
    ESCRITURAS.flatMap(([clase, metodos]) =>
      metodos.map((m) => [`${clase.name}.${m}`, clase, m] as const),
    ),
  )('%s exige distribuidora', (_nombre, clase, metodo) => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      clase,
      metodo,
    ) as Record<string, ArgCustom>;
    const exige = Object.values(args).some((a) => Boolean(a.data?.required));
    expect(exige).toBe(true);
  });
});
