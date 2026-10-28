import {
  CommissionEntryType,
  LiquidationStatus,
} from '../commission/domain/commission.enums';
import { DriverLiquidationDetailDto } from '../commission/dto/driver-liquidation.dto';
import { CashSessionDetailDto } from '../cash/dto/cash-session.dto';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSessionStatus,
} from '../cash/domain/cash.enums';
import {
  DifferenceResolution,
  DriverSettlementStatus,
} from '../driver-settlement/domain/driver-settlement.enums';
import { DriverSettlementDetailDto } from '../driver-settlement/dto/driver-settlement.dto';
import { OrderResponseDto } from '../order/dto/order-response.dto';
import {
  OrderDeliveryMode,
  PaymentMethod,
  PaymentStatus,
} from '../order/entities/order.entity';
import { Membrete } from './pdf-builder';

export const MEMBRETE_DE_PRUEBA: Membrete = {
  nombre: 'Gas del Sur',
  razonSocial: 'Gas del Sur S.R.L.',
  cuit: '30-71234567-8',
  contacto: '376 4123456 · ventas@gasdelsur.test',
  logo: null,
};

export const ID_DE_PEDIDO = '0a1b2c3d-1111-4222-8333-444455556666';

export function pedidoDePrueba(
  cambios: Partial<OrderResponseDto> = {},
): OrderResponseDto {
  return Object.assign(new OrderResponseDto(), {
    id: ID_DE_PEDIDO,
    distributorId: 'dist-1',
    total: 33300,
    status: 'delivered',
    createdAt: new Date('2026-10-27T15:30:00Z'),
    paymentMethod: 'cash',
    paymentMethodDetail: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.PAID,
    paymentConfirmedAt: new Date('2026-10-27T17:10:00Z'),
    deliveryMode: OrderDeliveryMode.EXPRESS,
    expressSurchargeAmount: 1500,
    address: {
      id: 'dir-1',
      street: 'Av. Mitre 1200',
      city: 'Posadas',
      postalCode: null,
      latitude: null,
      longitude: null,
      formattedAddress: 'Av. Mitre 1200, Posadas',
      additionalInstructions: 'Portón negro',
    },
    deliveryName: 'Juan Pérez',
    actualDeliveryDate: new Date('2026-10-27T17:05:00Z'),
    requestedDeliveryDate: null,
    items: [
      {
        quantity: 2,
        unitPrice: 14900,
        subtotal: 29800,
        cylinder: {
          id: 'g-1',
          type: '10kg',
          weight: 10,
          price: 14900,
          description: 'Envase propio',
        },
      },
    ],
    customer: {
      userId: 'u-cliente',
      fullName: 'Ana Gómez',
      phoneNumber: '+54 376 5551234',
      email: 'ana@test.com',
    },
    zoneSurcharge: {
      coverageZoneId: 'z-1',
      name: 'Garupá',
      type: 'fixed',
      value: 2000,
      amount: 2000,
    },
    subtotalItems: 29800,
    vehicle: {
      carId: 'c-1',
      patent: 'AB123CD',
      brand: 'Ford',
      model: 'F-100',
    },
    depositAmount: 0,
    ...cambios,
  } as Partial<OrderResponseDto>);
}

export function rendicionDePrueba(): DriverSettlementDetailDto {
  return Object.assign(new DriverSettlementDetailDto(), {
    settlementId: 's-1',
    number: 12,
    deliveryId: 'd-1',
    driverName: 'Juan Pérez',
    businessDate: '2026-10-27',
    status: DriverSettlementStatus.APPROVED,
    expectedCash: 54000,
    declaredCash: 51000,
    driverExpenses: 1500,
    difference: -1500,
    differenceResolution: DifferenceResolution.CHARGED_TO_DRIVER,
    submittedAt: new Date('2026-10-27T22:00:00Z'),
    approvedAt: new Date('2026-10-27T23:00:00Z'),
    notes: 'Faltó un vuelto',
    cashFromOrders: 48000,
    cashFromCollections: 6000,
    truckLoadStatus: null,
    orders: [
      {
        orderId: 'o-1',
        customerName: 'Ana Gómez',
        deliveryAddress: 'Av. Mitre 1200, Posadas',
        totalAmount: 48000,
        amountToCollect: 48000,
        paymentStatus: 'paid',
        deliveredAt: new Date('2026-10-27T17:05:00Z'),
      },
    ],
    collections: [
      {
        entryId: 'e-1',
        accountId: 'a-1',
        businessName: 'Panadería La Espiga S.R.L.',
        amount: 6000,
        collectedAt: new Date('2026-10-27T18:00:00Z'),
      },
    ],
    expenses: [
      {
        expenseId: 'x-1',
        categoryId: 'cat-1',
        categoryName: 'Combustible',
        amount: 1500,
        description: 'Carga en ruta',
      },
    ],
  } as Partial<DriverSettlementDetailDto>);
}

