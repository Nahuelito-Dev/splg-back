import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  traducirErrorDeBase,
  traducirRestriccionConocida,
} from './db-exceptions';
import { NotFoundDomainError } from './domain.error';

class RecursoInexistenteError extends NotFoundDomainError {
  constructor() {
    super('no existe');
  }
}

/**
 * Códigos de Postgres que traduce el helper compartido. 23505 y 40P01 son
 * los que importan para la revisión de vehículo en uso (`ponerEnUso`): un
 * choque de unicidad o un deadlock tienen que dar un 409 claro, no un 500.
 */
describe('traducirErrorDeBase', () => {
  it.each(['22021', '22P05'])(
    'un texto que la base no puede guardar (%s) sale como 400 en castellano',
    (code) => {
      const llamar = () =>
        traducirErrorDeBase(
          { code, message: 'invalid byte sequence' },
          logger,
          'envase',
        );
      expect(llamar).toThrow(BadRequestException);
      expect(llamar).toThrow(/caracteres no válidos/);
    },
  );

  it('un texto más largo que su columna (22001, p. ej. emojis con selector de variación) sale como 400 en castellano', () => {
    const llamar = () =>
      traducirErrorDeBase(
        {
          code: '22001',
          message: 'value too long for type character varying(200)',
        },
        logger,
        'pregunta',
      );
    expect(llamar).toThrow(BadRequestException);
    expect(llamar).toThrow(/supera el largo permitido/);
  });

  it('un dato obligatorio vacío (23502) nombra el campo con su etiqueta, no con la columna', () => {
    const llamar = () =>
      traducirErrorDeBase(
        { code: '23502', column: 'full_name', message: 'null value' },
        logger,
        'usuarios',
      );
    expect(llamar).toThrow('Falta un dato obligatorio: Nombre completo');
  });

  it('un dato obligatorio vacío sin etiqueta no muestra el nombre de la columna', () => {
    const llamar = () =>
      traducirErrorDeBase(
        { code: '23502', column: 'columna_rara_xyz', message: 'null value' },
        logger,
      );
    expect(llamar).toThrow(/^Falta un dato obligatorio$/);
  });

  const warn = jest.fn();
  const error = jest.fn();
  // Referencias directas a los `jest.fn()`, no a `logger.warn`/`logger.error`:
  // leer esos dos como propiedades de algo tipado `Logger` dispara
  // `@typescript-eslint/unbound-method` (el método "pierde" su `this`).
  const logger = { warn, error } as unknown as Logger;

  beforeEach(() => jest.clearAllMocks());

  it.each(['55P03', '57014'])(
    '%s (timeout de lock/consulta) es 503',
    (code) => {
      expect(() =>
        traducirErrorDeBase({ code, message: 'timeout' }, logger, 'pedido'),
      ).toThrow(ServiceUnavailableException);
      expect(() =>
        traducirErrorDeBase({ code, message: 'timeout' }, logger),
      ).toThrow('El sistema está ocupado, reintentá en unos segundos');
    },
  );

  it('un error de dominio pasa sin traducir (lo mapea el filtro global)', () => {
    const original = new RecursoInexistenteError();
    let capturado: unknown;
    try {
      traducirErrorDeBase(original, logger, 'cajas');
    } catch (e) {
      capturado = e;
    }
    expect(capturado).toBe(original);
    expect(error).not.toHaveBeenCalled();
  });

  it('23P01 (exclusión violada) es 409', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '23P01', detail: 'se pisan', message: 'exclusion' },
        logger,
        'licencias',
      ),
    ).toThrow(ConflictException);
  });

  it('23505 (unicidad violada) es 409', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '23505', detail: 'Key already exists', message: 'duplicate' },
        logger,
        'asignación de vehículo',
      ),
    ).toThrow(ConflictException);
  });

  it('en las unicidades de un legajo no se registran los valores (datos personales), sólo la restricción', () => {
    expect(() =>
      traducirErrorDeBase(
        {
          code: '23505',
          constraint: 'UQ_employee_document_vigente',
          detail:
            'Key (distributor_id, document_number)=(d1, 30123456) already exists.',
          message: 'duplicate key',
        },
        logger,
        'legajo',
      ),
    ).toThrow(ConflictException);
    const registrado = JSON.stringify(warn.mock.calls);
    expect(registrado).toContain('UQ_employee_document_vigente');
    expect(registrado).not.toContain('30123456');
  });

  describe('restricciones de la base con mensaje propio', () => {
    it('23514 (CHECK violado) conocido es 400 con el motivo en castellano', () => {
      const llamar = () =>
        traducirErrorDeBase(
          {
            code: '23514',
            constraint: 'CHK_order_cancelado_motivo',
            message: 'x',
          },
          logger,
          'pedidos',
        );
      expect(llamar).toThrow(BadRequestException);
      expect(llamar).toThrow(
        'Para cancelar un pedido hay que indicar el motivo',
      );
    });

    it('23514 de una restricción que no conocemos es 400 genérico, no 500', () => {
      const llamar = () =>
        traducirErrorDeBase(
          { code: '23514', constraint: 'CHK_futura', message: 'x' },
          logger,
          'pedidos',
        );
      expect(llamar).toThrow(BadRequestException);
      expect(llamar).toThrow('no cumple las reglas del sistema');
    });

    it('23505 de un índice conocido es 409 con su motivo', () => {
      const llamar = () =>
        traducirErrorDeBase(
          {
            code: '23505',
            constraint: 'UQ_coverage_zone_prioridad_activa',
            message: 'x',
          },
          logger,
          'zonas',
        );
      expect(llamar).toThrow(ConflictException);
      expect(llamar).toThrow('cada zona tiene una prioridad distinta');
    });

    it('23P01 de una exclusión conocida es 409 con su motivo', () => {
      const llamar = () =>
        traducirErrorDeBase(
          { code: '23P01', constraint: 'EXC_time_slot_solapada', message: 'x' },
          logger,
          'franjas',
        );
      expect(llamar).toThrow(ConflictException);
      expect(llamar).toThrow('se solapa con otra franja activa');
    });

    it('23514 de una transición de estado inválida es 409 (choca con el estado actual), no 400', () => {
      const llamar = () =>
        traducirErrorDeBase(
          {
            code: '23514',
            constraint: 'CHK_order_transicion_de_estado',
            message: 'x',
          },
          logger,
          'pedidos',
        );
      expect(llamar).toThrow(ConflictException);
      expect(llamar).toThrow('El pedido no puede pasar a ese estado');
    });

    it('23514 de un saldo que no cierra con el libro es 409', () => {
      expect(() =>
        traducirErrorDeBase(
          {
            code: '23514',
            constraint: 'CHK_cash_box_saldo_contra_libro',
            message: 'x',
          },
          logger,
        ),
      ).toThrow(ConflictException);
    });

    it('23503 de una clave compuesta con la distribuidora es 409 con su motivo', () => {
      const llamar = () =>
        traducirErrorDeBase(
          {
            code: '23503',
            constraint: 'FK_order_delivery_id_distribuidora',
            message: 'x',
          },
          logger,
        );
      expect(llamar).toThrow(ConflictException);
      expect(llamar).toThrow('pertenece a otra distribuidora');
    });

    it('23503 sigue siendo 409 (referencia inexistente o en uso)', () => {
      expect(() =>
        traducirErrorDeBase(
          {
            code: '23503',
            constraint: 'FK_5d1f609371a285123294fddcf3a',
            message: 'x',
          },
          logger,
        ),
      ).toThrow(ConflictException);
    });

    describe('traducirRestriccionConocida (red de seguridad del filtro global)', () => {
      it('traduce un CHECK conocido a 400', () => {
        const e = traducirRestriccionConocida({
          code: '23514',
          constraint: 'CHK_car_patente',
        });
        expect(e).toBeInstanceOf(BadRequestException);
        expect(e?.message).toContain('patente');
      });

      it('traduce un único y una exclusión conocidos a 409', () => {
        expect(
          traducirRestriccionConocida({
            code: '23505',
            constraint: 'UQ_user_address_principal',
          }),
        ).toBeInstanceOf(ConflictException);
        expect(
          traducirRestriccionConocida({
            code: '23P01',
            constraint: 'EXC_employee_attendance_solapada',
          }),
        ).toBeInstanceOf(ConflictException);
      });

      it('una transición inválida es 409 en la red de seguridad del filtro', () => {
        expect(
          traducirRestriccionConocida({
            code: '23514',
            constraint: 'CHK_truck_load_transicion_de_estado',
          }),
        ).toBeInstanceOf(ConflictException);
      });

      it('lo que no es nuestro (restricción desconocida, otro código, HTTP) pasa de largo', () => {
        expect(
          traducirRestriccionConocida({
            code: '23514',
            constraint: 'CHK_otra',
          }),
        ).toBeNull();
        expect(
          traducirRestriccionConocida({
            code: '23502',
            constraint: 'CHK_car_patente',
          }),
        ).toBeNull();
        expect(
          traducirRestriccionConocida(new ConflictException('x')),
        ).toBeNull();
        expect(traducirRestriccionConocida('algo')).toBeNull();
      });
    });
  });

  it('40P01 (deadlock) es 409, no 500', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '40P01', message: 'deadlock detected' },
        logger,
        'asignación de vehículo',
      ),
    ).toThrow(ConflictException);
  });

  it('40001 (falla de serialización) es 409, no 500', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '40001', message: 'could not serialize access' },
        logger,
        'asignación de vehículo',
      ),
    ).toThrow(ConflictException);
  });

  it('un código no contemplado sigue siendo 500, pero deja rastro en el log', () => {
    expect(() =>
      traducirErrorDeBase({ code: '99999', message: 'misterio' }, logger),
    ).toThrow(InternalServerErrorException);
    expect(error).toHaveBeenCalled();
  });

  it('22P02 (sintaxis inválida) es 400', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '22P02', message: 'invalid input syntax' },
        logger,
      ),
    ).toThrow(BadRequestException);
  });

  it('22003 (valor numérico fuera de rango) es 400', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '22003', message: 'numeric field overflow' },
        logger,
      ),
    ).toThrow(BadRequestException);
  });

  it('una excepción HTTP ya decidida no se pisa', () => {
    const original = new ConflictException('ya decidido');
    expect(() => traducirErrorDeBase(original, logger)).toThrow(original);
  });
});
