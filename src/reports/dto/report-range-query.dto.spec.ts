import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReportRangeQueryDto } from './report-range-query.dto';

const errores = (plano: object) =>
  validateSync(plainToInstance(ReportRangeQueryDto, plano)).length;

describe('ReportRangeQueryDto', () => {
  it('acepta YYYY-MM-DD y los campos vacíos', () => {
    expect(errores({ from: '2026-07-07', to: '2026-07-07' })).toBe(0);
    expect(errores({})).toBe(0);
  });

  it('rechaza un ISO con hora, formatos sueltos y días inexistentes', () => {
    expect(errores({ from: '2026-07-07T10:00:00Z' })).toBe(1);
    expect(errores({ to: '2026-7-7' })).toBe(1);
    expect(errores({ to: '2026-02-31' })).toBe(1);
  });
});
