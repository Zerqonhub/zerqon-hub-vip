# ZERQON HUB VIP

Portal full-stack en español para Zerqon Hub: interfaz premium, Script Center, Discord OAuth2, asignación y comprobación del rol VIP, cierre de sesión con intento de retirada del rol, evento de salida del servidor y diagnóstico del sistema.

> **Seguridad:** nunca pegues secretos reales en el código. El secreto OAuth2 y el token de bot que se compartieron en el chat deben regenerarse antes de desplegar. Este proyecto no contiene esos valores.

## Requisitos

- Node.js 20.11+ (recomendado Node 22/24).
- Una base SQLite local en `data/` (se crea automáticamente).
- Una aplicación en Discord Developer Portal y un bot instalado en el servidor.
- Permiso `Manage Roles` y la jerarquía correcta del rol del bot.

## Ejecutar localmente

```bash
cp .env.example .env
npm install
npm run check
npm test
npm start
```

Abrí `http://localhost:3000`. Para probar Discord en local, agregá exactamente esta URI a Discord Developer Portal → OAuth2 → Redirects:

`http://localhost:3000/api/auth/discord/callback`

Usá únicamente credenciales nuevas y privadas en `.env`. No subas `.env` a GitHub.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `PUBLIC_APP_URL` | Origen público real asignado por el hosting, sin ruta final. |
| `DISCORD_REDIRECT_URI` | Opcional. Si se usa, tiene que ser exactamente `PUBLIC_APP_URL + /api/auth/discord/callback`. |
| `DISCORD_CLIENT_ID` | ID público de la aplicación Discord. |
| `DISCORD_CLIENT_SECRET` | Secreto OAuth2 privado del backend. |
| `DISCORD_BOT_TOKEN` | Token privado del bot; no es el client secret. |
| `DISCORD_GUILD_ID` | ID del servidor de Discord. |
| `DISCORD_VIP_ROLE_ID` | ID del rol VIP configurado. El proyecto espera además que el nombre del rol coincida con `DISCORD_VIP_ROLE_NAME`. |
| `DISCORD_VIP_ROLE_NAME` | Nombre esperado: `zerqonviphub`. |
| `DISCORD_INVITE_URL` | Enlace de invitación del servidor. |
| `SESSION_SECRET` | Secreto aleatorio de al menos 32 caracteres. En producción es obligatorio. |
| `ENABLE_DISCORD_GATEWAY` | `true` por defecto. Permite invalidar sesiones cuando el bot recibe `GUILD_MEMBER_REMOVE`. |
| `DATABASE_PATH` | Ruta de SQLite; por defecto `./data/zerqon.sqlite`. |
| `SUPPORT_URL` | Opcional: URL oficial de soporte. |

El `.env.example` trae los valores no secretos de configuración que proporcionaste (IDs y enlace), pero **no** el client secret ni el bot token.

## Configuración de Discord

1. En Discord Developer Portal → tu aplicación → OAuth2 → Redirects, registra la URI exacta que calcula la web.
2. Para local: `http://localhost:3000/api/auth/discord/callback`.
3. Para producción, configura `PUBLIC_APP_URL` con el dominio final del hosting y registra `https://TU-DOMINIO-REAL/api/auth/discord/callback`. No uses ese texto de ejemplo literalmente.
4. Regenerá el client secret OAuth2 y el token del bot que se expusieron. Guarda los valores nuevos solo en el gestor de secretos del hosting.
5. Invitá el bot al servidor configurado.
6. Dale `Manage Roles` y mové el rol más alto del bot por encima de `zerqonviphub`.
7. En Discord Developer Portal → Bot → Privileged Gateway Intents, habilitá `Server Members Intent` (intent `GUILD_MEMBERS`) si querés revocar sesiones cuando alguien abandone el servidor.
8. Confirma que el ID de rol configurado corresponde al rol cuyo nombre es `zerqonviphub`. La API `/api/status` realiza una comprobación en vivo cuando las credenciales están configuradas.

