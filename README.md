# FIRMS Watch

Aplicación local para consultar focos térmicos detectados por satélite, mostrarlos en un mapa y recibir alertas de proximidad mediante Telegram.

La aplicación toma datos de NASA FIRMS, combina las detecciones de varios satélites, calcula su distancia respecto a la ubicación configurada o compartida desde el móvil y avisa cuando existen focos dentro del radio establecido.

> Una detección FIRMS es una anomalía térmica observada por satélite, no necesariamente un incendio confirmado.

## URLs locales

Mientras la aplicación no esté publicada en un servidor, primero hay que ejecutar:

```powershell
npm start
```

Después se pueden utilizar estas direcciones:

### Dashboard principal

```text
http://localhost:3000
```

Es la dirección recomendada. Muestra:

- Número de focos dentro del radio.
- Distancia al foco más cercano.
- Focos nuevos desde la última alerta.
- Radio de vigilancia activo.
- Ubicación GPS utilizada.
- Focos dibujados en el mapa.
- Capa opcional de terremotos recientes en el mismo mapa.
- Checkboxes independientes para mostrar u ocultar focos y terremotos.
- Tarjetas y panel lateral dinámicos según la última capa activada.
- Detalles del foco más cercano.
- Ruta orientativa evaluada respecto a todos los focos.

### Mapa sencillo anterior

```text
http://localhost:3000/mapa_focos_firms.html
```

Conserva una versión más sencilla del mapa, con un botón para cargar los focos actuales.

### Live Server de VS Code

Si se abre un archivo mediante **Open with Live Server**, las direcciones habituales son:

```text
http://127.0.0.1:5500/dashboard.html
http://127.0.0.1:5500/mapa_focos_firms.html
```

Aunque se utilice Live Server, `npm start` debe permanecer ejecutándose. Live Server solo entrega el HTML; las consultas FIRMS y Telegram siguen dependiendo del servidor Node.js en:

```text
http://localhost:3000
```

## Puesta en marcha

### 1. Requisitos

- Node.js 18 o superior.
- Una MAP_KEY de NASA FIRMS.
- Un bot de Telegram.

### 2. Configuración

Crear un archivo `.env` en la raíz del proyecto:

```env
TELEGRAM_BOT_TOKEN=token_privado_del_bot
TELEGRAM_CHAT_ID=
FIRMS_MAP_KEY=map_key_privada_de_firms
ALERT_LAT=37.2194
ALERT_LON=-3.78306
ALERT_RADIUS_KM=200
EARTHQUAKE_MIN_MAGNITUDE=1.5
EARTHQUAKE_DAYS=7
CHECK_INTERVAL_MINUTES=15
PORT=3000
```

`TELEGRAM_CHAT_ID` puede quedar vacío. La aplicación lo obtiene cuando se envía `/start` al bot.

No se deben publicar ni compartir `.env`, el token de Telegram o la clave de FIRMS.

Los terremotos se consultan en la información sísmica pública del IGN y no necesitan API key. Las variables
`EARTHQUAKE_MIN_MAGNITUDE` y `EARTHQUAKE_DAYS` son opcionales; sus valores predeterminados son
1.5 y 7 días. `ALERT_RADIUS_KM` solo limita los focos de fuego; la capa de terremotos cubre toda
España, incluidas Península, Baleares, Canarias, Ceuta y Melilla.

### 3. Arranque

```powershell
npm start
```

La terminal debe permanecer abierta. Al cerrarla se detienen el servidor y las comprobaciones automáticas.

## Cómo funciona

### Consulta de satélites

Cada 15 minutos el servidor consulta en paralelo estas fuentes de NASA FIRMS:

- VIIRS S-NPP.
- VIIRS NOAA-20.
- VIIRS NOAA-21.
- MODIS.

Las respuestas llegan en formato CSV y se convierten en objetos JavaScript.

### Consulta de terremotos

Al activar el checkbox **Terremotos**, el dashboard solicita al backend los eventos recientes del
Instituto Geográfico Nacional. El servidor filtra por la magnitud mínima y la ventana temporal configurada. La
consulta cubre toda España y cada marcador muestra magnitud, lugar,
distancia respecto a la ubicación activa, profundidad y fecha.

El checkbox solo controla la capa del mapa; no activa sensores físicos ni predice terremotos.

Al activar **Terremotos**, las tarjetas superiores pasan a mostrar el total nacional, los eventos
dentro del radio, la mayor magnitud y el periodo consultado. El panel lateral muestra el terremoto
más cercano. Al volver a activar **Focos de fuego**, se recuperan las métricas y el detalle FIRMS.
Las dos capas pueden permanecer dibujadas simultáneamente; la última activada determina los datos
mostrados por el dashboard.

### Eliminación de duplicados

