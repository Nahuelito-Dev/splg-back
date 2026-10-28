import {
  QueryFuelLoadDto,
  QueryRangeDto,
} from '../../fleet-expense/dto/fuel-load.dto';
import type { FuelLoadResponseDto } from '../../fleet-expense/dto/fuel-load.dto';
import type { FleetCostSummaryDto } from '../../fleet-expense/dto/fleet-cost.dto';
import { QueryTireDto } from '../../fleet-expense/dto/tire.dto';
import type { TireResponseDto } from '../../fleet-expense/dto/tire.dto';
import { QueryTrafficFineDto } from '../../fleet-expense/dto/traffic-fine.dto';
import type { TrafficFineResponseDto } from '../../fleet-expense/dto/traffic-fine.dto';
import { QueryVehicleAccidentDto } from '../../fleet-expense/dto/vehicle-accident.dto';
import type { VehicleAccidentResponseDto } from '../../fleet-expense/dto/vehicle-accident.dto';
import { FleetCostService } from '../../fleet-expense/fleet-cost.service';
import { FleetExpenseMapper } from '../../fleet-expense/fleet-expense.mapper';
import { FuelLoadService } from '../../fleet-expense/fuel-load.service';
import { TireService } from '../../fleet-expense/tire.service';
import { TrafficFineService } from '../../fleet-expense/traffic-fine.service';
import { VehicleAccidentService } from '../../fleet-expense/vehicle-accident.service';
import type { FuenteDeExporte } from '../export.types';
import {
  booleano,
  codigo,
  decimal,
  entero,
  fecha,
  fechaHora,
  moneda,
  texto,
} from './columnas';
import { fuente, porOffset } from './fuente';

export interface ServiciosDeFlota {
  fuelLoads: FuelLoadService;
  fines: TrafficFineService;
  accidents: VehicleAccidentService;
  tires: TireService;
  costs: FleetCostService;
}

