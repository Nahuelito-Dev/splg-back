import { ConfigService } from '@nestjs/config';

const enviar = jest.fn().mockResolvedValue({ error: null });
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: enviar } })),
}));

import { NotificationLogRecorder } from '../../notification-log/notification-log.recorder';
import {
  REMITENTE_POR_OMISION,
  ResendEmailAdapter,
} from './resend-email.adapter';

const registro = {
  conRegistro: jest.fn(
    async (
      _aviso: unknown,
      enviar: () => Promise<boolean>,
      evaluar?: (salio: boolean) => unknown,
    ) => {
      evaluador = evaluar;
      await enviar();
    },
  ),
};
let evaluador: ((salio: boolean) => unknown) | undefined;

function adaptador(valores: Record<string, string | undefined>) {
  const config = {
    get: (clave: string) => valores[clave],
  } as unknown as ConfigService;
  return new ResendEmailAdapter(
    config,
    registro as unknown as NotificationLogRecorder,
  );
}

describe('ResendEmailAdapter', () => {
  beforeEach(() => {
    enviar.mockClear();
    registro.conRegistro.mockClear();
  });

  it('registra el aviso con el destinatario original, el asunto y el contexto', async () => {
    await adaptador({ RESEND_API_KEY: 'k' }).send({
      to: 'a@b.com',
      subject: 'Asunto',
      html: 'h',
      registro: { type: 'CASH_READY', orderId: 'o1' },
    });
    expect(registro.conRegistro).toHaveBeenCalledWith(
      {
        channel: 'email',
        destino: 'a@b.com',
        titulo: 'Asunto',
        contexto: { type: 'CASH_READY', orderId: 'o1' },
      },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('sin RESEND_API_KEY el aviso se registra como skipped', async () => {
    await adaptador({}).send({ to: 'a@b.com', subject: 's', html: 'h' });
    expect(evaluador?.(true)).toBeNull();
    expect(evaluador?.(false)).toEqual({
      status: 'skipped',
      error: expect.stringContaining('RESEND_API_KEY') as string,
    });
  });

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

  it('manda el texto plano cuando viene', async () => {
    await adaptador({ RESEND_API_KEY: 'k' }).send({
      to: 'a@b.com',
      subject: 's',
      html: 'h',
      text: 't',
    });
    expect(enviar).toHaveBeenCalledWith(
      expect.objectContaining({ html: 'h', text: 't' }),
    );
  });

  it('con EMAIL_REDIRECT_TO manda todo a esa dirección, marcado con el destinatario original', async () => {
    await adaptador({
      RESEND_API_KEY: 'k',
      NODE_ENV: 'development',
      EMAIL_REDIRECT_TO: 'nahue@test.com',
    }).send({
      to: 'cliente@b.com',
      subject: 'Hola',
      html: '<body><p>x</p></body>',
      text: 'x',
    });
    const [[enviado]] = enviar.mock.calls as [
      [{ to: string; subject: string; html: string; text: string }],
    ];
    expect(enviado.to).toBe('nahue@test.com');
    expect(enviado.subject).toBe('[para: cliente@b.com] Hola');
    expect(enviado.html).toContain('Correo de prueba: era para');
    expect(enviado.text).toContain('era para cliente@b.com');
  });

  it('en producción ignora EMAIL_REDIRECT_TO', async () => {
    await adaptador({
      RESEND_API_KEY: 'k',
      NODE_ENV: 'production',
      EMAIL_REDIRECT_TO: 'nahue@test.com',
    }).send({ to: 'cliente@b.com', subject: 'Hola', html: 'h' });
    expect(enviar).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'cliente@b.com', subject: 'Hola' }),
    );
    expect(enviar).toHaveBeenCalledWith(
      expect.not.objectContaining({ text: expect.anything() as unknown }),
    );
  });
});
