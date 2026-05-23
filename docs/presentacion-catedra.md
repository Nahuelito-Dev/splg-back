# Presentación — Delivery Gas
**Documento:** Guía de presentación para cátedra  
**Proyecto:** SPLG – Sistema de Pedidos y Logística de Garrafas de Gas  
**Autor:** Nahuel Wagner  
**Fecha:** Abril 2026  
**Versión:** 1.0

---

## Introducción

Este documento es la guía slide a slide para armar la presentación del proyecto en Canva. Cada sección describe el contenido exacto de un slide: título, texto, bullets y sugerencia visual. El objetivo es exponer el sistema Delivery Gas ante la cátedra mostrando el problema real que resuelve, la solución técnica propuesta, el stack tecnológico, los módulos inteligentes y el estado actual del proyecto.

La presentación está pensada para una exposición de **15 a 20 minutos** con soporte visual en Canva. Los slides 7, 8 y 8B son los más importantes para la cátedra ya que cubren los módulos inteligentes del sistema.

---

## Índice de Slides

| Nro | Slide | Contenido |
| --- | ----- | --------- |
| 1 | Portada | Título, subtítulo, autor, institución |
| 2 | El Problema | 6 problemas del distribuidor actual |
| 3 | La Solución | 4 componentes integrados del sistema |
| 4 | Flujo Completo del Pedido | Timeline de 7 pasos del pedido a la entrega |
| 5 | Stack Tecnológico | Mobile, Backend e Infraestructura |
| 6 | Módulos Funcionales | 10 módulos del sistema en grilla |
| 7 | Módulos Inteligentes 1/3 | M1 Despacho automático · M2 Reintento radio expandido |
| 8 | Módulos Inteligentes 2/3 | M3 Control de stock · M4 Alerta por demora |
| 8B | Módulos Inteligentes 3/3 | M5 Integración MercadoPago |
| 9 | Estado Actual y Planificación | Barras de progreso + timeline ABR–DIC 2026 |
| 10 | Cierre | Frase impacto + números clave + contacto |

---

