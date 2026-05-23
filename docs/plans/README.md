# Agent-driven development — оркестрация

> Этот документ — для **координатора** (главной сессии или человека). Описывает:
> кто из агентов чем владеет, в каком порядке они работают, где встречаются на
> интеграциях. Каждый агент при вызове получает ссылку на свой план в
> `plans/<agent>.md` — и не выходит за его границы.
>
> Источники истины: [../architecture.md](../architecture.md),
> [../api-spec.md](../api-spec.md), [../db-schema.sql](../db-schema.sql),
> [../eip712.md](../eip712.md), [../contracts.md](../contracts.md),
> [../conventions.md](../conventions.md), [../functional-spec.md](../functional-spec.md),
> [../port-from-portable.md](../port-from-portable.md).

## Содержание
1. [Агенты и границы](#1-агенты-и-границы)
2. [Контракты между агентами](#2-контракты-между-агентами)
3. [Dependency graph по фазам](#3-dependency-graph-по-фазам)
4. [Integration checkpoints](#4-integration-checkpoints)
5. [Протокол вызова агента](#5-протокол-вызова-агента)
6. [Правила границ и эскалаций](#6-правила-границ-и-эскалаций)
7. [Координация параллельной работы](#7-координация-параллельной-работы)

---

## 1. Агенты и границы

Четыре рабочих агента; координатор не пишет код.

| Агент | План | Владеет (write) | Читает (read-only) | Запрещено |
|---|---|---|---|---|
| **Infra** | [infra.md](infra.md) | `infra/`, `.github/workflows/`, `scripts/`, root: `docker-compose.yml`, `Dockerfile.*` (если есть), `.env.example`, `Caddyfile` | `backend/Dockerfile` (его пишет Backend), `frontend/vite.config.js` | Trogать `backend/`, `frontend/`, `contracts/` исходники |
| **Contracts** | [contracts.md](contracts.md) | `contracts/`, `abis/*.json` (output), `../contracts.md`, `../eip712.md` (обновления) | `../conventions.md` §7, env-vars list | Trogать Python, JS |
| **Backend** | [backend.md](backend.md) | `backend/`, `backend/migrations/` | `abis/`, `frontend/dist/` (для serving), `../api-spec.md`, `../port-from-portable.md`, `db-schema.sql` (как референс) | Trogать Solidity, JS, Docker Compose. Правки `db-schema.sql` — только через PR-предложение координатору (не самовольно). |
| **Frontend** | [frontend.md](frontend.md) | `frontend/` | `abis/`, `../api-spec.md`, `../eip712.md`, `../functional-spec.md` | Trogать Python, Solidity, инфра |

**Spec-документы (`docs/*.md` кроме `plans/`) — read-only для всех агентов.**
Обновляются только координатором, когда инженерное решение требует изменения
контракта. Агент, столкнувшись с пробелом в спецификации, **не правит сам** —
эскалирует координатору.

## 2. Контракты между агентами

«Контракт» = документ, описывающий interface; нарушение = баг.

| Контракт | Кто продьюсер | Кто консьюмер | Документ |
|---|---|---|---|
| ABI смарт-контрактов | Contracts | Backend, Frontend | `abis/*.json` (выводится `forge build`) |
| Адреса задеплоенных контрактов | Contracts | Backend (env), Frontend (через `/config`) | env vars + [../conventions.md](../conventions.md) §9 |
| REST/SSE API | Backend | Frontend | [../api-spec.md](../api-spec.md) |
| EIP-712 формат ордера | Contracts (canonical) + Backend (валидация) | Frontend (подпись) | [../eip712.md](../eip712.md) |
| Схема БД | Backend | (только Backend; никто больше не пишет в БД) | [../db-schema.sql](../db-schema.sql) |
| Env vars | Infra (через `.env`) | Backend, Contracts (deploy) | [../conventions.md](../conventions.md) §9 |
| Каноничные формулы (PnL, change_pct, holders) | Backend | (внутреннее) | [../port-from-portable.md](../port-from-portable.md) §5.1 |
| Файловая раскладка | Координатор | Все агенты | [../conventions.md](../conventions.md) §5-7 |

## 3. Dependency graph по фазам

### Фаза 0 — Фундамент + монетизация

```
Infra:    I0.1 ─► I0.2 ─► I0.3 ─► I0.4 ─► I0.5 ─► I0.6 ─► I0.7
            │       │                       │
            ▼       ▼                       ▼
Backend:  B0.1 ─► B0.2 ─► B0.3 ─► B0.4 ─► B0.5 ─► B0.6 ─► B0.7 ─► B0.8 ─► B0.9 ─► B0.10 ─► B0.11 ─► B0.11b ─► B0.12 ─► B0.13 ─► B0.14
                                                                                       │
                                                                                       ▼
Contracts:  C0.1 ─► C0.2 ─► C0.3 ─► C0.4 ─────────────► C0.5
                                                          │
                                                          ▼
Frontend:  F0.1 ─► F0.2 ─► F0.3 ─► F0.4 ─► F0.5 ─► F0.6 ─► F0.7 ─► F0.8 ─► F0.9 ─► F0.10 ─► F0.11 ─► F0.12 ─► F0.12a ─► F0.12b ─► F0.12c ─► F0.13 ─► F0.14 ─► F0.15
```

Где:
- **B0.11b** — 4 эндпоинта `/api/v1/ref/*` (handle claim/resolve) + reserved-список.
- **F0.12a** — парсинг `?ref=` из URL, резолв через API, localStorage.
- **F0.12b** — UI claim/release handle в профиле (модалка, валидация).
- **F0.12c** — подписка на SSE-канал `event: config` (реактивное обновление цены/скидок).

**Жёсткие dependencies (cross-agent):**

| Зависит | От | Почему |
|---|---|---|
| B0.1 | I0.1 | Backend нужен скелет репо |
| B0.7 | I0.2 | API нужен поднятый Postgres |
| F0.2 | B0.7 (`/config`, `/health`) | Фронт без API не нужен |
| F0.10 | B0.7 (`/config` отдаёт WC project ID) | Wallet connect нужен `chainId` и адреса |
| F0.11 | B0.10 (SIWE endpoints) | Подпись без проверки на сервере бесполезна |
| F0.12 | C0.5 (Access задеплоен) + B0.11 (`/access`) + B0.8 (`/config?fresh=1`) + F0.12a (ref localStorage) | Оплата невозможна без контракта, эндпоинта и зарезолвленного referrer |
| F0.12a | B0.11b (`/api/v1/ref/{code}`) | Резолв handle → wallet через API |
| F0.12b | F0.11 (SIWE) + B0.11b (`PUT/DELETE /ref/me`) | Claim handle требует auth + соответствующий эндпоинт |
| F0.12c | F0.3 (SSE client) + B0.9 (SSE config канал) | Подписка требует уже работающего SSE-клиента и канала на бэке |
| F0.13 | B0.12 (`@require_premium`) | Soft-lock UI должен соответствовать серверной проверке |
| Все B0.7+ | I0.4 (Caddy) перед integration testing | Без same-origin не отладишь cookie |

### Фаза 1 — Некастодиальная торговля

```
Backend:  B1.1 (удалить /trade,/quote,/wallet)
Frontend: F1.1 ─► F1.2 ─► F1.3 ─► F1.4
                          (quote → approve → swap → refinement)
Contracts: — (ничего нового; используем pitchwc контракты)
Infra:    I1.1 (если нужно — обновить deploy)
```

### Фаза 2 — Лимит-ордера

```
Contracts: C2.1 ─► C2.2 ─► C2.3 ─► C2.4 ─► C2.5 ─► C2.6 (LimitOrderExecutor + аудит + deploy)
                                                    │
Backend:   B2.1 ─► B2.2 ─► B2.3 ─► B2.4 ─► B2.5 ◄──┘
            (POST /orders) (keeper) (status)
                                                    │
Frontend:  F2.1 ─► F2.2 ─► F2.3 ─► F2.4 ◄───────────┘
            (limit UI + EIP-712 + approve UX)
```

**Жёсткая dependency:** F2 + B2 keeper ждут C2.6 (executor задеплоен на mainnet).

### Фаза 3 — Telegram-алерты

```
Infra:    I3.1 (setWebhook, secret в env)
Backend:  B3.1 ─► B3.2 ─► B3.3 (webhook handler, link tokens, outbound)
Frontend: F3.1 (привязка Telegram в профиле)
Contracts: — 
```

## 4. Integration checkpoints

Точки, где агенты встречаются и координатор проверяет, что контракт соблюдён.
Не проходишь — фаза не закрыта.

| Checkpoint | Когда | Что проверяется | Кто валидирует |
|---|---|---|---|
| **IC-0.1** | После B0.7 + F0.2 | Curl + браузер: `/config`, `/tokens`, `/chart/:a`, `/trades/:a` отвечают, фронт их рендерит | Координатор + Backend + Frontend |
| **IC-0.2** | После B0.8 + F0.3 | SSE поток: prices/events приходят в браузер, фронт обновляет график без перезагрузки | Координатор |
| **IC-0.3** | После B0.10 + F0.11 | SIWE end-to-end: подключение → подпись → JWT-cookie → `/access` отдаёт `false` | Координатор |
| **IC-0.4** | После C0.5 + B0.11 + F0.12 | Тестовый платёж 1 PITCH → `hasAccess=true` → premium-зона разблокирована | Координатор + Contracts (deploy verify) |
| **IC-0.4a** | После B0.11b + F0.12a + F0.12b | Реферал-флоу e2e: claim handle (alex42) → ссылка `?ref=alex42` → новый пользователь видит skid'у в pay-flow → on-chain ref получает 25%, treasury 50%, buyer заплатил 75% | Координатор + Backend + Frontend |
| **IC-0.4b** | После B0.9 + F0.12c | Config sync: owner `setReferralSplit(1000,4000)` → ≤10с фронт получает `event: config` → баннер обновился без рефреша | Координатор + Backend + Frontend |
| **IC-0.5** | После B0.13 + F0.13 + F0.15 | `/profile` отдаёт данные, premium-зона работает, soft-lock-баннер для не-premium | Координатор |
| **IC-0.6** | DoD фазы 0 | Все пункты [../conventions.md](../conventions.md) §12 фазы 0 | Координатор |
| **IC-1.1** | После F1.3 | Market-swap end-to-end: quote → approve → buy → receipt → UI | Координатор + ультра-ревью контракта pitchwc |
| **IC-1.2** | DoD фазы 1 | Все пункты [../conventions.md](../conventions.md) §12 фазы 1 | Координатор |
| **IC-2.1** | После C2.3 (исполняется LimitOrderExecutor задеплоен на форк-тесте) | viem ↔ Solidity digest совпадают (см. [../eip712.md](../eip712.md) §7) | Координатор + Contracts |
| **IC-2.2** | После C2.6 + B2.4 | Реальный execute() на mainnet с реальными токенами (small amount) | Координатор |
| **IC-2.3** | DoD фазы 2 | Все пункты [../conventions.md](../conventions.md) §12 фазы 2, включая аудит | Координатор |
| **IC-3.1** | DoD фазы 3 | Все пункты [../conventions.md](../conventions.md) §12 фазы 3 | Координатор |

## 5. Протокол вызова агента

Каждый агент получает на вход одну из двух форм:

### 5.1 Полная фаза
> «Ты Backend-агент. Выполни шаги B0.1–B0.7 согласно `docs/plans/backend.md`.
> Следуй DoD каждого шага. Если упираешься в зависимость от другого агента
> или в неоднозначность в spec-документе — остановись и эскалируй координатору.»

### 5.2 Один шаг
> «Ты Frontend-агент. Выполни шаг F0.11 из `docs/plans/frontend.md`. DoD:
> SIWE-вход через MetaMask проходит, cookie `pt_session` ставится, `/access`
> возвращает корректный JSON.»

### 5.3 Что агент НЕ делает
- Не правит spec-документы (`api-spec.md` и т.д.). Только координатор.
- Не правит файлы вне своих границ (см. §1).
- Не «улучшает» соседние компоненты, даже если видит проблему — открывает
  issue/задачу для координатора.
- Не делает деплой на VPS — это всегда координатор или Infra-агент с явным
  на то указанием.
- Не запускает long-running тесты (fork-тесты Foundry, ультра-ревью) без
  явного указания.

### 5.4 Структура отчёта агента после шага
Каждый агент отчитывается по шаблону:
```
Шаг: <ID>
Статус: completed | blocked | partial
Что сделано: <bullet list>
DoD проверен: <да/нет, как именно>
Следующие шаги: <ID шагов, готовых к запуску>
Эскалации: <вопросы координатору, если есть>
```

## 6. Правила границ и эскалаций

**Когда агент должен остановиться и эскалировать:**

1. **Spec-конфликт.** Поведение, описанное в `api-spec.md`, противоречит
   `db-schema.sql`. → Не «угадывать», какое правильное — эскалировать.
2. **Зависимость не готова.** Frontend-агент нужен endpoint от Backend — но
   Backend ещё не выполнил соответствующий шаг. → Не мокать в production-коде;
   эскалировать или добавить timestamp checkpoint.
3. **Граница владения.** Frontend-агенту нужно изменить `api-spec.md`. →
   Не править сам — описать желаемое изменение, эскалировать.
4. **Новая зависимость.** Backend хочет добавить пакет, не в `requirements.txt`. →
   ОК добавить, но отметить в отчёте.
5. **DoD не выполняется.** Шаг по плану закончен, но один из DoD-критериев не
   проходит. → Статус `partial`, эскалация, не помечать `completed`.

**Что агент решает сам без эскалации:**
- Имена внутренних функций/переменных в своём слое.
- Структура внутри файлов (если не противоречит conventions).
- Какие unit-тесты писать (помимо обязательных из DoD).
- Логика, не описанная в spec, но укладывающаяся в нормы языка/фреймворка.

## 7. Координация параллельной работы

Пользователь выбрал **параллельно внутри фазы**. Для одиночной Claude Code
сессии это означает:

1. **Координатор стартует агентов через `Agent` tool в одном сообщении** — если
   шаги независимы (например, `I0.1`, `C0.1`, `F0.1` — все «scaffolding»).
2. **Background-задачи** для агентов, которые могут работать долго (например,
   Foundry fork-тесты, бэкфилл событий) — через `run_in_background: true`.
3. **Синхронизация на checkpoint'ах** — координатор не запускает следующий шаг,
   пока зависимый checkpoint не пройден.
4. **Git-ветки.** Каждый агент работает в отдельной feature-ветке (например,
   `feat/backend-phase0-foundation`). Координатор мёрджит после прохождения
   DoD соответствующих шагов.
5. **Worktree-изоляция** (опционально) — для физического разделения
   рабочих копий: `Agent({ isolation: "worktree" })`.

### 7.1 Что блокирует параллельность

| Блок | Причина | Решение |
|---|---|---|
| Изменение `abis/` | Contracts генерирует, Backend и Frontend читают | Contracts мёрджит ABI **первым**, остальные подтягивают |
| Изменение env vars | Все слои зависят | Заранее зафиксировано в `conventions.md` §9 — изменения только через координатора |
| Изменение `api-spec.md` | Backend и Frontend оба читают | Никто из агентов не правит; только координатор |
| Изменение `db-schema.sql` | Только Backend пишет — но миграции должны быть применены до тестов | Backend применяет в своей ветке; CI прогоняет миграции на каждом PR |

### 7.2 Карта стартовых шагов для параллельного запуска фазы 0

В первом батче запускается:
- `I0.1` (репо-скелет, .gitignore, docs/, abis/, верхнеуровневые директории)
- `C0.1` (Foundry scaffold) — независимо
- `F0.1` (Vite scaffold) — зависит от I0.1 (директории `frontend/`)
- `B0.1` (Python скелет) — зависит от I0.1

Координатор: запускает 4 агента параллельно с указанием первого шага каждого;
ждёт всех; проверяет, что директории не конфликтуют; затем — следующий батч
по dependency graph выше.
