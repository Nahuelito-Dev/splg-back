import { Module } from '@nestjs/common';
import { S3Module } from '../s3/s3.module';
import { LiveFleetController } from './live-fleet.controller';
import { LiveFleetService } from './live-fleet.service';

/**
 * Seguimiento en vivo de la flota (panel). Modelo de lectura: junta lo que ya
 * guardan flota, cargas, hojas de ruta y pedidos, sin escribir nada.
 */
@Module({
  imports: [S3Module],
  controllers: [LiveFleetController],
  providers: [LiveFleetService],
})
export class LiveFleetModule {}
