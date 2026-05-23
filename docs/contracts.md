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
источник истины для статуса доступа. **Двухсторонняя реферальная программа**:
при покупке через валидного реферрера покупатель получает скидку
(`buyerDiscountBps`, по умолчанию 25%), реферрер получает кешбэк
(`referralBps`, по умолчанию 25%), treasury получает остаток (по умолчанию 50%).
Все три доли отсчитываются от полной `price`. Без валидного реферрера — покупатель
платит полный `price`, treasury получает полный `price`, скидки нет.

### Состояние
- `IERC20 pitch` — **immutable**, токен PITCH.
- `address treasury` — **immutable**, кошелёк-получатель выручки.
- `uint256 price` — полная цена доступа (настраиваемая).
- `uint16 buyerDiscountBps` — текущая скидка покупателю в bps от `price`
  (настраиваемая совместно с `referralBps`).
- `uint16 referralBps` — текущая доля реферрера в bps от `price`
  (настраиваемая совместно с `buyerDiscountBps`).
- `address owner` — админ.
- `mapping(address => bool) paid` — оплатившие.
- `mapping(address => bool) whitelisted` — выданный бесплатный доступ.

Инвариант: `buyerDiscountBps + referralBps <= MAX_TOTAL_REFERRAL_BPS = 5000`.
Treasury всегда получает минимум 50% от полной `price` — защита от
компрометации owner-ключа (req H).

Контракт **не накапливает токены**: и реферал-доля, и доля treasury уходят
прямыми `safeTransferFrom` от buyer'а — без `withdraw`-функции и без удержания
средств на контракте. Это сохраняет требование «минимальная поверхность атаки».

### Конструктор
`(IERC20 pitch, address treasury, uint256 price, uint16 buyerDiscountBps,
uint16 referralBps, address owner)` — проверки: zero-address (`pitch`, `treasury`,
`owner`), `0 < price ≤ MAX_PRICE`, `buyerDiscountBps + referralBps ≤
MAX_TOTAL_REFERRAL_BPS`.

### Функции
- `buyAccess(address referrer)` — требует `!hasAccess(msg.sender)`.
  Если `referrer != address(0) && referrer != msg.sender && referrer != address(this)`
  (валидный реферрер):
  `buyerPaid = price * (10000 - buyerDiscountBps) / 10000`,
  `referralAmount = price * referralBps / 10000`,
  `treasuryAmount = buyerPaid - referralAmount`
  (= `price * (10000 - buyerDiscountBps - referralBps) / 10000`).
  Если `referralAmount > 0`:
  `safeTransferFrom(msg.sender, referrer, referralAmount)`,
  `safeTransferFrom(msg.sender, treasury, treasuryAmount)`.
  Если `referralAmount == 0` (owner выставил `referralBps = 0`, kill-switch):
  только `safeTransferFrom(msg.sender, treasury, buyerPaid)` — скидка покупателю
  сохраняется, реферрер ничего не получает, `referrer` в событии — `address(0)`.

  Иначе (zero-address, self-ref или self-contract — невалидный реферрер):
  `safeTransferFrom(msg.sender, treasury, price)` одним вызовом; скидки нет,
  `referralAmount = 0`, `buyerPaid = price`, `referrer` в событии — `address(0)`.

  В любом случае: `paid[msg.sender] = true` ставится **до** трансферов (CEI),
  emit `AccessPurchased(msg.sender, refForEvent, buyerPaid, referralAmount)`.

  Self-ref и self-contract — **silent skip** (не revert), чтобы случайный
  self-link или ссылка-грифа `?ref=ACCESS_CONTRACT_ADDR` не ломали UX и не
  приводили к потере 50% платежа в чёрную дыру.
- `hasAccess(address) view → bool` = `paid || whitelisted`. Геттеры `paid`,
  `whitelisted`, `buyerDiscountBps`, `referralBps`.
