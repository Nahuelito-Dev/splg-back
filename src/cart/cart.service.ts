import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Cart } from './entities/cart.entity';
import { CartItem } from './entities/cart-item.entity';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import {
  armarVista,
  CANTIDAD_MAXIMA_POR_ITEM,
  VistaDelCarrito,
} from './domain/cart-view';
import { OrderPricingService } from '../order/domain/order-pricing.service';

/** El carrito de un cliente en una distribuidora, con su vista calculada. */
export interface CarritoConsultado {
  cart: Cart | null;
  vista: VistaDelCarrito;
}

/**
 * Carrito persistente del cliente (CU-122 a CU-126): uno por cliente y
 * distribuidora. Guarda lo que el cliente armó; no fija el precio (el pedido
 * cobra el vigente del catálogo) ni reserva stock (se controla al crear el
 * pedido).
 *
 * Toda escritura toma el candado de la fila del carrito: dos altas o bajas
 * simultáneas del mismo cliente se serializan y no pisan la cantidad ni
 * duplican el ítem.
 */
@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    @InjectRepository(Cart)
    private readonly carts: Repository<Cart>,
    @InjectRepository(CartItem)
    private readonly items: Repository<CartItem>,
    private readonly dataSource: DataSource,
    private readonly catalogo: GasCylinderService,
    private readonly pricing: OrderPricingService,
  ) {}

  /**
   * CU-125. Sin carrito devuelve uno vacío, no un error. Un tipo dado de baja
   * se muestra marcado como no disponible.
   */
  async consultar(
    userId: string,
    distributorId: string,
  ): Promise<CarritoConsultado> {
    const cart = await this.carts.findOne({ where: { userId, distributorId } });
    if (!cart) return { cart: null, vista: armarVista([], this.pricing) };
    return { cart, vista: await this.vistaDe(cart, this.items) };
  }

  /**
   * CU-122. El tipo tiene que existir, estar activo y ser de la distribuidora
   * (si no, 404: no se revela que existe en otra). Si ya está en el carrito,
   * suma la cantidad; en los dos casos guarda el precio vigente como
   * referencia de lo que vio el cliente.
   */
  async agregarItem(
    userId: string,
    distributorId: string,
    gasCylinderId: string,
    quantity: number,
  ): Promise<CarritoConsultado> {
    const garrafa = await this.catalogo.findOne(gasCylinderId, distributorId);
    if (!garrafa.isActive) {
      throw new NotFoundException('Garrafa no encontrada');
    }

    try {
      await this.transaccion(async (manager) => {
        const cart = await this.carritoParaEscribir(
          manager,
          userId,
          distributorId,
        );
        const repo = manager.getRepository(CartItem);
        const item = await repo.findOne({
          where: { cartId: cart.cartId, gasCylinderId },
        });
        const total = (item?.quantity ?? 0) + quantity;
        if (total > CANTIDAD_MAXIMA_POR_ITEM) {
          throw new BadRequestException(
            `Un tipo de garrafa admite hasta ${CANTIDAD_MAXIMA_POR_ITEM} unidades en el carrito`,
          );
        }
        await repo.save(
          item
            ? Object.assign(item, {
                quantity: total,
                unitPrice: garrafa.price,
              })
            : repo.create({
                cartId: cart.cartId,
                gasCylinderId,
                quantity,
                unitPrice: garrafa.price,
              }),
        );
        await this.tocar(manager, cart);
      });
    } catch (error) {
      traducirErrorDeBase(error, this.logger, 'carrito');
    }
    return this.consultar(userId, distributorId);
  }

  /** CU-123. El ítem tiene que ser del carrito del cliente en la distribuidora. */
  async cambiarCantidad(
    userId: string,
    distributorId: string,
    cartItemId: string,
    quantity: number,
  ): Promise<CarritoConsultado> {
    await this.modificarItem(
      userId,
      distributorId,
      cartItemId,
      async (manager, item) => {
        const garrafa = await this.catalogo.findOne(
          item.gasCylinderId,
          distributorId,
        );
        if (!garrafa.isActive) {
          throw new BadRequestException(
            `El producto ${garrafa.type} ya no está disponible: quitalo del carrito`,
          );
        }
        item.quantity = quantity;
        await manager.getRepository(CartItem).save(item);
      },
    );
    return this.consultar(userId, distributorId);
  }

  /** CU-124. Se borra de verdad: un carrito no es un documento contable. */
  async quitarItem(
    userId: string,
    distributorId: string,
    cartItemId: string,
  ): Promise<CarritoConsultado> {
    await this.modificarItem(
      userId,
      distributorId,
      cartItemId,
      async (manager, item) => {
        await manager.getRepository(CartItem).remove(item);
      },
    );
    return this.consultar(userId, distributorId);
  }

  /** CU-126. Sin carrito no hace nada y lo muestra vacío. */
  async vaciar(
    userId: string,
    distributorId: string,
  ): Promise<CarritoConsultado> {
    await this.transaccion((manager) =>
      this.vaciarEnTransaccion(manager, userId, distributorId),
    );
    return this.consultar(userId, distributorId);
  }

  /**
   * Vacía el carrito dentro de la transacción de quien llama: al confirmarse un
   * pedido el vaciado tiene que ser atómico con el alta del pedido (CU-126).
   */
  async vaciarEnTransaccion(
    manager: EntityManager,
    userId: string,
    distributorId: string,
  ): Promise<void> {
    const cart = await manager.getRepository(Cart).findOne({
      where: { userId, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!cart) return;
    await manager.getRepository(CartItem).delete({ cartId: cart.cartId });
    await this.tocar(manager, cart);
  }

  /** Transacción con reintento ante deadlock o fallo de serialización (CONVENCIONES §8). */
  private transaccion<T>(
    trabajo: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return withTransactionRetry(() => this.dataSource.transaction(trabajo), {
      context: 'CartService',
    });
  }

  /**
   * Los renglones del carrito para armar un pedido (`fromCart`), en la
   * transacción de quien llama. Con `bloquear` toma el candado del carrito:
   * nadie lo modifica hasta que el pedido lo vacíe o se deshaga.
   *
   * @throws BadRequestException si el carrito está vacío o tiene tipos que ya
   *   no están disponibles (dados de baja): hay que quitarlos antes de comprar.
   */
  async itemsParaPedido(
    manager: EntityManager,
    userId: string,
    distributorId: string,
    bloquear: boolean,
  ): Promise<{ gasCylinderId: string; quantity: number }[]> {
    const cart = await manager.getRepository(Cart).findOne({
      where: { userId, distributorId },
      ...(bloquear && { lock: { mode: 'pessimistic_write' as const } }),
    });
    const renglones = cart
      ? await manager.getRepository(CartItem).find({
          where: { cartId: cart.cartId },
          relations: { gasCylinder: true },
          order: { gasCylinder: { type: 'ASC' } },
        })
      : [];
    if (renglones.length === 0) {
      throw new BadRequestException('Tu carrito está vacío');
    }
    const caidos = renglones.filter((r) => !r.gasCylinder.isActive);
    if (caidos.length > 0) {
      throw new BadRequestException(
        `Tu carrito tiene productos que ya no están disponibles (${caidos
          .map((r) => r.gasCylinder.type)
          .join(', ')}): quitalos para continuar`,
      );
    }
    return renglones.map((r) => ({
      gasCylinderId: r.gasCylinderId,
      quantity: r.quantity,
    }));
  }

  /** Carga el ítem bajo el candado de su carrito y aplica la operación. */
  private async modificarItem(
    userId: string,
    distributorId: string,
    cartItemId: string,
    operacion: (manager: EntityManager, item: CartItem) => Promise<void>,
  ): Promise<void> {
    try {
      await this.transaccion(async (manager) => {
        const cart = await manager.getRepository(Cart).findOne({
          where: { userId, distributorId },
          lock: { mode: 'pessimistic_write' },
        });
        const item = cart
          ? await manager
              .getRepository(CartItem)
              .findOne({ where: { cartItemId, cartId: cart.cartId } })
          : null;
        if (!cart || !item) {
          throw new NotFoundException('El ítem no está en tu carrito');
        }
        await operacion(manager, item);
        await this.tocar(manager, cart);
      });
    } catch (error) {
      traducirErrorDeBase(error, this.logger, 'carrito');
    }
  }

  /**
   * El carrito del cliente en la distribuidora, creado si no existe, con la
   * fila bloqueada. El insert ignora el conflicto de `UQ_cart_user_distributor`:
   * dos primeras altas simultáneas terminan con un único carrito.
   */
  private async carritoParaEscribir(
    manager: EntityManager,
    userId: string,
    distributorId: string,
  ): Promise<Cart> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(Cart)
      .values({ userId, distributorId })
      .orIgnore()
      .execute();
    return manager.getRepository(Cart).findOneOrFail({
      where: { userId, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  /** Marca el carrito como modificado ahora. */
  private async tocar(manager: EntityManager, cart: Cart): Promise<void> {
    await manager
      .getRepository(Cart)
      .update({ cartId: cart.cartId }, { updatedAt: new Date() });
  }

  private async vistaDe(
    cart: Cart,
    repo: Repository<CartItem>,
  ): Promise<VistaDelCarrito> {
    const renglones = await repo.find({
      where: { cartId: cart.cartId },
      relations: { gasCylinder: { promotions: true } },
      order: { gasCylinder: { type: 'ASC' } },
    });
    return armarVista(
      renglones.map((r) => ({
        cartItemId: r.cartItemId,
        gasCylinderId: r.gasCylinderId,
        type: r.gasCylinder.type,
        quantity: r.quantity,
        savedUnitPrice: r.unitPrice,
        listUnitPrice: r.gasCylinder.price,
        promotions: r.gasCylinder.promotions,
        available: r.gasCylinder.isActive,
        hasEnoughStock: r.gasCylinder.stock >= r.quantity,
      })),
      this.pricing,
    );
  }
}