## Dos URL diferentes, un solo dominio

- **URL de la web:** `PUBLIC_APP_URL`, por ejemplo `https://tu-dominio-real.example`.
- **Redirect URI OAuth2:** el mismo dominio más `/api/auth/discord/callback`.

No hace falta una web distinta para el callback: es una ruta del backend en el mismo dominio. No puedo conocer el dominio final hasta que la plataforma lo publique.

## Comportamiento de roles

- OAuth2 identifica la cuenta real de Discord.
- El backend consulta si el usuario es miembro del servidor.
- Si es miembro y el bot está autorizado/configurado, asigna el rol y vuelve a leer los roles para confirmar.
- Si el usuario no es miembro, no se asigna el rol y la interfaz muestra el enlace del servidor y una acción de reintento.
- El botón «Cerrar sesión y quitar VIP» intenta retirar el rol, vuelve a comprobarlo, revoca la sesión web y crea un trabajo de reintento si Discord falla. Cuando expira una sesión verificada y no queda otra sesión activa para esa cuenta, el worker también encola el retiro del rol.
- El bot escucha `GUILD_MEMBER_REMOVE`; Discord ya elimina los roles al abandonar el servidor, por lo que el proyecto revoca las sesiones web y actualiza el estado, sin intentar borrar un rol de un miembro que ya no existe.
- El bot **no puede detectar con fiabilidad que alguien simplemente cerró la aplicación Discord**. Se detectan el logout de este portal y la salida del servidor.

**Política de acceso:** con la lógica actual, cualquier usuario que autorice Discord y sea miembro del servidor puede recibir el rol `zerqonviphub`. Si VIP debe ser exclusivo para compradores o usuarios de una lista autorizada, agregá esa validación antes de `assignVipRole()`.

## Endpoints principales

- `GET /api/health` — salud básica del proceso.
- `GET /api/status` — diagnóstico sanitizado de OAuth y bot/rol.
- `GET /api/source-status` — comprueba la URL pública de la fuente Lua desde el backend.
- `GET /api/auth/discord` — inicia OAuth2.
- `GET /api/auth/discord/callback` — callback OAuth2 canónico.
- `GET /api/session` — estado de sesión y token CSRF para la UI.
- `POST /api/verification/retry` — reintenta membresía/asignación para el usuario autenticado.
- `POST /api/logout` — intenta retirar VIP y termina la sesión.

## Despliegue en Railway u otro host Node

1. Sube el proyecto a un repositorio privado (sin `.env`, `node_modules` ni base de datos).
2. Crea un servicio Node que ejecute `npm start`.
3. Configura las variables anteriores en el gestor de secretos del host.
4. Genera/publica el dominio HTTPS y luego actualiza `PUBLIC_APP_URL` y Redirects en Discord con la URI exacta.
5. Para persistir SQLite, monta un volumen persistente en `/app/data` y configura `DATABASE_PATH=/app/data/zerqon.sqlite`. No confíes en el disco efímero del contenedor para sesiones permanentes.
6. Habilita el intent `GUILD_MEMBERS`, si el plan del bot y el portal lo permiten.
7. Ejecuta `npm test` y `npm run check`; prueba el OAuth real y una asignación real después de configurar las credenciales nuevas.

Este entorno de chat no puede publicar la aplicación en tu cuenta ni asignarle un dominio; el proyecto queda preparado para que lo despliegues en el hosting que elijas.

## Limitaciones honestas

- No se realizó una prueba real contra tu servidor de Discord porque no se deben usar las credenciales que compartiste y fueron marcadas para regenerar.
- El estado de la fuente Lua se comprueba al usar el endpoint; no se asume que GitHub esté disponible.
- El portal solo copia el `loadstring`; no ejecuta Luau en el navegador.
- La política de privacidad y los términos incluidos son plantillas técnicas, no asesoramiento legal.
