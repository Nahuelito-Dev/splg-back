import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryEmployeeDto } from './query-employee.dto';
import { EmployeeDocumentStatus } from '../domain/document-status';

const errores = (plano: object) =>
  validate(plainToInstance(QueryEmployeeDto, plano));

describe('QueryEmployeeDto: documentStatus (CU-180)', () => {
  it.each(Object.values(EmployeeDocumentStatus))(
    'acepta %s',
    async (estado) => {
      expect(await errores({ documentStatus: estado })).toHaveLength(0);
    },
  );

  it('es opcional', async () => {
    expect(await errores({})).toHaveLength(0);
  });

  it('rechaza un estado que no existe', async () => {
    const res = await errores({ documentStatus: 'nada' });
    expect(res.map((e) => e.property)).toEqual(['documentStatus']);
  });
});
