/**
 * Reporte de liberaciones de ejemplo con las columnas y el separador que devuelve la
 * configuración real de la cuenta (`;`, sin RECORD_TYPE, EXTERNAL_REFERENCE ni
 * FINANCING_FEE_AMOUNT). Cubre: cobro conciliado, cobro sin ingreso, comisión pendiente con
 * retención, importe y comisión distintos, devolución total con reintegro de comisión e
 * impuestos (neto = bruto menos comisión e impuestos devueltos), contracargo, retiro, impuesto
 * suelto, cobro desconocido, cobro de otra distribuidora, saldo inicial y fila de totales.
 */
export const ENCABEZADO_LIBERACIONES =
  'DATE;TRANSACTION_APPROVAL_DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;TAXES_AMOUNT;PAYMENT_METHOD;BUSINESS_UNIT;SUB_UNIT;BALANCE_AMOUNT;PAYMENT_METHOD_TYPE;PURCHASE_ID';

export const FILAS_LIBERACIONES: string[] = [
  '2026-10-01T00:00:00.000-03:00;;;initial_available_balance;5000.00;0.00;5000.00;0.00;0.00;;;;5000.00;;',
  '2026-10-02T10:00:00.000-03:00;2026-10-02T09:00:00.000-03:00;1001;payment;950.00;0.00;1000.00;-50.00;0.00;visa;checkout_pro;;5950.00;credit_card;p-1001',
  '2026-10-02T11:00:00.000-03:00;2026-10-02T10:00:00.000-03:00;1002;payment;1900.00;0.00;2000.00;-100.00;0.00;master;checkout_pro;;7850.00;credit_card;p-1002',
  '2026-10-03T09:00:00.000-03:00;2026-10-03T08:00:00.000-03:00;1003;payment;2820.00;0.00;3000.00;-150.00;-30.00;visa;checkout_pro;;10670.00;credit_card;p-1003',
  '2026-10-03T12:00:00.000-03:00;2026-10-03T11:00:00.000-03:00;1004;payment;3800.00;0.00;4000.00;-200.00;0.00;account_money;checkout_pro;;14470.00;account_money;p-1004',
  '2026-10-04T08:00:00.000-03:00;2026-10-02T09:00:00.000-03:00;1005;refund;0.00;4750.00;-5000.00;250.00;0.00;visa;checkout_pro;;9720.00;credit_card;p-1005',
  '2026-10-04T08:30:00.000-03:00;2026-10-02T09:00:00.000-03:00;1006;chargeback;0.00;600.00;-600.00;0.00;0.00;visa;checkout_pro;;9120.00;credit_card;p-1006',
  '2026-10-05T07:00:00.000-03:00;;9001;payout;0.00;10000.00;-9997.00;-3.00;0.00;;;;0.00;;',
  '2026-10-05T07:05:00.000-03:00;;9002;tax_payment_iibb;0.00;120.00;-120.00;0.00;0.00;;;;0.00;;',
  '2026-10-05T09:00:00.000-03:00;2026-10-05T08:00:00.000-03:00;7777;payment;475.00;0.00;500.00;-25.00;0.00;visa;checkout_pro;;475.00;credit_card;p-7777',
  '2026-10-05T10:00:00.000-03:00;2026-10-05T09:00:00.000-03:00;8888;payment;950.00;0.00;1000.00;-50.00;0.00;visa;checkout_pro;;1425.00;credit_card;p-8888',
  '2026-10-06T00:00:00.000-03:00;;;total;0.00;0.00;0.00;0.00;0.00;;;;;;',
];

export const CSV_LIBERACIONES = [
  ENCABEZADO_LIBERACIONES,
  ...FILAS_LIBERACIONES,
].join('\n');
