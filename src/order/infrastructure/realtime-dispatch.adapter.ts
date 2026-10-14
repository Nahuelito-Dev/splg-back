import { Injectable } from '@nestjs/common';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { RedisService } from '../../redis/redis.service';
import { DriversGateway } from '../../gateways/drivers.gateway';
import { CustomersGateway } from '../../gateways/customers.gateway';
import { AdminGateway } from '../../gateways/admin.gateway';

/**
 * ADAPTER de infraestructura del RealtimeDispatchPort. Traduce los verbos del
 * dominio a la tecnología concreta: Redis GEO para la proximidad y los gateways
 * Socket.io para los avisos. Es el ÚNICO lugar del dominio de órdenes que conoce
 * Redis/Socket.io; el core queda desacoplado y testeable con un mock del puerto.
 */
@Injectable()
export class RealtimeDispatchAdapter extends RealtimeDispatchPort {
  constructor(
    private readonly redisService: RedisService,
    private readonly driversGateway: DriversGateway,
    private readonly customersGateway: CustomersGateway,
    private readonly adminGateway: AdminGateway,
  ) {
    super();
  }

  findNearbyDrivers(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<string[]> {
    return this.redisService.getNearbyDrivers(lat, lng, radiusKm);
  }

  reportDriverLocation(
    driverUserId: string,
    lat: number,
    lng: number,
  ): Promise<void> {
    return this.redisService.updateDriverLocation(driverUserId, lat, lng);
  }

  async lastDriverLocation(
    driverUserId: string,
    orderId: string,
  ): Promise<{ lat: number; lng: number; at: string | null } | null> {
    const activo = await this.redisService.getDriverActiveOrder(driverUserId);
    if (activo?.orderId !== orderId) return null;
    return this.redisService.getDriverLastLocation(driverUserId);
  }

  notifyDriverNewOrder(driverId: string, payload: unknown): void {
    this.driversGateway.notifyNewOrder(driverId, payload);
  }

  notifyDriverOrderCancelled(driverId: string, payload: unknown): void {
    this.driversGateway.notifyOrderCancelled(driverId, payload);
  }

  notifyCustomer(customerId: string, event: string, payload: unknown): void {
    this.customersGateway.notifyCustomer(customerId, event, payload);
  }

  notifyAdmins(
    event: string,
    payload: unknown,
    distributorId?: string | null,
  ): void {
    this.adminGateway.notifyAdmins(event, payload, distributorId);
  }

  startTracking(
    driverUserId: string,
    orderId: string,
    customerId: string,
    distributorId?: string | null,
  ): void {
    // Fire-and-forget: el tracking es best-effort, no bloquea el cambio de estado.
    void this.redisService.setDriverActiveOrder(driverUserId, {
      orderId,
      customerId,
      distributorId,
    });
  }

  stopTracking(driverUserId: string): void {
    void this.redisService.clearDriverActiveOrder(driverUserId);
  }
}
