import { Injectable } from '@nestjs/common';
import { PickType } from '@nestjs/swagger';
import { EntityManager } from 'typeorm';
import { CreateGasCylinderDto } from '../../gascylinder/dto/create-gascylinder.dto';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { ImportResource } from '../domain/import.enums';
import {
  ColumnaDeImportacion,
  ContextoDeAplicacion,
  ErrorDeFila,
  FilaCruda,
  FilaNormalizada,
  ImportHandler,
  ResultadoDeValidacion,
  ResumenDeImportacion,
} from '../domain/import.types';
import {
  claveNormal,
  conContexto,
  numeroDeCelda,
  validarConDto,
} from './validacion-de-filas';

/** El precio se valida con la misma regla del alta de la garrafa. */
class CambioDePrecioDto extends PickType(CreateGasCylinderDto, [
  'price',
] as const) {}

const COLUMNAS: ColumnaDeImportacion[] = [
  { key: 'type', header: 'Tipo', ejemplo: '10 kg', obligatoria: true },
  {
    key: 'price',
    header: 'Precio nuevo',
    ejemplo: '13000',
    obligatoria: true,
  },
];

interface DatosDePrecio {
  gasCylinderId: string;
  type: string;
  price: number;
  previousPrice: number;
}

function esDatosDePrecio(
  datos: Record<string, unknown>,
): datos is Record<string, unknown> & DatosDePrecio {
  return (
    typeof datos.gasCylinderId === 'string' &&
    typeof datos.price === 'number' &&
    typeof datos.type === 'string'
  );
}

/** Actualización masiva de precios por tipo de garrafa. */
@Injectable()
export class PreciosImportHandler implements ImportHandler {
  readonly recurso = ImportResource.PRECIOS;
  readonly columnas = COLUMNAS;

  constructor(private readonly garrafas: GasCylinderService) {}

  async validar(
    filas: FilaCruda[],
    distributorId: string,
  ): Promise<ResultadoDeValidacion> {
    const catalogo = new Map<string, GasCylinder>(
      (await this.garrafas.tiposDelCatalogo(distributorId)).map((g) => [
        claveNormal(g.type),
        g,
      ]),
    );
    const vistos = new Map<string, number>();
    const errores: ErrorDeFila[] = [];
    const validas: FilaNormalizada[] = [];

    for (const { fila, celdas } of filas) {
      const erroresDeFila: ErrorDeFila[] = [];
      const precio = numeroDeCelda(
        celdas.price,
        fila,
        COLUMNAS[1],
        erroresDeFila,
      );
      const resultado = await validarConDto(
        CambioDePrecioDto,
        { price: precio },
        fila,
        COLUMNAS,
        celdas,
      );
      if (erroresDeFila.length === 0) erroresDeFila.push(...resultado.errores);

      const clave = claveNormal(celdas.type);
      const garrafa = catalogo.get(clave);
      if (clave === '') {
        erroresDeFila.push({
          fila,
          columna: COLUMNAS[0].header,
          mensaje: 'es obligatorio',
        });
      } else if (!garrafa) {
        erroresDeFila.push({
          fila,
          columna: COLUMNAS[0].header,
          mensaje: 'No existe una garrafa con ese tipo en tu distribuidora',
        });
      } else if (!garrafa.isActive) {
        erroresDeFila.push({
          fila,
          columna: COLUMNAS[0].header,
          mensaje:
            'La garrafa está dada de baja: reactivala antes de cambiarle el precio',
        });
      } else if (vistos.has(clave)) {
        erroresDeFila.push({
          fila,
          columna: COLUMNAS[0].header,
          mensaje: `El tipo está repetido en el archivo (ya figura en la fila ${vistos.get(clave)})`,
        });
      } else {
        vistos.set(clave, fila);
      }

      if (erroresDeFila.length > 0 || !resultado.dto || !garrafa) {
        errores.push(...erroresDeFila);
        continue;
      }
      validas.push({
        fila,
        datos: {
          gasCylinderId: garrafa.gasCylinderId,
          type: garrafa.type,
          price: resultado.dto.price,
          previousPrice: garrafa.price,
        },
      });
    }
    return { errores, filas: validas };
  }

  async aplicar(
    manager: EntityManager,
    filas: FilaNormalizada[],
    ctx: ContextoDeAplicacion,
  ): Promise<ResumenDeImportacion> {
    // Los locks de las garrafas, siempre por id ascendente (orden global).
    const ordenadas = filas
      .flatMap(({ fila, datos }) =>
        esDatosDePrecio(datos) ? [{ fila, datos }] : [],
      )
      .sort((a, b) =>
        a.datos.gasCylinderId.localeCompare(b.datos.gasCylinderId),
      );
    let actualizadas = 0;
    let sinCambio = 0;
    for (const { fila, datos } of ordenadas) {
      try {
        const cambio = await this.garrafas.cambiarPrecioEn(
          manager,
          datos.gasCylinderId,
          datos.price,
          ctx.distributorId,
        );
        if (cambio) actualizadas++;
        else sinCambio++;
      } catch (error) {
        throw conContexto(error, `Fila ${fila}`);
      }
    }
    return { actualizadas, sinCambio };
  }
}