export function fuentesDeFlota(s: ServiciosDeFlota): FuenteDeExporte[] {
  return [
    fuente<QueryFuelLoadDto, FuelLoadResponseDto>({
      recurso: 'combustible',
      descripcion:
        'Cargas de combustible (mismos filtros que GET /fleet/fuel-loads)',
      query: QueryFuelLoadDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const r = await s.fuelLoads.findAll(distribuidoraId, query);
        return {
          filas: r.data.map((f) => FleetExpenseMapper.fuelLoad(f)),
          total: r.total,
        };
      },
      columnas: [
        fechaHora('Fecha', (f) => f.loadedAt),
        texto('Patente', (f) => f.carPatent),
        texto('Chofer', (f) => f.employeeName),
        texto('Combustible', (f) => f.fuelType),
        decimal('Litros', (f) => f.liters),
        moneda('Precio por litro', (f) => f.unitPrice),
        moneda('Total', (f) => f.totalAmount),
        decimal('Odómetro (km)', (f) => f.odometerKm),
        booleano('Tanque lleno', (f) => f.isFullTank),
        texto('Estación', (f) => f.station),
        texto('Medio de pago', (f) => f.paymentMethod),
        codigo('Comprobante', (f) => f.receiptNumber),
        booleano('Anomalía', (f) => f.anomaly),
        fechaHora('Anulada', (f) => f.voidedAt),
        texto('Notas', (f) => f.notes, 36),
      ],
    }),

    fuente<QueryTrafficFineDto, TrafficFineResponseDto>({
      recurso: 'multas',
      descripcion: 'Multas de tránsito (mismos filtros que GET /fleet/fines)',
      query: QueryTrafficFineDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const r = await s.fines.findAll(distribuidoraId, query);
        return {
          filas: r.data.map((m) => FleetExpenseMapper.trafficFine(m)),
          total: r.total,
        };
      },
      columnas: [
        fechaHora('Fecha de la infracción', (m) => m.occurredAt),
        texto('Patente', (m) => m.carPatent),
        texto('Empleado', (m) => m.employeeName),
        texto('Jurisdicción', (m) => m.jurisdiction),
        codigo('N° de acta', (m) => m.actNumber),
        texto('Infracción', (m) => m.infraction, 40),
        moneda('Monto', (m) => m.amount),
        moneda('Pago voluntario', (m) => m.voluntaryPaymentAmount),
        fecha('Vencimiento', (m) => m.dueDate),
        texto('Estado', (m) => m.status),
        fechaHora('Pagada', (m) => m.paidAt),
        moneda('Monto pagado', (m) => m.paidAmount),
        booleano('Imputada al empleado', (m) => m.chargedToEmployee),
        texto('Motivo de anulación', (m) => m.voidReason, 36),
      ],
    }),

    fuente<QueryVehicleAccidentDto, VehicleAccidentResponseDto>({
      recurso: 'siniestros',
      descripcion:
        'Siniestros de vehículos (mismos filtros que GET /fleet/accidents)',
      query: QueryVehicleAccidentDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const r = await s.accidents.findAll(distribuidoraId, query);
        return {
          filas: r.data.map((a) => FleetExpenseMapper.vehicleAccident(a)),
          total: r.total,
        };
      },
      columnas: [
        fechaHora('Fecha', (a) => a.occurredAt),
        texto('Patente', (a) => a.carPatent),
        texto('Empleado', (a) => a.employeeName),
        texto('Dirección', (a) => a.address, 36),
        texto('Descripción', (a) => a.description, 44),
        booleano('Con heridos', (a) => a.injuries),
        booleano('Con terceros', (a) => a.thirdPartiesInvolved),
        booleano('Derrame de gas', (a) => a.hazmatRelease),
        codigo('Parte policial', (a) => a.policeReportNumber),
        codigo('Reclamo a la aseguradora', (a) => a.insurerClaimNumber),
        texto('Estado', (a) => a.status),
        booleano('Vehículo inutilizable', (a) => a.vehicleUnusable),
        moneda('Costo de reparación', (a) => a.repairCost),
        moneda('Reintegro de la aseguradora', (a) => a.insurerReimbursement),
        moneda('Franquicia', (a) => a.deductibleAmount),
        moneda('Costo neto', (a) => a.netCost),
        fechaHora('Cierre', (a) => a.closedAt),
      ],
    }),

    fuente<QueryTireDto, TireResponseDto>({
      recurso: 'neumaticos',
      descripcion: 'Neumáticos (mismos filtros que GET /fleet/tires)',
      query: QueryTireDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const r = await s.tires.findAll(distribuidoraId, query);
        return {
          filas: r.data.map((t) => FleetExpenseMapper.tire(t)),
          total: r.total,
        };
      },
      columnas: [
        codigo('Serie', (t) => t.serialNumber),
        texto('Marca', (t) => t.brand),
        texto('Medida', (t) => t.size),
        moneda('Costo', (t) => t.cost),
        texto('Estado', (t) => t.status),
        texto('Patente', (t) => t.carPatent),
        texto('Posición', (t) => t.position),
        decimal('Km al montar', (t) => t.mountedOdometerKm),
        decimal('Km recorridos', (t) => t.kmTraveled),
        entero('Recapados', (t) => t.retreadCount),
        fechaHora('Alta', (t) => t.createdAt),
      ],
    }),

    fuente<QueryRangeDto, FleetCostSummaryDto>({
      recurso: 'costos-flota',
      descripcion:
        'Tablero de costos de la flota (mismos parámetros que GET /fleet/costs: from y to)',
      query: QueryRangeDto,
      leer: async (query, distribuidoraId) => {
        const filas = await s.costs.tablero(
          distribuidoraId,
          query.from,
          query.to,
        );
        return { filas, total: filas.length };
      },
      columnas: [
        texto('Patente', (c) => c.carPatent),
        texto('Marca', (c) => c.carBrand),
        texto('Modelo', (c) => c.carModel),
        moneda('Mantenimiento', (c) => c.maintenance),
        moneda('Seguro', (c) => c.insurance),
        moneda('Combustible', (c) => c.fuel),
        moneda('Multas', (c) => c.fines),
        moneda('Siniestros', (c) => c.accidents),
        moneda('Total', (c) => c.total),
        booleano('Seguro estimado', (c) => c.insuranceEstimated),
        decimal('Km', (c) => c.km),
        texto('Origen de los km', (c) => c.kmSource),
        moneda('Costo por km', (c) => c.costPerKm),
      ],
    }),
  ];
}
