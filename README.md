# CSV Manager

Aplicación Next.js 14 (App Router) + TypeScript + Tailwind CSS con login JWT, validador de correos y constructor de CSV.

## Funcionalidades

- **Login** con usuario/contraseña (bcrypt) y JWT (`jose`) en cookie HttpOnly, Secure y SameSite=Strict.
- **Validador** (`/dashboard/validador`): por etapas. **Paso 1** (automático y gratis): formato, listas y MX. **Paso 2** (gratis, lo pides tú): verificación SMTP por lotes. **Paso 3** (con costo, lo pides tú): proveedor externo para los que sigan sin confirmar.
- **Constructor** (`/dashboard/constructor`): tabla con orden, filtros, selección de filas/columnas y descarga.

## Instalación

```bash
npm install
```

## Generar el hash de la contraseña

```bash
npm run hash -- "tu_contraseña"
```

El script imprime dos versiones del hash:

- La normal, para pegar en el **panel de SiteGround**.
- La que tiene los `$` escapados (`\$`), para **`.env.local`**. Next.js expande `$` como variable, por lo que hay que escaparlo en ese archivo.

## Variables de entorno

Copia `.env.example` a `.env.local` y complétalo:

```env
JWT_SECRET=un_secreto_largo_y_aleatorio
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=\$2a\$10\$...
```

Para generar un `JWT_SECRET` seguro:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> El `.env.local` incluido en desarrollo usa la contraseña `admin123`. **Cámbiala antes de desplegar.**

## Ejecutar en local

```bash
npm run dev
```

Abre http://localhost:3000. En Windows PowerShell, si `npm` está bloqueado por la política de ejecución, usa `npm.cmd` o ejecuta `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

Para probar la versión de producción:

```bash
npm run build
npm start
```

## Despliegue en SiteGround (GoGeek)

1. Sube el proyecto a un repositorio de **GitHub**. `.env.local` está en `.gitignore`; no lo subas.
2. En **Site Tools**, abre la sección de aplicaciones Node.js y crea un proyecto nuevo. El nombre de la sección puede variar según la versión del panel.
3. Conecta tu cuenta de GitHub y selecciona el repositorio y la rama.
4. Elige el preset de **Next.js**. Los comandos esperados son:
   - Build: `npm run build`
   - Start: `npm start`
