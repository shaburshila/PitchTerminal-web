# Смарт-контракты PitchTerminal-web — спецификация

> Спецификация **двух контрактов, которые деплоим мы**. Внешние контракты pitchwc
> (Router'ы, Hook'и, PITCH) здесь не описаны — их адреса в env vars
> ([conventions.md](conventions.md) §9), детали см. отдельно.
>
> Стек: **Foundry**, **Solidity 0.8.26**, база — **OpenZeppelin 5.x**. Сеть — Base (8453).
> Оба контракта проходят ревью/аудит до mainnet-деплоя; `LimitOrderExecutor` — основная
> цель аудита (двигает средства пользователей).
>
> Детальные формулы (EIP-712 typeHash, расчёт `minOut`, reference flow `execute()`) — в
> [eip712.md](eip712.md). Этот документ описывает **что есть в контракте**;
> [eip712.md](eip712.md) — **как это считается**.

## 1. `PitchTerminalAccess`

Контракт доступа: разовая оплата 1 PITCH разблокирует premium навсегда; on-chain
источник истины для статуса доступа.

### Состояние
- `IERC20 pitch` — **immutable**, токен PITCH.
- `address treasury` — **immutable**, кошелёк-получатель выручки.
- `uint256 price` — цена доступа (настраиваемая).
- `address owner` — админ.
- `mapping(address => bool) paid` — оплатившие.
- `mapping(address => bool) whitelisted` — выданный бесплатный доступ.

### Конструктор
`(IERC20 pitch, address treasury, uint256 price, address owner)` — с проверками на
zero-address и `price > 0`.

### Функции
- `buyAccess()` — требует `!hasAccess(msg.sender)`; `safeTransferFrom(msg.sender,
  treasury, price)`; `paid[msg.sender]=true`; emit `AccessPurchased`.
- `hasAccess(address) view → bool` = `paid || whitelisted`. Геттеры `paid`, `whitelisted`.
- onlyOwner: `grantAccess(address)`, `grantBatch(address[])`, `revokeAccess(address)`,
  `setPrice(uint256)`, `transferOwnership` / `acceptOwnership` (двухшаговый).
  `grantBatch` ограничен `MAX_BATCH = 100` адресов за вызов (защита от
  out-of-gas — owner делит больший whitelist на несколько tx).
  `setPrice` имеет верхнюю границу `MAX_PRICE = 100e18` (100 PITCH) — защита от
  компрометации owner-ключа: атакующий не может сделать доступ нереалистично
  дорогим. Лимит явно зашит как `immutable` константа.

### События
`AccessPurchased(address indexed user)`, `AccessGranted(address indexed user)`,
`AccessRevoked(address indexed user)`, `PriceChanged(uint256 newPrice)`,
`OwnershipTransferred(...)`.

### Требования безопасности
- **A. CEI** — `paid[msg.sender]=true` устанавливается **до** `safeTransferFrom`; плюс
  `nonReentrant` на `buyAccess`.
- **B.** Движение токенов — только через **`SafeERC20`** (`safeTransferFrom`).
- **C.** Передача прав — **`Ownable2Step`** (двухшаговая), не одношаговая.
- **D.** Конструктор валидирует zero-address (`pitch`, `treasury`, `owner`) и `price > 0`.
- **E.** Контракт **не `payable`**, без `receive()` — работает только с PITCH-ERC20.
- **F.** Допущение: PITCH — стандартный токен без fee-on-transfer (зафиксировано).
- **G. Bounded `setPrice`** — `MAX_PRICE = 100e18` (100 PITCH) `immutable`. `setPrice`
  обязан `require(newPrice > 0 && newPrice <= MAX_PRICE)`. Защита от компрометации
  owner-ключа: атакующий не может сделать доступ нереалистично дорогим (DoS) или
  бесплатным.
- `treasury` **immutable** — owner его менять не может: при компрометации owner-ключа
  платежи нельзя перенаправить (owner управляет whitelist и ценой, но не средствами).

