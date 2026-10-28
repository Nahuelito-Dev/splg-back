import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DataAuditService } from '../audit/data/data-audit.service';
import { CarService } from '../car/car.service';
import { CashBoxService } from '../cash/application/cash-box.service';
import { CashMovementService } from '../cash/application/cash-movement.service';
import { ClaimsService } from '../claims/claims.service';
import { DriverLiquidationService } from '../commission/application/driver-liquidation.service';
import { CustomerAccountQueryService } from '../customer-account/application/customer-account-query.service';
import { CustomersService } from '../customer/customer.service';
import { CylinderService } from '../cylinder/cylinder.service';
import { DeliveryService } from '../delivery/delivery.service';
import { DriverSettlementQueryService } from '../driver-settlement/application/driver-settlement-query.service';
import { EmployeeService } from '../employee/employee.service';
import { FleetCostService } from '../fleet-expense/fleet-cost.service';
import { FuelLoadService } from '../fleet-expense/fuel-load.service';
import { TireService } from '../fleet-expense/tire.service';
import { TrafficFineService } from '../fleet-expense/traffic-fine.service';
import { VehicleAccidentService } from '../fleet-expense/vehicle-accident.service';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { IncidentService } from '../incident/incident.service';
import { OrderService } from '../order/order.service';
import { PurchaseQueryService } from '../purchase/application/purchase-query.service';
import { SupplierService } from '../purchase/application/supplier.service';
import { StockQueryService } from '../stock/application/stock-query.service';
import type { FuenteDeExporte } from './export.types';
import { fuentesDeAtencion } from './sources/atencion.fuentes';
import { fuentesComerciales } from './sources/comercial.fuentes';
import { fuentesDeCompras } from './sources/compras.fuentes';
import { fuentesDeFinanzas } from './sources/finanzas.fuentes';
import { fuentesDeFlota } from './sources/flota.fuentes';
import { fuentesDePersonal } from './sources/personal.fuentes';
import { fuentesDeStock } from './sources/stock.fuentes';

/**
 * Los recursos que se pueden exportar. Cada uno reusa el servicio de su
 * listado y el DTO de consulta del listado, así que respeta sus filtros y su
 * aislamiento por distribuidora sin duplicar reglas.
 */
@Injectable()
export class ExportSourcesRegistry {
  private readonly fuentes: ReadonlyMap<string, FuenteDeExporte>;

  constructor(
    orders: OrderService,
    customers: CustomersService,
    deliveries: DeliveryService,
    cars: CarService,
    gasCylinders: GasCylinderService,
    cylinders: CylinderService,
    stock: StockQueryService,
    cashBoxes: CashBoxService,
    cashMovements: CashMovementService,
    accounts: CustomerAccountQueryService,
    settlements: DriverSettlementQueryService,
    liquidations: DriverLiquidationService,
    fuelLoads: FuelLoadService,
    fines: TrafficFineService,
    accidents: VehicleAccidentService,
    tires: TireService,
    costs: FleetCostService,
    claims: ClaimsService,
    incidents: IncidentService,
    purchases: PurchaseQueryService,
    suppliers: SupplierService,
    employees: EmployeeService,
    audit: AuditService,
    dataAudit: DataAuditService,
  ) {
    const todas: FuenteDeExporte[] = [
      ...fuentesComerciales({
        orders,
        customers,
        deliveries,
        cars,
        gasCylinders,
        cylinders,
      }),
      ...fuentesDeStock({ stock }),
      ...fuentesDeFinanzas({
        cashBoxes,
        cashMovements,
        accounts,
        settlements,
        liquidations,
      }),
      ...fuentesDeFlota({ fuelLoads, fines, accidents, tires, costs }),
      ...fuentesDeAtencion({ claims, incidents }),
      ...fuentesDeCompras({ purchases, suppliers }),
      ...fuentesDePersonal({ employees, audit, dataAudit }),
    ];
    this.fuentes = new Map(todas.map((f) => [f.recurso, f]));
  }

  buscar(recurso: string): FuenteDeExporte | undefined {
    return this.fuentes.get(recurso);
  }

  recursos(): string[] {
    return [...this.fuentes.keys()];
  }
}
