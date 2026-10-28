import { CarService } from '../../car/car.service';
import { CarMapper } from '../../car/car.mapper';
import type { CarResponseDto } from '../../car/dto/car-response.dto';
import { CustomerMapper } from '../../customer/customer.mapper';
import { CustomersService } from '../../customer/customer.service';
import { QueryCustomersDto } from '../../customer/dto/query-customers.dto';
import type { CustomerResponseDto } from '../../customer/dto/customer-response.dto';
import { DeliveryService } from '../../delivery/delivery.service';
import { DeliveryMapper } from '../../delivery/delivery.mapper';
import { QueryDeliveryDto } from '../../delivery/dto/query-delivery.dto';
import type { DeliveryResponseDto } from '../../delivery/dto/delivery-response.dto';
import { CylinderMapper } from '../../cylinder/cylinder.mapper';
import { CylinderService } from '../../cylinder/cylinder.service';
import { QueryCylindersDto } from '../../cylinder/dto/query-cylinders.dto';
import type { CylinderResponseDto } from '../../cylinder/dto/cylinder-response.dto';
import { CatalogQueryDto } from '../../gascylinder/dto/catalog-query.dto';
import type { GasCylinderResponseDto } from '../../gascylinder/dto/gascylinder-response.dto';
import { GasCylinderMapper } from '../../gascylinder/gascylinder.mapper';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { QueryOrdersDto } from '../../order/dto/query-orders.dto';
import type { OrderResponseDto } from '../../order/dto/order-response.dto';
import { OrderMapper } from '../../order/order.mapper';
import { OrderService } from '../../order/order.service';
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
import { fuente, SinFiltros, porOffset } from './fuente';

/** "2 x 10 kg; 1 x 15 kg": lo que lleva el pedido, en una celda. */
function resumenDeRenglones(pedido: OrderResponseDto): string {
  return pedido.items
    .map((i) => `${i.quantity} x ${i.cylinder?.type ?? 'producto'}`)
    .join('; ');
}

function direccionDe(pedido: OrderResponseDto): string {
  const d = pedido.address;
  if (!d) return '';
  return d.formattedAddress ?? [d.street, d.city].filter(Boolean).join(', ');
}

export interface ServiciosComerciales {
  orders: OrderService;
  customers: CustomersService;
  deliveries: DeliveryService;
  cars: CarService;
  gasCylinders: GasCylinderService;
  cylinders: CylinderService;
}