Dos observaciones se consideran el mismo foco cuando se encuentran aproximadamente a menos de 2 km y tienen una diferencia temporal máxima de una hora. De esta forma, una detección observada por varios satélites no se cuenta varias veces.

### Distancia y radio

La aplicación calcula la distancia entre la ubicación activa y cada foco o terremoto. Solo conserva
para alertas las detecciones situadas dentro de `ALERT_RADIUS_KM`, actualmente 200 km. La capa del
mapa continúa mostrando terremotos de toda España, aunque estén fuera del radio de notificación.

Los focos se ordenan por distancia, por lo que el primer elemento es el más cercano.

### Alertas de Telegram

Cada 15 minutos el servidor comprueba tanto los focos térmicos como los terremotos del IGN.

Si aparece al menos un foco nuevo dentro del radio, envía una alerta con:

- Número de focos cercanos.
- Número de detecciones nuevas.
- Distancia al foco más cercano.
- Fecha y hora de adquisición.
- Confianza.
- Potencia radiativa FRP.
- Fuentes satelitales.
- Enlace a las coordenadas del foco.
- Enlace a una ruta orientativa.

Los focos que ya figuran en `notified-fires.json` continúan visibles en el dashboard, pero no vuelven
a generar mensajes. Si Telegram falla, las detecciones nuevas no se marcan como notificadas y se
reintentan en la siguiente comprobación.

Cuando aparece un terremoto nuevo dentro del radio, envía una alerta con:

- Número de terremotos nuevos cercanos.
- Magnitud y localización del más cercano.
- Distancia y profundidad.
- Fecha y hora UTC.
- Enlaces al epicentro y a la ficha oficial del IGN.

Los identificadores ya notificados se guardan en `notified-earthquakes.json`, por lo que un mismo
terremoto no genera mensajes repetidos. Si Telegram falla, el evento no se marca y se reintenta en
la siguiente comprobación. En el primer arranque se envía un único resumen si ya existen terremotos
dentro del radio; después solo se notifican los eventos nuevos.

Pulsar **Actualizar datos** o activar el checkbox en el dashboard solo actualiza el mapa. No envía
una notificación adicional.

## Ubicación GPS

Al arrancar, el bot solicita una ubicación mediante el botón:

```text
📍 Compartir mi ubicación
```

Al pulsarlo desde Telegram:

1. El móvil solicita permiso para acceder al GPS.
2. Telegram envía las coordenadas al bot.
3. El servidor guarda la ubicación.
4. Las siguientes distancias y rutas utilizan esa posición.

La última ubicación y el identificador del chat se guardan localmente en:

```text
current-location.json
```

Si no se comparte ninguna ubicación, se utilizan las coordenadas de respaldo configuradas en `.env`.

## Ruta orientativa

La aplicación prueba 24 direcciones posibles, separadas por 15 grados. Para cada dirección proyecta un destino a 30 km, divide el recorrido recto en diez muestras y calcula su separación respecto a todos los focos detectados. Se elige la alternativa cuya distancia mínima a cualquier foco sea mayor.

Después genera una URL de Google Maps para mostrar una ruta en coche hasta el destino elegido. El dashboard muestra también la separación mínima estimada.

Esta ruta:

- No conoce el perímetro real del incendio.
- No tiene en cuenta viento o humo.
- No comprueba carreteras cortadas.
- Evalúa una línea recta, mientras Google Maps puede elegir un trazado de carretera diferente.
- No sustituye las órdenes de evacuación.
- No garantiza que el recorrido sea seguro.

Ante una emergencia hay que seguir las instrucciones del **112** y de las autoridades.

## Archivos principales

```text
dashboard.html              Dashboard principal
mapa_focos_firms.html       Mapa sencillo
server.js                   Servidor, FIRMS, IGN, Telegram y cálculos
package.json                Configuración de Node.js
.env                        Credenciales privadas, no incluido en Git
current-location.json       Última ubicación GPS, no incluido en Git
notified-fires.json         Registro de detecciones, no incluido en Git
notified-earthquakes.json   Registro de terremotos avisados, no incluido en Git
```

## Datos privados

El archivo `.gitignore` excluye:

```text
.env
current-location.json
notified-fires.json
notified-earthquakes.json
```

Antes de publicar el repositorio conviene comprobar:

```powershell
git status
git check-ignore .env current-location.json notified-fires.json notified-earthquakes.json
```

## Publicación futura

Cuando se publique en un servidor, la dirección local:

```text
http://localhost:3000
```

se sustituirá por una URL HTTPS pública, por ejemplo:

```text
https://alertas.example.com
```

El alojamiento deberá mantener el proceso Node.js activo, proporcionar las variables de entorno privadas y utilizar almacenamiento persistente para la ubicación y el registro de focos.
