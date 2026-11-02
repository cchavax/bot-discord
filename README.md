# Aura Bot

Bot de Discord en TypeScript + discord.js v14. Se construye **sistema por sistema**; cada uno es una *feature* en `src/features/`.

**Multi-servidor:** se puede agregar a cualquier servidor. Cada uno tiene su propia configuración, sus stats y su "marca" (`/ajustes marca`), y `/ajustes estado` dice qué falta configurar y qué permisos le faltan al bot.

## Estado

| # | Sistema | Estado |
|---|---|---|
| 0 | Ajustes, multi-servidor, rangos/categorías/hitos configurables | ✅ listo (testeado; falta probarlo en vivo) |
| 1 | Tags de apodo (`[Rol] nombre`) | ✅ probado en vivo |
| 2 | **Tickets** (derivar, encuesta, stats, postulaciones) | ✅ probado en vivo |
| 3 | Bienvenidas y verificación (un botón) | ✅ probado en vivo |
| 3b | Contador de miembros (canal de voz) | ✅ probado en vivo |
| 4 | Conteo de invitaciones y recompensas por hitos | ⚠️ la detección de invitaciones todavía no se confirmó en vivo |
| 5 | Sugerencias, encuestas, sorteos (con cancelar) | ✅ probado en vivo (cancelar: falta probarlo) |
| 6 | Registro del servidor (`/logs`) | ✅ listo (falta probarlo en vivo) |
| 7 | Integración con Minecraft | ✅ puente `/mcbridge` (el plugin vive aparte, en `../minecraft-plugin`) |
| 8 | Moderación con historial, automod, anuncios programados | ✅ listo (testeado; falta probarlo en vivo) |
| 9 | Base de datos (PostgreSQL) y hosting | ⏳ al final, cuando todo funcione |

## Puesta en marcha

### 1. Crear la aplicación en Discord
1. Entrá a https://discord.com/developers/applications → **New Application**.
2. En **Bot**: **Reset Token** y copiá el token. Es una contraseña: **no lo pegues en chats ni lo subas a git**.
3. En **Bot → Privileged Gateway Intents** activá **Server Members Intent** y **Message Content Intent** (los dos son obligatorios; sin ellos el bot no inicia).
4. En **OAuth2 → URL Generator**: scopes `bot` y `applications.commands`; permisos:
   **Manage Nicknames**, **Manage Channels**, **Manage Roles**, **Manage Server** (para leer las invitaciones), **View Audit Log** (para que `/logs` diga quién baneó/expulsó), **Moderate Members**, **Kick Members**, **Ban Members**, **Manage Messages** (moderación y automod), **View Channels**, **Send Messages**, **Embed Links**, **Attach Files**, **Read Message History**, **Add Reactions**.
   Esa misma URL sirve para agregar el bot a **cualquier** servidor. Al entrar, manda una guía de primeros pasos.

### 2. Rol del bot
En Ajustes del servidor → Roles, subí el rol del bot **por encima** de todos los roles de staff cuyo apodo tenga que cambiar. Si queda por debajo, Discord rechaza el cambio. Con el rol de **Owner** no hay nada que hacer: Discord no permite que ningún bot cambie el apodo del dueño del servidor.

### 3. Configurar y correr
```bash
npm install
cp .env.example .env     # completá DISCORD_TOKEN
npm start                # o: npm run dev (recarga al guardar)
```
`GUILD_ID` ya **no es obligatorio**: los comandos se registran solos en cada servidor donde esté el bot (y en los nuevos apenas lo agregan). Solo sirve para pasar la configuración vieja (de cuando el bot era de un solo servidor) a ese servidor; la migración es automática la primera vez que arranca.

Al prender, la consola muestra cada servidor con el estado de cada sistema, y lo mismo se publica en el canal de `/logs` (o, si no hay, en el de registros de tickets).

## Ajustes (en cada servidor)

- `/ajustes estado`: revisa todos los sistemas y dice qué falta configurar, con qué comando, y si al bot le falta algún permiso o tiene el rol muy abajo.
- `/ajustes marca [nombre] [servidor] [color] [restablecer]`: texto del pie de los mensajes (por defecto, el nombre del bot), cómo se nombra al servidor en los textos (por defecto, su nombre en Discord) y color del costado. Sin opciones, muestra cómo está.

## Rangos de staff (en cada servidor)

