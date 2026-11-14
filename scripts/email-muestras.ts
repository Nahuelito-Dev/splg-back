/**
 * Manda una muestra de cada correo del sistema a una dirección.
 *
 *   npm run email:muestras -- <correo>
 *
 * Usa el puerto real (`ResendEmailAdapter`, con `RESEND_API_KEY` y
 * `EMAIL_FROM` del `.env`) y respeta `EMAIL_REDIRECT_TO`: si está cargada, las
 * muestras van ahí, marcadas con <correo> como destinatario original. Sin
 * `RESEND_API_KEY` no sale nada (el adaptador no envía) y se avisa.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { ResendEmailAdapter } from '../src/email/infrastructure/resend-email.adapter';
import { destinoDeRedireccion } from '../src/email/redireccion-de-desarrollo';
import { muestrasDeCorreo } from '../src/email/vista-previa/muestras-de-correo';

const PAUSA_MS = 700; // Resend acepta pocas solicitudes por segundo.

async function main(): Promise<number> {
  const destino = process.argv[2]?.trim();
  if (!destino || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destino)) {
    console.error('Uso: npm run email:muestras -- <correo>');
    return 2;
  }
  if (!process.env.RESEND_API_KEY?.trim()) {
    console.error(
      'Falta RESEND_API_KEY en el .env: el adaptador no envía nada. No se mandó ninguna muestra.',
    );
    return 1;
  }
  const redireccion = destinoDeRedireccion(process.env);
  if (redireccion) {
    console.log(
      `EMAIL_REDIRECT_TO activo: las muestras van a ${redireccion} (marcadas «para: ${destino}»).`,
    );
  }

  const adaptador = new ResendEmailAdapter(new ConfigService(process.env));
  const muestras = muestrasDeCorreo({ env: process.env });
  let fallidas = 0;
  for (const [i, m] of muestras.entries()) {
    try {
      await adaptador.send({
        to: destino,
        subject: m.correo.asunto,
        html: m.correo.html,
        text: m.correo.text,
      });
      console.log(`ok     ${m.clave}  «${m.correo.asunto}»`);
    } catch (error) {
      fallidas += 1;
      console.error(
        `falló  ${m.clave}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (i < muestras.length - 1) {
      await new Promise((r) => setTimeout(r, PAUSA_MS));
    }
  }
  console.log(
    `${muestras.length - fallidas} de ${muestras.length} muestras enviadas.`,
  );
  return fallidas > 0 ? 1 : 0;
}

main().then(
  (codigo) => process.exit(codigo),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