- onlyOwner: `grantAccess(address)`, `grantBatch(address[])`, `revokeAccess(address)`,
  `setPrice(uint256)`, `setReferralSplit(uint16, uint16)`, `transferOwnership` /
  `acceptOwnership` (двухшаговый).
  `grantBatch` ограничен `MAX_BATCH = 100` адресов за вызов (защита от
  out-of-gas — owner делит больший whitelist на несколько tx).
  `setPrice` имеет верхнюю границу `MAX_PRICE = 100e18` (100 PITCH) — защита от
  компрометации owner-ключа: атакующий не может сделать доступ нереалистично
  дорогим. Лимит явно зашит как `constant`.
  `setReferralSplit(uint16 newDiscountBps, uint16 newReferralBps)` — атомарно
  обновляет обе доли; require'ит `newDiscountBps + newReferralBps ≤
  MAX_TOTAL_REFERRAL_BPS`. **Атомарность важна**: позволяет переключиться,
  например, с (10%, 40%) на (40%, 10%) одним вызовом — отдельные сеттеры
  потребовали бы временного нарушения инварианта в середине. Kill-switch —
  `setReferralSplit(0, 0)` (без редеплоя).

### События
`AccessPurchased(address indexed user, address indexed referrer, uint256 buyerPaid, uint256 referralAmount)`
— единое событие на покупку. `buyerPaid` — сколько реально заплатил покупатель
(== `price` без реферала, == `price * (1 - discount/10000)` с реферрером).
`referralAmount` — сколько ушло реферреру (0 если реферрера не было или
`referralBps = 0`). Treasury получил `buyerPaid - referralAmount` — выводимо
из лога. Поля `referrer = address(0) && referralAmount = 0` означают «без
реферала» (zero-address-аргумент, self-ref или self-contract); при этом
`buyerPaid == price`.
`AccessGranted(address indexed user)`, `AccessRevoked(address indexed user)`,
`PriceChanged(uint256 newPrice)`,
`ReferralSplitUpdated(uint16 newBuyerDiscountBps, uint16 newReferralBps)`,
`OwnershipTransferred(...)`.

### Требования безопасности
- **A. CEI** — `paid[msg.sender] = true` устанавливается **до** любых
  `safeTransferFrom` (включая реферал-выплату); плюс `nonReentrant` на `buyAccess`.
- **B.** Движение токенов — только через **`SafeERC20`** (`safeTransferFrom`).
- **C.** Передача прав — **`Ownable2Step`** (двухшаговая), не одношаговая.
- **D.** Конструктор валидирует zero-address (`pitch`, `treasury`, `owner`),
  `price > 0`, `buyerDiscountBps + referralBps ≤ MAX_TOTAL_REFERRAL_BPS`.
- **E.** Контракт **не `payable`**, без `receive()` — работает только с PITCH-ERC20.
  Не накапливает токены: реферал и treasury получают свои доли прямыми трансферами
  от buyer'а.
- **F.** Допущение: PITCH — стандартный токен без fee-on-transfer (зафиксировано).
- **G. Bounded `setPrice`** — `MAX_PRICE = 100e18` (100 PITCH) `constant`. `setPrice`
  обязан `require(newPrice > 0 && newPrice <= MAX_PRICE)`. Защита от компрометации
  owner-ключа: атакующий не может сделать доступ нереалистично дорогим (DoS) или
  бесплатным.
- **H. Bounded `setReferralSplit`** — `MAX_TOTAL_REFERRAL_BPS = 5000` (50%) `constant`.
  Сумма `buyerDiscountBps + referralBps` не может превысить этот потолок ни в
  конструкторе, ни в `setReferralSplit`. Гарантирует: treasury всегда получает
  **минимум 50%** от полной `price` даже при компрометации owner-ключа.
  Owner не может перенаправить более половины полной цены (как реферреру, так и в
  виде скидки покупателю, или их комбинации).
- **I. Rounding-инвариант** — для любых `price ∈ (0, MAX_PRICE]`,
  `discount ∈ [0, MAX_TOTAL_REFERRAL_BPS]`, `ref ∈ [0, MAX_TOTAL_REFERRAL_BPS]`
  с `discount + ref ≤ MAX_TOTAL_REFERRAL_BPS`: для валидного реферрера
  `referralAmount + treasuryAmount == buyerPaid`; для невалидного —
  `treasuryAmount == price`. Никаких «потерянных wei» (treasury всегда получает
  остаток от buyer'ского платежа). Покрыто Foundry fuzz-тестом.
- **J. Self-ref + self-contract не revert** — `referrer == msg.sender` ИЛИ
  `referrer == address(this)` обрабатывается как «нет реферала» (silent skip).
  Self-ref: иначе случайный self-link → revert → потеря fee для пользователя.
  Self-contract: защита от грифинга через ссылку `?ref=ACCESS_CONTRACT_ADDR` —
  без проверки 50% каждого платежа уходили бы на адрес контракта без rescue
  (чёрная дыра).
- `treasury` **immutable** — owner его менять не может: при компрометации owner-ключа
  платежи нельзя перенаправить (owner управляет whitelist, ценой и долей реферала,
  но не средствами).

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