- `/staff rangos`: muestra los rangos de mayor a menor, agrupados por nivel.
- `/staff rango agregar rol:<rol> tag:<texto> [abreviatura] [grupo]`: suma un rol como rango (o lo edita). El **orden lo da la posición del rol** en Ajustes → Roles. Los rangos con el mismo **grupo** cuentan como el mismo nivel al derivar un ticket (ej. Mod Sr, Mod y Mod Jr en el grupo "Moderador").
- `/staff rango quitar rol:<rol>` y `/staff restablecer` (vuelve a la plantilla).
- Si un servidor no configura nada, se usa la **plantilla por nombre** de `src/ranks.ts` (Owner, Head Staff, Admin Sr…). Al agregar o quitar el primer rango, se copia la plantilla como punto de partida, así no se pierde nada.
- Los usan los tags de apodo, quién atiende cada categoría de ticket y a quién se deriva.

## Moderación

- `/warn`, `/mute usuario duracion motivo` (ej. `10m`, `1h30m`, `2d`, máx. 28d), `/unmute`, `/kick`, `/ban [borrar_mensajes]`, `/unban usuario_id`.
- `/historial usuario`: todas sus sanciones con número de caso. `/sancion quitar caso`: la anula (queda tachada y deja de contar).
- Cada sanción se avisa por DM a la persona (antes de expulsar/banear) y queda registrada en `/moderacion config canal` (o, si no hay, en el de `/logs`).
- **Escala automática**: al llegar a X advertencias, el bot aplica una sanción solo. Por defecto 3 → 1 h de mute y 5 → 1 día. Se cambia con `/moderacion escala agregar|quitar|ver`.
- Quién puede usar cada comando lo deciden los permisos de Discord (Moderar miembros, Expulsar, Banear); cada servidor lo ajusta en Ajustes → Integraciones. Nadie puede sancionar a alguien con un rol igual o más alto que el suyo.

## Automod

- `/automod ver` y un subcomando por filtro, cada uno con `activar:true/false`: `spam [mensajes] [segundos]`, `links [permitidos]`, `invitaciones`, `menciones [maximo]`, `raid [entradas] [segundos]`.
- Al saltar un filtro: borra el mensaje, avisa en el canal (el aviso se borra a los 8 s) y le da una advertencia que cuenta para la escala de moderación.
- La alerta de raid avisa en el canal de `/logs` si entran muchas cuentas de golpe.
- Nunca actúa sobre bots, admins, quien puede gestionar mensajes ni los rangos de staff. `/automod excluir canal|rol` suma excepciones.

## Anuncios

- `/anuncio crear canal [mencionar] [cuando] [repetir]` abre un formulario (título, texto, imagen, color) y publica un embed con la marca del servidor.
- `cuando`: vacío = ahora; `18:30`, `en 2h`, `30/10 20:00`, `30/10/2026 20:00`. `repetir`: todos los días o todas las semanas.
- `/anuncio lista`, `/anuncio cancelar id`, `/anuncio zona` (zona horaria; por defecto Argentina). Los programados sobreviven reinicios.

## Registro del servidor

- `/logs config canal:<canal>` / `/logs desactivar`. Requiere **Gestionar servidor**.
- Anota entradas y salidas (y expulsiones), baneos y desbaneos, mensajes editados y borrados, cambios de apodo y de roles, boosts, canales creados/borrados y movimientos en canales de voz. Con **Ver registro de auditoría**, también quién baneó/expulsó.

## Sistema 1: tags de apodo

- `/tags ver miembro:@alguien`: muestra el rango detectado y el apodo que le correspondería, sin cambiar nada.
- `/tags sincronizar`: aplica el tag a todo el staff de una vez. Es de uso manual, para etiquetar al staff que ya tenía rol antes de que existiera el bot.
- Ambos piden el permiso **Gestionar roles**.

**Cómo funciona**
- Los rangos viven en `src/ranks.ts`, **resueltos por nombre de rol**: el rol en Discord tiene que llamarse igual (Head Staff, Moderador Sr, etc.). Se ignoran los adornos al principio y al final del nombre, así que `・ Moderador Sr` y `🛡️ Moderador Sr` funcionan igual que `Moderador Sr`.
- Si alguien tiene varios rangos, gana el más alto de la lista.
- El apodo se arma como `[Tag] nombre`, por ejemplo `[Head Staff] .cchava`. Si pasa de 32 caracteres usa la abreviatura (`Mod Sr`, `HS`) y, si aun así no entra, recorta el nombre.
- **El tag cambia solo cuando cambia el rango principal** de la persona: se le asigna un rango, la suben o bajan, o se lo sacan (ahí se le quita el tag).
- No hace nada si la persona cambia su apodo, ni si le agregan roles que no son de rango (Eventos, Builders...), ni un rango más bajo que el que ya tiene.
- Los corchetes ajenos (ej. `[ES] Juan`) no se tocan.

