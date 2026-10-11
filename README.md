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
- **Velocidad:** panel **WARP** arriba a la derecha de cada página, con botones 1×–16×. **Alt+W** lo oculta o muestra. El ajuste es individual por pestaña y se aplica también a sus iframes.
- **HAR:** la captura se inicia automáticamente antes de la primera navegación. Al cerrar una pestaña se consolida un archivo `.har` y se abre **Guardar como** para elegir ubicación y nombre.
- **Cancelación:** si se cancela el diálogo, el archivo **no se descarta**: queda en el directorio de recuperación. `recover-windows.bat` o `npm run recover` lo recupera y vuelve a ofrecer guardarlo.
- **Varias pestañas cerradas:** los diálogos se presentan secuencialmente, uno por captura. No se mezclan los HAR de las diferentes pestañas.

### Qué se captura

Requests HTTP y HTTPS sin filtrado de URL ni método: navegación, fetch/XHR, POSTs, headers, query strings, request bodies, respuestas, contenidos textuales y binarios (por ejemplo JS, imágenes o WebAssembly), tiempos y requests fallidas. El HAR usa el estándar 1.2. Los **mensajes de WebSocket** enviados/recibidos se adjuntan como una extensión del HAR (`log._warpWebSockets`) ya que las tramas no forman parte del formato HAR estándar. Requests de service workers que no pueden asociarse a una pestaña se guardan en una captura adicional al terminar la sesión.

### Alcance real de la aceleración

Acelerar los temporizadores de JavaScript, `performance.now()`, `Date.now()`, el tiempo entregado a `requestAnimationFrame()` y las animaciones Web Animations API **no aumenta los FPS físicos**, ni el ancho de banda, ni acelera un servidor remoto. Algunos juegos se rigen por tiempos del backend, Workers o WebGL y pueden ignorar parcial o totalmente el ajuste. Los tiempos virtuales pueden alterar comportamientos dependientes de relojes, como expiraciones y firmas; volver a 1× si ocurre.

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

El workflow de GitHub Actions ejecuta pruebas unitarias en Windows y Linux y una prueba real de Chromium headless que abre dos pestañas, navega, hace POSTs, comprueba aislamiento de HAR y prueba el cambio de velocidad.

## Arquitectura

- `src/index.js` inicia un perfil de Chromium mediante `chromium.launchPersistentContext` y conserva las pestañas nativas.
- `src/manager.js` vincula cada `Page` con su grabador, recibe eventos de red desde `BrowserContext` (incluida la navegación inicial) y gestiona cierres por separado.
- `src/har.js` registra entradas HAR y frames WebSocket por pestaña en un diario temporal, y materializa los `.har` al cierre.
- `src/preload.js` instala antes del código del sitio el reloj virtual y el pequeño panel de control.
- `src/dialog.js` muestra un diálogo nativo de guardado (PowerShell WinForms en Windows; `zenity`/`kdialog` en Linux; AppleScript en macOS) y conserva copias recuperables si el guardado falla.

No se necesita servidor remoto, cuenta de usuario ni permisos administrativos para utilizar el navegador, salvo los que requiera la instalación local de Chromium.
