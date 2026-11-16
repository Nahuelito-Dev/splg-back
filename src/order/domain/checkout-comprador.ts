import type {
  CheckoutAddress,
  CheckoutPayer,
} from '../../payments/domain/ports/payment-gateway.port';

/** Lo que el checkout necesita saber de quien paga y de dónde se entrega. */
export interface DatosDelComprador {
  payer: CheckoutPayer;
  receiverAddress: CheckoutAddress;
}

interface Comprador {
  email: string | null;
  fullName: string | null;
  phoneNumber: string | null;
}

interface Direccion {
  street: string;
  city: string;
  postalCode: string | null;
  floor: string | null;
  apartment: string | null;
}

/**
 * El pagador y la dirección de entrega para armar el checkout. Mientras más datos
 * lleve la preferencia, más pagos aprueba el antifraude de Mercado Pago. No hay
 * documento del comprador en el sistema (el del receptor del pedido es de otra
 * persona), así que no se manda.
 */
export function datosDelComprador(
  comprador: Comprador,
  direccion: Direccion,
): DatosDelComprador {
  const entrega: CheckoutAddress = {
    street: direccion.street,
    city: direccion.city,
    zipCode: direccion.postalCode,
    floor: direccion.floor,
    apartment: direccion.apartment,
  };
  return {
    payer: {
      email: comprador.email,
      fullName: comprador.fullName,
      phone: comprador.phoneNumber,
      address: { street: direccion.street, zipCode: direccion.postalCode },
    },
    receiverAddress: entrega,
  };
}