## Sistema 2: tickets

### Configuración (una sola vez, requiere permiso **Gestionar servidor**)
1. Creá en Discord una **categoría** para los tickets (ej. `🎫 TICKETS`) y un canal de staff para las transcripciones (ej. `#tickets-registro`).
2. `/ticket config categoria:<categoría> registros:<canal>`
3. `/ticket panel` (o `/ticket panel canal:#ayuda`) publica el panel con los botones.

### Cómo funciona
- El jugador toca un botón de categoría y el bot crea un **canal privado** dentro de la categoría de tickets: solo lo ven esa persona y el staff que corresponde.
- **Un solo ticket abierto por persona.**
- Cada categoría la atienden los **roles desde un rango mínimo hacia arriba** (ej. Soporte desde Helper Jr; Apelaciones desde Moderador Sr). Se configura en `src/features/tickets/categories.ts`.
- El staff puede tocar **Reclamar** para marcar quién lo atiende. Lo puede **cerrar** quien lo abrió o el staff.
- **Derivar**: quien tiene el ticket reclamado puede derivarlo (solo él). El ticket vuelve a quedar sin reclamar, se avisa en el canal quién lo derivó, y se taggea a las tres variantes (Sr/base/Jr) del rango inmediatamente superior al suyo (ej. de un Trial, a toda la fila de Helper). Esa jerarquía está definida en `STAFF_TIERS` (`src/ranks.ts`).
- Al cerrar: el bot guarda una **transcripción** (.txt, hasta 1000 mensajes) en el canal de registros y se la manda por DM a quien abrió el ticket (si los tiene habilitados), y borra el canal a los 5 segundos.
- **Encuesta de satisfacción**: si alguien llegó a reclamar el ticket, el DM de cierre incluye tres botones (😃 Me gustó / 😐 Indiferente / 😞 No me gustó) para quien lo abrió. La respuesta queda guardada contra quien lo atendió, y se avisa en el canal de registros con el tipo de feedback y las stats actuales de ese staff.
- El estado del ticket (quién lo abrió, categoría, quién lo reclamó) se guarda en `data/config.json` (antes iba en el tema del canal, pero Discord solo deja cambiarlo 2 veces cada 10 minutos y reclamar/derivar seguido se colgaba).
- Los administradores del servidor siempre cuentan como staff, aunque el servidor use otros nombres de rango.

### Postulaciones (staff, builder, social)

- `/ticket postulaciones panel [canal]`: publica un panel aparte, con botones solo de emoji, para postularse a staff/builder/social. Editá la lista en `src/features/tickets/applicationCategories.ts`.
- `/ticket postulaciones abrir categoria:<...>` / `cerrar categoria:<...>`: por defecto todas arrancan cerradas (no se buscan todo el tiempo). El propio panel se actualiza solo al abrir/cerrar: cada categoría muestra 🟢 (se acepta) o 🔴 (cerrada, el botón queda deshabilitado), con una leyenda explicando los dos colores.
- Usan el mismo sistema de reclamar/derivar/cerrar/encuesta que los tickets de soporte.

### Stats de staff

- `/ticket stats [miembro]`: cuántos tickets atendió, y cuántos salieron bien/mal/indiferente (por defecto, los tuyos).
- `/ticket transcripciones miembro:<...> [calificacion]`: lista los tickets que atendió, con su ID, categoría, calificación y fecha. Filtra por `bien`/`mal`/`indiferente` si lo pedís.
- `/ticket transcripcion id:<...>`: manda el archivo de un ticket puntual (el ID lo da el comando de arriba). Las transcripciones quedan guardadas en `data/transcripts/`.
- Las tres requieren **Gestionar servidor**, igual que el resto de `/ticket` (pueden contener charlas privadas).

### Personalizar categorías (por servidor)
- `/ticket categoria lista`: las categorías de los dos paneles y quién atiende cada una.
- `/ticket categoria agregar panel:<Soporte|Postulaciones> nombre emoji descripcion [rango_minimo]`: suma una categoría (o la edita si ya hay una con ese nombre). Máximo 5 por panel. Sin rango mínimo, la atiende todo el staff. Las de postulación arrancan cerradas.
- `/ticket categoria quitar categoria:<...>` (se elige de una lista) y `/ticket categoria restablecer panel:<...>`.
- `/ticket categoria preguntas categoria:<...> [pregunta1..5]`: formulario que se completa antes de abrir ese ticket (ideal para postulaciones). Las respuestas aparecen al principio del ticket. Sin preguntas, se saca el formulario.