## 2. `LimitOrderExecutor`

Контракт авто-исполнения лимит-ордеров. Ордер — off-chain подписанное EIP-712-сообщение;
контракт проверяет подпись и условие, исполняет своп через Router pitchwc.

### EIP-712
Domain: name `"PitchTerminal LimitOrders"`, version `"1"`, chainId 8453, verifyingContract.

Структура `Order` (точный encoding и обоснование `quoteToken` — в [eip712.md](eip712.md) §3):
```
Order {
  address owner;        // владелец ордера (и подписант)
  address token;        // торгуемый токен (игрока или страны)
  address quoteToken;   // quote-валюта пары: country для player-venue, PITCH для country-venue
  uint8   venue;        // 0 = player, 1 = country — выбирает пару Router/Hook
  uint8   side;         // 0 = limit-buy, 1 = take-profit
  uint256 targetPrice;  // целевая цена (в quote-валюте токена)
  uint256 amountIn;     // сумма входного токена
  uint256 slippageBps;  // допуск проскальзывания, базисные пункты
  uint256 expiry;       // unix-время; 0 = без срока
  uint256 nonce;        // уникальный per-owner (рекомендуется случайный 256-бит)
}
```

### Резолюция venue
Адреса Player Router / Country Router / Player Hook / Country Hook — **immutable**
constructor-параметры. Поле `Order.venue` (подписанное пользователем) выбирает нужную
пару. **Owner-задаваемого реестра `token→router` нет** — это исключает перенаправление
средств через вредоносный «роутер» при компрометации owner-ключа.

`Order.quoteToken` подписывается пользователем явно (см. [eip712.md](eip712.md) §3.3,
§6.1) — `getBaseCurrency` хука pitchwc нерабочий для части токенов. Sanity-check:
для `venue=country` контракт проверяет `quoteToken == PITCH` (PITCH immutable);
для `venue=player` корректность пары гарантирует router pitchwc (несовместимая пара
→ revert свопа → откат tx → средства пользователя возвращены).

### Константы
- `MAX_SLIPPAGE_BPS` = 1000 (10%) — потолок поля `slippageBps` в `Order`.
- `FEE_BPS` = 500 (5%) — захардкоженная комиссия pitchwc, входит в расчёт `minOut`.
  Если pitchwc сменит fee, потребуется ре-деплой executor'а — это намеренно
  (старые ордера с устаревшим `minOut` не должны исполняться по новой кривой).
- `EIP712_DOMAIN_NAME` = `"PitchTerminal LimitOrders"`, `VERSION` = `"1"`.

### Случайно отправленные на executor токены
У контракта **нет** rescue-функции для извлечения токенов, отправленных напрямую
на его адрес. Это намеренный архитектурный выбор: rescue с onlyOwner —
дополнительный вектор для злоупотребления owner-ключом; rescue без owner —
очевидная дыра. Executor — **не custodial vault**: проходящие через него
токены тратятся в той же транзакции (`safeTransferFrom` → swap →
`safeTransfer` обратно владельцу). Если кто-то по ошибке отправил токены на
адрес executor'а через обычный `transfer` — они потеряны. Это
документируется в README контрактов; адрес executor'а **не должен**
светиться в UI как «receive address».

### Функции
- `execute(Order order, bytes signature)` — **permissionless**. Шаги:
  1. `nonReentrant`; контракт не на паузе.
  2. Проверить подпись против `order.owner` (OZ `SignatureChecker` — ECDSA + EIP-1271).
  3. Проверить: nonce не использован; `expiry==0 || block.timestamp<=expiry`;
     `amountIn>0`; `slippageBps` в пределах потолка; `side`/`venue` валидны.
  4. Проверить ценовое условие через Hook: limit-buy → `currentPrice ≤ targetPrice`;
     take-profit → `currentPrice ≥ targetPrice`.
  5. **Пометить nonce использованным** (до внешних вызовов).
  6. `safeTransferFrom(owner → this, amountIn)` → `forceApprove(router, amountIn)` →
     `Router.buy/sell(…, minOut)`.
  7. Переслать **весь полученный баланс** выходного токена владельцу.
  8. emit `OrderExecuted`.
