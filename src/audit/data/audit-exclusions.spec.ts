import { ENTIDADES_DE_LA_DISTRIBUIDORA_DEL_REQUEST } from './audit-exclusions';

describe('entidades que toman la distribuidora del request', () => {
  it('la lectura de un aviso de la bandeja queda en la auditoría con la distribuidora del admin', () => {
    expect(
      ENTIDADES_DE_LA_DISTRIBUIDORA_DEL_REQUEST.has('AdminNotificationRead'),
    ).toBe(true);
  });
});