### Cierre por inactividad
- `/ticket inactividad tiempo:<24h|2d|…>` (o `0` para apagarlo): si un ticket pasa ese tiempo sin mensajes, el bot avisa en el canal y, si nadie escribe, lo cierra 1 hora después (o antes si el tiempo es corto). Guarda la transcripción y manda la encuesta igual que el botón.
- Después de cambiar algo, volvé a publicar el panel. Si no se configura nada, se usan las de `src/features/tickets/categories.ts` y `applicationCategories.ts`.

## Sistema 3a: bienvenida

- `/bienvenida config canal:<canal>`: canal donde se saluda a quien se une. Requiere **Gestionar roles**.
- `/bienvenida simular`: manda el mensaje de bienvenida como si el que lo corrió se acabara de unir. Es solo para probar sin tener que salir y volver a entrar al servidor.
- Al unirse alguien nuevo, se manda un mensaje en el canal configurado, con un link directo al canal del panel de verificación (si ya se publicó).

## Sistema 3b: verificación

- `/verificacion config rol:<rol>`: rol que se da al tocar el botón. Requiere **Gestionar roles**.
- `/verificacion panel [canal]`: publica el panel con el botón de verificación (por defecto, en el canal donde se corre el comando).
- Al tocar **Verificarme**, se le da el rol configurado (o avisa si ya lo tenía), y eso es lo que hace que sus invitaciones empiecen a contar (ver sistema 4).

## Contador de miembros

- `/contador config canal:<canal de voz>`: el nombre de ese canal pasa a mostrar "👥 Miembros: N". Requiere **Gestionar canales**.
- Se actualiza solo (al entrar o irse alguien, y cada 10 minutos) respetando el límite de Discord de 2 cambios de nombre de canal cada 10 minutos.

## Sistema 4: invitaciones

- Cuenta invitados **verificados** por persona (no alcanza con entrar: tiene que tocar "Verificarme"). Si alguien se va antes de verificarse, no cuenta para nadie.
- `/invitaciones ver [miembro]`: cuántos invitados verificados tiene alguien (por defecto, quien lo corre).
- `/invitaciones top`: ranking de invitadores.
- `/invitaciones hitos`: lista los hitos y su recompensa.
- `/invitaciones hito agregar cantidad recompensa` / `hito quitar cantidad`: hitos propios del servidor (requiere **Gestionar servidor**). Sin configurar, se usan los de `src/features/invites/milestones.ts`.
- `/invitaciones config canal:<canal>`: canal propio donde se avisa cada ingreso (con quién invitó), cada verificación y cada reclamo. Requiere **Gestionar servidor**.
- Al llegar a un hito, el bot le manda un DM al invitador con un botón **Reclamar**. Al tocarlo, se avisa en el canal configurado arriba para que el staff le entregue la recompensa a mano — todavía no hay vínculo con el juego para hacerlo automático.
- El bot necesita el permiso **Gestionar servidor** para poder leer las invitaciones del servidor.

## Sistema 5a: sugerencias