export function fuentesComerciales(s: ServiciosComerciales): FuenteDeExporte[] {
  return [
    fuente<QueryOrdersDto, OrderResponseDto>({
      recurso: 'pedidos',
      descripcion: 'Pedidos (mismos filtros que GET /orders)',
      query: QueryOrdersDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const r = await s.orders.findAll(query, distribuidoraId);
        return {
          filas: r.orders.map((o) => OrderMapper.toDto(o)),
          total: r.total,
        };
      },
      columnas: [
        codigo('Pedido', (o) => o.id, 38),
        fechaHora('Fecha', (o) => o.createdAt),
        texto('Estado', (o) => o.status),
        texto('Cliente', (o) => o.customer?.fullName),
        texto('Email del cliente', (o) => o.customer?.email),
        codigo('Teléfono del cliente', (o) => o.customer?.phoneNumber),
        texto('Dirección', direccionDe, 40),
        texto('Productos', resumenDeRenglones, 36),
        entero('Unidades', (o) => o.items.reduce((t, i) => t + i.quantity, 0)),
        texto('Modalidad', (o) => o.deliveryMode),
        fecha('Entrega solicitada', (o) => o.requestedDeliveryDate),
        texto('Chofer', (o) => o.deliveryName ?? o.driver?.fullName),
        texto('Patente', (o) => o.vehicle?.patent),
        texto('Medio de pago', (o) => o.paymentMethodDetail),
        texto('Estado del cobro', (o) => o.paymentStatus),
        moneda('Subtotal', (o) => o.subtotalItems),
        moneda('Recargo express', (o) => o.expressSurchargeAmount),
        moneda('Recargo por zona', (o) => o.zoneSurcharge?.amount),
        moneda('Total', (o) => o.total),
        fechaHora('Entregado', (o) => o.actualDeliveryDate),
        texto('Motivo de cancelación', (o) => o.cancellationReason, 36),
      ],
    }),

    fuente<QueryCustomersDto, CustomerResponseDto>({
      recurso: 'clientes',
      descripcion:
        'Clientes de la distribuidora (mismos filtros que GET /customers)',
      query: QueryCustomersDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const [clientes, total] = await s.customers.findAll(
          query,
          distribuidoraId,
        );
        return {
          filas: clientes.map((c) => CustomerMapper.toDto(c)),
          total,
        };
      },
      columnas: [
        texto('Nombre', (c) => c.user?.full_name),
        texto('Email', (c) => c.user?.email),
        codigo('Teléfono', (c) => c.user?.phone_number),
        booleano('Bloqueado', (c) => c.user?.blocked),
        texto('Garrafa habitual', (c) => c.declaredCylinderType),
        decimal('Consumo mensual (kg)', (c) => c.avgMonthlyConsumptionKg),
        fecha('Próxima recompra', (c) => c.nextRepurchaseEstimateAt),
        fechaHora('Alta', (c) => c.createdAt),
        fechaHora('Baja', (c) => c.deletedAt),
      ],
    }),

    fuente<QueryDeliveryDto, DeliveryResponseDto>({
      recurso: 'choferes',
      descripcion: 'Choferes (mismos filtros que GET /delivery)',
      query: QueryDeliveryDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const [choferes, total] = await s.deliveries.findAll(
          query,
          distribuidoraId,
          query.status,
        );
        return {
          filas: choferes.map((d) => DeliveryMapper.toDto(d)),
          total,
        };
      },
      columnas: [
        texto('Nombre', (d) => d.user?.full_name),
        texto('Email', (d) => d.user?.email),
        codigo('Teléfono', (d) => d.user?.phone_number),
        booleano('Habilitado', (d) => d.isEnabled),
        booleano('Validado', (d) => d.validated),
        booleano('Disponible', (d) => d.isAvailable),
        decimal('Calificación', (d) => d.calification),
        moneda('Saldo', (d) => d.balance),
        fechaHora('Alta', (d) => d.createdAt),
        fechaHora('Baja', (d) => d.deletedAt),
      ],
    }),

    fuente<SinFiltros, CarResponseDto>({
      recurso: 'vehiculos',
      descripcion: 'Vehículos de la flota',
      query: SinFiltros,
      leer: async (_query, distribuidoraId) => {
        const autos = await s.cars.findAll(distribuidoraId);
        return {
          filas: autos.map((c) => CarMapper.toDto(c)),
          total: autos.length,
        };
      },
      columnas: [
        texto('Patente', (c) => c.car_patent),
        texto('Tipo', (c) => c.type_car),
        texto('Marca', (c) => c.car_brand),
        texto('Modelo', (c) => c.car_model),
        entero('Año', (c) => c.car_year),
        texto('Color', (c) => c.car_color),
        texto('Combustible', (c) => c.fuel_type),
        decimal('Capacidad de carga', (c) => c.car_capacity),
        decimal('Tanque (litros)', (c) => c.tank_capacity_liters),
        decimal('Odómetro (km)', (c) => c.odometer_km),
        texto('Estado de flota', (c) => c.fleet_status),
        texto('Chofer asignado', (c) => c.user?.full_name),
        fechaHora('Alta', (c) => c.createdAt),
      ],
    }),

    fuente<CatalogQueryDto, GasCylinderResponseDto>({
      recurso: 'garrafas',
      descripcion: 'Catálogo de garrafas (mismos filtros que GET /gascylinder)',
      query: CatalogQueryDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const r = await s.gasCylinders.findAll(query, distribuidoraId);
        return {
          filas: r.gasCylinders.map((g) => GasCylinderMapper.toDto(g)),
          total: r.total,
        };
      },
      columnas: [
        texto('Tipo', (g) => g.type),
        decimal('Peso (kg)', (g) => g.weight),
        moneda('Precio', (g) => g.price),
        entero('Stock', (g) => g.stock),
        texto('Descripción', (g) => g.description, 40),
        booleano('Activa', (g) => g.isActive),
        fechaHora('Alta', (g) => g.createdAt),
        fechaHora('Última modificación', (g) => g.updatedAt),
      ],
    }),

    fuente<QueryCylindersDto, CylinderResponseDto>({
      recurso: 'envases',
      descripcion: 'Envases físicos (mismos filtros que GET /cylinders)',
      query: QueryCylindersDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const [envases, total] = await s.cylinders.findAll(
          distribuidoraId,
          query,
        );
        return {
          filas: envases.map((e) => CylinderMapper.toDto(e)),
          total,
        };
      },
      columnas: [
        codigo('Serie', (e) => e.serial),
        texto('Estado', (e) => e.state),
        texto('Producto', (e) => e.gas_cylinder?.type),
        decimal('Peso (kg)', (e) => e.gas_cylinder?.weight),
        texto('Cliente actual', (e) => e.current_customer?.full_name),
        codigo('Teléfono del cliente', (e) => e.current_customer?.phone_number),
        moneda('Depósito', (e) => e.deposit),
        fecha('Fabricación', (e) => e.manufactured_at),
        fecha('Última revisión', (e) => e.last_inspection_at),
        fecha('Vencimiento', (e) => e.expires_at),
        fechaHora('Último movimiento', (e) => e.lastMovementAt),
        fechaHora('Alta', (e) => e.createdAt),
      ],
    }),
  ];
}
