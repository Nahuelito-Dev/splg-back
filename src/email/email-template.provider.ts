import { Injectable } from '@nestjs/common';
import { EnlacesDeLaApp } from './enlaces-de-la-app';
import {
  armarCorreo,
  BloqueDeCorreo,
  CorreoArmado,
  MensajeDeCorreo,
} from './layout/correo';
import { MarcaDeCorreo, marcaDePlataforma } from './layout/marca-de-correo';

/** Los valores que una plantilla interpola: todos texto, todos opcionales. */
export type DatosDePlantilla = Record<string, string | undefined>;

/** Lo que una plantilla necesita además de sus datos. */
export interface ContextoDePlantilla {
  marca: MarcaDeCorreo;
  enlaces: Pick<EnlacesDeLaApp, 'inicio' | 'accionDeCuenta'>;
}

/** Una plantilla: datos → contenido del correo (el layout lo pone `armarCorreo`). */
export type PlantillaDeCorreo = (
  data: DatosDePlantilla,
  ctx: ContextoDePlantilla,
) => MensajeDeCorreo;

const nombreDe = (data: DatosDePlantilla) => data.displayName || 'Usuario';

const firma = (marca: MarcaDeCorreo): BloqueDeCorreo => ({
  tipo: 'parrafo',
  texto: ['Gracias,\n', { fuerte: `El equipo de ${marca.nombre}` }],
});

/** Botón más el enlace a la vista; nada si el enlace no vino. */
const botonConEnlace = (
  texto: string,
  url: string | undefined,
): BloqueDeCorreo[] =>
  url
    ? [
        { tipo: 'boton', texto, url },
        { tipo: 'enlace-alternativo', url },
      ]
    : [];

/**
 * Las plantillas de la plataforma, por nombre. Para sumar una (por ejemplo el
 * aviso de un ticket de soporte) alcanza con agregar una entrada que devuelva
 * un `MensajeDeCorreo`: el layout, la marca y el texto plano salen solos.
 */