- `/sugerencias config canal:<canal>`: canal donde se publican. Requiere **Gestionar servidor**.
- `/sugerir texto:<...>`: cualquiera puede mandar una. Queda publicada con reacciones 👍/👎 para votar y botones **Aceptar**/**Rechazar** para el staff (requieren **Gestionar servidor**); al tocarlos, se marca el estado en el propio mensaje.

## Sistema 5b: encuestas

- `/encuesta pregunta:<...> opcion1:<...> opcion2:<...> [opcion3] [opcion4] [opcion5] [horas] [multiple]`: crea una encuesta nativa de Discord (hasta 5 opciones). Discord se encarga solo de los votos, el conteo y el cierre automático; no hace falta nada de nuestro lado.

## Sistema 5c: sorteos

- `/sorteo crear [dias] [horas] [minutos] [canal]`: cuánto dura se arma combinando los que uses (ej. `dias:1 horas:12`); después abre una ventana (modal) con título (opcional) y premios, uno por línea. `Diamante x64` da 1 unidad; `Diamante x64 x3` da 3 unidades (3 ganadores distintos se llevan esa misma recompensa). Requiere **Gestionar servidor**.
- `/sorteo config canal:<...> [rol]`: canal donde se avisa que hay un sorteo activo (ej. el general) y, opcional, un rol para taggear en ese aviso.
- `/sorteo finalizar id_mensaje:<...>`: lo termina ya, sin esperar el tiempo, y elige ganadores (el ID del mensaje te lo da el bot al crearlo).
- `/sorteo cancelar id_mensaje:<...>`: lo termina ya **sin ganadores ni premios** (el mensaje queda como "Cancelado").
- Al crearse, si está configurado el aviso, se publica un mensaje corto en ese canal invitando a participar con un link directo al sorteo.
- Al cerrar, cada premio se sortea entre los participantes (sin repetir a nadie) y cada ganador recibe un DM con lo que ganó, recomendándole abrir un ticket para reclamarlo.
- Los sorteos activos se guardan en `data/config.json`: si el bot se reinicia, al prender retoma cada uno (si ya venció, lo cierra; si no, programa el cierre para cuando corresponda).

## Almacenamiento
Por ahora la configuración se guarda en `data/config.json` (ignorado por git), **separada por servidor** (`guilds.<id>.<sistema>`), y las transcripciones en `data/transcripts/<servidor>/`. Todos los sistemas pasan por `src/store.ts`; cuando se sume PostgreSQL, solo se reemplaza ese archivo. La carpeta se puede cambiar con `DATA_DIR`. Al apagar con Ctrl+C, el bot espera a terminar de guardar.

## Comandos de desarrollo
```bash
npm test            # tests de la lógica (apodos, tickets, rangos)
npm run typecheck   # chequeo de tipos
```

## Estructura
```
src/
  index.ts                  arranque, intents, registro de comandos e interacciones
  config.ts                 variables de entorno
  types.ts                  tipos Command y Feature
  store.ts                  almacenamiento local (JSON) por servidor, reemplazable por la DB
  paths.ts                  carpeta de datos
  log.ts                    logs de consola con hora y sistema
  ui.ts                     embed con la marca del servidor, respuestas efímeras
  health.ts                 chequeos de permisos (canales, roles) para /ajustes estado
  ranks.ts                  lista de rangos y tags (editable)
  nickLogic.ts              lógica pura de apodos
  features/
    settings.ts             /ajustes (estado, marca) y guía al entrar a un servidor
    staff.ts                /staff: rangos de staff por servidor (o plantilla por nombre)
    serverLogs.ts           /logs: registro de todo lo que pasa en el servidor
    moderation/             /warn, /mute, /ban…, historial y escala automática (logic.ts: duraciones)
    automod/                filtros de spam, links, invitaciones, menciones y raid (logic.ts: puro)
    announcements/          /anuncio: anuncios con formulario, programados y repetidos
    nicknames.ts            sistema 1: tags de apodo
    tickets/
      index.ts              sistema 2: panel, abrir, reclamar, cerrar
      categories.ts         categorías por defecto + lógica pura (clave, emoji, quién atiende)
      categoryStore.ts      categorías propias de cada servidor
      applicationCategories.ts  categorías de postulación: staff, builder, social (editable)
      transcript.ts         armado de la transcripción (lógica pura)
      stats.ts              stats de staff y transcripciones guardadas en disco
    welcome.ts              sistema 3a: bienvenida
    verification.ts         sistema 3b: verificación
    memberCount.ts          contador de miembros (canal de voz)
    invites/
      index.ts              sistema 4: conteo, hitos, reclamo de recompensa
      logic.ts               lógica pura (qué invite se usó, qué hitos se cruzan)
      milestones.ts          hitos y recompensas (editable)
    suggestions.ts          sistema 5a: sugerencias
    polls.ts                sistema 5b: encuestas
    giveaways/
      index.ts               sistema 5c: sorteos (persisten si se reinicia el bot)
      logic.ts                lógica pura (elegir ganadores al azar)
test/
  nickLogic.test.ts
  tickets.test.ts
  invites.test.ts
  giveaways.test.ts
  store.test.ts             migración al formato por servidor, colores
  moderation.test.ts        duraciones, escala, automod y horarios de anuncios
```

## Para sumar un sistema nuevo
1. Crear `src/features/<sistema>.ts` exportando un `Feature` (comandos, eventos y, si usa botones, `handleInteraction`).
2. Agregarlo a la lista `features` de `src/index.ts`.
