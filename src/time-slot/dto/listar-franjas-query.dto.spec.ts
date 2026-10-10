import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListarFranjasQueryDto } from './listar-franjas-query.dto';

const parsear = (q: object) => {
  const dto = plainToInstance(ListarFranjasQueryDto, q);
  return { dto, errores: validateSync(dto) };
};

describe('ListarFranjasQueryDto', () => {
  it('includeInactive: "true" es true, "false" es false y ausente queda sin definir', () => {
    expect(parsear({ includeInactive: 'true' }).dto.includeInactive).toBe(true);
    expect(parsear({ includeInactive: 'false' }).dto.includeInactive).toBe(
      false,
    );
    expect(parsear({}).dto.includeInactive).toBeUndefined();
  });

  it('un valor que no es booleano es inválido', () => {
    expect(parsear({ includeInactive: 'quizas' }).errores).not.toHaveLength(0);
  });
});
