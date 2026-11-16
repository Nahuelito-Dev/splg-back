import { Injectable } from '@nestjs/common';
import { Car } from './entities/car.entity';
import { CarService } from './car.service';
import {
  DestinoDeFoto,
  EnlaceDeFoto,
  EntityPhotoService,
} from '../s3/entity-photo.service';

const DESTINO: DestinoDeFoto = {
  entity: Car,
  idProp: 'carId',
  keyProp: 'photoKey',
};

/**
 * Foto principal del vehículo. El tenant lo resuelve `CarService.findOne`
 * (404 si es de otra distribuidora); acá sólo se guarda, se saca y se firma.
 */
@Injectable()
export class CarPhotoService {
  constructor(
    private readonly cars: CarService,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Completa la URL firmada del vehículo y la del chofer cargado, si lo hay. */
  async firmar(cars: Car | readonly Car[]): Promise<void> {
    const lista: readonly Car[] = Array.isArray(cars)
      ? (cars as readonly Car[])
      : [cars as Car];
    await this.fotos.firmar(lista, (c) => c.photoKey);
    const duenos = lista.flatMap((c) => (c.user ? [c.user] : []));
    await this.fotos.firmar(duenos, (u) => u.photoKey);
  }

  async subir(
    id: string,
    distributorId: string | null,
    file: Express.Multer.File | undefined,
  ): Promise<Car> {
    const car = await this.cars.findOne(id, distributorId);
    await this.fotos.guardar(
      DESTINO,
      id,
      file,
      `cars/${car.distributorId}/${id}`,
    );
    return this.recargar(id, distributorId);
  }

  async quitar(id: string, distributorId: string | null): Promise<Car> {
    await this.cars.findOne(id, distributorId);
    await this.fotos.quitar(DESTINO, id);
    return this.recargar(id, distributorId);
  }

  async enlace(
    id: string,
    distributorId: string | null,
  ): Promise<EnlaceDeFoto> {
    const car = await this.cars.findOne(id, distributorId);
    return this.fotos.enlace(car.photoKey);
  }

  private async recargar(
    id: string,
    distributorId: string | null,
  ): Promise<Car> {
    const car = await this.cars.findOne(id, distributorId);
    await this.firmar(car);
    return car;
  }
}
