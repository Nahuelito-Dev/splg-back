import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AsistenteIaService,
  type PruebaDelAsistente,
  type TipoDePrueba,
  TopeDePruebasAlcanzado,
} from '../assistant-ai/asistente-ia.service';
import { clienteDeLaDistribuidora } from '../common/tenancy/pertenencia';
import { Customer } from '../customer/entities/customer.entity';
import { vistaPrevia, type VistaPrevia } from './assistant-lab.dominio';
import { clienteInexistente, topeDePruebas } from './assistant-lab.errors';

/** Una pregunta al probador de una empresa (C3). */
export interface PreguntaDeLaEmpresa {
  distributorId: string;
  question: string;
  /** El cliente (`customer_id`) como el que pregunta; sin él, uno anónimo. */
  customerId?: string;
  actorUserId: string | null;
  tipo?: TipoDePrueba;
}

/**
 * Probador del asistente (7b): contesta como lo haría en una conversación
 * real, por el mismo camino (`AsistenteIaService.probar`), sin publicar nada.
 * La empresa prueba con su base y, si elige un cliente suyo, con los pedidos
 * de ese cliente; la plataforma, con la suya (C1).
 */
@Injectable()
export class ProbadorService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly asistente: AsistenteIaService,
  ) {}

  async deLaEmpresa(p: PreguntaDeLaEmpresa): Promise<VistaPrevia> {
    const customerUserId = p.customerId
      ? await this.usuarioDelCliente(p.distributorId, p.customerId)
      : null;
    return this.probar({
      canal: 'clientes',
      distributorId: p.distributorId,
      customerUserId,
      pregunta: p.question,
      tipo: p.tipo ?? 'preview',
      actorUserId: p.actorUserId,
    });
  }

  async deLaPlataforma(
    question: string,
    actorUserId: string | null,
  ): Promise<VistaPrevia> {
    return this.probar({
      canal: 'soporte',
      distributorId: null,
      customerUserId: null,
      pregunta: question,
      tipo: 'preview',
      actorUserId,
    });
  }

  /** El motor; el cupo de pruebas agotado es un 429 con su código. */
  private async probar(prueba: PruebaDelAsistente): Promise<VistaPrevia> {
    try {
      return vistaPrevia(await this.asistente.probar(prueba));
    } catch (error) {
      if (error instanceof TopeDePruebasAlcanzado) throw topeDePruebas();
      throw error;
    }
  }

  /**
   * El usuario del cliente, si es de la empresa (le compró o ella lo dio de
   * alta, y no lo dio de baja: la misma regla que la API). Si no, 404.
   */
  private async usuarioDelCliente(
    distributorId: string,
    customerId: string,
  ): Promise<string> {
    const cliente = await this.dataSource
      .getRepository(Customer)
      .createQueryBuilder('customer')
      .select(['customer.customerId', 'customer.userId'])
      .where('customer.customerId = :customerId', { customerId })
      .andWhere(clienteDeLaDistribuidora('customer.userId'), {
        distributorId,
      })
      .getOne();
    if (!cliente) throw clienteInexistente();
    return cliente.userId;
  }
}
