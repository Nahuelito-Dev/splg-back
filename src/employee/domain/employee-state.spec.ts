import { validarEgreso, validarReingreso } from './employee-state';
import { EmployeeStatus } from '../entities/employee.entity';

const activo = {
  status: EmployeeStatus.ACTIVE,
  hireDate: '2026-03-01',
  terminationDate: null,
};
const egresado = {
  status: EmployeeStatus.TERMINATED,
  hireDate: '2026-03-01',
  terminationDate: '2026-09-30',
};

describe('transiciones del legajo', () => {
  describe('egreso', () => {
    it('un activo puede egresar desde el día de su ingreso', () => {
      expect(validarEgreso(activo, '2026-03-01')).toBeNull();
      expect(validarEgreso(activo, '2026-10-04')).toBeNull();
    });

    it('un egresado no puede egresar de nuevo', () => {
      expect(validarEgreso(egresado, '2026-10-04')).toBe('YA_EGRESADO');
    });

    it('la fecha no puede ser anterior al ingreso', () => {
      expect(validarEgreso(activo, '2026-02-28')).toBe(
        'FECHA_ANTERIOR_AL_INGRESO',
      );
    });
  });

  describe('reingreso', () => {
    it('un egresado puede reingresar el día del egreso o después', () => {
      expect(validarReingreso(egresado, '2026-09-30')).toBeNull();
      expect(validarReingreso(egresado, '2026-10-05')).toBeNull();
    });

    it('un activo no puede reingresar', () => {
      expect(validarReingreso(activo, '2026-10-05')).toBe('NO_EGRESADO');
    });

    it('no puede reingresar antes de haber egresado', () => {
      expect(validarReingreso(egresado, '2026-09-29')).toBe(
        'FECHA_ANTERIOR_AL_EGRESO',
      );
    });
  });
});
