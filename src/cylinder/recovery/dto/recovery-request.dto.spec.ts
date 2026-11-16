import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { QueryRecoveryCasesDto } from './recovery-request.dto';

const parsear = (query: object) => {
  const dto = plainToInstance(QueryRecoveryCasesDto, query);
  return { dto, errores: validateSync(dto) };
};

describe('QueryRecoveryCasesDto', () => {
  it.each(['live', 'pending'] as const)(
    '%s sólo acepta true o false',
    (campo) => {
      expect(parsear({ [campo]: 'true' }).dto[campo]).toBe(true);
      expect(parsear({ [campo]: 'false' }).dto[campo]).toBe(false);
      expect(parsear({ [campo]: true }).dto[campo]).toBe(true);
      expect(parsear({ [campo]: false }).dto[campo]).toBe(false);
      expect(parsear({ [campo]: 'x' }).errores).not.toHaveLength(0);
    },
  );
});
