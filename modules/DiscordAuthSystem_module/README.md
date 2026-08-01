# DiscordAuthSystem module

Встроенный Java-модуль для GravitLauncher LaunchServer, который реализует standalone Discord OAuth auth provider.

## Возможности

- Авто-регистрация пользователей при первом входе через Discord.
- Восстановление сессии и обновление Discord OAuth access token через refresh token.
- Отдельные случайные токены сессии LaunchServer: Discord access/refresh tokens не отправляются лаунчеру.
- Проверка принадлежности к обязательным Discord-гильдиям.
- Безопасное форматирование никнеймов (транслитерация, фильтрация символов, regex).
- Хранение пользователей в JSON-файле (`config/DiscordAuthSystem/`), без внешней БД.
- Работает как standalone auth core: `core.type: discordauthsystem` в `LaunchServer.json`.

## Сборка

### Через Docker (рекомендуется)

Поскольку панель управляет LauncherDockered, проще всего собирать модуль в Docker-контейнере. При этом не нужен JDK/Gradle на хосте, а JAR-зависимости берутся из того же pinned-релиза `LaunchServerBuild.zip`, который использует панель.

```bash
./build-docker.sh
```

Результат: `build/docker/DiscordAuthSystem_module.jar`.

Можно указать другую выходную директорию:

```bash
./build-docker.sh /path/to/output
```

### Вручную

1. Установите JDK 21+ и Gradle 8.5.
2. Поместите JAR-зависимости LaunchServer в `libs/`.
3. Запустите:
   ```bash
   gradle build
   ```
4. Скопируйте `build/libs/DiscordAuthSystem_module-1.0.11.jar` в `LaunchServer/modules/`.
5. Запустите LaunchServer и выполните `modules load DiscordAuthSystem`.

## Конфигурация

После загрузки модуля создаётся файл `config/DiscordAuthSystem/Config.json`:

```json
{
  "clientId": "YOUR_DISCORD_CLIENT_ID",
  "clientSecret": "YOUR_DISCORD_CLIENT_SECRET",
  "redirectUrl": "http://127.0.0.1:9274/webapi/auth/discord",
   "portalRedirectUrl": "https://launch.example.com/webapi/auth/discord/portal",
   "portalCallbackUrl": "https://panel.example.com/auth/discord/callback",
   "portalHmacSecret": "32-or-more-random-bytes-shared-with-the-panel",
   "portalTicketTtlSeconds": 60,
  "discordAuthorizeUrl": "https://discord.com/oauth2/authorize",
  "discordTokenUrl": "https://discord.com/api/oauth2/token",
  "discordApiEndpoint": "https://discord.com/api/v10",
  "requiredGuildIds": ["123456789012345678"],
  "useGlobalNickname": true,
  "usernameRegex": "^[a-zA-Z0-9_]{3,16}$",
  "usernameFormat": "{discord}",
  "autoRegister": true
}
```

### Поля

- `clientId` / `clientSecret` — OAuth2-приложение Discord.
- `redirectUrl` — redirect URI, должен совпадать с настройками приложения Discord и заканчиваться на `/webapi/auth/discord`.
- `portalRedirectUrl` — отдельный redirect URI для портала, зарегистрированный в Discord и заканчивающийся на `/webapi/auth/discord/portal`. Не заменяет `redirectUrl`, поэтому launcher OAuth остаётся независимым.
- `portalCallbackUrl` — доверенный HTTPS URL панели. После успешного OAuth модуль перенаправляет браузер сюда с параметром `ticket`.
- `portalHmacSecret` — общий с панелью секрет длиной не менее 32 байт. Сгенерируйте криптографически случайное значение и не помещайте его в клиентский код.
- `portalTicketTtlSeconds` — срок действия portal ticket, от 30 до 300 секунд (по умолчанию 60).
- `requiredGuildIds` — список ID гильдий, членство в одной из которых обязательно для входа.
- `useGlobalNickname` — если `true`, использовать глобальный ник Discord пользователя; иначе — ник на первой обязательной гильдии.
- `usernameRegex` — regex для проверки итогового никнейма.
- `usernameFormat` — формат никнейма. Поддерживает `{discord}` (ник Discord) и `{username}` (fallback).
- `autoRegister` — автоматически создавать аккаунт, если пользователь ещё не зарегистрирован.

## Настройка через панель