5. En la configuración del proyecto, añade las **variables de entorno**:
   - `JWT_SECRET`
   - `ADMIN_USER`
   - `ADMIN_PASSWORD_HASH`: pega el hash normal (sin `\`).
   - `NODE_ENV=production`, si el panel no lo añade solo.
6. Despliega y comprueba que el sitio carga por **HTTPS**. La cookie es `Secure` en producción, así que el login no funcionará por HTTP.
7. Para cada actualización, haz `git push` y vuelve a desplegar desde el panel.

### Notas sobre SiteGround

- **Verificación SMTP (capa 3):** se hace por lotes pequeños con pausas, solo sobre los correos que ya pasaron las capas 1 y 2. Si el hosting bloquea el puerto 25 saliente, usa un proxy SOCKS5 (ver sección siguiente). Usa el botón **«Probar conexión SMTP»** del validador para comprobarlo en segundos.
- **Tiempos de espera:** cada lote es una petición corta, así que no choca con el tiempo máximo del hosting. Las capas 1 y 2 de 10.000 correos tardan solo unos segundos.
- **Memoria y procesos:** si la app se reinicia sola con archivos muy grandes, reduce los límites en `app/api/validate-csv/route.ts`.

## Verificación SMTP: lotes, límites y proxy SOCKS5

### Cómo funciona
1. Las capas 1 y 2 (sintaxis/listas y MX) se ejecutan sobre todo el archivo.
2. La capa 3 **no se ejecuta sola**: tras ver los resultados de las capas 1 y 2 aparece el «Paso 2» y tú pulsas «Verificar por SMTP». Entonces el navegador envía los correos válidos en **lotes** (20–120) con una **pausa** entre lotes.
3. Por cada dominio de destino se abre **una sola conexión** que se reutiliza para varios correos, con una pausa entre consultas (`SMTP_DELAY_MS`). El catch-all se comprueba una vez por dominio.
4. Si un servidor pide esperar (respuestas 4xx), la pausa entre lotes se duplica automáticamente.
5. Si ningún correo de un lote se puede consultar, se detiene con un aviso (puerto 25 bloqueado) en vez de seguir.
6. Puedes cancelar y **continuar donde quedó** o **reintentar los «no concluyentes»**. La pestaña debe seguir abierta.

### Variables de entorno (todas opcionales)
```env
# Proxy(s) SOCKS5 por los que sale la consulta SMTP. Varios separados por coma: se rotan.
SMTP_PROXIES=socks5://usuario:clave@IP_DEL_VPS:1080
# Dominio para el saludo EHLO y remitente de la consulta (mejor uno tuyo, con DNS inverso correcto)
SMTP_HELO_DOMAIN=mail.tudominio.com
SMTP_MAIL_FROM=verify@tudominio.com
# Pausa entre consultas al mismo dominio, en milisegundos (por defecto 700)
SMTP_DELAY_MS=700
```
Si la clave tiene caracteres especiales (`@ : / #`), codifícala como URL (`%40`, `%3A`...).

### Montar el proxy en un VPS (si SiteGround bloquea el puerto 25)
Necesitas un VPS pequeño con el **puerto 25 saliente abierto**. Confírmalo con el soporte del proveedor antes de pagar.

En el VPS (Ubuntu/Debian), con **Dante**:
```bash
sudo apt update && sudo apt install -y dante-server
# Usuario solo para el proxy (sin shell)
sudo useradd -r -s /usr/sbin/nologin proxyuser && echo 'proxyuser:CLAVE_LARGA' | sudo chpasswd
ip route | grep default   # anota el nombre de la interfaz (eth0, ens3...)
```
`/etc/danted.conf` (cambia `eth0` si hace falta):
```
logoutput: syslog
internal: 0.0.0.0 port = 1080
external: eth0
socksmethod: username
user.privileged: root
user.unprivileged: nobody
# Solo se permite conectar al puerto 25: así no sirve como proxy abierto para otras cosas
socks pass  { from: 0.0.0.0/0 to: 0.0.0.0/0 port = 25 command: connect log: error }
socks block { from: 0.0.0.0/0 to: 0.0.0.0/0 log: error }
client pass { from: 0.0.0.0/0 to: 0.0.0.0/0 log: error }
```
```bash
sudo systemctl restart danted && sudo systemctl enable danted
sudo ufw allow 1080/tcp   # si usas ufw
```
Después pon `SMTP_PROXIES=socks5://proxyuser:CLAVE_LARGA@IP_DEL_VPS:1080` en las variables de entorno de SiteGround y pulsa **«Probar conexión SMTP»**.

Para mejores resultados con Yahoo y Outlook, configura en el panel del VPS el **DNS inverso (PTR)** de su IP con tu dominio y usa ese dominio en `SMTP_HELO_DOMAIN`. Sin PTR correcto, estos proveedores rechazan la consulta («no concluyente»).

### Qué esperar
- **Gmail** responde con claridad si el buzón existe.
- **Yahoo y Outlook** suelen bloquear o no revelar buzones; esos correos quedarán «no concluyentes» y pasan al CSV limpio salvo que marques el modo estricto.
- Una lista de varios miles puede tardar **horas**. Empieza con una muestra pequeña.

## Capa 4: EmailAwesome (opcional)

Servicio externo de verificación de buzones que usa créditos de tu plan. Se usa **solo para los correos que ninguna capa anterior pudo confirmar**, y nunca se envía nada sin que lo confirmes en pantalla.

- Variable: `EMAILAWESOME_API_KEY` (en `.env.local` y en las variables de entorno de SiteGround). Nunca en el código ni en GitHub.
- Flujo de su API: se crea la validación (POST) y se consulta por `id` hasta que termine (unos 15 s). No usa callback.
- Los lotes son de 20 correos. Las validaciones que no terminan a tiempo se reanudan con su `id` sin volver a cobrarse.
- Los resultados «Unknown» no se cobran. Si falla la clave, no hay créditos o hay límite de velocidad, el proceso se detiene con un aviso y se conserva lo ya verificado.
- La tarjeta muestra tus **créditos disponibles** (`GET /billing/me`) y limita el máximo a enviar a ese saldo. Si no se puede leer el saldo, simplemente no se muestra.
- Scripts de diagnóstico: `node scripts/ea-test.js` (crea 1 validación, gasta 1 crédito), `node scripts/ea-poll.js` (consulta una existente, no gasta) y `node scripts/ea-balance.js` (muestra el saldo, no gasta).
### Segundo proveedor: emailval (opcional)

- Variable: `EMAILVAL_API_KEY`. Se cobra **por correo enviado** (≈ US$ 0,0008, también los inválidos) con cargo a tu tarjeta a fin de mes: **no hay un tope automático**, por eso la app te pide confirmar y limita el envío al máximo que elijas.
- Según su propio sitio, **Gmail, Outlook/Hotmail, Yahoo y Apple no permiten confirmar el buzón** (puntaje máximo 60), así que la app **no les envía esos dominios** para no pagar sin obtener información.
- Responde de forma síncrona y en lotes de hasta 100 desde la app (la API admite 500).
- Selector en pantalla: **Automático** (usa los proveedores en orden y, si uno se queda sin créditos o falla, continúa con el siguiente), o uno en concreto. El orden se cambia con `VERIFIER_ORDER` (por defecto `emailawesome,emailval`).
- Un correo ya enviado a un proveedor no se reenvía a otro en la misma ejecución, para no cobrarlo dos veces.
## Estructura

```
app/
  login/page.tsx
  dashboard/layout.tsx · validador/page.tsx · constructor/page.tsx
  api/login · api/logout · api/validate-csv · api/smtp-batch · api/smtp-check
components/  ui/ · Sidebar · ValidadorCSV · ValidationProgressModal · ConstructorCSV
lib/         auth.ts · csv.ts · email-validation.ts · smtp.ts · validation-types.ts
middleware.ts
scripts/hash-password.js
```

## Seguridad

- Cookie HttpOnly + Secure (producción) + SameSite=Strict.
- El middleware protege `/dashboard/*` y `/api/validate-csv`.
- Las celdas CSV que empiezan por `= + - @` se prefijan con `'` para evitar inyección de fórmulas en Excel.
- No hay limitación de intentos de login. Si expones la app públicamente, valora añadir rate limiting.

