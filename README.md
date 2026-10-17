# Warp Browser

Navegador de escritorio basado en **Playwright + Chromium** para revisar juegos web. Utiliza las pestañas nativas de Chromium, ofrece un control de velocidad de **1×, 2×, 4×, 8× y 16×** sobre los temporizadores/animaciones del cliente y registra automáticamente **un HAR por pestaña**.

**No bloquea, modifica, reescribe ni filtra requests.** No llama a `route()`, no usa proxy y no desactiva recursos. El objetivo es capturar la navegación tal como ocurre en el sitio.

## Inicio rápido en Windows

1. Instalar [Node.js 20 o superior](https://nodejs.org/).
2. Descargar el repositorio (ZIP o `git clone https://github.com/Shisetsu-Code/Warp-Browser.git`).
3. Ejecutar **`start-windows.bat`**. La primera ejecución instala Playwright y Chromium.
4. Navegar normalmente usando la barra de direcciones. También se puede pasar un enlace como argumento: `start-windows.bat https://ejemplo.com/juego`.

Alternativamente, desde la terminal:

```powershell
npm install
npx playwright install chromium
npm start -- https://ejemplo.com/juego
```

En Linux/macOS se utilizan los mismos tres comandos de la terminal (sin el `.bat`). En Linux, el diálogo gráfico de guardado requiere `zenity` o `kdialog`.

## Uso

- **Pestañas:** `Ctrl+T` abre una pestaña, `Ctrl+W` cierra la actual. También funcionan las pestañas que abren los sitios mediante `window.open()`.
- **Velocidad:** etiqueta **WARP** plegable arriba a la derecha de cada página, con botones 1×–16×. **Alt+W** lo oculta o muestra. El ajuste es individual por pestaña y se aplica también a sus iframes.
- **HAR:** la captura se inicia automáticamente antes de la primera navegación. Al cerrar una pestaña se consolida un archivo `.har` y se abre **Guardar como** para elegir ubicación y nombre.
- **Cancelación:** si se cancela el diálogo, el archivo **no se descarta**: queda en el directorio de recuperación. `recover-windows.bat` o `npm run recover` lo recupera y vuelve a ofrecer guardarlo.
- **Varias pestañas cerradas:** los diálogos se presentan secuencialmente, uno por captura. No se mezclan los HAR de las diferentes pestañas.

### Qué se captura

Requests HTTP y HTTPS sin filtrado de URL ni método: navegación, fetch/XHR, POSTs, headers, query strings, request bodies, respuestas, contenidos textuales y binarios (por ejemplo JS, imágenes o WebAssembly), tiempos y requests fallidas. El HAR usa el estándar 1.2. Los **mensajes de WebSocket** enviados/recibidos se adjuntan como una extensión del HAR (`log._warpWebSockets`) ya que las tramas no forman parte del formato HAR estándar. Requests de service workers que no pueden asociarse a una pestaña se guardan en una captura adicional al terminar la sesión.

### Alcance real de la aceleración (clics compatibles desde v0.1.1)

**`Date.now()` y `performance.now()` permanecen reales y sincronizados con `Event.timeStamp`.** La versión anterior los adelantaba artificialmente, lo que podía romper interacciones, menús de compra, validaciones y tiempos del juego. Ahora solo se aceleran los temporizadores JavaScript, el tiempo **entregado al callback** de `requestAnimationFrame()` y las animaciones Web Animations API. Mientras el usuario presiona un botón del mouse o una tecla se pausa temporalmente la aceleración del fotograma/temporizadores y se reanuda 350 ms después de soltarlo. No se modifican ni sintetizan clics.

El control WARP queda **plegado** en una pequeña etiqueta arriba a la derecha; al pulsarla aparecen las velocidades y se vuelve a plegar después de elegir una. **Alt+W** oculta o muestra completamente la etiqueta si tapa alguna opción.

Esto **no aumenta los FPS físicos**, ni el ancho de banda, ni acelera el servidor remoto. Juegos que calculan su lógica directamente a partir de los relojes reales, Web Workers o WebGL podrían acelerar menos de lo deseado; se prioriza que las interacciones funcionen correctamente.

La grabación HAR no utiliza interceptación de solicitudes, aunque el navegador continúa ejecutando las propias políticas de red/CORS del sitio y las funcionalidades habituales de Chromium.

## Recuperación y privacidad

Las capturas temporales se almacenan en:

- Windows: `%LOCALAPPDATA%\Warp-Browser\recovery`
- Linux: `~/.config/warp-browser/recovery`
- macOS: `~/Library/Application Support/Warp-Browser/recovery`

El perfil persistente de Chromium se conserva en un subdirectorio `chromium-profile` de esas carpetas de datos, para mantener cookies y sesiones entre ejecuciones. El directorio raíz puede cambiarse con `WARP_HOME`. Un cierre forzado puede dejar `.ndjson` incompletos: `npm run recover` reconstruye el HAR omitiendo la última línea incompleta.

**Precaución:** los HAR completos pueden contener cookies, tokens de sesión, cuerpos POST y datos privados. Nunca subas capturas a un repositorio público sin revisarlas. Por ese motivo, `*.har` y archivos temporales están excluidos con `.gitignore`.

## Desarrollo y tests

```bash
npm install
npm run check
npm test
npx playwright install chromium
npm run test:e2e
```

El workflow de GitHub Actions ejecuta pruebas unitarias en Windows y Linux y una prueba real de Chromium headless que abre dos pestañas, navega, hace POSTs, comprueba aislamiento de HAR y prueba el cambio de velocidad. Una prueba adicional verifica los clics reales, las compras simuladas, la compatibilidad de los relojes y la aceleración en iframes a 8× y 16×.

## Arquitectura

- `src/index.js` inicia un perfil de Chromium mediante `chromium.launchPersistentContext` y conserva las pestañas nativas.
- `src/manager.js` vincula cada `Page` con su grabador, recibe eventos de red desde `BrowserContext` (incluida la navegación inicial) y gestiona cierres por separado.
- `src/har.js` registra entradas HAR y frames WebSocket por pestaña en un diario temporal, y materializa los `.har` al cierre.
- `src/preload.js` instala antes del código del sitio un planificador virtual para animaciones y temporizadores (sin alterar los relojes reales) y el panel plegable de control.
- `src/dialog.js` muestra un diálogo nativo de guardado (PowerShell WinForms en Windows; `zenity`/`kdialog` en Linux; AppleScript en macOS) y conserva copias recuperables si el guardado falla.

No se necesita servidor remoto, cuenta de usuario ni permisos administrativos para utilizar el navegador, salvo los que requiera la instalación local de Chromium.

### Compatibilidad con Nolimit City (v0.1.3)

**Airport Security (Playin / Nolimit City)** usa un ticker propio de PIXI.js, GSAP y Spine. La versión 0.1.1 no aceleraba sus animaciones controladas por GSAP. Ahora el navegador: 

- Ajusta la velocidad del ticker de la aplicación PIXI y del ticker compartido (no el ticker de sistema, para proteger entradas).
- Localiza la línea de tiempo raíz de GSAP dentro del juego mediante el `Speedster` expuesto por `NolimitLauncher`, sin modificar ni interceptar requests y sin introducir scripts del proveedor en el repositorio.
- Usa marcas de tiempo **reales** en los callbacks `requestAnimationFrame` de PIXI para impedir acelerar dos veces y evita cambiar `Date.now()` y `performance.now()`.
- Mantiene 1× mientras se realiza un clic o una pulsación; restablece la velocidad seleccionada después de 350 ms.
- Aplica el ajuste cuando las bibliotecas terminan de cargar, incluso si ya habías seleccionado 8×.

En la consola de desarrollo del iframe del juego podés consultar `__warpGetEngineStatus()` para saber si se detectaron PIXI y GSAP. `selectedSpeed: 8` no asegura que toda la ronda dure 1/8: los tiempos impuestos por el servidor WebSocket y cualquier lógica no basada en estas bibliotecas son independientes. Los juegos de otros proveedores pueden necesitar integraciones adicionales.

**Importante:** no subas capturas HAR de sesiones reales a repositorios públicos; pueden incluir cookies, tokens y datos de sesión.


### Control de velocidad nativo en Airport Security (v0.1.3)

El juego presenta un control de tirada rápida propio (`fastSpin`); la configuración capturada para la demo Playin indica `fastSpinEnabled: true`, `minimumSpinTime: 0` y operador `FANPAGE_DEMO`. La aplicación PIXI del juego usa `autoStart: false` y los renders se disparan con el ticker de GSAP; por eso un PIXI `ticker.speed=8` no equivale a una tirada ocho veces más rápida.

En **esa demo identificable** (solo `funMode: true` y operador `FANPAGE_DEMO`) al seleccionar 2×, 4×, 8× o 16× Warp habilita además el modo de tirada rápida **oficial del cliente**. Usa nivel 2 solo si el propio juego declara soporte `supportFastSpinMega`. Al volver a 1× restaura el valor anterior, a menos que el usuario lo haya cambiado directamente en el juego. La protección de clics no desactiva el modo rápido durante una pulsación. **No se aplica automáticamente en partidas con dinero real** ni se generan acciones de apuesta o compra.

El panel diagnostica motores mediante `__warpGetEngineStatus()`: `nativeFastSpin`, `gsap`, `pixiTickerRunning`. Estos indicadores solo confirman qué controles se aplicaron, no garantizan una duración de ronda exactamente proporcional al número seleccionado.

## Compatibilidad Playtech GPAS (v0.1.4)

Para juegos como Buffalo Blitz II (ruta `gpasclient.html`) se detecta el bucle GWT específico de Playtech. Su temporizador de simulación utiliza `Date.now()` y no el timestamp de `requestAnimationFrame`, por lo que las versiones anteriores no aceleraban el motor. Ahora Warp escala exclusivamente las consultas a `Date.now()` realizadas durante el callback de renderizado GWT; fuera de ese callback se conserva el reloj del navegador, los eventos del mouse y toda la comunicación HTTP/WebSocket.

El diagnóstico está disponible en la consola del frame correspondiente con `window.__warpGetGpasStatus?.()` (campo `supported` y contador `acceleratedFrames`). Si `supported` es `false`, no se detectó el bucle GWT compatible y no debe suponerse una aceleración real. Las esperas impuestas por el servidor continúan sin alteraciones. El script también admite `localhost` únicamente para pruebas locales de esta ruta. No incorpora archivos ni datos personales del HAR.


### Detección dinámica Playtech GPAS/GWT (v0.1.5)

El adaptador GWT se instala antes de ejecutar el JavaScript de **cada iframe**, sin depender de su dominio ni de la ruta `/gpasclient.html`. Solo modifica `fnRequestAnimationFrame` al reconocer la firma específica de GWT del HAR (`frameBudget`, `lastTick`, `requestAnimFrame`, `Date.now`); las páginas no reconocidas quedan intactas. Comprueba periódicamente los motores que cargan tarde o reemplazan la función y reaplica el ajuste tras cambios de URL.

Cada iframe nuevo consulta la velocidad seleccionada para su pestaña. El chip distingue `WARP 8× · ?` (seleccionado pero no confirmado), `WARP 8× · GWT …` (detectado sin medición) y `WARP 8× · GWT 8.0×` (reloj de fotogramas GWT medido a ~8×). Este dato **no garantiza que la tirada completa dure 1/8**: esperas del servidor y otros relojes del juego pueden mantenerse reales. No se cambian requests, respuestas, WebSockets, ni marcas de tiempo de clics. Los HAR continúan siendo automáticos por pestaña.

Las pruebas incluyen carga tardía, iframes de distinto origen, reinicio del motor, clics simulados y grabación HAR. No se ejecutan compras con dinero real.
