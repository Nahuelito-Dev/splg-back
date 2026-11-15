import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import {
  etiquetaDelPermiso,
  type Permiso,
} from '../../common/permisos/catalogo';

/** La empresa apagó el chat con los clientes (C3). */
export function chatDeClientesApagado(): ForbiddenException {
  return conCodigo(
    ForbiddenException,
    403,
    'La distribuidora no atiende por chat.',
    CODIGOS_DE_ERROR.CUSTOMER_CHAT_DISABLED,
  );
}

/** Editar un mensaje que escribió otra persona (también un compañero del equipo). */
export function mensajeAjeno(): ForbiddenException {
  return conCodigo(
    ForbiddenException,
    403,
    'Sólo podés editar tus propios mensajes.',
    CODIGOS_DE_ERROR.MESSAGE_NOT_OWN,
  );
}

/** Borrar mensajes es sólo del cliente (D-C23): el chofer no borra. */
export function borradoNoPermitido(): ForbiddenException {
  return conCodigo(
    ForbiddenException,
    403,
    'Sólo el cliente puede borrar sus mensajes.',
    CODIGOS_DE_ERROR.MESSAGE_DELETE_NOT_ALLOWED,
  );
}

/** Un canal o una acción que el rol del personal no tiene. */
export function sinPermiso(...permisos: Permiso[]): ForbiddenException {
  return conCodigo(
    ForbiddenException,
    403,
    `No tenés permiso para ${permisos.map(etiquetaDelPermiso).join(' ni para ')}`,
    CODIGOS_DE_ERROR.PERMISSION_DENIED,
  );
}

export const noExisteElMensaje = () =>
  new NotFoundException('No existe ese mensaje');
export const noExisteElPedido = () =>
  new NotFoundException('No existe ese pedido');
export const noExisteElCliente = () =>
  new NotFoundException('No existe ese cliente');
export const noExisteElChofer = () =>
  new NotFoundException('No existe ese chofer');
export const noExisteLaPersonaDelPersonal = () =>
  new NotFoundException('No existe esa persona del personal');
/** Un cliente sin vínculo ni pedidos con la empresa: no se le confirma que exista. */
export const sinRelacionConLaEmpresa = () =>
  new NotFoundException('No encontramos a la distribuidora');
export const choferesAjenos = () =>
  new NotFoundException(
    'Alguno de los choferes no es de la empresa: no se mandó el mensaje a ninguno',
  );
