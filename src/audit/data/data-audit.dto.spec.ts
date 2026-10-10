import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { QueryAuditEntriesDto } from './data-audit.dto';

describe('QueryAuditEntriesDto', () => {
  it('orderId en mayúsculas se normaliza a minúsculas', () => {
    const dto = plainToInstance(QueryAuditEntriesDto, {
      orderId: '7C1F0B3E-5A2D-4E8F-9B6A-1D2C3E4F5A60',
    });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.orderId).toBe('7c1f0b3e-5a2d-4e8f-9b6a-1d2c3e4f5a60');
  });

  it('orderId que no es uuid es inválido', () => {
    const dto = plainToInstance(QueryAuditEntriesDto, { orderId: 'x' });
    expect(validateSync(dto)).not.toHaveLength(0);
  });
});
