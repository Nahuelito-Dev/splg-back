import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Car } from '../../car/entities/car.entity';
import { EntityPhotoService } from '../../s3/entity-photo.service';
import type { OrderResponseDto } from '../dto/order-response.dto';

/**
 * Foto firmada del vehículo de los pedidos. El vehículo del pedido es una foto
 * instantánea (patente, marca y modelo copiados al aceptar), pero la imagen sale
 * del auto actual por `car_id`: si el auto ya no existe, está dado de baja o es
 * de otra distribuidora, la foto es `null` y el pedido sigue igual. Se resuelve
 * en lote: una lectura de los autos por ids para toda la lista; firmar es local.
 */
@Injectable()
export class OrderVehiclePhotoService {
  constructor(
    @InjectRepository(Car) private readonly cars: Repository<Car>,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Completa `vehicle.photoUrl` de cada pedido que tenga vehículo. */
  async completar(pedidos: readonly OrderResponseDto[]): Promise<void> {
    const conVehiculo = pedidos.filter((p) => p.vehicle);
    if (conVehiculo.length === 0) return;
    const ids = [
      ...new Set(
        conVehiculo.flatMap((p) => (p.vehicle ? [p.vehicle.carId] : [])),
      ),
    ];
    const autos = await this.cars.find({
      select: { carId: true, photoKey: true, distributorId: true },
      where: { carId: In(ids) },
    });
    const porId = new Map(autos.map((a) => [a.carId, a]));
    const urlDe = new Map<string, string | null>();
    await Promise.all(
      autos.map(async (a) => {
        urlDe.set(a.carId, await this.fotos.urlDe(a.photoKey));
      }),
    );
    for (const pedido of conVehiculo) {
      if (!pedido.vehicle) continue;
      const auto = porId.get(pedido.vehicle.carId);
      pedido.vehicle.photoUrl =
        auto && auto.distributorId === pedido.distributorId
          ? (urlDe.get(auto.carId) ?? null)
          : null;
    }
  }
}
