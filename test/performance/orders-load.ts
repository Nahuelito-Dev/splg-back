/**
 * Performance test del endpoint crítico POST /orders.
 *
 * Usa autocannon para generar carga sostenida sobre el backend
 * y medir latencia (p50, p95, p99), throughput y tasa de error.
 *
 * Uso:
 *   1. Levantar el backend: npm run start:dev
 *   2. Hacer seed manual de un Customer + GasCylinder + Address y
 *      poner los IDs en las env vars del payload abajo
 *   3. Correr: npm run test:perf:orders
 *
 * Configuración por defecto:
 *   - 50 conexiones concurrentes
 *   - Duración: 30 segundos
 *   - Pipelining: 1 (sin pipelining HTTP)
 *
 * Targets razonables para el endpoint (según el doc de requisitos NFR-02):
 *   - p95 < 5000ms
 *   - Throughput > 20 req/s en máquina dev
 *   - Tasa de error < 1%
 */
import autocannon from 'autocannon';

const URL = process.env.PERF_TARGET_URL ?? 'http://localhost:3000';
const CUSTOMER_ID =
  process.env.PERF_CUSTOMER_ID ?? '00000000-0000-0000-0000-000000000001';
const ADDRESS_ID =
  process.env.PERF_ADDRESS_ID ?? '00000000-0000-0000-0000-000000000002';
const CYLINDER_ID =
  process.env.PERF_CYLINDER_ID ?? '00000000-0000-0000-0000-000000000003';

const orderPayload = JSON.stringify({
  customerId: CUSTOMER_ID,
  addressId: ADDRESS_ID,
  paymentMethod: 'CASH',
  items: [{ gasCylinderId: CYLINDER_ID, quantity: 1 }],
});

async function run() {
  console.log(`🎯 Apuntando a ${URL}/orders`);
  console.log(`📦 Payload:`, JSON.parse(orderPayload));
  console.log(`⏱️  Duración: 30s, Conexiones: 50`);
  console.log('');

  const result = await autocannon({
    url: `${URL}/orders`,
    connections: 50,
    duration: 30,
    pipelining: 1,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: orderPayload,
  });

  console.log('');
  console.log('📊 RESULTADOS');
  console.log('───────────────────────────────────────────');
  console.log(`Total requests:    ${result.requests.total}`);
  console.log(
    `Throughput:        ${(result.requests.average ?? 0).toFixed(2)} req/s`,
  );
  console.log(`Errores:           ${result.errors}`);
  console.log(`Timeouts:          ${result.timeouts}`);
  console.log(`Non-2xx:           ${result.non2xx}`);
  console.log('');
  const lat = result.latency;
  console.log('Latencia (ms):');
  console.log(`  p50  → ${lat.p50}`);
  console.log(`  p90  → ${lat.p90}`);
  console.log(`  p97  → ${lat.p97_5 ?? 'N/A'}`);
  console.log(`  p99  → ${lat.p99}`);
  console.log(`  avg  → ${lat.average.toFixed(2)}`);
  console.log(`  max  → ${lat.max}`);
  console.log('───────────────────────────────────────────');

  // Validación contra targets NFR-02
  const targets = {
    p95Max: 5000, // ms
    minThroughput: 20, // req/s
    maxErrorRate: 0.01,
  };
  const errorRate =
    (result.errors + result.timeouts + result.non2xx) / result.requests.total;
  const p95 = result.latency.p97_5 ?? result.latency.p99;

  const issues: string[] = [];
  if (p95 > targets.p95Max)
    issues.push(`❌ p95 ${p95}ms > target ${targets.p95Max}ms`);
  if ((result.requests.average ?? 0) < targets.minThroughput) {
    issues.push(
      `❌ Throughput ${result.requests.average} req/s < target ${targets.minThroughput}`,
    );
  }
  if (errorRate > targets.maxErrorRate) {
    issues.push(
      `❌ Error rate ${(errorRate * 100).toFixed(2)}% > target ${(targets.maxErrorRate * 100).toFixed(2)}%`,
    );
  }

  if (issues.length === 0) {
    console.log('');
    console.log('✅ Todos los targets NFR-02 cumplidos');
  } else {
    console.log('');
    console.log('⚠️  Targets NFR-02 NO cumplidos:');
    issues.forEach((i) => console.log(`   ${i}`));
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('Performance test falló:', err);
  process.exit(1);
});
