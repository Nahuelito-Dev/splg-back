import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Esquema completo de la base, generado desde las entidades contra una base
 * vacia. Es el punto de partida: una base nueva se crea corriendo las
 * migraciones y nada mas, sin synchronize.
 *
 * Reemplaza a AddHotIndexes, DistributorIdNotNull y OrderCustomerRestrictOnDelete,
 * que suponian las tablas ya creadas por synchronize; lo que hacian ya esta
 * incluido aca. Las extensiones no se borran en down(): otras bases del mismo
 * servidor pueden estar usandolas.
 */
export class InitialSchema1790281980739 implements MigrationInterface {
  name = 'InitialSchema1790281980739';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await queryRunner.query(
      `CREATE TYPE "public"."distributor_status_enum" AS ENUM('active', 'suspended')`,
    );
    await queryRunner.query(
      `CREATE TABLE "distributor" ("distributor_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(120) NOT NULL, "slug" character varying(60) NOT NULL, "legal_name" character varying(160), "tax_id" character varying(20), "email" character varying, "phone" character varying, "logo_url" character varying, "status" "public"."distributor_status_enum" NOT NULL DEFAULT 'active', "plan" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_02331b27890084627684d99ec5b" UNIQUE ("slug"), CONSTRAINT "PK_a4d4d9b8c62c00011a67eba1abb" PRIMARY KEY ("distributor_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_02331b27890084627684d99ec5" ON "distributor" ("slug") `,
    );
    await queryRunner.query(
      `CREATE TABLE "admin" ("admin_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid, "user_id" uuid NOT NULL, "role_id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_08603203f2c50664bda27b1ff89" PRIMARY KEY ("admin_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0fc586a3c26b9bb49e64e6ff1f" ON "admin" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "role" ("role_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now(), CONSTRAINT "PK_df46160e6aa79943b83c81e496e" PRIMARY KEY ("role_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer" ("customer_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "notification_token" text, "lat_lang" text, "validated" text, "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "REL_5d1f609371a285123294fddcf3" UNIQUE ("user_id"), CONSTRAINT "PK_cde3d123fc6077bcd75eb051226" PRIMARY KEY ("customer_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "delivery" ("delivery_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "user_id" uuid NOT NULL, "calification" double precision, "latLng" text, "actual_location" text, "cancelledCharge" real, "validated" boolean NOT NULL DEFAULT false, "isActive" boolean NOT NULL DEFAULT true, "notification_token" text, "isTraveling" text, "balance" double precision NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "REL_a3b8af1ce2f6e143d416d83080" UNIQUE ("user_id"), CONSTRAINT "PK_9f4d2062bce95d9b75e00d145ee" PRIMARY KEY ("delivery_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8b64ee4e6e615c2082862f9e09" ON "delivery" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a3b8af1ce2f6e143d416d83080" ON "delivery" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "car" ("car_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "user_id" uuid NOT NULL, "type_car" character varying(50), "car_capacity" integer, "car_patent" character varying(20), "car_brand" character varying(50), "car_model" character varying(50), "car_year" integer, "car_color" character varying(50), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_81fec581f526499deff9677050e" UNIQUE ("car_patent"), CONSTRAINT "PK_1755d5edaf7738f5780f57a445f" PRIMARY KEY ("car_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e823ac113ba2af8cbe72ddcbe8" ON "car" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "user_address" ("address_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "street" character varying(255) NOT NULL, "city" character varying(100) NOT NULL, "postalCode" character varying(20), "latitude" character varying(50), "longitude" character varying(50), "formattedAddress" text, "isDefault" boolean NOT NULL DEFAULT false, "additionalInstructions" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b3bdd98c49956021c44c23a48c4" PRIMARY KEY ("address_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "user" ("user_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "role_id" uuid, "firebase_uid" character varying, "full_name" character varying, "selfie" character varying, "email" character varying, "phone_number" character varying, "phone_verified" boolean NOT NULL DEFAULT false, "email_verified" boolean NOT NULL DEFAULT false, "blocked" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_e12875dfb3b1d92d7d7c5377e22" UNIQUE ("email"), CONSTRAINT "UQ_01eea41349b6c9275aec646eee0" UNIQUE ("phone_number"), CONSTRAINT "PK_758b8ce7c18b9d347461b30228d" PRIMARY KEY ("user_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "time_slot" ("time_slot_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "name" character varying(50) NOT NULL, "startTime" TIME NOT NULL, "endTime" TIME NOT NULL, "capacity" integer NOT NULL DEFAULT '50', "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9dbd485d0299b8adccf7f933acb" PRIMARY KEY ("time_slot_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e87ae54beaee42b885813deb8e" ON "time_slot" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "gas_cylinder" ("gas_cylinder_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "type" character varying(50) NOT NULL, "weight" numeric(10,2) NOT NULL, "price" numeric(10,2) NOT NULL, "stock" integer NOT NULL DEFAULT '0', "description" text, "isActive" boolean NOT NULL DEFAULT true, "promotions" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6768507f2214b15ab4653ef28c9" PRIMARY KEY ("gas_cylinder_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_990b829fdf06cb282d835a5d72" ON "gas_cylinder" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "order_item" ("order_item_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "gas_cylinder_id" uuid NOT NULL, "quantity" integer NOT NULL, "unitPrice" numeric(10,2) NOT NULL, "subtotal" numeric(10,2) NOT NULL, CONSTRAINT "PK_f91441b7e69922a51a0d2917107" PRIMARY KEY ("order_item_id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."order_status_enum" AS ENUM('reserved', 'pending', 'accepted', 'on_the_way', 'delivered', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."order_paymentmethod_enum" AS ENUM('cash', 'mercadopago', 'transfer')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."order_paymenttype_enum" AS ENUM('cash', 'online')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."order_paymentstatus_enum" AS ENUM('pending', 'paid', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "order" ("order_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "customer_id" uuid NOT NULL, "time_slot_id" uuid, "scheduled_date" date, "deposit_amount" numeric(10,2) NOT NULL DEFAULT '0', "deposit_paid" boolean NOT NULL DEFAULT false, "delivery_id" uuid, "address_id" uuid NOT NULL, "status" "public"."order_status_enum" NOT NULL DEFAULT 'pending', "paymentMethod" "public"."order_paymentmethod_enum" NOT NULL, "paymentType" "public"."order_paymenttype_enum" NOT NULL DEFAULT 'cash', "paymentStatus" "public"."order_paymentstatus_enum" NOT NULL DEFAULT 'pending', "totalAmount" numeric(10,2) NOT NULL, "notes" text, "deliveryInstructions" text, "deliveryLatitude" character varying(50), "deliveryLongitude" character varying(50), "acceptedAt" TIMESTAMP, "onTheWayAt" TIMESTAMP, "deliveredAt" TIMESTAMP, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "cancellationReason" text, "gatewayPaymentId" character varying(100), "deliveryCode" character varying(12), CONSTRAINT "PK_58998c5eaeaacdd004dec8b5d86" PRIMARY KEY ("order_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_df56039592a4bbbd3fa4a19f14" ON "order" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cd7812c96209c5bdd48a6b858b" ON "order" ("customer_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_775a36a19670c03781e60bbce9" ON "order" ("scheduled_date") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7a9573d6a1fb982772a9123320" ON "order" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f437a76442f23c89ad7652b2a4" ON "order" ("deliveredAt") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_3adf34152c77fdb4e8f7346c5f" ON "order" ("gatewayPaymentId") WHERE "gatewayPaymentId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_order_dist_status_delivered" ON "order" ("distributor_id", "status", "deliveredAt") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_order_status_delivery" ON "order" ("status", "delivery_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."rating_from_role_enum" AS ENUM('customer', 'delivery')`,
    );
    await queryRunner.query(
      `CREATE TABLE "rating" ("rating_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "from_user_id" uuid NOT NULL, "to_user_id" uuid NOT NULL, "from_role" "public"."rating_from_role_enum" NOT NULL, "stars" integer NOT NULL, "comment" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_rating_order_role" UNIQUE ("order_id", "from_role"), CONSTRAINT "PK_1ba02007f1315301d9553a6839a" PRIMARY KEY ("rating_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_beb6f44b22a7f1ed7cad984a2e" ON "rating" ("order_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b46b63fc1ddf2135e1ed37069a" ON "rating" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6f590ebbc097c4ed21d5d3e11e" ON "rating" ("to_user_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_gateway_enum" AS ENUM('mercadopago', 'cash')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_integration_enum" AS ENUM('checkout_pro', 'cash')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_status_enum" AS ENUM('pending', 'approved', 'rejected', 'cancelled', 'refunded')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment" ("payment_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "distributor_id" uuid, "gateway" "public"."payment_gateway_enum" NOT NULL, "integration" "public"."payment_integration_enum" NOT NULL, "method" character varying(50), "gateway_payment_id" character varying(100), "external_reference" character varying, "amount" numeric(10,2) NOT NULL, "currency" character varying(10) NOT NULL DEFAULT 'ARS', "status" "public"."payment_status_enum" NOT NULL DEFAULT 'pending', "payment_url" text, "is_deposit" boolean NOT NULL DEFAULT false, "metadata" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9fff60ac6ac1844ea4e0cfba67a" PRIMARY KEY ("payment_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f5221735ace059250daac9d980" ON "payment" ("order_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0cdad15fa39dd1ebace139096f" ON "payment" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_05b8eaefed5471a643ee578c74" ON "payment" ("gateway_payment_id") WHERE "gateway_payment_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."order_dispatch_offer_status_enum" AS ENUM('offered', 'accepted', 'rejected', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TABLE "order_dispatch_offer" ("offer_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "order_id" uuid NOT NULL, "driver_id" uuid NOT NULL, "status" "public"."order_dispatch_offer_status_enum" NOT NULL DEFAULT 'offered', "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "offeredAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0aff47b29f1a507ac9ed28618dd" PRIMARY KEY ("offer_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_830f3888d1424414675f1c184d" ON "order_dispatch_offer" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1231f4249963aa2efb93749a8e" ON "order_dispatch_offer" ("order_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_21b60d43f182e2b1e8a30ea0a5" ON "order_dispatch_offer" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9ff85bc9c62717502d1ad68216" ON "order_dispatch_offer" ("expiresAt") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_offer_status_expires" ON "order_dispatch_offer" ("status", "expiresAt") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_offer_order_status" ON "order_dispatch_offer" ("order_id", "status") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."incident_type_enum" AS ENUM('damaged', 'out_of_stock', 'no_show', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."incident_status_enum" AS ENUM('open', 'resolved')`,
    );
    await queryRunner.query(
      `CREATE TABLE "incident" ("incident_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "reported_by" uuid NOT NULL, "type" "public"."incident_type_enum" NOT NULL, "description" text NOT NULL, "photo_url" character varying, "status" "public"."incident_status_enum" NOT NULL DEFAULT 'open', "resolution_note" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "resolvedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_78e450f2684a57c80de36e5d411" PRIMARY KEY ("incident_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8a89ba6c226022354d0d8b4ada" ON "incident" ("order_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a2223c18baa97faf54118f95bd" ON "incident" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cylinder_state_enum" AS ENUM('in_depot', 'filled', 'dispatched', 'with_customer', 'empty_returned')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cylinder" ("cylinder_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "serial" character varying NOT NULL, "gas_cylinder_id" uuid, "state" "public"."cylinder_state_enum" NOT NULL DEFAULT 'in_depot', "current_customer_id" uuid, "current_order_id" uuid, "deposit" numeric(10,2) NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_9e39bbb32ed614ddd09ac126e37" UNIQUE ("distributor_id", "serial"), CONSTRAINT "PK_3b2102a9e7f6077898af87911f9" PRIMARY KEY ("cylinder_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9e8b3d9c0ecf2651f6e836aca4" ON "cylinder" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7a848929dbfa5535e93e9494e7" ON "cylinder" ("serial") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9e32d1c8fd5721ba71e98c5c93" ON "cylinder" ("state") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_903b537f13281f56613047bcdc" ON "cylinder" ("current_order_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cylinder_movement_from_state_enum" AS ENUM('in_depot', 'filled', 'dispatched', 'with_customer', 'empty_returned')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cylinder_movement_to_state_enum" AS ENUM('in_depot', 'filled', 'dispatched', 'with_customer', 'empty_returned')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cylinder_movement" ("movement_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "cylinder_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "from_state" "public"."cylinder_movement_from_state_enum", "to_state" "public"."cylinder_movement_to_state_enum" NOT NULL, "order_id" uuid, "actor_user_id" uuid, "note" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8a8e801aea031583dea87867f7a" PRIMARY KEY ("movement_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1c48ac355fa0315ba792b68045" ON "cylinder_movement" ("cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_968ad11170db2741bb5c0c47bb" ON "cylinder_movement" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "coverage_zone" ("coverage_zone_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "name" character varying(120) NOT NULL, "area" geometry(Polygon,4326) NOT NULL, "surcharge" numeric(10,2) NOT NULL DEFAULT '0', "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3f757c582bbdc9b4f5fd48b57d9" PRIMARY KEY ("coverage_zone_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_50ad99ebfb6554428f39160228" ON "coverage_zone" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_01a53f7455396839c245037c9f" ON "coverage_zone" USING GiST ("area") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."claims_status_enum" AS ENUM('pending', 'in_process', 'resolved', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TABLE "claims" ("claim_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "order_id" uuid NOT NULL, "customer_id" uuid NOT NULL, "reason" character varying NOT NULL, "description" text NOT NULL, "photoUrl" character varying, "status" "public"."claims_status_enum" NOT NULL DEFAULT 'pending', "resolutionNote" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e8c55807de8dde683de34399da3" PRIMARY KEY ("claim_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_870bf1e0dc6005837ff0643b5f" ON "claims" ("distributor_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" ADD CONSTRAINT "FK_0fc586a3c26b9bb49e64e6ff1f4" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" ADD CONSTRAINT "FK_a28028ba709cd7e5053a86857b4" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" ADD CONSTRAINT "FK_fd32421f2d93414e46a8fcfd86b" FOREIGN KEY ("role_id") REFERENCES "role"("role_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ADD CONSTRAINT "FK_5d1f609371a285123294fddcf3a" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery" ADD CONSTRAINT "FK_8b64ee4e6e615c2082862f9e09a" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery" ADD CONSTRAINT "FK_a3b8af1ce2f6e143d416d83080a" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD CONSTRAINT "FK_e823ac113ba2af8cbe72ddcbe84" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD CONSTRAINT "FK_c8d34198d86de9e96aae03b8990" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" ADD CONSTRAINT "FK_29d6df815a78e4c8291d3cf5e53" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD CONSTRAINT "FK_fb2e442d14add3cefbdf33c4561" FOREIGN KEY ("role_id") REFERENCES "role"("role_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "time_slot" ADD CONSTRAINT "FK_e87ae54beaee42b885813deb8e9" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" ADD CONSTRAINT "FK_990b829fdf06cb282d835a5d729" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" ADD CONSTRAINT "FK_e9674a6053adbaa1057848cddfa" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" ADD CONSTRAINT "FK_8ea8fa760695e81b4624345fc72" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "FK_df56039592a4bbbd3fa4a19f141" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "FK_cd7812c96209c5bdd48a6b858b0" FOREIGN KEY ("customer_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "FK_962eec87d3d029c51525f259fba" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "FK_a4743951fe3b697adf8ce898cf4" FOREIGN KEY ("time_slot_id") REFERENCES "time_slot"("time_slot_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "FK_f07603e96b068aae820d4590270" FOREIGN KEY ("address_id") REFERENCES "user_address"("address_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" ADD CONSTRAINT "FK_beb6f44b22a7f1ed7cad984a2e1" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" ADD CONSTRAINT "FK_b46b63fc1ddf2135e1ed37069a9" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" ADD CONSTRAINT "FK_d613d840f71f5ab083af2ceb1cf" FOREIGN KEY ("from_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ADD CONSTRAINT "FK_1231f4249963aa2efb93749a8ee" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" ADD CONSTRAINT "FK_8a89ba6c226022354d0d8b4ada0" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" ADD CONSTRAINT "FK_a2223c18baa97faf54118f95bd2" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" ADD CONSTRAINT "FK_9e8b3d9c0ecf2651f6e836aca46" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ADD CONSTRAINT "FK_50ad99ebfb6554428f39160228a" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ADD CONSTRAINT "FK_870bf1e0dc6005837ff0643b5fc" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ADD CONSTRAINT "FK_573f53b0981b244cd25223e3ce7" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ADD CONSTRAINT "FK_af79ab775a51930eb21951a3c95" FOREIGN KEY ("customer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "claims" DROP CONSTRAINT "FK_af79ab775a51930eb21951a3c95"`,
    );
    await queryRunner.query(
      `ALTER TABLE "claims" DROP CONSTRAINT "FK_573f53b0981b244cd25223e3ce7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "claims" DROP CONSTRAINT "FK_870bf1e0dc6005837ff0643b5fc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" DROP CONSTRAINT "FK_50ad99ebfb6554428f39160228a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" DROP CONSTRAINT "FK_9e8b3d9c0ecf2651f6e836aca46"`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" DROP CONSTRAINT "FK_a2223c18baa97faf54118f95bd2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" DROP CONSTRAINT "FK_8a89ba6c226022354d0d8b4ada0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" DROP CONSTRAINT "FK_1231f4249963aa2efb93749a8ee"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" DROP CONSTRAINT "FK_d613d840f71f5ab083af2ceb1cf"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" DROP CONSTRAINT "FK_b46b63fc1ddf2135e1ed37069a9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" DROP CONSTRAINT "FK_beb6f44b22a7f1ed7cad984a2e1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "FK_f07603e96b068aae820d4590270"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "FK_a4743951fe3b697adf8ce898cf4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "FK_962eec87d3d029c51525f259fba"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "FK_cd7812c96209c5bdd48a6b858b0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "FK_df56039592a4bbbd3fa4a19f141"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" DROP CONSTRAINT "FK_8ea8fa760695e81b4624345fc72"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" DROP CONSTRAINT "FK_e9674a6053adbaa1057848cddfa"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" DROP CONSTRAINT "FK_990b829fdf06cb282d835a5d729"`,
    );
    await queryRunner.query(
      `ALTER TABLE "time_slot" DROP CONSTRAINT "FK_e87ae54beaee42b885813deb8e9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP CONSTRAINT "FK_fb2e442d14add3cefbdf33c4561"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" DROP CONSTRAINT "FK_29d6df815a78e4c8291d3cf5e53"`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" DROP CONSTRAINT "FK_c8d34198d86de9e96aae03b8990"`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" DROP CONSTRAINT "FK_e823ac113ba2af8cbe72ddcbe84"`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery" DROP CONSTRAINT "FK_a3b8af1ce2f6e143d416d83080a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery" DROP CONSTRAINT "FK_8b64ee4e6e615c2082862f9e09a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" DROP CONSTRAINT "FK_5d1f609371a285123294fddcf3a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" DROP CONSTRAINT "FK_fd32421f2d93414e46a8fcfd86b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" DROP CONSTRAINT "FK_a28028ba709cd7e5053a86857b4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" DROP CONSTRAINT "FK_0fc586a3c26b9bb49e64e6ff1f4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_870bf1e0dc6005837ff0643b5f"`,
    );
    await queryRunner.query(`DROP TABLE "claims"`);
    await queryRunner.query(`DROP TYPE "public"."claims_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_01a53f7455396839c245037c9f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_50ad99ebfb6554428f39160228"`,
    );
    await queryRunner.query(`DROP TABLE "coverage_zone"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_968ad11170db2741bb5c0c47bb"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1c48ac355fa0315ba792b68045"`,
    );
    await queryRunner.query(`DROP TABLE "cylinder_movement"`);
    await queryRunner.query(
      `DROP TYPE "public"."cylinder_movement_to_state_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."cylinder_movement_from_state_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_903b537f13281f56613047bcdc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9e32d1c8fd5721ba71e98c5c93"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7a848929dbfa5535e93e9494e7"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9e8b3d9c0ecf2651f6e836aca4"`,
    );
    await queryRunner.query(`DROP TABLE "cylinder"`);
    await queryRunner.query(`DROP TYPE "public"."cylinder_state_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a2223c18baa97faf54118f95bd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8a89ba6c226022354d0d8b4ada"`,
    );
    await queryRunner.query(`DROP TABLE "incident"`);
    await queryRunner.query(`DROP TYPE "public"."incident_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."incident_type_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_offer_order_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_offer_status_expires"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9ff85bc9c62717502d1ad68216"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_21b60d43f182e2b1e8a30ea0a5"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1231f4249963aa2efb93749a8e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_830f3888d1424414675f1c184d"`,
    );
    await queryRunner.query(`DROP TABLE "order_dispatch_offer"`);
    await queryRunner.query(
      `DROP TYPE "public"."order_dispatch_offer_status_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_05b8eaefed5471a643ee578c74"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0cdad15fa39dd1ebace139096f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f5221735ace059250daac9d980"`,
    );
    await queryRunner.query(`DROP TABLE "payment"`);
    await queryRunner.query(`DROP TYPE "public"."payment_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."payment_integration_enum"`);
    await queryRunner.query(`DROP TYPE "public"."payment_gateway_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6f590ebbc097c4ed21d5d3e11e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b46b63fc1ddf2135e1ed37069a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_beb6f44b22a7f1ed7cad984a2e"`,
    );
    await queryRunner.query(`DROP TABLE "rating"`);
    await queryRunner.query(`DROP TYPE "public"."rating_from_role_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_order_status_delivery"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_order_dist_status_delivered"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3adf34152c77fdb4e8f7346c5f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f437a76442f23c89ad7652b2a4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7a9573d6a1fb982772a9123320"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_775a36a19670c03781e60bbce9"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cd7812c96209c5bdd48a6b858b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_df56039592a4bbbd3fa4a19f14"`,
    );
    await queryRunner.query(`DROP TABLE "order"`);
    await queryRunner.query(`DROP TYPE "public"."order_paymentstatus_enum"`);
    await queryRunner.query(`DROP TYPE "public"."order_paymenttype_enum"`);
    await queryRunner.query(`DROP TYPE "public"."order_paymentmethod_enum"`);
    await queryRunner.query(`DROP TYPE "public"."order_status_enum"`);
    await queryRunner.query(`DROP TABLE "order_item"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_990b829fdf06cb282d835a5d72"`,
    );
    await queryRunner.query(`DROP TABLE "gas_cylinder"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e87ae54beaee42b885813deb8e"`,
    );
    await queryRunner.query(`DROP TABLE "time_slot"`);
    await queryRunner.query(`DROP TABLE "user"`);
    await queryRunner.query(`DROP TABLE "user_address"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e823ac113ba2af8cbe72ddcbe8"`,
    );
    await queryRunner.query(`DROP TABLE "car"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a3b8af1ce2f6e143d416d83080"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8b64ee4e6e615c2082862f9e09"`,
    );
    await queryRunner.query(`DROP TABLE "delivery"`);
    await queryRunner.query(`DROP TABLE "customer"`);
    await queryRunner.query(`DROP TABLE "role"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0fc586a3c26b9bb49e64e6ff1f"`,
    );
    await queryRunner.query(`DROP TABLE "admin"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_02331b27890084627684d99ec5"`,
    );
    await queryRunner.query(`DROP TABLE "distributor"`);
    await queryRunner.query(`DROP TYPE "public"."distributor_status_enum"`);
  }
}