> **Tip Canva:** Buscá el template "Pitch Deck Moderno" o "Tech Startup Presentation".
> Paleta sugerida: fondo oscuro (#1a1a2e o #0f0f1a) + acento naranja/amarillo (#f59e0b) + texto blanco.
> Fuente títulos: Bold sans-serif (Montserrat / Poppins). Fuente cuerpo: Regular.

---

## SLIDE 1 — PORTADA

**Título grande (centro):**
```
Delivery Gas
```

**Subtítulo:**
```
Sistema de Pedidos y Logística para
Distribuidores de Gas Envasado
```

**Abajo a la izquierda:**
```
Nahuel Wagner
Proyecto de Software (LSI) · Trabajo Final (ASC)
FCEQyN – UNaM · 2026
```

**Elemento visual sugerido:**
- Ícono de garrafa de gas o camión de reparto (buscar en Canva: "gas delivery icon")
- Fondo con mapa de ciudad con pins de ubicación (estilo dark map)

---

## SLIDE 1B — INTRODUCCIÓN

**Título:**
```
¿De qué se trata el proyecto?
```

**Párrafo central (texto grande, bien visible):**
```
Delivery Gas es un sistema de pedidos y logística diseñado
para distribuidores de gas envasado que hoy operan
con procesos 100% manuales: pedidos por teléfono,
coordinación verbal con choferes y stock contado a mano.
```

**3 bullets abajo:**
```
→  Un cliente real: distribuidor de gas envasado de la región

→  Un problema real: sin trazabilidad, sin autogestión, sin datos

→  Una solución completa: 4 componentes integrados que
   digitalizan y automatizan toda la operación
```

**Abajo a la derecha, dato de contexto:**
```
Trabajo Final — LSI · FCEQyN – UNaM
Metodología: Unified Process (UP)
Período: Abril – Diciembre 2026
```

**Elemento visual sugerido:**

- Fondo oscuro con una línea divisoria vertical: izquierda texto, derecha ícono grande de garrafa o camión
- Podés usar el mismo ícono de la portada para mantener coherencia visual

---

## SLIDE 1C — AGENDA

**Título:**
```
¿Qué vamos a ver hoy?
```

**Lista numerada (grande, con íconos):**
```
01  El problema que resuelve el sistema

02  La solución: 4 componentes integrados

03  Cómo funciona un pedido de punta a punta

04  Stack tecnológico elegido

05  Módulos funcionales del sistema

06  Módulos inteligentes y procesos automáticos

07  Estado actual y planificación
```

**Elemento visual sugerido:**

- Lista con números grandes en color de acento (naranja/amarillo)
- Fondo oscuro, texto blanco
- Sin imagen — el texto debe respirar, márgenes amplios

---

## SLIDE 2 — EL PROBLEMA

**Título:**
```
El problema
```

**6 bullets grandes (uno por ítem):**
```
📞  Pedidos solo por teléfono — sin autogestión del cliente

🗺️  Choferes sin hoja de ruta digital — coordinación verbal

📦  Stock contado a mano al final del día — errores frecuentes

📍  Sin seguimiento en tiempo real del reparto

🧾  Reclamos sin evidencia — sin foto, sin GPS, sin timestamp

📊  Cero visibilidad operativa para el administrador
```

**Elemento visual sugerido:**
- Dividir el slide en 2 columnas: izquierda texto, derecha foto de libreta/planilla o ícono de teléfono analógico

---

## SLIDE 3 — LA SOLUCIÓN

**Título:**
```
La solución: 4 componentes integrados
```

**4 bloques (usar tarjetas o íconos grandes):**

```
📱 App Cliente          🚗 App Chofer
───────────────         ───────────────
Pedidos desde           GPS en tiempo real
el celular              Recepción de órdenes
Tracking en mapa        Confirmación de entrega
Historial y reclamos    Hoja de ruta digital


🖥️ Panel Admin          ⚙️ Backend API
───────────────         ───────────────
Gestión de flota        NestJS + PostgreSQL
Precios y stock         Redis · WebSocket
Reportes de ventas      Firebase · Docker
Resolución de reclamos  Despacho automático
```

**Elemento visual sugerido:**
- 4 tarjetas con color de fondo diferente (azul, verde, violeta, naranja)
- Íconos de cada componente (phone, truck, dashboard, server)

---

## SLIDE 4 — FLUJO COMPLETO DEL PEDIDO

**Título:**
```
¿Cómo funciona? — Del pedido a la entrega
```

**Timeline horizontal (7 pasos):**
```
[1]          [2]          [3]          [4]          [5]          [6]          [7]
Cliente   →  Sistema   →  Chofer    →  Chofer    →  Cliente   →  Chofer    →  Admin
pide en      asigna       recibe       acepta        ve al        confirma     ve el
la app       al chofer    la orden     y sale        chofer       entrega      reporte
             más cercano  en 5 seg     en el mapa    en mapa      con GPS
             (auto 🤖)                 en tiempo     en tiempo    y foto
                                       real          real
```

**Elemento visual sugerido:**
- Línea de tiempo horizontal con círculos numerados y flechas
- Íconos pequeños debajo de cada paso

---

## SLIDE 5 — STACK TECNOLÓGICO

**Título:**
```
Tecnología elegida
```

**3 columnas:**

```
MOBILE (Flutter)          BACKEND (NestJS)          INFRAESTRUCTURA
────────────────          ────────────────          ────────────────
Android + iOS             TypeScript                Docker
Stacked MVVM              PostgreSQL                Firebase Auth
Google Maps               Redis (GEO)               Firebase FCM
Socket.IO Client          WebSocket                 Render (hosting)
Firebase Auth             JWT + Roles               Google Maps API
Dio (HTTP)                Resend (email)            Redis Cloud
```

**Abajo, una línea destacada:**
```
🏗️  Arquitectura modular lista para escalar a microservicios
```

**Elemento visual sugerido:**
- Logos reales de cada tecnología (disponibles en Canva o buscar PNG)
- Fondo dividido en 3 columnas con colores sutiles

---

## SLIDE 6 — MÓDULOS DEL SISTEMA

**Título:**
```
Módulos funcionales
```

**Tabla o grilla de tarjetas (2 columnas):**

```
🛒  Pedidos                    📍  Despacho y Asignación
    Creación, estados,              GEORADIUS, notificación
    cancelación, historial          WebSocket al chofer

📡  Seguimiento en Tiempo Real  📦  Catálogo y Stock
    GPS del chofer,                 Garrafas, precios,
    mapa para el cliente            reserva atómica, promociones

👤  Usuarios y Autenticación   📊  Reportes y Dashboard
    JWT, Firebase, 3 roles          Ventas, choferes, productos,
    Cliente · Chofer · Admin        gráficos últimos 7 días

📣  Reclamos                   🚗  Choferes y Vehículos
    Registro con foto,              Alta, validación,
    resolución por admin            activación, vehículo

💳  Pagos                      ⏰  Franjas Horarias
    Efectivo · MercadoPago          Capacidad diaria,
    Transferencia (+10%)            bloqueo automático
```

**Elemento visual sugerido:**
- Grilla de 5x2 tarjetas con ícono + título + descripción corta
- Color de acento en el ícono

---

## SLIDE 7 — MÓDULOS INTELIGENTES (1/2)

**Título:**
```
🤖 Procesos automáticos — El corazón del sistema
```

**Subtítulo:**
```
4 módulos que automatizan flujos críticos del negocio
```

**Módulo 1:**
```
M1 · Despacho Automático por Proximidad

Al crearse un pedido, el sistema busca en tiempo real el chofer
disponible más cercano usando Redis GEORADIUS.
Lo notifica por WebSocket en menos de 1 segundo.
Sin que el operador haga nada.

Configurable: radio inicial · tiempo máximo de espera del chofer
Tecnología: Redis GEO + Socket.IO
```

**Módulo 2:**
```
M2 · Reintento con Radio Expandido

Si ningún chofer acepta, el sistema reintenta automáticamente
ampliando el radio en pasos configurables.

5 km → 10 km → 15 km → Alerta al administrador

Configurable: pasos de expansión · intervalo · máx. reintentos · canal de alerta
```

**Elemento visual sugerido:**
- Dos tarjetas lado a lado: mapa con radio expandiéndose (M1→M2)
- Badge "🤖 Configurable" en cada tarjeta

---

## SLIDE 8 — MÓDULOS INTELIGENTES (2/2)

**Título:**
```
🤖 Procesos automáticos — continuación
```

**Módulo 3:**
```
M3 · Control de Stock con Alertas y Bloqueo Automático

Cuando el stock de un producto cae bajo el mínimo configurado:
→ Notifica al administrador con informe de productos afectados
→ Calcula estimación de reposición según demanda promedio
→ Opcionalmente bloquea nuevos pedidos de ese producto

El administrador decide si y cuánto reponer.

Configurable: stock mínimo por producto · acción (notificar/bloquear/ambos)
             · frecuencia de alertas · canal · ventana de demanda
```

**Módulo 4:**
```
M4 · Alerta Proactiva por Demora en Entrega

Monitorea pedidos "en camino". Si supera el tiempo configurado:
→ Notifica al cliente que hay una demora
→ Alerta al administrador con ubicación del chofer y datos del pedido
→ Si supera un segundo umbral: escalado urgente al administrador

El administrador decide cómo intervenir.

Configurable: umbral normal · umbral de escalado
             · canal al cliente · canal al admin · activar/desactivar
```

**Elemento visual sugerido:**
- Dos tarjetas side by side con íconos de stock (M3) y reloj de alerta (M4)

---

## SLIDE 8B — MÓDULOS INTELIGENTES (3/3)

**Título:**
```
🤖 Procesos automáticos — continuación
```

**Módulo 5:**
```
M5 · Integración de Pagos con MercadoPago

El cliente elige su método de pago al hacer el pedido.
Si elige pago digital, el sistema genera automáticamente
un enlace o QR a través de la API de MercadoPago.

Cuando el cliente paga, MercadoPago notifica al sistema:
→ Pago aprobado → pedido avanza al despacho automáticamente
→ Pago rechazado o expirado → pedido cancelado · stock restituido

Sin intervención del operador en ningún paso.

Métodos: Efectivo · Transferencia · Débito · Crédito · QR

Configurable: credenciales MP · métodos habilitados
             · recargo por transferencia (%) · expiración del link
```

**Elemento visual sugerido:**
- Diagrama de flujo: Cliente → QR/Link → MP → Webhook → Sistema → Despacho
- Logos de los métodos de pago (efectivo, tarjeta, QR)
- Badge "🔗 Integración API" en esquina superior

---

## SLIDE 9 — ESTADO ACTUAL Y PLANIFICACIÓN

**Título:**
```
Estado del proyecto
```

**4 filas de estado:**
```
⚙️  Backend API          ████████████████████  MVP completo ✅

📱  App Cliente          ████████████████░░░░  75% — checkout y tracking ✅

🚗  App Chofer           ████████████░░░░░░░░  60% — GPS ✅ · WebSocket 🔧

🖥️  Panel Admin          ████████░░░░░░░░░░░░  40% — navegación ✅ · páginas 🔧
```

**Planificación (timeline simple):**
```
ABR–JUN 2026          JUL–SEP 2026          OCT–NOV 2026          DIC 2026
────────────          ────────────          ────────────          ────────
Documentación         Desarrollo            Integración           Pruebas
+ MVP ✅              Apps + Panel          End-to-End            + Deploy
```

**Elemento visual sugerido:**
- Barras de progreso de colores (verde = completo, amarillo = en progreso)
- Timeline con línea horizontal y puntos

---

## SLIDE 10 — CIERRE

**Título grande:**
```
Delivery Gas
```

**Frase central:**
```
De la llamada telefónica al tracking en tiempo real.
```

**3 columnas con números impacto:**
```
4               45              3
────────        ────────        ────────
componentes     casos de        módulos
integrados      uso             inteligentes
```

**Abajo:**
```
Un sistema real · Un cliente real · Una solución completa
```

**Contacto / datos:**
```
Nahuel Wagner
FCEQyN – UNaM · 2026
Metodología: Unified Process (UP)
```

**Elemento visual sugerido:**
- Fondo con gradiente oscuro
- Los 3 números grandes en color de acento (naranja/amarillo)
- Mismo ícono de la portada para cerrar el círculo visual

---

## Notas generales para Canva

- **Duración estimada:** 15–20 minutos de presentación
- **Animaciones:** entrada por slide (Fade o Rise) — no usar animaciones por elemento, se ve amateur
- **Tipografía:** Montserrat Bold para títulos, Montserrat Regular para cuerpo
- **No pongas más de 6 líneas de texto por slide** — si sobra, cortá
- **Slides 7 y 8** son las más importantes para la cátedra — dedicarles más tiempo en la presentación
