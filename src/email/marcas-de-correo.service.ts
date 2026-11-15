import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { errorMessage } from '../common/errors/error-message';
import { Distributor } from '../distributor/entities/distributor.entity';
import { MarcaDeCorreo, marcaDeDistribuidora } from './layout/marca-de-correo';

/**
 * La marca de un correo operativo cuando quien lo arma sólo tiene el id de la
 * distribuidora. Si el nombre no se puede leer, el correo sale igual con el
 * encabezado genérico: un aviso nunca se pierde por la marca.
 */
@Injectable()
export class MarcasDeCorreo {
  private readonly logger = new Logger(MarcasDeCorreo.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async deDistribuidora(distributorId: string): Promise<MarcaDeCorreo> {
    try {
      const distribuidora = await this.dataSource
        .getRepository(Distributor)
        .findOne({
          where: { distributorId },
          select: { distributorId: true, name: true },
          withDeleted: true,
        });
      return marcaDeDistribuidora(distribuidora?.name);
    } catch (error) {
      this.logger.warn(
        `No se pudo leer el nombre de la distribuidora ${distributorId} para el correo: ${errorMessage(error)}`,
      );
      return marcaDeDistribuidora(null);
    }
  }
}
