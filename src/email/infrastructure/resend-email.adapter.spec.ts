import { ConfigService } from '@nestjs/config';

const enviar = jest.fn().mockResolvedValue({ error: null });
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: enviar } })),
}));

import {
  REMITENTE_POR_OMISION,
  ResendEmailAdapter,
} from './resend-email.adapter';

function adaptador(valores: Record<string, string | undefined>) {
  const config = {
    get: (clave: string) => valores[clave],
  } as unknown as ConfigService;
  return new ResendEmailAdapter(config);
}

describe('ResendEmailAdapter', () => {
  beforeEach(() => enviar.mockClear());

  it('usa EMAIL_FROM como remitente', async () => {
    await adaptador({
      RESEND_API_KEY: 'k',
      EMAIL_FROM: 'OrixTech <noreply@ejemplo.com>',
    }).send({ to: 'a@b.com', subject: 's', html: 'h' });
    expect(enviar).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'OrixTech <noreply@ejemplo.com>' }),
    );
  });

  it('sin EMAIL_FROM usa el remitente de prueba de Resend', async () => {
    await adaptador({ RESEND_API_KEY: 'k', EMAIL_FROM: '  ' }).send({
      to: 'a@b.com',
      subject: 's',
      html: 'h',
    });
    expect(enviar).toHaveBeenCalledWith(
      expect.objectContaining({ from: REMITENTE_POR_OMISION }),
    );
  });

  it('sin RESEND_API_KEY no envía', async () => {
    await adaptador({}).send({ to: 'a@b.com', subject: 's', html: 'h' });
    expect(enviar).not.toHaveBeenCalled();
  });

  it('un error del proveedor se propaga', async () => {
    enviar.mockResolvedValueOnce({ error: { message: 'API key is invalid' } });
    await expect(
      adaptador({ RESEND_API_KEY: 'k' }).send({
        to: 'a@b.com',
        subject: 's',
        html: 'h',
      }),
    ).rejects.toThrow('API key is invalid');
  });
});
