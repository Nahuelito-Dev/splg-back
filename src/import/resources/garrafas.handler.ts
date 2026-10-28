import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { EntityManager } from 'typeorm';
import { CreateGasCylinderDto } from '../../gascylinder/dto/create-gascylinder.dto';
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

const COLUMNAS: ColumnaDeImportacion[] = [
  { key: 'type', header: 'Tipo', ejemplo: '10 kg', obligatoria: true },
  { key: 'weight', header: 'Peso (kg)', ejemplo: '10', obligatoria: true },
  { key: 'price', header: 'Precio', ejemplo: '12500,50', obligatoria: true },
  {
    key: 'stock',
    header: 'Stock inicial',
    ejemplo: '0',
    obligatoria: false,
  },
  {
    key: 'description',
    header: 'Descripción',
    ejemplo: 'Garrafa envasada de 10 kg',
    obligatoria: false,
  },
];

/** Catálogo de garrafas: el alta unitaria (`GasCylinderService.crearEn`) fila por fila. */
@Injectable()
export class GarrafasImportHandler implements ImportHandler {
  readonly recurso = ImportResource.GARRAFAS;
  readonly columnas = COLUMNAS;

  constructor(private readonly garrafas: GasCylinderService) {}

  async validar(
    filas: FilaCruda[],
    distributorId: string,
  ): Promise<ResultadoDeValidacion> {
    const existentes = new Set(
      (await this.garrafas.tiposDelCatalogo(distributorId)).map((g) =>
        claveNormal(g.type),
      ),
    );
    const vistos = new Map<string, number>();
    const errores: ErrorDeFila[] = [];
    const validas: FilaNormalizada[] = [];

    for (const { fila, celdas } of filas) {
      const erroresDeFila: ErrorDeFila[] = [];
      const plano: Record<string, unknown> = {
        type: celdas.type,
        weight: numeroDeCelda(celdas.weight, fila, COLUMNAS[1], erroresDeFila),
        price: numeroDeCelda(celdas.price, fila, COLUMNAS[2], erroresDeFila),
        stock: numeroDeCelda(celdas.stock, fila, COLUMNAS[3], erroresDeFila),
        description: celdas.description || undefined,
      };
      const resultado = await validarConDto(
        CreateGasCylinderDto,
        plano,
        fila,
        COLUMNAS,
        celdas,
      );
      // Un número mal escrito ya tiene su error: no se repite el del DTO.
      const columnasConError = new Set(erroresDeFila.map((e) => e.columna));
      erroresDeFila.push(
        ...resultado.errores.filter((e) => !columnasConError.has(e.columna)),
      );

      const clave = claveNormal(celdas.type);
      if (clave !== '') {
        const previa = vistos.get(clave);
        if (previa !== undefined) {
          erroresDeFila.push({
            fila,
            columna: COLUMNAS[0].header,
            mensaje: `El tipo está repetido en el archivo (ya figura en la fila ${previa})`,
          });
        } else if (existentes.has(clave)) {
          erroresDeFila.push({
            fila,
            columna: COLUMNAS[0].header,
            mensaje: 'Ya existe una garrafa con este tipo en tu distribuidora',
          });
        }
        if (previa === undefined) vistos.set(clave, fila);
      }

      if (erroresDeFila.length > 0 || !resultado.dto) {
        errores.push(...erroresDeFila);
        continue;
      }
      const { type, weight, price, stock, description } = resultado.dto;
      validas.push({
        fila,
        datos: {
          type,
          weight,
          price,
          stock: stock ?? 0,
          description: description ?? null,
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
    for (const { fila, datos } of filas) {
      const dto = plainToInstance(CreateGasCylinderDto, {
        ...datos,
        description: datos.description ?? undefined,
      });
      try {
        await this.garrafas.crearEn(manager, dto, ctx.distributorId);
      } catch (error) {
        throw conContexto(error, `Fila ${fila}`);
      }
    }
    return { creadas: filas.length };
  }
}