export function liquidacionDePrueba(): DriverLiquidationDetailDto {
  return Object.assign(new DriverLiquidationDetailDto(), {
    liquidationId: 'l-1',
    number: 3,
    employeeId: 'emp-1',
    employeeName: 'Juan Pérez',
    periodFrom: '2026-10-01',
    periodTo: '2026-10-31',
    gross: 9000,
    deductions: 750,
    net: 8250,
    status: LiquidationStatus.PAID,
    approvedAt: new Date('2026-11-01T12:00:00Z'),
    paidAt: new Date('2026-11-02T12:00:00Z'),
    voidedAt: null,
    cashMovementId: null,
    createdAt: new Date('2026-11-01T11:00:00Z'),
    entries: [
      {
        entryId: 'en-1',
        employeeId: 'emp-1',
        employeeName: 'Juan Pérez',
        deliveryId: 'd-1',
        type: CommissionEntryType.DELIVERY_COMMISSION,
        amount: 9000,
        orderId: 'o-1',
        ruleId: null,
        liquidationId: 'l-1',
        description: 'Comisión por 20 entregas',
        occurredAt: new Date('2026-10-20T12:00:00Z'),
      },
      {
        entryId: 'en-2',
        employeeId: 'emp-1',
        employeeName: 'Juan Pérez',
        deliveryId: 'd-1',
        type: CommissionEntryType.TRAFFIC_FINE,
        amount: -750,
        orderId: null,
        ruleId: null,
        liquidationId: 'l-1',
        description: 'Multa por exceso de velocidad',
        occurredAt: new Date('2026-10-22T12:00:00Z'),
      },
    ],
  } as Partial<DriverLiquidationDetailDto>);
}

export function sesionDeCajaDePrueba(): CashSessionDetailDto {
  return Object.assign(new CashSessionDetailDto(), {
    sessionId: 'ses-1',
    cashBoxId: 'box-1',
    cashBoxName: 'Caja central',
    status: CashSessionStatus.CLOSED,
    openedAt: new Date('2026-10-27T11:00:00Z'),
    openedByUserId: 'u-1',
    openingAmount: 5000,
    closedAt: new Date('2026-10-27T23:00:00Z'),
    closedByUserId: 'u-1',
    expectedAmount: 18250,
    countedAmount: 18000,
    difference: -250,
    notes: 'Faltante por vuelto',
    currentBalance: 18000,
    totalIn: 14000,
    totalOut: 750,
    movements: [
      {
        movementId: 'm-1',
        cashBoxId: 'box-1',
        cashBoxName: 'Caja central',
        sessionId: 'ses-1',
        direction: CashDirection.IN,
        amount: 14000,
        categoryId: 'c-1',
        categoryName: 'Rendición de chofer',
        method: CashMethod.CASH,
        occurredAt: new Date('2026-10-27T20:00:00Z'),
        description: 'Rendición N° 12',
        referenceType: CashReferenceType.MANUAL,
        referenceId: null,
        reversesMovementId: null,
        reversed: false,
        createdByUserId: 'u-1',
        createdAt: new Date('2026-10-27T20:00:00Z'),
      },
      {
        movementId: 'm-2',
        cashBoxId: 'box-1',
        cashBoxName: 'Caja central',
        sessionId: 'ses-1',
        direction: CashDirection.OUT,
        amount: 750,
        categoryId: 'c-2',
        categoryName: 'Gastos varios',
        method: CashMethod.CASH,
        occurredAt: new Date('2026-10-27T21:00:00Z'),
        description: 'Librería',
        referenceType: CashReferenceType.MANUAL,
        referenceId: null,
        reversesMovementId: null,
        reversed: false,
        createdByUserId: 'u-1',
        createdAt: new Date('2026-10-27T21:00:00Z'),
      },
    ],
  } as Partial<CashSessionDetailDto>);
}
