/**
 * Etiquetas de un campo cuando el nombre genérico (`user_id`, `type`, `name`,
 * `items`…) significa otra cosa en un DTO puntual. La clave es `Clase.campo`
 * (la clase que recibe el cuerpo; un `Update…Dto` hereda del `Create…Dto`, por
 * eso se listan juntos). Lo que no figura acá usa `etiquetas-campos.ts`.
 */

function paraClases(
  clases: readonly string[],
  etiquetas: Readonly<Record<string, string>>,
): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const clase of clases) {
    for (const [campo, etiqueta] of Object.entries(etiquetas)) {
      salida[`${clase}.${campo}`] = etiqueta;
    }
  }
  return salida;
}

export const ETIQUETAS_POR_CLASE: Readonly<Record<string, string>> = {
  ...paraClases(['CreateCarDto', 'UpdateCarDto'], { user_id: 'Chofer' }),
  ...paraClases(['CreateAdminDto', 'UpdateAdminDto'], {
    user_id: 'Usuario administrador',
  }),
  ...paraClases(['CreateCustomerDto', 'UpdateCustomerDto'], {
    user_id: 'Usuario del cliente',
  }),
  ...paraClases(['CreateUserAddressDto', 'UpdateUserAddressDto'], {
    user_id: 'Cliente',
  }),
  ...paraClases(['QueryAuditEntriesDto'], {
    userId: 'Usuario que hizo el cambio',
  }),
  ...paraClases(['QueryRepurchaseInvitationsDto'], { userId: 'Cliente' }),
  ...paraClases(['CreateGasCylinderDto', 'UpdateGasCylinderDto'], {
    type: 'Tipo de garrafa',
  }),
  ...paraClases(['CreateIncidentDto', 'UpdateIncidentDto'], {
    type: 'Tipo de incidencia',
    description: 'Descripción de la incidencia',
  }),
  ...paraClases(['CreateLeaveDto', 'QueryLeaveDto'], {
    type: 'Tipo de licencia',
  }),
  ...paraClases(['CreateRoleDto', 'UpdateRoleDto'], { type: 'Nombre del rol' }),
  ...paraClases(['CreateTireEventDto'], {
    type: 'Tipo de evento',
    position: 'Posición del neumático',
  }),
  ...paraClases(['QueryCommissionEntryDto'], { type: 'Tipo de comisión' }),
  ...paraClases(['CreateCashBoxDto', 'UpdateCashBoxDto'], {
    name: 'Nombre de la caja',
    kind: 'Tipo de caja',
  }),
  ...paraClases(['CreateCashCategoryDto', 'UpdateCashCategoryDto'], {
    name: 'Nombre de la categoría',
  }),
  ...paraClases(['CreateCoverageZoneDto', 'UpdateCoverageZoneDto'], {
    name: 'Nombre de la zona',
  }),
  ...paraClases(['CreateDistributorDto', 'UpdateDistributorDto'], {
    name: 'Nombre de la distribuidora',
  }),
  ...paraClases(['CreateFleetPlanDto', 'UpdateFleetPlanDto'], {
    name: 'Nombre del plan',
  }),
  ...paraClases(['CreateInsurerDto', 'UpdateInsurerDto'], {
    name: 'Nombre de la aseguradora',
  }),
  ...paraClases(['CreateJobPositionDto', 'UpdateJobPositionDto'], {
    name: 'Nombre del puesto',
    category: 'Categoría del puesto',
  }),
  ...paraClases(['CreateTimeSlotDto', 'UpdateTimeSlotDto'], {
    name: 'Nombre de la franja',
  }),
  ...paraClases(['CreateWarehouseDto', 'UpdateWarehouseDto'], {
    name: 'Nombre del depósito',
    code: 'Código del depósito',
    kind: 'Tipo de depósito',
    address: 'Dirección del depósito',
  }),
  ...paraClases(
    ['CreateSupplierDto', 'UpdateSupplierDto', 'QuerySupplierDto'],
    {
      kind: 'Tipo de proveedor',
    },
  ),
  ...paraClases(['QueryCashBoxDto'], { kind: 'Tipo de caja' }),
  ...paraClases(['RegisterAdjustmentDto'], { kind: 'Tipo de ajuste' }),
  ...paraClases(['QueryEmployeeDto'], { category: 'Categoría del puesto' }),
  ...paraClases(['QueryCylindersDto'], { state: 'Estado del envase' }),
  ...paraClases(['ConfirmDeliveryDto'], { code: 'Código de entrega' }),
  ...paraClases(['CreateCommissionRuleDto', 'UpdateCommissionRuleDto'], {
    value: 'Valor de la comisión',
  }),
  ...paraClases(['AdjustmentItemDto', 'TransferItemDto'], {
    condition: 'Condición de los envases',
  }),
  ...paraClases(['InstallmentPlanDto'], { count: 'Cantidad de cuotas' }),
  ...paraClases(['CreateTireDto'], {
    size: 'Medida',
    cost: 'Costo del neumático',
  }),
  ...paraClases(['CreateGasCylinderDto', 'UpdateGasCylinderDto'], {
    weight: 'Peso (kg)',
  }),
  ...paraClases(
    [
      'CreateTransferDto',
      'CreateTruckLoadDto',
      'ReloadTruckLoadDto',
      'ReturnTruckLoadDto',
      'UpdateTruckLoadItemsDto',
      'CreateAdjustmentDto',
      'CreateInitialCountDto',
    ],
    { items: 'Envases' },
  ),
  ...paraClases(['ApplyMpReconciliationDto'], { items: 'Pagos' }),
  ...paraClases(
    [
      'CreatePurchaseOrderDto',
      'CreatePurchaseReceiptDto',
      'PreviewPurchaseTotalDto',
    ],
    { items: 'Productos' },
  ),
};

/** Cómo se nombra un elemento de una lista: `items.1.quantity` → «Ítem 2 · Cantidad». */
export const SINGULARES: Readonly<Record<string, string>> = {
  items: 'Ítem',
  promotions: 'Promoción',
  installments: 'Cuota',
  expenses: 'Gasto',
  serials: 'Serial',
  thresholds: 'Escalón',
  polygon: 'Vértice',
};
