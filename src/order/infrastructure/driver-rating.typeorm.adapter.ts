import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  DriverRatingPort,
  ResumenDeCalificaciones,
} from '../domain/ports/driver-rating.port';

/**
 * Lee el promedio y la cantidad de calificaciones visibles de un chofer. Misma
 * cuenta que `RatingService.getSummaryForUser` (las ocultas no cuentan);
 * excepción de lectura documentada en CONVENCIONES, como `reports`: `rating`
 * depende de `order` y no puede inyectarse acá.
 */
@Injectable()
export class DriverRatingTypeormAdapter extends DriverRatingPort {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    super();
  }

  async resumen(driverUserId: string): Promise<ResumenDeCalificaciones> {
    const filas: Array<{ average: string | null; count: string }> =
      await this.dataSource.query(
        `SELECT COALESCE(AVG(stars), 0) AS average, COUNT(*) AS count
           FROM rating
          WHERE to_user_id = $1 AND hidden = false`,
        [driverUserId],
      );
    const fila = filas[0];
    return {
      average: fila ? Math.round(Number(fila.average) * 100) / 100 : 0,
      count: fila ? Number(fila.count) : 0,
    };
  }
}
