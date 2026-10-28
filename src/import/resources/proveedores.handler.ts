import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { EntityManager } from 'typeorm';
import { SupplierService } from '../../purchase/application/supplier.service';
import { SupplierKind } from '../../purchase/domain/purchase.enums';
import { CreateSupplierDto } from '../../purchase/dto/supplier.dto';
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
import { normalizarEncabezado } from '../parsing/tabla-importada';
import {
  conContexto,
  numeroDeCelda,
  validarConDto,
} from './validacion-de-filas';

const COLUMNAS: ColumnaDeImportacion[] = [
  {
    key: 'businessName',
    header: 'Razón social',
    ejemplo: 'Gas del Litoral S.A.',
    obligatoria: true,
  },
  { key: 'cuit', header: 'CUIT', ejemplo: '30-71512345-9', obligatoria: true },
  {
    key: 'kind',
    header: 'Tipo',
    ejemplo: 'planta fraccionadora',
    obligatoria: true,
  },
  {
    key: 'contactName',
    header: 'Contacto',
    ejemplo: 'Marta Gómez',
    obligatoria: false,
  },
  {
    key: 'phone',
    header: 'Teléfono',
    ejemplo: '+54 9 362 4123456',
    obligatoria: false,
  },
  {
    key: 'email',
    header: 'Email',
    ejemplo: 'compras@gasdellitoral.com.ar',
    obligatoria: false,
  },
  {
    key: 'address',
    header: 'Dirección',
    ejemplo: 'Ruta 11 km 1005, Resistencia',
    obligatoria: false,
  },
  {
    key: 'paymentTermsDays',
    header: 'Plazo de pago (días)',
    ejemplo: '30',
    obligatoria: false,
  },
];

/** Cómo se escribe el tipo en la planilla (sin acentos ni mayúsculas) y a qué valor va. */
const TIPOS: Record<string, SupplierKind> = {
  plantafraccionadora: SupplierKind.FILLING_PLANT,
  fillingplant: SupplierKind.FILLING_PLANT,
  otro: SupplierKind.OTHER,
  other: SupplierKind.OTHER,
};

/** Proveedores: el alta unitaria (`SupplierService.crearEn`) fila por fila. */
@Injectable()
export class ProveedoresImportHandler implements ImportHandler {
  readonly recurso = ImportResource.PROVEEDORES;
  readonly columnas = COLUMNAS;

  constructor(private readonly proveedores: SupplierService) {}

  async validar(
    filas: FilaCruda[],
    distributorId: string,
  ): Promise<ResultadoDeValidacion> {
    const existentes = await this.proveedores.cuitsVigentes(distributorId);
    const vistos = new Map<string, number>();
    const errores: ErrorDeFila[] = [];
    const validas: FilaNormalizada[] = [];

    for (const { fila, celdas } of filas) {
      const erroresDeFila: ErrorDeFila[] = [];
      const kind = TIPOS[normalizarEncabezado(celdas.kind)];
      if (celdas.kind !== '' && !kind) {
        erroresDeFila.push({
          fila,
          columna: COLUMNAS[2].header,
          mensaje: `"${celdas.kind}" no es un tipo válido: usá "planta fraccionadora" u "otro"`,
        });
      }
      const plazo = numeroDeCelda(
        celdas.paymentTermsDays,
        fila,
        COLUMNAS[7],
        erroresDeFila,
      );
      const resultado = await validarConDto(
        CreateSupplierDto,
        {
          businessName: celdas.businessName,
          cuit: celdas.cuit,
          kind,
          contactName: celdas.contactName || undefined,
          phone: celdas.phone || undefined,
          email: celdas.email || undefined,
          address: celdas.address || undefined,
          paymentTermsDays: plazo,
        },
        fila,
        COLUMNAS,
        celdas,
      );
      // El tipo y el plazo ya tienen su error propio si vinieron mal.
      const conError = new Set(erroresDeFila.map((e) => e.columna));
      erroresDeFila.push(
        ...resultado.errores.filter((e) => !conError.has(e.columna)),
      );

      if (resultado.dto) {
        const cuit = resultado.dto.cuit;
        const previa = vistos.get(cuit);
        if (previa !== undefined) {
          erroresDeFila.push({
            fila,
            columna: COLUMNAS[1].header,
            mensaje: `El CUIT está repetido en el archivo (ya figura en la fila ${previa})`,
          });
        } else {
          vistos.set(cuit, fila);
          if (existentes.has(cuit)) {
            erroresDeFila.push({
              fila,
              columna: COLUMNAS[1].header,
              mensaje: `Ya hay un proveedor vigente con el CUIT ${cuit}`,
            });
          }
        }
      }

      if (erroresDeFila.length > 0 || !resultado.dto) {
        errores.push(...erroresDeFila);
        continue;
      }
      const dto = resultado.dto;
      validas.push({
        fila,
        datos: {
          businessName: dto.businessName,
          cuit: dto.cuit,
          kind: dto.kind,
          contactName: dto.contactName ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          address: dto.address ?? null,
          paymentTermsDays: dto.paymentTermsDays ?? null,
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
      const dto = plainToInstance(CreateSupplierDto, datos);
      try {
        await this.proveedores.crearEn(manager, dto, ctx.distributorId);
      } catch (error) {
        throw conContexto(error, `Fila ${fila}`);
      }
    }
    return { creados: filas.length };
  }
}
