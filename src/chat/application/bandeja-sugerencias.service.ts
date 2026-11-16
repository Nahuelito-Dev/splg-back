import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { completarPlantilla } from '../domain/bandeja';
import { MessageTemplateScope } from '../domain/chat.enums';
import {
  PALABRAS_DE_CORTESIA,
  PARECIDO_MINIMO,
  TOPE_DE_SUGERENCIAS,
  textoParaSugerir,
} from '../domain/sugerencias';
import { type ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import { CompanyChatSettingsService } from './company-chat-settings.service';
import { valoresDePlantilla } from './valores-de-plantilla';

/** Una respuesta guardada sugerida, con el texto ya completado. */
export interface Sugerencia {
  templateId: string;
  key: string;
  title: string;
  body: string;
}

export interface SugerenciasDeLaConversacion {
  /** El `seq` del mensaje de la persona con que se buscó; nulo si no escribió. */
  basadoEnSeq: number | null;
  items: Sugerencia[];
}

interface UltimoMensaje {
  seq: string | number;
  body: string;
}

interface PlantillaParecida {
  template_id: string;
  key: string;
  title: string;
  body: string;
}

/**
 * El último texto visible de la persona (cliente en C3, chofer en C2): ni
 * redactado, ni borrado por su autor, ni dado de baja.
 */
const ULTIMO_MENSAJE_DE_LA_PERSONA = `
  SELECT "seq", "body" FROM "message"
   WHERE "conversation_id" = $1
     AND "sender_party" IN ('customer', 'driver')
     AND "kind" = 'text'
     AND "body" IS NOT NULL
     AND "redacted_at" IS NULL
     AND "withdrawn_at" IS NULL
     AND "deleted_at" IS NULL
   ORDER BY "seq" DESC
   LIMIT 1`;

/**
 * Las respuestas guardadas de la empresa más parecidas a un texto, sin IA:
 * búsqueda de texto en castellano sin tildes (`unaccent`). Cada palabra del
 * mensaje (sin las vacías, ya reducida a su raíz) suma; las de 3 letras o más
 * valen también como comienzo («hora» encuentra «horarios»). El título pesa
 * más que el texto, y no cuentan las variables (`{{cliente.nombre}}`) ni los
 * saludos de las respuestas («Hola…»); por
 * debajo de un parecido mínimo no se sugiere. Sólo
 * las vigentes y activas de esa empresa para ese canal: nunca las de otra
 * empresa ni las de la plataforma.
 */
const PLANTILLAS_PARECIDAS = `
  WITH consulta AS (
    SELECT (SELECT string_agg(
                     quote_literal(l.lexeme)
                       || CASE WHEN char_length(l.lexeme) >= 3 THEN ':*' ELSE '' END,
                     ' | ')
              FROM unnest(to_tsvector('spanish', unaccent($1))) AS l
           )::tsquery AS q
  ),
  cortesia AS (
    SELECT array_agg(l.lexeme) AS lexemas
      FROM unnest(to_tsvector('spanish', unaccent($6))) AS l
  ),
  candidatas AS (
    SELECT t."template_id", t."key", t."title", t."body",
           ts_delete(
             setweight(to_tsvector('spanish', unaccent(t."title")), 'A')
               || setweight(to_tsvector('spanish', unaccent(
                    regexp_replace(t."body", '\\{\\{[^{}]*\\}\\}', ' ', 'g'))), 'B'),
             (SELECT lexemas FROM cortesia)) AS v
      FROM "message_template" t
     WHERE t."distributor_id" = $2
       AND t."scope" = '${MessageTemplateScope.STAFF_REPLY}'
       AND t."active"
       AND t."deleted_at" IS NULL
       AND (t."channel" IS NULL OR t."channel" = $3)
  )
  SELECT c."template_id", c."key", c."title", c."body"
    FROM candidatas c, consulta
   WHERE c.v @@ consulta.q
     AND ts_rank(c.v, consulta.q) >= $5
   ORDER BY ts_rank(c.v, consulta.q) DESC, c."title" ASC, c."template_id" ASC
   LIMIT $4`;

/**
 * Sugerencias de respuesta para quien atiende la bandeja (diseño CH-BOT §3,
 * capa fija): las respuestas guardadas de la empresa más parecidas al último
 * mensaje del cliente o del chofer, con las variables completadas para esa
 * conversación. Sólo lectura: no manda nada.
 */
@Injectable()
export class BandejaSugerenciasService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly acceso: BandejaAcceso,
    private readonly ajustes: CompanyChatSettingsService,
  ) {}

  async sugerir(
    actor: ActorDeLaBandeja,
    conversationId: string,
    ahora: Date = new Date(),
  ): Promise<SugerenciasDeLaConversacion> {
    // 404 si es de otra empresa o de un canal que quien pide no atiende.
    const c = await this.acceso.buscar(actor, conversationId);
    const manager = this.dataSource.manager;
    const [ultimo]: UltimoMensaje[] = await manager.query(
      ULTIMO_MENSAJE_DE_LA_PERSONA,
      [c.conversationId],
    );
    if (!ultimo) return { basadoEnSeq: null, items: [] };
    const basadoEnSeq = Number(ultimo.seq);
    // Un saludo o un agradecimiento solo no pide nada: no se sugiere.
    const texto = textoParaSugerir(ultimo.body);
    if (texto === null) return { basadoEnSeq, items: [] };
    const parecidas: PlantillaParecida[] = await manager.query(
      PLANTILLAS_PARECIDAS,
      [
        texto,
        c.distributorId,
        c.channel,
        TOPE_DE_SUGERENCIAS,
        PARECIDO_MINIMO,
        PALABRAS_DE_CORTESIA,
      ],
    );
    if (parecidas.length === 0) return { basadoEnSeq, items: [] };
    const ajustes = await this.ajustes.leer(c.distributorId, manager);
    const valores = await valoresDePlantilla(manager, c, ajustes, ahora);
    const items = parecidas
      .map((p) => ({
        templateId: p.template_id,
        key: p.key,
        title: p.title,
        body: completarPlantilla(p.body, valores).slice(0, 2000),
      }))
      .filter((s) => s.body.length > 0);
    return { basadoEnSeq, items };
  }
}