1. Откройте страницу **Modules**, перейдите на вкладку **Auth** и нажмите **Build module** на карточке `DiscordAuthSystem`. Панель соберёт JAR через Docker.
   - Если выбрана инсталляция, JAR сразу копируется в её `LaunchServer/modules/`.
   - Если инсталляция не выбрана, JAR сохраняется в `data/modules/DiscordAuthSystem_module.jar` — его можно скопировать вручную.
2. Дождитесь окончания сборки, затем нажмите **Install and load** на той же карточке (или дождите, пока панель автоматически загрузит модуль при применении рецепта).
3. В панели откройте страницу **Auth**, выберите рецепт **Discord OAuth** и нажмите **Configure Discord OAuth**.
4. В модальном окне введите `clientId`, `clientSecret`, `redirectUrl` и при необходимости список обязательных гильдий.
5. Нажмите **Apply Discord auth** — панель запишет `config/DiscordAuthSystem/Config.json`, загрузит модуль и пропишет `core.type: discordauthsystem` в `LaunchServer.json`, после чего перезапустит LaunchServer.

## Ручная настройка LaunchServer

Добавьте auth provider в `LaunchServer.json`:

```json
{
  "std": {
    "isDefault": true,
    "core": {
      "type": "discordauthsystem"
    },
    "textureProvider": {
      "type": "void"
    },
    "displayName": "Discord",
    "visible": true
  }
}
```

## Как работает вход

1. Лаунчер открывает браузер по URL `https://discord.com/oauth2/authorize?...` (генерируется модулем).
2. Пользователь авторизуется в Discord.
3. Discord редиректит на `/webapi/auth/discord?code=...&state=...`.
4. Модуль обменивает `code` на access token, получает данные пользователя, проверяет гильдии и форматирует ник.
5. Если пользователь новый и `autoRegister=true`, создаётся UUIDv5 на основе Discord ID.
6. В браузере появляется подтверждение успешной авторизации. Пользователь возвращается в лаунчер и нажимает **Подтвердить вход**.
7. Модуль передаёт сохранённый OAuth-результат штатному `AuthRequest` лаунчера. До этого момента WebSocket-клиент не помечается авторизованным, поэтому повторный запрос не конфликтует с состоянием LaunchServer.

Завершённый результат хранится в памяти не более двух минут и привязан к тому
же WebSocket-клиенту, который создал OAuth `state`.

LauncherRuntime сохраняет OAuth-сессию через элемент интерфейса, который в
upstream называется «Сохранить пароль». Панель меняет эту подпись на
«Запомнить вход»: пароль Discord не сохраняется. При включённом автовходе
сохраненный OAuth access token восстанавливает сессию, а после истечения срока
действия модуль обновляет его через Discord refresh token.

В `Database.json` Discord provider tokens хранятся отдельно от локальных
LaunchServer session tokens. В протокол лаунчера и его TRACE-логи Discord
access/refresh tokens не передаются.

## Portal OAuth

Откройте в браузере `https://launch.example.com/webapi/auth/discord/portal`. Этот endpoint создаёт случайный server-side `state`, действующий 10 минут и удаляемый при первом callback. Для portal flow в Discord application должны быть зарегистрированы **оба** URI: существующий `redirectUrl` launcher-а и новый `portalRedirectUrl`.

После проверки Discord, guild membership, форматирования имени и auto-registration используется тот же `DiscordUser` из `Database.json` (и, соответственно, тот же UUIDv5 на Discord ID). Модуль перенаправляет на `portalCallbackUrl?ticket=...`. Ticket имеет формат `base64url(json).base64url(hmac-sha256)` и содержит только `uuid`, `username`, `discordId`, `exp` (Unix seconds) и `nonce`; Discord access/refresh tokens в него не входят.

Панель должна проверять HMAC над первой частью ticket с `portalHmacSecret`, отклонять истёкший ticket и атомарно отмечать `nonce` использованным до создания своей сессии. Это делает ticket одноразовым на стороне получателя. `portalCallbackUrl` должен быть HTTPS в production; endpoint также отправляет `Cache-Control: no-store` и `Referrer-Policy: no-referrer`.

## Безопасность никнеймов

- Нормализация Unicode (NFD).
- Транслитерация кириллицы → латиница.
- Замена пробелов и спецсимволов на `_`.
- Удаление символов, не подходящих под `usernameRegex`.
- Финальная проверка по `usernameRegex`; при неудаче — отказ в авторизации.
