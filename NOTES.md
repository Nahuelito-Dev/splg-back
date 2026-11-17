## v2.1.0 - 2026-11-17

### Funcionalidades

- **chat:** ✨ métricas del chat y del asistente para la empresa y la plataforma (B4) (bde56c0)
- **chat:** ✨ adjuntos en el chat con escaneo antivirus (CH7) (99a2fd5)

### Correcciones

- **chat:** 🐛 quien supervisa puede leer las respuestas guardadas (7ad9292)
- **deploy:** 🐛 la API no espera a que el antivirus esté sano para arrancar (0adb12a)
- **route-batch:** 🐛 leer bien los UPDATE con RETURNING en el seguimiento de las hojas en curso (86d881e)

### Mantenimiento

- 👷 más tiempo para el deploy (el gate en GitHub tarda ~20 min) (15c13f3)
- 👷 avisos de Telegram con versión, cambios, paso que falló y duración (e70730b)
- 👷 release nocturno automático de develop a main (1679db0)

