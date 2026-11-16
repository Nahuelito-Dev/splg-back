import {
  HttpException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../../common/errors/domain.error';
import { detalleDe } from '../../common/errors/domain.error';
import { GasCylinderNotFoundError } from '../../gascylinder/domain/errors/gas-cylinder-not-found.error';
import { CreateGasCylinderDto } from '../../gascylinder/dto/create-gascylinder.dto';
import { CreateSupplierDto } from '../../purchase/dto/supplier.dto';
import { ColumnaDeImportacion, ErrorDeFila } from '../domain/import.types';
import {
  claveNormal,
  conContexto,
  numeroDeCelda,
  parsearNumero,
  validarConDto,
} from './validacion-de-filas';

class ErrorDeNegocio extends BadRequestDomainError {
  constructor() {
    super('falta stock');
  }
}
class NoEncontrado extends NotFoundDomainError {
  constructor() {
    super('no está');
  }
}
class Choque extends ConflictDomainError {
  constructor() {
    super('chocó');
  }
}

const COLUMNAS: ColumnaDeImportacion[] = [
  { key: 'type', header: 'Tipo', ejemplo: '', obligatoria: true },
  { key: 'weight', header: 'Peso (kg)', ejemplo: '', obligatoria: true },
  { key: 'price', header: 'Precio', ejemplo: '', obligatoria: true },
  { key: 'stock', header: 'Stock inicial', ejemplo: '', obligatoria: false },
  { key: 'cuit', header: 'CUIT', ejemplo: '', obligatoria: true },
  {
    key: 'businessName',
    header: 'Razón social',
    ejemplo: '',
    obligatoria: true,
  },
  { key: 'kind', header: 'Tipo de proveedor', ejemplo: '', obligatoria: true },
  { key: 'email', header: 'Email', ejemplo: '', obligatoria: false },
];

describe('validacion-de-filas', () => {
  describe('parsearNumero', () => {
    it.each([
      ['12500', 12500],
      ['12,5', 12.5],
      ['12.5', 12.5],
      ['1.234,56', 1234.56],
      ['  7 ', 7],
      ['-3', -3],
      ['1 000', 1000],
      // Punto de miles sin coma (Excel en castellano): no es un decimal.
      ['12.500', 12500],
      ['1.250.000', 1250000],
      ['-1.000', -1000],
    ])('%s -> %s', (texto, esperado) => {
      expect(parsearNumero(texto)).toBe(esperado);
    });

    it.each(['', 'abc', '12,5,5', '1e3', '--2', '12.'])(
      '"%s" no es un número',
      (texto) => {
        expect(parsearNumero(texto)).toBeNull();
      },
    );
  });

  describe('numeroDeCelda', () => {
    it('una celda vacía no es un error: queda sin valor', () => {
      const errores: ErrorDeFila[] = [];
      expect(numeroDeCelda('', 2, COLUMNAS[1], errores)).toBeUndefined();
      expect(errores).toEqual([]);
    });

    it('un texto que no es número agrega el error de la columna', () => {
      const errores: ErrorDeFila[] = [];
      expect(numeroDeCelda('diez', 5, COLUMNAS[1], errores)).toBeUndefined();
      expect(errores).toEqual([
        { fila: 5, columna: 'Peso (kg)', mensaje: '"diez" no es un número' },
      ]);
    });
  });

  it('claveNormal compara sin mayúsculas ni espacios de los bordes', () => {
    expect(claveNormal('  10 KG ')).toBe('10 kg');
  });

  describe('validarConDto', () => {
    const celdas = (c: Record<string, string>) => c;

    it('devuelve el DTO transformado cuando la fila es válida', async () => {
      const r = await validarConDto(
        CreateSupplierDto,
        {
          businessName: '  Gas del Litoral ',
          cuit: '30-71234567-1',
          kind: 'filling_plant',
        },
        2,
        COLUMNAS,
        celdas({
          businessName: 'Gas del Litoral',
          cuit: '30-71234567-1',
          kind: 'planta fraccionadora',
        }),
      );
      expect(r.errores).toEqual([]);
      expect(r.dto?.cuit).toBe('30712345671');
      expect(r.dto?.businessName).toBe('Gas del Litoral');
    });

    it('un valor obligatorio vacío dice "es obligatorio" con el encabezado de la columna', async () => {
      const r = await validarConDto(
        CreateGasCylinderDto,
        { weight: 10, price: 100 },
        3,
        COLUMNAS,
        celdas({ type: '', weight: '10', price: '100' }),
      );
      expect(r.dto).toBeNull();
      expect(r.errores).toEqual([
        { fila: 3, columna: 'Tipo', mensaje: 'es obligatorio' },
      ]);
    });

    it('conserva los mensajes en castellano del DTO, con el encabezado en lugar de la propiedad', async () => {
      const r = await validarConDto(
        CreateGasCylinderDto,
        { type: '10 kg', weight: 10, price: -5 },
        4,
        COLUMNAS,
        celdas({ type: '10 kg', weight: '10', price: '-5' }),
      );
      expect(r.errores).toContainEqual({
        fila: 4,
        columna: 'Precio',
        mensaje: 'Precio debe ser mayor que 0',
      });
    });

    it('traduce los mensajes por defecto en inglés', async () => {
      const r = await validarConDto(
        CreateSupplierDto,
        {
          businessName: 'x'.repeat(121),
          cuit: '30715123456',
          kind: 'filling_plant',
          email: 'no-es-email',
        },
        6,
        COLUMNAS,
        celdas({
          businessName: 'x',
          cuit: '30715123456',
          kind: 'a',
          email: 'no-es-email',
        }),
      );
      expect(r.errores).toEqual(
        expect.arrayContaining([
          {
            fila: 6,
            columna: 'Razón social',
            mensaje: 'supera el máximo de 120 caracteres',
          },
          { fila: 6, columna: 'Email', mensaje: 'no es un email válido' },
        ]),
      );
    });

    it('un CUIT con dígito verificador inválido se rechaza con la regla del alta', async () => {
      const r = await validarConDto(
        CreateSupplierDto,
        { businessName: 'X', cuit: '30715123450', kind: 'other' },
        2,
        COLUMNAS,
        celdas({ businessName: 'X', cuit: '30715123450', kind: 'otro' }),
      );
      expect(r.errores).toEqual([
        {
          fila: 2,
          columna: 'CUIT',
          mensaje:
            'CUIT: no es un CUIT válido (11 dígitos y dígito verificador)',
        },
      ]);
    });
  });

  describe('conContexto', () => {
    it('antepone el contexto conservando el estado HTTP', () => {
      const e = conContexto(new ConflictException('ya existe'), 'Fila 3');
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).message).toBe('Fila 3: ya existe');
      expect((e as HttpException).getStatus()).toBe(409);
      const otro = conContexto(new ForbiddenException('no'), 'Fila 1');
      expect((otro as ForbiddenException).getStatus()).toBe(403);
    });

    it('conserva el detalle interno del error de dominio para el log, no en el mensaje', () => {
      const e = conContexto(new GasCylinderNotFoundError('g-1'), 'Fila 4');
      expect((e as HttpException).message).toBe(
        'Fila 4: Garrafa no encontrada',
      );
      expect(detalleDe(e)).toBe('gasCylinderId=g-1');
    });

    it('traduce los errores de dominio a su excepción HTTP', () => {
      expect(conContexto(new ErrorDeNegocio(), 'Fila 2')).toEqual(
        new BadRequestException('Fila 2: falta stock'),
      );
      expect(conContexto(new NoEncontrado(), 'Fila 2')).toEqual(
        new NotFoundException('Fila 2: no está'),
      );
      expect(conContexto(new Choque(), 'Fila 2')).toEqual(
        new ConflictException('Fila 2: chocó'),
      );
    });

    it('lo que no es de negocio pasa sin tocar', () => {
      const error = new Error('conexión caída');
      expect(conContexto(error, 'Fila 2')).toBe(error);
    });
  });
});