- `cancel(uint256 nonce)` — `msg.sender` помечает свой nonce использованным (трастлес-
  отмена on-chain). **`cancel` НЕ имеет модификатора `whenNotPaused`** — пользователь
  обязан иметь возможность отменить ордер даже если контракт на паузе (иначе
  pause превратился бы в захват пользовательских средств).
- `isNonceUsed(address owner, uint256 nonce) view → bool`.
- onlyOwner: `pause()` / `unpause()` — аварийный стоп; `transferOwnership` /
  `acceptOwnership` (двухшаговый).

### События
`OrderExecuted(address indexed owner, uint256 indexed nonce, address token,
uint256 amountIn, uint256 amountOut)`, `OrderCancelled(address indexed owner,
uint256 indexed nonce)`.

### Требования безопасности
- **G. `nonReentrant`** на `execute` — внутри несколько внешних вызовов (включая внешний
  вызов `isValidSignature` для EIP-1271-кошельков).
- **H. CEI** — nonce помечается использованным **до** внешних вызовов (шаг 5 до шага 6).
- **I. `minOut` вычисляется из подписанных `targetPrice` + `slippageBps`**, НЕ из цены,
  прочитанной в момент исполнения. Подписанный `targetPrice` — фиксированный пол, который
  манипуляция цены / sandwich сдвинуть не могут. **Ключевая защита от кражи через
  sandwich.**
- **J.** Проверка подписи — только OZ `SignatureChecker` / `ECDSA` (отсекает malleability
  high-s, нулевой адрес; закрывает EIP-1271). Ручной `ecrecover` запрещён.
- **K.** Подпись проверяется против `order.owner` — привязка ордера к подписанту.
- **L.** Движения токенов — только `SafeERC20` (`safeTransferFrom`, `safeTransfer`,
  `forceApprove`).
- **M.** Владельцу пересылается **весь полученный баланс** выходного токена (не вычисленная
  величина) — чтобы не копилась пыль.
- **N.** Валидация входа в `execute` (см. шаг 3).
- **O.** `Ownable2Step`; злоупотребление `pause` ограничено DoS-заморозкой, не кражей.
- **P.** Свойство (не дыра): on-chain `cancel` может быть фронт-ранен `execute` —
  мгновенная отмена идёт server-side, on-chain `cancel` — для строго трастлес сценария.
- **Q. `cancel` НЕ под `whenNotPaused`** — пользователь обязан иметь возможность
  отменить свой ордер (заблокировать nonce) даже когда контракт на паузе. Иначе
  pause превратился бы в захват средств. Тест: `pause → cancel → unpause →
  execute revert "nonce used"`.
- **R. Residual allowance reset** — после `router.buy/sell` обязательный
  `IERC20(inToken).forceApprove(router, 0)`. Defensive против багов router'а,
  оставляющего часть allowance неиспользованной. Инвариант теста:
  `allowance(executor, router) == 0` после каждого `execute`.
- **Главное свойство для аудита:** пользователь даёт executor'у standing-allowance
  (max-approve). Поэтому **`execute` — единственный путь, делающий `transferFrom`**, и
  только под валидную подпись владельца ровно на `order.amountIn`. Аудит обязан доказать:
  вытянуть средства без валидного подписанного ордера контракт не может.

## Аудит и деплой

Оба контракта: Foundry-тесты (близко к 100% веток) → ревью/аудит → деплой в Base mainnet
→ верификация на Basescan. `LimitOrderExecutor` дополнительно — ранний end-to-end тест
свопа с реальными токенами (закрыть остаток выполнимости пути авто-исполнения) и
**cross-check ритуал viem ↔ Solidity** (см. [eip712.md](eip712.md) §7) — обязательная
галочка в DoD фазы 2 ([conventions.md](conventions.md) §12).