export const PLANTILLAS_DE_CORREO: Readonly<Record<string, PlantillaDeCorreo>> =
  {
    welcome: (data, { marca, enlaces }) => ({
      asunto: `Te damos la bienvenida a ${marca.nombre}`,
      preheader: `Tu cuenta ya está lista para usar ${marca.nombre}.`,
      etiqueta: 'Cuenta creada',
      titulo: '¡Te damos la bienvenida!',
      bloques: [
        { tipo: 'parrafo', texto: ['Hola ', { fuerte: nombreDe(data) }, ','] },
        {
          tipo: 'parrafo',
          texto: `Gracias por crear tu cuenta. Ya está todo listo para que empieces a usar ${marca.nombre}.`,
        },
        { tipo: 'boton', texto: 'Ir a la aplicación', url: enlaces.inicio },
        {
          tipo: 'parrafo',
          suave: true,
          texto: data.supportEmail
            ? [
                'Si necesitás ayuda, escribinos a ',
                {
                  enlace: data.supportEmail,
                  url: `mailto:${data.supportEmail}`,
                },
                '.',
              ]
            : 'Si necesitás ayuda, contactá a tu distribuidora.',
        },
        firma(marca),
      ],
    }),

    'email-verification': (data, { marca }) => ({
      asunto: `Verificá tu correo de ${marca.nombre}`,
      preheader: 'Confirmá tu dirección para empezar a usar tu cuenta.',
      etiqueta: 'Verificación',
      titulo: 'Verificá tu correo',
      bloques: [
        { tipo: 'parrafo', texto: ['Hola ', { fuerte: nombreDe(data) }, ','] },
        {
          tipo: 'parrafo',
          texto: `¡Te damos la bienvenida a ${marca.nombre}! Verificá tu correo para empezar a usar tu cuenta.`,
        },
        ...botonConEnlace('Verificar correo', data.verificationLink),
        {
          tipo: 'parrafo',
          suave: true,
          texto: `Si no creaste una cuenta en ${marca.nombre}, ignorá este correo.`,
        },
        {
          tipo: 'parrafo',
          texto: [
            `¡Gracias por elegir ${marca.nombre}!\n`,
            { fuerte: `El equipo de ${marca.nombre}` },
          ],
        },
      ],
    }),

    'password-reset': (data, { marca }) => ({
      asunto: `Restablecé tu contraseña de ${marca.nombre}`,
      preheader:
        'Usá el enlace para elegir una contraseña nueva. Vence en 1 hora.',
      etiqueta: 'Seguridad de la cuenta',
      titulo: 'Restablecé tu contraseña',
      bloques: [
        { tipo: 'parrafo', texto: 'Hola,' },
        {
          tipo: 'parrafo',
          texto: data.email
            ? [
                `Recibimos un pedido para restablecer la contraseña de tu cuenta de ${marca.nombre} (`,
                { fuerte: data.email },
                ').',
              ]
            : `Recibimos un pedido para restablecer la contraseña de tu cuenta de ${marca.nombre}.`,
        },
        ...(data.resetLink
          ? ([
              {
                tipo: 'boton',
                texto: 'Restablecer contraseña',
                url: data.resetLink,
              },
              {
                tipo: 'nota',
                tono: 'aviso',
                titulo: 'Ojo',
                texto: 'Este enlace vence en 1 hora.',
              },
              { tipo: 'enlace-alternativo', url: data.resetLink },
            ] satisfies BloqueDeCorreo[])
          : []),
        {
          tipo: 'parrafo',
          suave: true,
          texto:
            'Si no pediste restablecer la contraseña, ignorá este correo: tu contraseña no se modifica.',
        },
        firma(marca),
      ],
    }),

    'email-change-notification': (data, { marca, enlaces }) => ({
      asunto: `Cambió el correo de ingreso a ${marca.nombre}`,
      preheader: data.newEmail
        ? `Ahora ingresás con ${data.newEmail}. Si no fuiste vos, protegé tu cuenta.`
        : 'Cambió tu correo de ingreso. Si no fuiste vos, protegé tu cuenta.',
      etiqueta: 'Seguridad de la cuenta',
      titulo: 'Cambió tu correo',
      bloques: [
        { tipo: 'parrafo', texto: ['Hola ', { fuerte: nombreDe(data) }, ','] },
        {
          tipo: 'parrafo',
          texto: [
            `El correo con el que ingresás a ${marca.nombre} se cambió de esta dirección a `,
            { fuerte: data.newEmail || 'una dirección nueva' },
            '.',
          ],
        },
        {
          tipo: 'parrafo',
          texto: 'Si hiciste el cambio, no tenés que hacer nada más.',
        },
        {
          tipo: 'nota',
          tono: 'peligro',
          titulo: '¿No fuiste vos?',
          texto: 'Si no pediste cambiar el correo, protegé tu cuenta ahora.',
        },
        {
          tipo: 'boton',
          texto: 'Proteger mi cuenta',
          url: enlaces.accionDeCuenta,
        },
        {
          tipo: 'parrafo',
          suave: true,
          texto: marca.contacto
            ? [
                'Si necesitás ayuda, escribile a nuestro equipo de soporte: ',
                { enlace: marca.contacto, url: `mailto:${marca.contacto}` },
                '.',
              ]
            : 'Si necesitás ayuda, escribile a nuestro equipo de soporte.',
        },
        firma(marca),
      ],
    }),
  };

/**
 * Provider de las plantillas de correo de la plataforma. `render` conserva su
 * contrato (nombre + datos → HTML; plantilla inexistente → el mismo
 * placeholder); `renderCorreo` además devuelve el asunto y el texto plano.
 */
@Injectable()
export class EmailTemplateProvider {
  constructor(private readonly enlaces: EnlacesDeLaApp) {}

  render(template: string, data: DatosDePlantilla): string {
    return this.renderCorreo(template, data).html;
  }

  renderCorreo(
    template: string,
    data: DatosDePlantilla,
    marca: MarcaDeCorreo = marcaDePlataforma(),
  ): CorreoArmado {
    const plantilla = Object.hasOwn(PLANTILLAS_DE_CORREO, template)
      ? PLANTILLAS_DE_CORREO[template]
      : undefined;
    if (!plantilla) {
      return {
        asunto: '',
        html: '<p>Plantilla de correo inexistente</p>',
        text: 'Plantilla de correo inexistente',
      };
    }
    return armarCorreo(
      marca,
      plantilla(data, { marca, enlaces: this.enlaces }),
    );
  }
}
